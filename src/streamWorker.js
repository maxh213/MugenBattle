/**
 * StreamWorker: one Xvfb + one ffmpeg + a broadcast client pool, optionally
 * driving a league via runLeagueWorker. Multiple StreamWorkers can run side
 * by side in the stream-server process — each claims a distinct DISPLAY,
 * logPath, and leagueId so nothing collides.
 *
 * Lifecycle:
 *   start()       — spawn Xvfb, wait for it, spawn ffmpeg. Worker goes 'idle'.
 *   assignLeague  — bind to a leagueId and loop runFixture until done.
 *                   When it returns, worker goes back to 'idle' and the
 *                   supervisor can reassign.
 *   stop()        — tear down ffmpeg + Xvfb, end all client responses.
 *
 * Observability via describe(): workerId, display, status, leagueId,
 * currentFixtureId, clients.size, lastError.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { runLeagueWorker } from './leagueWorker.js';

const SOI = Buffer.from([0xff, 0xd8]); // JPEG start of image
const EOI = Buffer.from([0xff, 0xd9]); // JPEG end of image

const DEFAULT_SIZE = '640x480';
const DEFAULT_FPS = 15;
const XVFB_READY_TIMEOUT_MS = 5000;

export class StreamWorker {
  constructor({
    workerId,
    display,
    size = DEFAULT_SIZE,
    fps = DEFAULT_FPS,
    logPath,
  }) {
    if (!workerId) throw new Error('StreamWorker: workerId required');
    if (!display) throw new Error('StreamWorker: display required');
    this.workerId = workerId;
    this.display = display;
    this.size = size;
    this.fps = fps;
    this.logPath = logPath;

    this.xvfb = null;
    this.ffmpeg = null;
    this.frameBuffer = { data: null, ts: 0 };
    this.clients = new Set();

    this.status = 'pending';
    this.leagueId = null;
    this.divisionId = null;
    this.currentFixtureId = null;
    this.runPromise = null;
    this.lastError = null;
    this.startedAt = null;
  }

  async start() {
    if (this.status !== 'pending' && this.status !== 'stopped') {
      throw new Error(`StreamWorker ${this.workerId}: can't start from status=${this.status}`);
    }
    this.status = 'starting';

    this._startXvfb();
    await this._waitForDisplay();
    this._startFfmpeg();

    this.status = 'idle';
    this.startedAt = Date.now();
    console.log(`[worker ${this.workerId}] up: display=${this.display} log=${this.logPath}`);
  }

  _startXvfb() {
    this.xvfb = spawn('Xvfb', [this.display, '-screen', '0', `${this.size}x24`, '-nolisten', 'tcp'], {
      stdio: 'ignore',
    });
    // Xvfb may fork-and-exit-the-parent once the display is ready; the actual
    // server lives on as a reparented daemon. Don't flip to 'error' on exit —
    // if the display really did die, ffmpeg will fail next and flag it there.
    this.xvfb.on('exit', (code) => {
      this.xvfb = null;
      if (code !== 0 && this.status === 'starting') {
        console.error(`[worker ${this.workerId}] xvfb startup exit code=${code}`);
      }
    });
  }

  /** Wait for Xvfb to create its X socket. Poll /tmp/.X11-unix/Xnn. */
  async _waitForDisplay() {
    const num = this.display.replace(':', '');
    const sock = `/tmp/.X11-unix/X${num}`;
    const deadline = Date.now() + XVFB_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (existsSync(sock)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Xvfb for ${this.display} did not come up in time`);
  }

  _startFfmpeg() {
    this.ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-f', 'x11grab',
      '-draw_mouse', '0',
      '-framerate', String(this.fps),
      '-video_size', this.size,
      '-i', `${this.display}.0`,
      '-c:v', 'mjpeg',
      '-q:v', '5',
      '-f', 'mpjpeg',
      '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let buf = Buffer.alloc(0);
    this.ffmpeg.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const soi = buf.indexOf(SOI);
        if (soi < 0) { buf = Buffer.alloc(0); break; }
        const eoi = buf.indexOf(EOI, soi + 2);
        if (eoi < 0) {
          if (soi > 0) buf = buf.slice(soi);
          break;
        }
        const frame = buf.slice(soi, eoi + 2);
        buf = buf.slice(eoi + 2);
        this.frameBuffer.data = frame;
        this.frameBuffer.ts = Date.now();
        for (const c of this.clients) {
          try {
            c.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
            c.write(frame);
            c.write('\r\n');
          } catch {}
        }
      }
    });
    this.ffmpeg.stderr.on('data', (d) => process.stderr.write(`[worker ${this.workerId} ffmpeg] ${d}`));
    this.ffmpeg.on('exit', (code) => {
      console.error(`[worker ${this.workerId}] ffmpeg exited code=${code}`);
      this.ffmpeg = null;
      if (this.status !== 'stopped') this.status = 'error';
    });
  }

  /**
   * Attach an HTTP response to the frame broadcast. Returns a detach function.
   */
  attachClient(res) {
    this.clients.add(res);
    if (this.frameBuffer.data) {
      try {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${this.frameBuffer.data.length}\r\n\r\n`);
        res.write(this.frameBuffer.data);
        res.write('\r\n');
      } catch {}
    }
    return () => this.clients.delete(res);
  }

  /**
   * Assign a league (optionally scoped to a single division) and begin
   * running its fixtures. Returns the promise; resolves when nothing is
   * pending for this scope. With a divisionId, N workers can run the same
   * league's N tiers in parallel without racing for fixtures.
   */
  assignLeague(db, leagueId, divisionId = null) {
    if (this.status !== 'idle') {
      throw new Error(`StreamWorker ${this.workerId}: can't assign in status=${this.status}`);
    }
    this.leagueId = leagueId;
    this.divisionId = divisionId;
    this.status = 'running';
    this.lastError = null;
    const ctx = { logPath: this.logPath, display: this.display };

    this.runPromise = runLeagueWorker(db, leagueId, ctx, {
      onFixtureStart: (f) => { this.currentFixtureId = f.id; },
      onFixtureEnd: () => { this.currentFixtureId = null; },
      onError: (f, err) => {
        this.lastError = `fixture #${f.id}: ${err.message}`;
        console.error(`[worker ${this.workerId}] ${this.lastError}`);
        // Try to continue past the error; if another one hits we'll stop.
        return false;
      },
    }, { divisionId }).catch((err) => {
      this.lastError = err.message;
      console.error(`[worker ${this.workerId}] runLeagueWorker threw: ${err.message}`);
      return { fixturesRun: 0, stopped: true };
    }).finally(() => {
      this.currentFixtureId = null;
      this.runPromise = null;
      this.leagueId = null;
      this.divisionId = null;
      if (this.status === 'running') this.status = 'idle';
    });

    return this.runPromise;
  }

  stop() {
    if (this.status === 'stopped') return;
    this.status = 'stopped';
    for (const c of this.clients) { try { c.end(); } catch {} }
    this.clients.clear();
    if (this.ffmpeg) { try { this.ffmpeg.kill('SIGTERM'); } catch {} }
    if (this.xvfb) { try { this.xvfb.kill('SIGTERM'); } catch {} }
    // Xvfb can reparent to init after fork-and-exit — kill by display name
    // to catch the orphaned daemon too.
    try {
      spawn('pkill', ['-f', `Xvfb ${this.display} `], { stdio: 'ignore' });
    } catch {}
  }

  describe() {
    return {
      workerId: this.workerId,
      display: this.display,
      status: this.status,
      leagueId: this.leagueId,
      divisionId: this.divisionId,
      currentFixtureId: this.currentFixtureId,
      clients: this.clients.size,
      lastError: this.lastError,
      startedAt: this.startedAt,
      hasFrame: !!this.frameBuffer.data,
    };
  }
}

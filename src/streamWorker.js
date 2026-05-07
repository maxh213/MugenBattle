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

import { spawn, spawnSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { runLeagueWorker } from './leagueWorker.js';
import { runExhibition, runTournamentMatch } from './exhibition.js';

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
    kind = 'league',
  }) {
    if (!workerId) throw new Error('StreamWorker: workerId required');
    if (!display) throw new Error('StreamWorker: display required');
    this.workerId = workerId;
    this.display = display;
    this.size = size;
    this.fps = fps;
    this.logPath = logPath;
    // 'league' workers loop through fixture queues; 'exhibition' workers
    // claim one ad-hoc match at a time. Different supervisors, different
    // assign methods — kept on one Map so /stream/<id> works uniformly.
    this.kind = kind;

    this.xvfb = null;
    this.ffmpeg = null;
    this.frameBuffer = { data: null, ts: 0 };
    this.clients = new Set();

    this.status = 'pending';
    this.leagueId = null;
    this.divisionId = null;
    this.currentFixtureId = null;
    this.exhibitionId = null;
    this.tournamentMatchId = null;
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
    // Stale sockets from a previous run will fool a naive readiness check —
    // existsSync(/tmp/.X11-unix/Xnn) returns true for the leftover even
    // though no server is listening, and Ikemen later errors with
    // "Failed to open display". Kill any orphan Xvfb on this display and
    // remove the sockets before spawning a fresh one.
    const num = this.display.replace(':', '');
    try { spawnSync('pkill', ['-9', '-f', `Xvfb ${this.display} `], { stdio: 'ignore' }); } catch {}
    for (const f of [`/tmp/.X11-unix/X${num}`, `/tmp/.X11-unix/X${num}_`]) {
      try { if (existsSync(f)) unlinkSync(f); } catch {}
    }
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

  /**
   * Wait for Xvfb to actually be serving — not just for the socket file to
   * exist (a leftover socket from a dead Xvfb passes existsSync but no
   * server is listening). We probe with `xprop` which connects to the X
   * server and bails fast if nobody's there.
   */
  async _waitForDisplay() {
    const deadline = Date.now() + XVFB_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const r = spawnSync('xprop', ['-display', this.display, '-root'], { stdio: 'ignore', timeout: 1000 });
      if (r.status === 0) return;
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

  /**
   * Assign a single pre-claimed exhibition match. Caller is responsible for
   * having atomically marked the exhibition_match row as 'running' first
   * (claimNextPendingExhibition). The runner finalises the row when the
   * match resolves; on failure the row is marked 'failed' inside runExhibition.
   */
  assignExhibition(db, exhibitionId, callbacks = {}) {
    if (this.status !== 'idle') {
      throw new Error(`StreamWorker ${this.workerId}: can't assign exhibition in status=${this.status}`);
    }
    this.status = 'running';
    this.exhibitionId = exhibitionId;
    this.lastError = null;
    const ctx = { logPath: this.logPath, display: this.display };

    this.runPromise = (async () => {
      try {
        callbacks.onStart?.(exhibitionId);
        const r = await runExhibition(db, exhibitionId, ctx);
        callbacks.onEnd?.(exhibitionId, r);
        return r;
      } catch (err) {
        this.lastError = err.message;
        console.error(`[worker ${this.workerId}] exhibition ${exhibitionId} failed: ${err.message}`);
        callbacks.onError?.(exhibitionId, err);
        return { ok: false };
      }
    })().finally(() => {
      this.exhibitionId = null;
      this.runPromise = null;
      if (this.status === 'running') this.status = 'idle';
    });

    return this.runPromise;
  }

  /**
   * Assign a single pre-claimed exhibition_tournament_match. Caller has
   * already marked the row 'running' via claimNextPendingTournamentMatch.
   * On match completion runTournamentMatch records the winner and advances
   * the bracket; the supervisor will pick up follow-up matches on its next
   * tick.
   */
  assignTournamentMatch(db, matchId, callbacks = {}) {
    if (this.status !== 'idle') {
      throw new Error(`StreamWorker ${this.workerId}: can't assign tournament match in status=${this.status}`);
    }
    this.status = 'running';
    this.tournamentMatchId = matchId;
    this.lastError = null;
    const ctx = { logPath: this.logPath, display: this.display };

    this.runPromise = (async () => {
      try {
        callbacks.onStart?.(matchId);
        const r = await runTournamentMatch(db, matchId, ctx);
        callbacks.onEnd?.(matchId, r);
        return r;
      } catch (err) {
        this.lastError = err.message;
        console.error(`[worker ${this.workerId}] tournament match ${matchId} failed: ${err.message}`);
        callbacks.onError?.(matchId, err);
        return { ok: false };
      }
    })().finally(() => {
      this.tournamentMatchId = null;
      this.runPromise = null;
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
      kind: this.kind,
      display: this.display,
      status: this.status,
      leagueId: this.leagueId,
      divisionId: this.divisionId,
      currentFixtureId: this.currentFixtureId,
      exhibitionId: this.exhibitionId,
      tournamentMatchId: this.tournamentMatchId,
      clients: this.clients.size,
      lastError: this.lastError,
      startedAt: this.startedAt,
      hasFrame: !!this.frameBuffer.data,
    };
  }
}

/**
 * League worker loop: pulls the next pending fixture from a single league,
 * runs it, repeats until the league is complete.
 *
 * Stateless; takes a db + ctx and a set of optional lifecycle callbacks so
 * supervisors (CLI one-shots, stream-server) can observe progress without
 * the worker knowing about them.
 *
 * Not concurrency-safe across two workers pulling from the same league —
 * callers must assign each worker a distinct league.
 */

import { pickNextFixture, runFixture } from './leagues.js';

/**
 * Run all remaining fixtures for leagueId in sequence.
 *
 * @param {object}   db          better-sqlite3 handle.
 * @param {number}   leagueId    which league this worker owns.
 * @param {object}  [ctx]        per-worker isolation context: { logPath, display }.
 * @param {object}  [hooks]
 * @param {Function}[hooks.onFixtureStart] (fixture) => void | Promise
 * @param {Function}[hooks.onFixtureEnd]   (fixture, result) => void | Promise
 * @param {Function}[hooks.onError]        (fixture, err) => boolean | Promise<boolean>
 *                                          return true to stop, false to continue past the error.
 * @param {Function}[hooks.shouldStop]     () => boolean — polled between fixtures.
 *
 * @returns {Promise<{fixturesRun: number, stopped: boolean}>}
 */
export async function runLeagueWorker(db, leagueId, ctx = {}, hooks = {}) {
  let fixturesRun = 0;

  for (;;) {
    if (hooks.shouldStop && hooks.shouldStop()) {
      return { fixturesRun, stopped: true };
    }

    const next = pickNextFixture(db, { leagueId });
    if (!next) {
      // No pending fixtures — either the league is complete or every
      // remaining fixture is already running/done (e.g. another worker
      // touched it). Either way we're done.
      return { fixturesRun, stopped: false };
    }

    if (hooks.onFixtureStart) await hooks.onFixtureStart(next);

    let result;
    try {
      result = await runFixture(db, next.id, ctx);
    } catch (err) {
      const stop = hooks.onError ? await hooks.onError(next, err) : true;
      if (stop) return { fixturesRun, stopped: true };
      continue;
    }

    fixturesRun++;
    if (hooks.onFixtureEnd) await hooks.onFixtureEnd(next, result);
  }
}

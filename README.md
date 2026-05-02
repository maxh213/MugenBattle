# MugenBattle

Automated AI fighting tournament runner with stat tracking, live video streaming dashboard, and SaltyBet-style bracket tournaments.

Pits AI-controlled MUGEN / Ikemen GO fighters against each other, runs single-elimination brackets, records results to a local SQLite database, and streams live matches to a web dashboard that you can watch in a browser.

Works cross-platform: **Ikemen GO** on Linux / **MUGEN** on Windows.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- SQLite (comes bundled via `better-sqlite3`)

### Linux (Arch / similar)

System packages — most of these are optional depending on which features you use:

```bash
# Always required: Ikemen GO engine. Download a release:
# https://github.com/ikemen-engine/Ikemen-GO/releases
mkdir engine && cd engine
# ...extract Ikemen_GO_Linux + data/ here...

# For headless streaming (no game window on your desktop):
sudo pacman -S xorg-server-xvfb ffmpeg xdotool wmctrl xorg-xprop
# xprop is REQUIRED — the worker pool uses it to verify Xvfb is actually
# serving on each display before launching Ikemen. Stale X11 sockets from
# crashed Xvfbs would otherwise pass a naive existsSync check.

# For the user character-upload pipeline. Both are HARD requirements —
# importer refuses to run without clamscan on PATH, and rejects the
# sandbox test if bwrap is missing.
sudo pacman -S clamav bubblewrap
sudo freshclam                    # pull signature database
sudo systemctl enable --now clamav-freshclam.service  # keep it updated

# For the bulk import pipeline (pulling chars from MUGEN Free For All etc):
sudo pacman -S unrar p7zip
paru -S megatools   # for Mega.nz downloads (from AUR)
```

For the Python scripts (portrait extraction, bulk import, dedupe), a venv is expected at `.venv/`:

```bash
python3 -m venv .venv
.venv/bin/pip install Pillow gdown playwright
.venv/bin/playwright install chromium
```

### Windows

Install [MUGEN](https://mugen.fandom.com/) in a `mugen/` directory at the project root. Headless streaming + bulk import are Linux-only at the moment.

## Setup

```bash
npm install
```

## Quick start

```bash
# Run a random match (requires at least 2 fighters + 1 stage registered)
node src/index.js run

# Run a 16-fighter tournament with live streaming
node src/stream-server.js &                  # terminal 1: web dashboard
DISPLAY=:99 node src/index.js tournament start --size 16
# open http://localhost:8080 in your browser
```

## Fighter / stage management

```bash
# Add (folder name inside engine/chars/ or engine/stages/)
node src/index.js fighters add kfm
node src/index.js stages add stage0

# Add with source URL + explicit author (optional — auto-read from .def [Info])
node src/index.js fighters add ragna --source "https://mugenfreeforall.com/..." --author "Devilpp"

# List / remove
node src/index.js fighters list
node src/index.js fighters remove kfm
node src/index.js stages list

# Pull author/displayname from every character's .def [Info] section
node src/index.js fighters backfill-authors

# Deactivate broken chars (missing files, malformed cmd, etc)
node src/index.js fighters validate
node src/index.js fighters validate --force   # re-check even previously-validated
```

## Running matches

```bash
# Single random match
node src/index.js run

# Batch
node src/index.js run --count 10

# Fighter leaderboard
node src/index.js stats

# Recent fights
node src/index.js history
node src/index.js history --limit 50
```

## Tournaments

Single-elimination brackets of any power-of-two size.

```bash
# Basic 8-fighter bracket (fresh-fighter selection by default — prioritizes least-played)
node src/index.js tournament start --size 8

# 16-fighter bracket with classic seeding (top win-rate seeded 1 vs N, 2 vs N-1, etc)
node src/index.js tournament start --size 16 --name "Spring Cup" --selection top --seeding seeded

# See all tournaments and their winners
node src/index.js tournament list

# Inspect a specific bracket (round-by-round)
node src/index.js tournament show 3

# Resume a tournament interrupted mid-run
node src/index.js tournament resume 3
```

Selection modes:
- `fresh` *(default)* — picks fighters with the fewest total matches first, ties broken randomly. Good rotation.
- `random` — uniform random from active pool.
- `top` — picks highest-win-rate fighters. Needed for seeded brackets.

Seeding modes:
- `random` *(default)* — shuffle before bracketing.
- `seeded` — classic 1-vs-N, 2-vs-(N-1) layout so top seeds can't meet until later rounds. Implies `--selection top`.

Tournaments survive broken characters: a pre-flight validator catches common issues (missing files, malformed `.cmd`) and if something still blows up mid-match, the broken char is deactivated and the other side declared winner.

## Live streaming dashboard

`src/stream-server.js` is the long-running web server. It owns:

- **A pool of "stream workers"**, each = one Xvfb display + one ffmpeg MJPEG encoder + (when assigned) one Ikemen process. Configurable count via `STREAM_WORKERS`. Each worker covers one division of the running league.
- **An exhibition worker pool** for ad-hoc user-requested sparring matches (`/exhibition`). Lives on a separate display so league fixtures aren't preempted.
- **Three supervisor loops**: league-fixture supervisor (assigns idle workers to running league divisions), exhibition supervisor (claims pending exhibition matches), and bot-market supervisor (periodic transfer-market simulation).
- **The HTTP server** at `:8080` with all routes — Live, Leagues, Pyramid, Team, Market, Exhibition, Trades, Leaderboard.

### Starting the server

The recommended invocation (uses `setsid -f` to fully detach from the launching shell so a Ctrl-C in your terminal won't bring it down):

```bash
# Default: 1 league worker + 1 exhibition worker, 3 divisions per season
setsid -f env STREAM_WORKERS=3 EXHIBITION_WORKERS=1 STREAM_AUTO_SEASONS=1 \
       STREAM_AUTO_DIVS=3 node src/stream-server.js \
       > /tmp/mb-server.log 2>&1
```

Open http://localhost:8080 once the log shows `[server] http://localhost:8080` (boot takes ~5–8s while Xvfb + ffmpeg come up per worker).

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `STREAM_PORT` | `8080` | HTTP port |
| `STREAM_WORKERS` | `1` | League-fixture worker count. **Match this to `STREAM_AUTO_DIVS`** so each tier has its own worker (otherwise the supervisor only assigns the first N divisions). |
| `EXHIBITION_WORKERS` | `1` | Dedicated exhibition workers (off the league pool). Set `0` to disable the `/exhibition` page. |
| `STREAM_DISPLAY_BASE` | `99` | League workers start at `:100`, exhibition workers continue past them on `:N+1..`. |
| `STREAM_SIZE` | `640x480` | Per-worker capture resolution. Must match `engine/save/config.json`. |
| `STREAM_FPS` | `15` | MJPEG framerate. |
| `STREAM_AUTO_SEASONS` | unset | Set to `1` to auto-create the next season when no league is running. Off by default to keep `node src/stream-server.js` quiet on a dev box. |
| `STREAM_AUTO_DIVS` | `3` | Number of divisions per auto-created season. |
| `STREAM_AUTO_PER_DIV` | `20` | Teams per division. |
| `STREAM_AUTO_LEGS` | `2` | `1` = single round-robin (19 fixtures/team), `2` = home+away (38). |
| `STREAM_AUTO_PROMOTE_PER_TIER` | `3` | How many teams promote/relegate between seasons. |
| `BOT_MARKET_TICK_MS` | `300000` | Bot transfer-market tick cadence (ms). |
| `BOT_MARKET_DISABLED` | unset | Set to `1` to turn off bot trading entirely. |
| `SESSION_SECRET` | dev default | HMAC key for cookies — set this for any non-dev deployment. |

### Restarting safely

The server holds Xvfb children that can leak across restarts; the worker code now self-cleans, but a brutal `pkill -9` from outside can leave stale `/tmp/.X11-unix/X10*` sockets. Full clean-restart sequence:

```bash
# 1. kill everything tied to the engine
pkill -9 -f stream-server.js
pkill -9 -f Ikemen
pkill -9 -f bwrap
pkill -9 -f 'ffmpeg.*x11grab'
pkill -9 -f Xvfb        # may need running twice — Xvfb forks-and-reparents
sleep 2
pkill -9 -f Xvfb
sleep 2

# 2. wipe stale X11 sockets so the new Xvfbs can bind
rm -f /tmp/.X11-unix/X10[0-9]

# 3. confirm port is free + workers are gone
ss -tln | grep :8080 && echo STILL UP || echo "8080 free"
ps aux | awk '/Xvfb :10/ && !/awk/' | wc -l

# 4. fresh log + spawn (setsid -f detaches; nohup is also fine)
echo "MARKER $(date)" > /tmp/mb-server.log
setsid -f env STREAM_WORKERS=3 EXHIBITION_WORKERS=1 STREAM_AUTO_SEASONS=1 \
       STREAM_AUTO_DIVS=3 node src/stream-server.js \
       >> /tmp/mb-server.log 2>&1

# 5. wait + verify
sleep 8
ss -tln | grep :8080 && echo UP
grep -vE "WARNING.*SESSION_SECRET" /tmp/mb-server.log | tail -10
for d in 100 101 102 103; do xprop -display :$d -root >/dev/null 2>&1 \
  && echo "X$d OK" || echo "X$d DEAD"; done
```

### Pages

| Path | Content |
|---|---|
| `/` | Tier-tabbed live view — one tab per division. League N tabs render dynamically based on the running league's `division_count`. |
| `/leagues` | Multi-stream wall — every running division side-by-side. |
| `/pyramid` | Standings pyramid across all tiers. |
| `/team` | Your roster, lineup, rotation rules, team-notice center. |
| `/market` | Unclaimed fighter pool + user/bot listings + stage market. |
| `/exhibition` | One-off match between any two owned fighters. Records bump (W/L/D) but **not** stamina or league standings. |
| `/trades` | Live feed of recent market activity (buys, listing trades, releases). Polls every 8s. |
| `/leaderboard` | Sortable/searchable lifetime master record. |
| `/portrait/<name>.png` | Character portrait extracted from `.sff`. |
| `/api/workers` | JSON status for each league worker (status, fixture, division, last-error). |
| `/stream/<workerId>` | MJPEG broadcast for that worker (used by the Live page). |

## Portraits

Extract small portraits (sprite group 9000, image 0) from every character's `.sff` — handles SFF v1 and v2 (raw, RLE8, RLE5, LZ5, PNG formats):

```bash
.venv/bin/python3 scripts/extract_portraits.py          # skip already-done
.venv/bin/python3 scripts/extract_portraits.py --force  # re-extract
.venv/bin/python3 scripts/extract_portraits.py NAME1 NAME2   # specific chars
```

## Bulk import from MFFA

Pulls characters from [Mugen Free For All](https://mugenfreeforall.com) collection threads into `engine/chars/` and registers them. Handles multiple hosts: MediaFire, Mega.nz, Dropbox, Google Drive, OneDrive, `getuploader.com` (via Playwright to bypass Cloudflare).

```bash
# Grab one thread
.venv/bin/python3 scripts/grab_v3.py "https://mugenfreeforall.com/topic/47837-kirby/" /home/$USER/bulkgrab/kirby

# Grab a list of threads in sequence
nohup bash /home/$USER/bulkgrab/driver_v3.sh &

# Install the downloaded archives into engine/chars/ and register fighters
bash /home/$USER/bulkgrab/bulk_install.sh

# Deduplicate by display_name + author (stats merge into the primary)
.venv/bin/python3 scripts/dedupe_fighters.py            # dry run
.venv/bin/python3 scripts/dedupe_fighters.py --apply    # commit
```

## Sign-in (optional)

The streaming dashboard supports passwordless email sign-in via a 6-digit code. No password, no user database to manage — we just match a code against an email. Auth infrastructure is plumbed but nothing is gated behind it yet (future hooks: favorite fighters, voting, comments).

Setup:

```bash
cp .env.example .env
# fill in SESSION_SECRET (openssl rand -hex 32) + the four GMAIL_* vars
```

Dev mode (no Gmail creds): codes are printed to the server console. You can still sign in — just copy the code from the console into the dashboard modal.

Schema (added to `mugenbattle.db`):

```
user_account  (id, email UNIQUE, display_name, created_at)
auth_code     (id, email, code, expires_at, used, created_at)
```

Session: HMAC-signed stateless cookie (`mb_session`), 30-day TTL. Endpoints:

- `POST /api/auth/send-code` — `{ email }` → rate-limited (3/10min)
- `POST /api/auth/verify-code` — `{ email, code }` → sets `mb_session` cookie
- `POST /api/auth/logout` — clears cookie
- `GET /api/auth/me` — `{ authenticated, email, display_name }`

## League seasons

Auto-managed Premier-League-style seasons with promotion/relegation, prize money, a fixture queue, and a transfer market.

```
1 season = 1 league row
1 league = N divisions (tiers 1..N)
1 division = perDiv teams in a double round-robin
1 fixture = 1 owned-fighter-vs-owned-fighter best-of-3 match
```

**Lifecycle:**

1. With `STREAM_AUTO_SEASONS=1`, when no league is running, `autoCreateSeason` fires. It promotes/relegates teams from the most recent completed season, slots new real-user signups into the bottom division first, and tops up remaining gaps from the orphan-bot pool.
2. The supervisor assigns one **idle league worker** to one **division** each. Each worker loops through its division's pending fixtures via `runLeagueWorker` (in `src/leagueWorker.js`).
3. Standings are kept in `division_team` (`points`, `fixtures_won/drawn/lost`, `matches_won/lost`). Three-points-for-a-win, one for a draw.
4. Prize money is credited to the user's wallet on each fixture win.
5. On the last fixture, `maybeCompleteLeague` fires: marks the season `complete`, retires bot rosters back to the unclaimed pool, leaves the door open for the next season's `autoCreateSeason` call.

**Orphan-bot pick order** (when filling new-season gaps):

1. Bots that have **never played a fixture** come first.
2. Within each group, **highest user_id wins** (newest beats stale). So a hand-curated bot you just created gets prioritized over old recycling stock.

### Manual league commands

You can also create leagues by hand (skip auto-seasons mode):

```bash
node src/index.js league create --name "Spring Cup" --divisions 3 --per-div 20 --legs 2
node src/index.js league list
node src/index.js league show 1
```

## Teams + roster rules

Every signed-in user gets a team with up to 5 active + 5 bench + 1 for-sale fighters. Bots follow the same shape — anywhere `setLineup` runs, the 5-active invariant is enforced.

### Rotation rules

Configurable per team via `/team` page or `PUT /api/team/<id>/lineup`:

- `auto_rotate` (bool) — master switch
- `rotate_on_stamina` (bool) + `rotation_threshold` (0.0–1.0) — skip a fighter for the next fixture if their effective stamina is below the threshold
- `rotate_on_losses` (bool) + `rotation_loss_streak` (1–99) — skip after N consecutive losses

**Bots ignore these rules.** They use **strict sequential rotation** through their 5 active fighters: `(count of completed fixtures) % active.length`. Every fighter gets equal screen time regardless of stamina or loss streak. Stamina + loss-streak rules apply to human-owned teams only.

### Stamina

Each fixture costs the fielded fighter `0.20` stamina; teammates that didn't play recover `0.25` (capped at 1.0). Effective stamina is read at fixture-time, scales the in-engine `-p1.life`/`-p2.life` arg (so tired fighters fight at reduced HP). Exhibition matches **do not** affect stamina.

### Auto-replenish

A team that drops below 5 active gets topped up from the oldest unclaimed master pool (with KFM as last-ditch padding). A `team_notice` row is written so the user sees a banner on `/team`. Boot-time sweep + bot-market sweep both call `topUpRoster`.

## Bot ecosystem

Bots fill league slots so seasons can run regardless of human signup count. They behave the same as users from the runner's POV (they're just `user_account.is_bot = 1` rows with teams) but get extra automated behaviors.

### Bot market simulation

Every `BOT_MARKET_TICK_MS` (default 5 min), a small fraction of bots (`ACT_PROBABILITY = 0.15`) act:

1. **Sell** their weakest active fighter (fitness < 0.30 + has played ≥5 matches) at 90% of `priceFor()`.
2. **Buy** the best market candidate that's at least `0.10` fitter than their current weakest active, within 50% of their cash.
3. **Release** the worst bench fighter to free a slot if the buy needs space.
4. **Rebalance** active vs bench by fitness — top-5 are active, rest bench. Includes a novelty bonus so freshly-signed fighters get rotation time.

Fitness formula: `0.6 * master_win_rate + 0.4 * owned_win_rate + 0.10 * log10(1 + total_matches) + novelty_bonus`. Novelty: `+0.20` for 0-match, `+0.10` for <5-match — applied to both rebalance and market-pick decisions so untested fighters can compete with veterans.

Releases and buys both surface in `/trades`.

### Pre-built bots

70 generic bots (`bot_001` … `bot_069`) plus three hand-curated ones:

- `sailor_bot` (Sailor Senshi) — 5 Blaze102 Sailor Moon characters
- `bot_dbz` (Team HDBZ) — 5 Z2 Hyper DBZ chars (Krillin, Gohan, Piccolo, 18, Vegeta)
- `bot_dbz_wild` (DBZ Wild Card) — 5 non-Z2 DBZ-themed characters

## Exhibition matches

`/exhibition` lets any signed-in user run a one-off match between any two owned fighters (yours or another team's, including bot teams). Random stage by default. Records update on both fighters (W/L/D + master records), but **stamina and league standings are not affected** — safe to test team compositions.

Runs on the dedicated exhibition worker, never preempts league fixtures.

## Trades feed

`/trades` shows recent market activity (newest first), polled every 8s, with a brief green flash for new entries:

- **Buys from the unclaimed pool** — `@user bought X from the unclaimed pool · $price`
- **Listing trades** — `@buyer bought X ← @seller · $price`
- **Releases** — `@user released X back to the unclaimed pool` (no price)

Backed by `wallet_ledger` entries (every monetary movement) plus a `release` reason marker — no separate event table.

## Character imports

User-uploaded characters go through `/api/import/char` which runs the full pipeline:

1. Extract → safety scan (denylist + ClamAV + zip-bomb caps)
2. Locate `<charName>/<charName>.def`, validate static deps (sprite/cmd/cns existence, malformed VarSet check)
3. Run a sandbox test match in bwrap (matched against KFM)
4. On pass, copy to `engine/chars/<name>/`, insert `fighter` row with `imported_by_user_id`

CLI equivalent:

```bash
node src/index.js import -u <username> /path/to/char.zip

# Bulk: rename a master in DB + propagate to default-named clones + rewrite .def
node src/index.js rename-master old_filename "New Display Name"
```

Caps (in `src/charImport.js`):

- `MAX_ZIP_BYTES` 250 MB compressed
- `MAX_EXTRACTED_BYTES` 500 MB total
- `MAX_FILE_BYTES` 128 MB per-file (HD char `.snd` files often hit 100 MB+)

## Operations playbook

### Server keeps falling over

If `pkill -9 -f stream-server.js` from outside the server skips the cleanup that happens on graceful shutdown, leftover Xvfbs reparent to your session daemon and stale sockets remain in `/tmp/.X11-unix/`. The next startup may report `[worker N] up` but Ikemen subsequently fails with `Failed to open display :NN`.

**Fix:** run the full clean-restart sequence above (`pkill` everything → `rm /tmp/.X11-unix/X10[0-9]` → spawn fresh). The worker code's `_startXvfb` self-cleans the stale socket before each spawn, but only for displays it claims.

### Match storms (every fixture finishing 0-0)

Symptom: dozens of fixtures completing as draws in seconds, KFM master draws ballooning, masters auto-deactivating with `repeated_crash`.

**Cause:** an environmental failure (Xvfb died, GLFW couldn't init, OOM, disk full) makes every fixture catch-branch synthesize a draw and bump both chars' `crash_suspect_count`. After 3 such hits per char, `deactivateMaster` fires and replaces the clone with KFM across every team that owned it.

**Mitigations already in place:**

- `runMatch.sh` binds a writable per-match `Ikemen.log` (so the engine doesn't hit ROFS).
- `streamWorker.js` probes Xvfb readiness with `xprop`, not just socket existence.
- `leagues.js` catch-branch detects environmental error patterns (`Failed to open display`, `GLFW`, `panic: NotInitialized`, `read-only file system`) and skips `chargeCrashSuspects` — chars don't get blamed.

**Recovery if it ever happens again** (worked-example from a real incident):

```bash
# 1. take server down (see "Restarting safely" above)
# 2. find masters wrongly deactivated by the storm window
sqlite3 mugenbattle.db "SELECT id FROM fighter WHERE active=0 AND validation_reason LIKE 'repeated_crash%' AND validated_at >= '<storm-start-iso>'"
# 3. reactivate, un-retire their owned_fighter rows, retire the KFM stubs that took their slot
# 4. roll back inflated draws by deleting fixture_match for the bogus fixtures and decrementing matches_drawn on the 4 referenced rows (2 owned + 2 master)
# 5. reset bogus fixtures to 'pending'
```

(See git history for the actual one-shot Node script that does all five steps in a transaction — keep it around in case.)

### Stuck Ikemen (worker shows live but black stream)

Some characters or stages cause Ikemen to hang on a load screen — process alive, 0% CPU, never progresses. Detection:

```bash
# CPU% per Ikemen — a stuck one is at 0.0%
top -b -n 2 -p $(pgrep -d, -f "^./Ikemen_GO_Linux") | tail -10
```

The 600s `execFile` timeout on the runner will eventually kill it; the catch branch will mark the fixture a draw and move on. After three such hangs, the suspected master gets deactivated. To recover faster, kill the hung process by hand: `kill -9 <pid>`.

### Bot teams growing past 5 active

Used to happen when `seedBots` called `insertStarterRoster` (always inserts 5) on teams short by 1, ballooning to 9+ across repeated season transitions. Fixed: it now calls `topUpRoster` (caps at 5). If you see this on a fresh DB, run:

```bash
# Trim every bot team back to 5 active + 5 bench + retire the rest
node --input-type=module -e "
import { getDb } from './src/db.js';
const db = getDb();
// ... see git history for the exact script
"
```

## Writing AI for passive characters

Many MUGEN chars ship with no custom AI and just stand around. To add an aggressive AI pattern, append `[State -1]` blocks to the char's `.cmd` file with `triggerall = AILevel > 0` and priority-ordered ChangeState triggers based on `P2BodyDist X`, `P2StateType`, `Power`, etc.

Pattern examples live in `engine/chars/King_Dedede_v2/dedede.cmd`, `engine/chars/KingKonga/kong.cmd`, `engine/chars/SpaceGodzillaNES/`, and `engine/chars/Godzilla2019/` (all written by Claude — see the `; AI —` comment blocks).

## Project structure

```
src/
  index.js         - CLI entry (Commander.js)
  db.js            - SQLite + migrations runner (sql files in src/migrations/)
  migrations/      - Numbered SQL files, applied in order at boot
  match.js         - Ikemen GO / MUGEN launcher + result parser; runOwnedFighterMatch + applyMatchOutcome
  matchStaging.js  - Per-match staged char dirs (with AI overrides, stamina-scaled life)
  tournament.js    - Single-match fighter/stage picker, stat recording (legacy)
  brackets.js      - Bracket tournament engine (legacy CLI tournament)
  validator.js     - Pre-flight char dependency check (handles \\ in def paths)
  charImport.js    - Char ZIP upload pipeline (extract, scan, sandbox-test, install)
  stream-server.js - HTTP dashboard + worker-pool boot + supervisors
  streamWorker.js  - Per-worker class: Xvfb + ffmpeg + assignLeague/assignExhibition
  leagueWorker.js  - Pulls pending fixtures for a division and runs them
  leagues.js       - Season creation, promotion/relegation, getLiveTierView, fixture queue
  teams.js         - Roster mgmt, lineup rules, pickActiveFighter, topUpRoster
  market.js        - priceFor, buyUnclaimedMaster, listForSale, buyListedFighter, releaseOwnedFighter
  bots.js          - seedBots (creates bot user_accounts + teams), retireAllBotRosters
  botMarket.js     - tickBotMarket: per-tick sell/buy/release/rebalance per bot
  exhibition.js    - User-requested ad-hoc match queue + runner
  follow.js        - Polymorphic follow (master / team)
  auth.js          - Passwordless email sign-in (code via Gmail OAuth2)
scripts/
  extract_portraits.py - SFF v1/v2 portrait extractor (→ engine/chars/<n>/portrait.png)
  fix_missing_bgm.py   - Comment out broken bgmusic = refs in stage .def files (Ikemen hangs on missing audio)
  grab_v3.py           - MFFA thread scraper + multi-host downloader
  dedupe_fighters.py   - Merge duplicate fighter rows by display_name + author
engine/              - Ikemen GO install (Linux, gitignored)
mugen/               - MUGEN install (Windows, gitignored)
runMatch.sh          - bwrap-sandboxed Ikemen GO invocation (Linux)
runMugenTourney.bat  - MUGEN invocation (Windows)
test/                - Node:test suites (run with npm test)
old/                 - Original Node.js + C# reference code
mugenbattle.db       - SQLite database (gitignored)
```

## Tests

```bash
npm test       # node:test on test/*.test.mjs (in-memory DB + fake match driver)
```

Fast — the suite uses `MB_DB_PATH=:memory:` and `MB_MATCH_MODE=fake` so it deterministically simulates matches without spawning Ikemen.

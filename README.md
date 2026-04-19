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
sudo pacman -S xorg-server-xvfb ffmpeg xdotool wmctrl

# For the user character-upload pipeline (required — the importer refuses
# to run without a working clamscan on PATH):
sudo pacman -S clamav
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

`src/stream-server.js` spawns a headless Xvfb display (`:99`), an `ffmpeg` MJPEG encoder, and a tiny HTTP server. Matches run entirely off-screen; you watch them in a browser.

```bash
# Start the dashboard (terminal 1)
node src/stream-server.js

# Run matches with DISPLAY=:99 so they render on the virtual display (terminal 2)
DISPLAY=:99 node src/index.js tournament start --size 16
```

Dashboard at http://localhost:8080:

- **`/`** — live video + match info + bracket + top-15 leaderboard + recent matches
- **`/leaderboard`** — sortable/searchable full fighter list
- Click any fighter name (leaderboard row, match info, bracket, recent matches) → profile modal with stats, portrait, author, source URL, recent fights
- **`/portrait/<name>.png`** — character portrait extracted from their `.sff`

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

## Writing AI for passive characters

Many MUGEN chars ship with no custom AI and just stand around. To add an aggressive AI pattern, append `[State -1]` blocks to the char's `.cmd` file with `triggerall = AILevel > 0` and priority-ordered ChangeState triggers based on `P2BodyDist X`, `P2StateType`, `Power`, etc.

Pattern examples live in `engine/chars/King_Dedede_v2/dedede.cmd`, `engine/chars/KingKonga/kong.cmd`, `engine/chars/SpaceGodzillaNES/`, and `engine/chars/Godzilla2019/` (all written by Claude — see the `; AI —` comment blocks).

## Project structure

```
src/
  index.js         - CLI entry (Commander.js)
  db.js            - SQLite schema + migrations
  match.js         - Ikemen GO / MUGEN launcher + result parser
  tournament.js    - Single-match fighter/stage picker, stat recording, backfill
  brackets.js      - Bracket tournament engine (create/run/resume/show)
  validator.js     - Pre-flight char dependency check
  stream-server.js - Headless Xvfb + ffmpeg + HTTP dashboard
  auth.js          - Passwordless email sign-in (code via Gmail OAuth2)
scripts/
  extract_portraits.py - SFF v1/v2 portrait extractor (→ engine/chars/<n>/portrait.png)
  grab_v3.py           - MFFA thread scraper + multi-host downloader
  dedupe_fighters.py   - Merge duplicate fighter rows by display_name + author
engine/              - Ikemen GO install (Linux, gitignored)
mugen/               - MUGEN install (Windows, gitignored)
runMatch.sh          - Ikemen GO invocation (Linux)
runMugenTourney.bat  - MUGEN invocation (Windows)
old/                 - Original Node.js + C# reference code
mugenbattle.db       - SQLite database (gitignored)
```

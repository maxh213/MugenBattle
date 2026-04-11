# MugenBattle

Automated AI fighting tournament runner with stat tracking.

Randomly pits AI-controlled fighters against each other, records match results to a local SQLite database, and tracks win/loss/draw stats over time.

Works cross-platform: **Ikemen GO** on Linux / **MUGEN** on Windows.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)

### Linux (Arch)

Install [Ikemen GO](https://github.com/ikemen-engine/Ikemen-GO) and place/symlink it in an `engine/` directory at the project root:

```bash
# Install from AUR (e.g. with yay)
yay -S ikemen-go

# Or download a release from GitHub and extract it
mkdir engine
cd engine
# extract Ikemen_GO binary + data here
```

The `engine/` directory should contain the `Ikemen_GO` binary and its default data files. Place your characters in `engine/chars/` and stages in `engine/stages/`.

### Windows

Install [MUGEN](https://mugen.fandom.com/) in a `mugen/` directory at the project root.

## Setup

```bash
npm install
```

## Usage

### Manage fighters and stages

Add fighters and stages using their character/stage folder names:

```bash
node src/index.js fighters add android18
node src/index.js fighters add buu
node src/index.js stages add bamboo
node src/index.js stages add cats_on_the_roof
```

List them:

```bash
node src/index.js fighters list
node src/index.js stages list
```

Remove them:

```bash
node src/index.js fighters remove android18
```

### Run matches

```bash
# Run a single random match
node src/index.js run

# Run 10 matches in a row
node src/index.js run --count 10
```

### View results

```bash
# Fighter leaderboard
node src/index.js stats

# Recent fight history
node src/index.js history
node src/index.js history --limit 50
```

## Project Structure

```
src/
  index.js        - CLI entry point (Commander.js)
  db.js           - SQLite database setup and schema
  match.js        - Match launcher and result parser (cross-platform)
  tournament.js   - Fighter/stage selection and stat recording
runMatch.sh         - Shell script that launches Ikemen GO (Linux)
runMugenTourney.bat - Batch file that launches MUGEN (Windows)
engine/             - Ikemen GO install (Linux, gitignored)
mugen/              - MUGEN install (Windows, gitignored)
old/                - Original Node.js and C# code for reference
```

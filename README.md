# MugenBattle

Automated MUGEN AI fighting tournament runner with stat tracking.

Randomly pits AI-controlled fighters against each other, records match results to a local SQLite database, and tracks win/loss/draw stats over time.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [MUGEN](https://mugen.fandom.com/) engine installed in a `mugen/` directory at the project root
- Windows (MUGEN runs via batch file)

## Setup

```bash
npm install
```

## Usage

### Manage fighters and stages

Add fighters and stages using their MUGEN folder names:

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
  match.js        - MUGEN process launcher and result parser
  tournament.js   - Fighter/stage selection and stat recording
runMugenTourney.bat - Batch file that launches MUGEN
old/              - Original Node.js and C# code for reference
```

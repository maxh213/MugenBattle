#!/usr/bin/env python3
"""
Comment out `bgmusic = <path>` lines in stage .def files where the referenced
audio file doesn't exist. Why: Ikemen attempts to load the bgm at stage init
even with `-nosound`; when the file is missing, the engine hangs partway
through round setup and the match never completes (resulting in 0-0 fixtures
across the league). Stripping these refs lets Ikemen skip the bgm cleanly.

Idempotent: only acts on uncommented bgmusic lines whose target file is
missing on disk. Run from repo root.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STAGES_DIR = ROOT / "engine" / "stages"
ENGINE = ROOT / "engine"


def resolve_bgm_path(rel: str) -> Path:
    rel = rel.strip().strip('"').strip("'")
    if not rel:
        return None
    return (ENGINE / rel).resolve()


def fix_def(path: Path) -> int:
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return 0
    new_lines = []
    changed = 0
    for line in content.splitlines(keepends=True):
        stripped = line.lstrip()
        # Only act on bgmusic = ... lines that aren't already commented.
        m = re.match(r"^(\s*)(bgmusic|musicalt|music)\s*=\s*(.+?)\s*$", stripped, re.IGNORECASE)
        if m and not stripped.startswith(";"):
            indent, key, val = m.group(1), m.group(2), m.group(3)
            # Strip trailing comments from val
            val_clean = re.split(r"\s*;", val, maxsplit=1)[0].strip()
            if val_clean:
                resolved = resolve_bgm_path(val_clean)
                if resolved is not None and not resolved.exists():
                    # Preserve original line as a commented backup
                    eol = line[len(line.rstrip("\r\n")):]
                    new_lines.append(f";{line.rstrip(eol or chr(10))}  ; mb: missing file{eol or chr(10)}")
                    changed += 1
                    continue
        new_lines.append(line)
    if changed:
        path.write_text("".join(new_lines), encoding="utf-8")
    return changed


def main():
    if not STAGES_DIR.is_dir():
        print(f"stages dir not found: {STAGES_DIR}", file=sys.stderr)
        sys.exit(1)
    total_files = 0
    total_lines = 0
    for def_path in sorted(STAGES_DIR.glob("*.def")):
        n = fix_def(def_path)
        if n:
            total_files += 1
            total_lines += n
            print(f"  {def_path.name}: {n} bgm line(s) commented")
    print()
    print(f"Patched {total_lines} bgm line(s) across {total_files} stage def(s).")


if __name__ == "__main__":
    main()

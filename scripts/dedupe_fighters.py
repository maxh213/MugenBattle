#!/usr/bin/env python3
"""
Deactivate duplicate fighters. Two rows are considered duplicates when they
share display_name AND author (case-insensitive). For each group:
  - Pick the primary: prefer file_name without `_v2` suffix, then most matches,
    then shortest file_name.
  - Transfer the primary's total match count to include all dupes' wins/losses
    so we don't lose history.
  - Deactivate the non-primary rows with validation_reason='duplicate_of:<id>'.

Dry-run by default; pass --apply to actually write changes.
"""

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / 'mugenbattle.db'

def pick_primary(rows):
    def score(r):
        # Lower is better.
        v2_suffix = r['file_name'].endswith('_v2') or '_v2_' in r['file_name']
        total = r['matches_won'] + r['matches_lost'] + r['matches_drawn']
        return (
            1 if v2_suffix else 0,       # prefer non-_v2
            -total,                        # prefer most matches (sort ascending so negate)
            len(r['file_name']),          # prefer shorter name
            r['id'],                       # stable tiebreaker
        )
    rows_sorted = sorted(rows, key=score)
    return rows_sorted[0]

def main():
    apply = '--apply' in sys.argv
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    rows = list(cur.execute('SELECT * FROM fighter WHERE active = 1'))
    groups = {}
    for r in rows:
        dn = (r['display_name'] or r['file_name']).lower().strip()
        au = (r['author'] or '').lower().strip()
        groups.setdefault((dn, au), []).append(r)

    dupe_groups = {k: v for k, v in groups.items() if len(v) > 1}
    print(f'active fighters: {len(rows)}')
    print(f'dupe groups: {len(dupe_groups)}')
    total_dupes = sum(len(v) - 1 for v in dupe_groups.values())
    print(f'rows that would be deactivated: {total_dupes}')
    print(f'fighters after dedup: {len(rows) - total_dupes}')

    if not apply:
        print('\n(dry run — pass --apply to write)')
        return

    with conn:
        for group, rs in dupe_groups.items():
            primary = pick_primary(rs)
            others = [r for r in rs if r['id'] != primary['id']]
            # Transfer stats to primary
            won = sum(r['matches_won'] for r in others)
            lost = sum(r['matches_lost'] for r in others)
            drawn = sum(r['matches_drawn'] for r in others)
            if won or lost or drawn:
                conn.execute(
                    'UPDATE fighter SET matches_won = matches_won + ?, '
                    'matches_lost = matches_lost + ?, matches_drawn = matches_drawn + ? '
                    'WHERE id = ?',
                    (won, lost, drawn, primary['id'])
                )
            for r in others:
                conn.execute(
                    'UPDATE fighter SET active = 0, '
                    'validation_reason = ? WHERE id = ?',
                    (f'duplicate_of:{primary["id"]}', r['id'])
                )
    print('applied.')


if __name__ == '__main__':
    main()

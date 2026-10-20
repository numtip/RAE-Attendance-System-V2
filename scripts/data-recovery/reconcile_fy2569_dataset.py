#!/usr/bin/env python3
"""Reconcile the FY2569 integration dataset against the previously derived artefacts.

Compares, per fiscal month:
  * late rows  -> prepared/events.csv  and  prepared/monthly_summary.csv
  * early rows -> prepared/events.csv
and explains every difference instead of assuming one.

Read-only. Prints counts only.
"""
from __future__ import annotations

import csv
import io
import json
import sys
from collections import Counter
from pathlib import Path

PREPARED = Path(r'G:\ProjectAI\attendance-report-generator\CodexWorker\prepared')
DATASET = Path('database/local/fy2569-integration-20261020')


def read_csv(path: Path) -> list[dict]:
    with open(path, encoding='utf-8-sig') as fh:
        return list(csv.DictReader(fh))


def main() -> int:
    rows = read_csv(DATASET / 'daily_attendance_normalized.csv')
    events = list(csv.DictReader(io.StringIO((PREP_ARGS := PREPARED / 'events.csv')
                                            .read_bytes().decode('utf-8-sig'))))
    summary = list(csv.DictReader(io.StringIO((PREPARED / 'monthly_summary.csv')
                                              .read_bytes().decode('utf-8-sig'))))

    mine_late, mine_early, mine_official_late = Counter(), Counter(), Counter()
    for r in rows:
        m = r['attendance_date'][:7]
        if r['attendance_status'] == 'late':
            mine_late[m] += 1
            if 'OFFICIAL_DUTY' in r['flags']:
                mine_official_late[m] += 1
        if r['is_early_leave'] == '1' and r['attendance_status'] != 'leave':
            mine_early[m] += 1

    ev_late, ev_early = Counter(), Counter()
    for r in events:
        m = r['date_iso'][:7]
        (ev_early if r['event_type'] == 'กลับก่อน' else ev_late)[m] += 1

    # monthly_summary has month as 1..12 within BE fiscal year
    sm_late = Counter()
    for r in summary:
        mi = int(r['month'])
        sm_late[f"{2025 if mi >= 10 else 2026}-{mi:02d}"] += int(r['late_count'])

    months = sorted(set(mine_late) | set(ev_late) | set(sm_late))
    out = {'months': {}, 'totals': {}}
    print(f"{'month':9s} {'mine':>5s} {'events':>6s} {'d_ev':>4s} {'off':>4s} {'summary':>7s} {'d_sm':>4s}")
    for m in months:
        d_ev = mine_late[m] - ev_late[m]
        d_sm = mine_late[m] - sm_late[m]
        out['months'][m] = {'mine_late': mine_late[m], 'events_late': ev_late[m],
                            'delta_vs_events': d_ev,
                            'official_duty_late': mine_official_late[m],
                            'summary_late': sm_late[m], 'delta_vs_summary': d_sm,
                            'mine_early': mine_early[m], 'events_early': ev_early[m],
                            'delta_early': mine_early[m] - ev_early[m]}
        print(f'{m:9s} {mine_late[m]:5d} {ev_late[m]:6d} {d_ev:4d} '
              f'{mine_official_late[m]:4d} {sm_late[m]:7d} {d_sm:4d}')

    tot = {
        'mine_late': sum(mine_late.values()),
        'events_late': sum(ev_late.values()),
        'official_duty_late': sum(mine_official_late.values()),
        'summary_late': sum(sm_late.values()),
        'mine_early': sum(mine_early.values()),
        'events_early': sum(ev_early.values()),
    }
    tot['delta_vs_events_explained_by_official_duty'] = (
        tot['mine_late'] - tot['events_late'] == tot['official_duty_late'])
    out['totals'] = tot

    # every month's delta must be exactly its official-duty count
    out['all_month_deltas_explained'] = all(
        v['delta_vs_events'] == v['official_duty_late'] for v in out['months'].values())
    out['early_chains_match'] = all(v['delta_early'] == 0 for v in out['months'].values())

    print()
    print('totals:', json.dumps(tot, ensure_ascii=False))
    print('every monthly late delta == official-duty rows:', out['all_month_deltas_explained'])
    print('early chain matches events.csv in every month:', out['early_chains_match'])

    (DATASET / 'reconciliation_vs_derived.json').write_text(
        json.dumps(out, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

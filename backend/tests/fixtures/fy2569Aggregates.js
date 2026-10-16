/**
 * FY2569 (Thai government fiscal year: 1 Oct 2025 - 30 Sep 2026) attendance aggregates.
 *
 * PUBLIC-SAFE, TEST-ONLY EVIDENCE -- AGGREGATE COUNTS ONLY.
 *
 * This file is the R-04-C artefact. It exists so the reconciliation slice can be exercised against a real,
 * externally produced FY2569 result without importing a single personal value. It deliberately contains:
 *
 *   - the 12 monthly count totals (late / early / half-day leave / needs-review),
 *   - their fiscal-year totals,
 *   - the discrepancy classification as THREE COUNTS (accepted / half-day-reclassified / single-scan),
 *   - a provenance record.
 *
 * It deliberately does NOT contain, and must never contain: employee codes, names, national ids, emails,
 * per-person rows or raw attendance records. The 26 documented person-month discrepancies are recorded ONLY
 * as the three group counts plus their total -- never as code+month pairs, because a 4-digit employee code
 * is an employee code even without a name next to it.
 *
 * TRANSCRIBED, NOT INTEGRATED. These numbers were copied by hand from the prepared README of a sibling
 * PRIVATE repository (`numtip/Attendance-Report`). No V2 code reads that repository at runtime, no external
 * source was integrated, and reconciliation still reports `realSourceVerified: false`. Transcription is not
 * verification: nothing here is checked against the original HIP/MJU source data.
 *
 * Everything below is held as LITERAL transcribed values. The Gregorian months are typed independently of
 * `fiscalYearPeriod` so that the guard test can cross-check them against the real period helper instead of
 * comparing the helper to itself. `backend/tests/reconciliationFiscalEvidence.test.js` enforces both the
 * arithmetic self-consistency and the PII-free contract; it reads nothing from disk beyond this module.
 */

/** Buddhist-Era fiscal year this evidence covers. */
const FISCAL_YEAR = 2569;

/**
 * One record per fiscal month, in fiscal order (Oct..Sep) with `monthIndex` 1..12.
 * `fiscalMonth` is the Thai labelling (BE `YYYY-MM`); `gregorianMonth` is the same month in CE `YYYY-MM`.
 */
const monthlyAggregates = Object.freeze([
  { monthIndex: 1, fiscalMonth: '2568-10', gregorianMonth: '2025-10', late: 144, early: 4, halfDayLeave: 1, needsReview: 4 },
  { monthIndex: 2, fiscalMonth: '2568-11', gregorianMonth: '2025-11', late: 125, early: 3, halfDayLeave: 0, needsReview: 0 },
  { monthIndex: 3, fiscalMonth: '2568-12', gregorianMonth: '2025-12', late: 148, early: 3, halfDayLeave: 1, needsReview: 0 },
  { monthIndex: 4, fiscalMonth: '2569-01', gregorianMonth: '2026-01', late: 165, early: 0, halfDayLeave: 1, needsReview: 0 },
  { monthIndex: 5, fiscalMonth: '2569-02', gregorianMonth: '2026-02', late: 141, early: 2, halfDayLeave: 1, needsReview: 1 },
  { monthIndex: 6, fiscalMonth: '2569-03', gregorianMonth: '2026-03', late: 157, early: 0, halfDayLeave: 2, needsReview: 0 },
  { monthIndex: 7, fiscalMonth: '2569-04', gregorianMonth: '2026-04', late: 128, early: 0, halfDayLeave: 1, needsReview: 0 },
  { monthIndex: 8, fiscalMonth: '2569-05', gregorianMonth: '2026-05', late: 128, early: 0, halfDayLeave: 1, needsReview: 0 },
  { monthIndex: 9, fiscalMonth: '2569-06', gregorianMonth: '2026-06', late: 105, early: 1, halfDayLeave: 2, needsReview: 0 },
  { monthIndex: 10, fiscalMonth: '2569-07', gregorianMonth: '2026-07', late: 131, early: 4, halfDayLeave: 0, needsReview: 0 },
  { monthIndex: 11, fiscalMonth: '2569-08', gregorianMonth: '2026-08', late: 117, early: 3, halfDayLeave: 1, needsReview: 0 },
  { monthIndex: 12, fiscalMonth: '2569-09', gregorianMonth: '2026-09', late: 111, early: 4, halfDayLeave: 0, needsReview: 3 },
]);

/** The transcribed fiscal-year totals, held independently of the monthly records on purpose. */
const totals = Object.freeze({
  late: 1600,
  early: 24,
  halfDayLeave: 11,
  needsReview: 8,
});

/**
 * The 26 documented person-month discrepancies between the HIP source and the monthly report, represented
 * ONLY as three classification counts and their total. `populationCodes` is the number of employee codes the
 * evidence covers (a count, never a roster).
 */
const discrepancyClassification = Object.freeze({
  accepted: 12,
  halfDayReclassified: 9,
  singleScanAttributed: 5,
  total: 26,
  populationCodes: 53,
});

/** Where the numbers came from, and what kind of evidence they are. */
const provenance = Object.freeze({
  source: 'numtip/Attendance-Report (sibling PRIVATE repository; local directory attendance-report-generator)',
  file: 'CodexWorker/prepared/README.md',
  transcribedOn: '2026-10-16',
  note: 'TRANSCRIBED EVIDENCE, not a live integration: these aggregate counts were copied from the sibling '
    + 'private repository\'s prepared README. No V2 code reads that repository at runtime, so this snapshot '
    + 'still does NOT verify the original HIP/MJU source data.',
});

module.exports = {
  FISCAL_YEAR,
  monthlyAggregates,
  totals,
  discrepancyClassification,
  provenance,
};

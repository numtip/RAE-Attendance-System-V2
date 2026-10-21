#!/usr/bin/env node
/**
 * Reconcile the owner-approved 2027 roster against the previous 54-code employee master.
 *
 *   node scripts/data-onboarding/reconcile-roster-2027.mjs \
 *     --roster database/roster_rae2027.csv \
 *     --master database/local/fy2569-integration-20261020/employee_master_integration.csv \
 *     [--out database/local/f4-20261021/roster-reconciliation.json] [--json]
 *
 * Guarantees
 *   * Read-only against both inputs; neither is rewritten. Hashes are printed so the run can be identified.
 *   * stdout is safe to paste into a PR: counts and reason histograms only. No name, email or national ID is
 *     ever printed, and `assertNoPersonalData` enforces it before the summary is emitted.
 *   * The per-code detail (which code is missing, which row changed) is written ONLY under `database/local/`,
 *     which is gitignored, and only from an explicit `--out` path that passes `assertLocalOutputPath`.
 *   * This tool does not allocate a UID, does not write to a database and does not decide a gate. It reconciles.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCsvBuffer, parseCsv } from './csvText.mjs';
import { assessImportReadiness, summarizeReadiness } from '../../backend/src/domain/employeeMasterImportGuards.js';
import {
  normalizeRosterRow,
  normalizeMasterRow,
  reconcileRoster,
  summarize,
  assertNoPersonalData,
  resolveLocalOutputPath,
  EMPLOYEE_TYPES,
} from './rosterReconciliation.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEFAULT_OUT = 'database/local/f4-20261021/roster-reconciliation.json';
const FLAGS = new Set(['json', 'help']);

export function parseArgs(argv) {
  const args = { flags: new Set(), out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (FLAGS.has(name)) {
      args.flags.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    args[name] = value;
    i += 1;
  }
  return args;
}

async function readRecords(path) {
  const buffer = await readFile(path);
  const rows = parseCsv(decodeCsvBuffer(buffer));
  if (rows.length === 0) return { header: [], records: [], sha256: '' };
  const [header, ...data] = rows;
  const keys = header.map((h) => h.trim());
  const records = data.map((row) => Object.fromEntries(keys.map((key, index) => [key, row[index] ?? ''])));
  return {
    header: keys,
    records,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

function assertRosterHeader(header) {
  const required = ['ID HIP', 'name', 'c_name', 'ID card', 'email', 'employee type'];
  const missing = required.filter((column) => !header.includes(column));
  if (missing.length > 0) throw new Error(`roster is missing required column(s): ${missing.join(', ')}`);
}

function assertMasterHeader(header) {
  const hasCode = header.includes('report_code') || header.includes('device_code');
  if (!hasCode) throw new Error('master needs a report_code or device_code column');
  if (!header.includes('full_name_th')) throw new Error('master needs a full_name_th column');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('help') || !args.roster || !args.master) {
    console.log('usage: reconcile-roster-2027.mjs --roster <csv> --master <csv> [--out <database/local/**.json>] [--json]');
    if (args.flags.has('help')) return 0;
    return 2;
  }
  // Resolved against the repository root, so running the CLI from another directory cannot write the detail
  // outside the gitignored tree.
  const out = resolveLocalOutputPath(REPO_ROOT, args.out);

  const roster = await readRecords(args.roster);
  const master = await readRecords(args.master);
  assertRosterHeader(roster.header);
  assertMasterHeader(master.header);

  const rosterRows = roster.records.map((record, index) => normalizeRosterRow(record, index + 2));
  const masterRows = master.records.map((record) => normalizeMasterRow(record));
  const unknownTypeRows = rosterRows.filter((row) => !EMPLOYEE_TYPES.includes(row.employeeType)).length;

  const reconciliation = reconcileRoster({ rosterRows, masterRows });
  const summary = summarize(reconciliation);

  // Gate status computed from the evidence, not asserted in prose. Effective dates are never supplied to this
  // tool, so F5 blocks every row by construction — which is the honest answer (D-2026-10-20-03).
  const rosterByCode = new Map(rosterRows.map((row) => [row.code, row]));
  const masterByCode = new Map(masterRows.filter((row) => row.code).map((row) => [row.code, row]));
  const verdicts = [];
  for (const [code, masterRow] of masterByCode.entries()) {
    const rosterRow = rosterByCode.get(code);
    verdicts.push(assessImportReadiness({
      email: rosterRow?.email,
      firstNameTh: rosterRow?.nameTh,
      lastNameTh: rosterRow?.cNameTh,
      employeeType: rosterRow?.employeeType,
      employeeCode: masterRow.employeeCode,
      deviceCode: masterRow.deviceCode,
    }));
  }
  const readiness = summarizeReadiness(verdicts);
  const gateReport = {
    ...readiness,
    f9_national_id_path: 'UNAPPROVED_GLOBAL_GATE',
    f4_uid_policy: 'RESOLVED_ADR-012',
    r_f4a_schema_check: 'PROPOSED_NOT_APPLIED',
  };
  summary.readiness = gateReport;
  assertNoPersonalData(summary);

  const detail = {
    generated_at: new Date().toISOString(),
    tool: 'scripts/data-onboarding/reconcile-roster-2027.mjs',
    inputs: {
      roster: { sha256: roster.sha256, rows: rosterRows.length },
      master: { sha256: master.sha256, rows: masterRows.length },
    },
    summary,
    matched_codes: reconciliation.matched.map((m) => m.code),
    missing_codes: reconciliation.missing.map((m) => m.code),
    extra_codes: reconciliation.extra.map((m) => m.code),
    unkeyable_master_rows: reconciliation.unkeyable,
    conflicts: reconciliation.conflicts,
    preservation_note: reconciliation.preservationNote,
  };
  // The whole detail artefact is checked, not just the summary: it is the file that leaves the process, and a
  // national ID or email appearing anywhere in it is a leak even though the code lists are internal.
  assertNoPersonalData(detail);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(detail, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  if (args.flags.has('json')) {
    console.log(JSON.stringify({ ...summary, inputs: { roster: roster.sha256, master: master.sha256 }, detail_written: out }, null, 2));
    return 0;
  }

  const { counts } = summary;
  const attendance = summary.missing.attendance_evidence_available
    ? String(summary.missing.with_attendance_evidence)
    : 'UNKNOWN (source has no attendance columns)';
  console.log(`roster  ${args.roster}  rows=${counts.roster_rows}  sha256=${roster.sha256.slice(0, 16)}`);
  console.log(`master  ${args.master}  rows=${counts.master_rows}  codes=${counts.master_codes}  sha256=${master.sha256.slice(0, 16)}`);
  console.log('');
  console.log(`matched                          ${counts.matched}`);
  console.log(`  of which changed               ${counts.matched_with_changes}`);
  console.log(`missing from roster              ${counts.missing_from_roster}`);
  console.log(`  with attendance evidence       ${attendance}`);
  console.log(`  without a confirmed name       ${summary.missing.without_a_confirmed_name}`);
  console.log(`extra in roster (unknown code)   ${counts.extra_in_roster}`);
  console.log(`master rows with no usable code  ${counts.master_rows_unkeyable}`);
  console.log(`conflicting rows                 ${counts.conflicting_rows}`);
  console.log('');
  console.log(`conflicts by kind  ${JSON.stringify(summary.conflicts_by_kind)}`);
  console.log(`changes by field   ${JSON.stringify(summary.changes_by_field)}`);
  console.log(`name evidence      ${JSON.stringify(summary.name_evidence)}`);
  console.log(`employee_type outside the enum: ${unknownTypeRows}`);
  console.log('');
  console.log(`import readiness   assessed=${readiness.assessed} ready=${readiness.ready} blocked=${readiness.blocked}`);
  console.log(`  blocked by gate  ${JSON.stringify(readiness.blocked_by_gate)}`);
  console.log(`  blocked by code  ${JSON.stringify(readiness.blocked_by_code)}`);
  console.log('');
  console.log(`detail (codes, local only) -> ${out}`);
  return counts.conflicting_rows > 0 || counts.master_rows_unkeyable > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('reconcile-roster-2027.mjs');
if (invokedDirectly) {
  main().then((code) => process.exit(code ?? 0)).catch((error) => {
    console.error(`reconcile-roster-2027: ${error.message}`);
    process.exit(1);
  });
}

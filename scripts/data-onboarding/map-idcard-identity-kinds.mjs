#!/usr/bin/env node
/**
 * Dry-run: classify IDCardRaecsv2027 rows as MJU / HIP / UNRESOLVED and print a MASKED report to stdout.
 *
 *   node scripts/data-onboarding/map-idcard-identity-kinds.mjs --csv database/IDCardRaecsv2027.csv [options]
 *
 *   --mju-source <file.json>   { "authoritative": true|false, "records": [{ "personnelId", "nationalId" }] } (private, not in Git)
 *   --existing <file.json>     employee_identifier snapshot ([{ employeeUid, idType, idValue|lookupHmac, status }])
 *   --hip-approval-ref <ref>   approval reference that allows HIP classification
 *   --hip-id-evidence-ref <ref> evidence that CSV 'Facescan Code' = HIP USERID (docs/HIP_ID_MAPPING_EVIDENCE.md); required for HIP/attendance
 *   --accept-unverified-mju-absence   operator confirms contractors have no MJU account (recorded in the report)
 *   --confirmed-scope <n>      human-confirmed unique employees (default 50 for IDCardRaecsv2027); mismatch => exit code 2
 *   --summary                  counts only (no per-row items)
 *   --ephemeral-key            use a throw-away in-memory HMAC key when none is configured (counts only; nothing persisted)
 *
 * Guarantees: the CSV is opened read-only and never rewritten; no database / network / SSH; nothing is written to
 * disk; national IDs are protected with the shared contract (HMAC, key version) and never printed.
 */
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildIdentityKindMapping } from './identityKindMapping.mjs';
import { loadIdentifierKeys } from './identifierCrypto.mjs';

function parseArgs(argv) {
  const args = { flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (['summary', 'ephemeral-key', 'accept-unverified-mju-absence'].includes(name)) args.flags.add(name);
    else args[name] = argv[++i];
  }
  return args;
}

/** Minimal RFC-4180 reader (quotes, embedded commas/newlines); only the first two columns are used. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

async function readCsvLatin1(path) {
  // latin1 keeps ASCII digits intact regardless of the Thai name/org encoding (those columns are never used).
  const chunks = [];
  for await (const chunk of createReadStream(path, { flags: 'r' })) chunks.push(chunk);
  return Buffer.concat(chunks).toString('latin1').replace(/^\uFEFF/, '');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.csv) throw new Error('--csv is required');

  let keys;
  let keySource = 'configured';
  try {
    keys = loadIdentifierKeys(process.env);
  } catch (error) {
    if (!args.flags.has('ephemeral-key')) {
      throw new Error(`HMAC key is not configured (${error.code || 'error'}). Set EMPLOYEE_IDENTIFIER_HMAC_KEY[_FILE] or pass --ephemeral-key for a counts-only run.`);
    }
    keys = loadIdentifierKeys({
      EMPLOYEE_IDENTIFIER_HMAC_KEY: randomBytes(32).toString('base64'),
      EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION: '1',
    });
    keySource = 'ephemeral-in-memory';
  }

  const records = parseCsv(await readCsvLatin1(args.csv));
  const [, ...dataRows] = records; // header skipped
  const rows = dataRows.map((cells, index) => ({
    rowNumber: index + 2,
    nationalId: cells[0] ?? '',
    facescanId: cells[1] ?? '',
  }));

  const { report } = buildIdentityKindMapping(rows, {
    keys,
    mjuSource: args['mju-source'] ? await readJson(args['mju-source']) : null,
    existingIdentifiers: args.existing ? await readJson(args.existing) : [],
    confirmedScope: Number(args['confirmed-scope'] ?? 50),
    hipPolicy: {
      approvalRef: args['hip-approval-ref'],
      hipIdFieldEvidenceRef: args['hip-id-evidence-ref'],
      acceptUnverifiedMjuAbsence: args.flags.has('accept-unverified-mju-absence'),
    },
  });

  const output = { ...report, keySource };
  if (args.flags.has('summary')) delete output.items;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (report.scope.matchesConfirmedScope === false) {
    console.error('map-idcard-identity-kinds: unique rows do not match the confirmed scope');
    process.exitCode = 2;
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  main().catch((error) => {
    // Error messages from the contract never contain identifiers.
    console.error(`map-idcard-identity-kinds failed: ${error.message}`);
    process.exitCode = 1;
  });
}

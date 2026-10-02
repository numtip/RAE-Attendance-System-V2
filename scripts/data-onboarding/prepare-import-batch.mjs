import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildImportBatchFromPersonRecords,
  dryRun,
  redactImportBatchSummary,
  sha256Text,
} from './lib.mjs';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error(
    'usage: node scripts/data-onboarding/prepare-import-batch.mjs <person-batch.json> [--write-local]',
  );
  process.exit(2);
}

const writeLocal = process.argv.includes('--write-local');
const raw = await readFile(inputPath, 'utf8');
const parsed = JSON.parse(raw);
const records = Array.isArray(parsed) ? parsed : parsed.persons ?? parsed.records;
if (!Array.isArray(records)) {
  console.error('input must be an array or contain persons/records array');
  process.exit(2);
}

const manifest = {
  ...(parsed.manifest ?? {}),
  source_batch_id: parsed.manifest?.source_batch_id ?? `mju-batch-${sha256Text(raw).slice(0, 12)}`,
  input_sha256: sha256Text(raw),
  owner: parsed.manifest?.owner ?? 'operator',
  captured_at_utc: parsed.manifest?.captured_at_utc ?? new Date().toISOString(),
  sequence_start: Number(parsed.manifest?.sequence_start || 1),
};

const batch = buildImportBatchFromPersonRecords(records, manifest);
if (!batch.uniqueness.ok) {
  console.error(JSON.stringify(redactImportBatchSummary(batch), null, 2));
  process.exit(1);
}

const bundleText = JSON.stringify(batch.bundle);
const dry = dryRun(batch.bundle, { sourceText: bundleText });
const summary = redactImportBatchSummary(batch, dry);

if (writeLocal) {
  const outDir = path.resolve('.local/import-batches');
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const outFile = path.join(outDir, `${summary.source_batch_id}.preview.json`);
  await writeFile(outFile, bundleText, { mode: 0o600 });
  summary.local_preview_path = outFile;
}

console.log(JSON.stringify(summary, null, 2));
process.exit(dry.validation.ok && batch.readyCount > 0 ? 0 : 1);

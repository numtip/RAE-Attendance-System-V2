/**
 * Cross-check CSV national IDs against mju-person-enrich citizenID index.
 * Does NOT use name keys for identity — only citizenID equality.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  auditIdCardRows,
  loadIdCardCsv,
  maskFacescanId,
  maskNationalId,
  normalizeNationalId,
} from './idcardCsvLib.mjs';

const enrichCachePath = process.argv[2]
  || path.join('..', '..', '..', 'mju-person-enrich', 'logs', 'person-cache.json');

function indexCitizenIdsFromCache(cacheJson) {
  const byCitizen = new Map();
  for (const value of Object.values(cacheJson || {})) {
    const rows = Array.isArray(value) ? value : [];
    for (const person of rows) {
      const citizen = normalizeNationalId(person?.citizenID);
      if (!citizen) continue;
      if (!byCitizen.has(citizen)) {
        byCitizen.set(citizen, {
          positionCode: person.positionCode ? String(person.positionCode) : null,
          hasEmail: Boolean(person.e_mail || person.email),
        });
      }
    }
  }
  return byCitizen;
}

const csvPath = process.argv[3] || 'database/IDCardRaecsv2027.csv';
const { rows } = await loadIdCardCsv(csvPath);
const audit = auditIdCardRows(rows);
const cache = JSON.parse(await readFile(enrichCachePath, 'utf8'));
const byCitizen = indexCitizenIdsFromCache(cache);

let inEnrich = 0;
let notInEnrich = 0;
const samples = [];

for (const row of audit.dedupedRows) {
  if (!row.nationalId) continue;
  if (byCitizen.has(row.nationalId)) {
    inEnrich += 1;
    if (samples.length < 3) {
      samples.push({
        maskedNationalId: maskNationalId(row.nationalId),
        maskedFacescanId: maskFacescanId(row.facescanId),
      });
    }
  } else {
    notInEnrich += 1;
  }
}

console.log(JSON.stringify({
  csvDedupedRows: audit.dedupedRows.length,
  enrichCitizenIndexSize: byCitizen.size,
  csvRowsWithCitizenInEnrichCache: inEnrich,
  csvRowsNotInEnrichCache: notInEnrich,
  note: 'Enrich verifies citizenID only; does not provide employee_uid without employees DB.',
  samples,
}, null, 2));

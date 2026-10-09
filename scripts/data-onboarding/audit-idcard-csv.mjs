import { auditIdCardRows, loadIdCardCsv } from './idcardCsvLib.mjs';

const filePath = process.argv[2] || 'database/IDCardRaecsv2027.csv';
const { rows } = await loadIdCardCsv(filePath);
const audit = auditIdCardRows(rows);
console.log(JSON.stringify({
  file: filePath,
  csvAudit: {
    rowCount: audit.rowCount,
    uniqueNationalIds: audit.uniqueNationalIds,
    uniqueFacescanIds: audit.uniqueFacescanIds,
    dedupedRowCount: audit.dedupedRows.length,
    exactDuplicateGroups: audit.exactDuplicateGroups,
    mappingConflicts: audit.mappingConflicts,
    invalidNational: audit.invalidNational,
    invalidFacescan: audit.invalidFacescan,
    duplicateCases: audit.duplicateCases,
  },
}, null, 2));

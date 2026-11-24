const { HttpError } = require('../utils/httpError');
const { resolveScope } = require('./authorizationService');
const { createFacescanRawIngestionService } = require('./facescanRawIngestionService');
const { runFacescanImport, EXIT } = require('../imports/facescanImportCli');
const { backupBeforeWrite } = require('./productionBackup');

function createHipUploadService(container, backup = backupBeforeWrite) {
  const { repositories } = container;
  const ingestion = createFacescanRawIngestionService(container);
  async function owner(auth) {
    if (!(await resolveScope(auth, repositories, 'data')).all) throw new HttpError(403, 'FORBIDDEN', 'Owner access required');
  }
  function content(body) {
    if (typeof body.csv !== 'string' || !body.csv.length || Buffer.byteLength(body.csv, 'utf8') > 8 * 1024 * 1024) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'CSV must be provided and no larger than 8 MB');
    }
    return Buffer.from(body.csv, 'utf8');
  }
  return {
    async preview(auth, body) {
      await owner(auth);
      return ingestion.previewFile(content(body), { format: 'hip_daily_report' });
    },
    async history(auth) {
      await owner(auth);
      const batches = await repositories.facescanRaw.listRecentBatches();
      return batches.map(({ id, status, rowCount, insertedCount, duplicateCount, unmappedCount, startedAt, finishedAt }) =>
        ({ id, status, rowCount, insertedCount, duplicateCount, unmappedCount, startedAt, finishedAt }));
    },
    async confirm(auth, body) {
      await owner(auth);
      const file = content(body);
      if (body.confirm !== true || !/^[a-f0-9]{64}$/.test(body.contentSha256 || '')) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Preview and confirmation are required');
      }
      return repositories.facescanRaw.withImportLock(async () => {
        const preview = await ingestion.previewFile(file, { format: 'hip_daily_report' });
        if (preview.contentSha256 !== body.contentSha256) throw new HttpError(409, 'PREVIEW_MISMATCH', 'File differs from preview');
        if (container.dataSource !== 'mariadb') throw new HttpError(503, 'DB_UNAVAILABLE', 'Import requires MariaDB');
        await backup(container);
        const result = await runFacescanImport(['upload.csv', '--format', 'hip-daily', '--confirm', '--derive', '--operator', auth.employeeUid], {
          container, readFile: async () => file,
        });
        if (result.exitCode !== EXIT.OK && result.exitCode !== EXIT.DERIVE_INCOMPLETE) {
          throw new HttpError(400, 'IMPORT_FAILED', result.report.refused || 'Import failed');
        }
        return { ...result.report, complete: result.exitCode === EXIT.OK };
      });
    },
  };
}
module.exports = { createHipUploadService };

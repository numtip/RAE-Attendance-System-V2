const { createHolidayManagementService } = require('../services/holidayManagementService');

// Local operator command: default is read-only. Never emit employee data or credentials.
async function runHolidayRecalculate(argv, { container, backup } = {}) {
  const [year, flag] = argv;
  if (!/^\d{4}$/.test(year || '') || argv.length > 2 || (flag && flag !== '--confirm')) {
    throw new Error('usage: holidayRecalculateCli.js <CE year> [--confirm]');
  }
  if (container.dataSource !== 'mariadb') throw new Error('MariaDB is required');
  const holidays = await container.repositories.attendanceHolidays.listApproved(`${year}-01-01`, `${year}-12-31`);
  const dates = new Set(holidays.map((entry) => entry.date));
  if (flag !== '--confirm') return { mode: 'dry-run', year, approvedDates: dates.size, written: false };
  const service = createHolidayManagementService(container, backup);
  const result = await service.recalculateYearForOperator(year);
  return { mode: 'recalculated', year, approvedDates: result.dates, written: true };
}

module.exports = { runHolidayRecalculate };

if (require.main === module) {
  const { createContainer } = require('../container');
  const { closePool } = require('../db/pool');
  (async () => {
    try {
      console.log(JSON.stringify(await runHolidayRecalculate(process.argv.slice(2), { container: createContainer() })));
    } catch (error) {
      console.error(JSON.stringify({ failed: error?.code || error?.name || 'Error' }));
      process.exitCode = 1;
    } finally { await closePool(); }
  })();
}

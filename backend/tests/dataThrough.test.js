const assert = require('node:assert/strict');
const test = require('node:test');

const { dataThrough } = require('../src/services/dataThrough');
const { reportHelpers } = require('../src/services/reportService');

const { thaiDate } = reportHelpers;
const repos = (latest) => ({ attendance: { async latestDailyDate() { return latest; } } });

test('a month the source stops half-way through is flagged partial with a plain-language note', async () => {
  const result = await dataThrough(repos('2026-11-18'), '2026-11-01', '2026-11-30', thaiDate);
  assert.equal(result.through, '2026-11-18');
  assert.equal(result.partial, true);
  assert.match(result.label, /ข้อมูลถึงวันที่ 18 พฤศจิกายน 2569/);
  assert.match(result.note, /ไม่ใช่ศูนย์/);
});

test('a complete month is not partial: a weekend/holiday gap at month end is tolerated', async () => {
  const result = await dataThrough(repos('2026-10-30'), '2026-10-01', '2026-10-31', thaiDate);
  assert.equal(result.partial, false);
  assert.equal(result.note, null);
  assert.ok(result.label);
});

test('no data in the month gives no label and no claim', async () => {
  assert.deepEqual(await dataThrough(repos(null), '2026-12-01', '2026-12-31', thaiDate), { through: null, label: null, partial: false });
});

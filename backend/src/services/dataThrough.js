const DAY_MS = 86400000;

/**
 * How far the imported attendance reaches inside a month. A report for a month the source only covers
 * part of (e.g. a HIP export that stops on the 18th) must not read as "nothing happened afterwards".
 * `partial` is true when the last imported day is more than 3 days before month end (3 absorbs a
 * weekend plus a public holiday); the label is always available so the screen can show it.
 */
async function dataThrough(repositories, start, end, thaiDate) {
  const through = await repositories.attendance.latestDailyDate(start, end);
  if (!through) return { through: null, label: null, partial: false };
  const gap = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${through}T00:00:00Z`)) / DAY_MS;
  return {
    through,
    label: `ข้อมูลถึงวันที่ ${thaiDate(through)}`,
    partial: gap > 3,
    note: gap > 3
      ? `เดือนนี้มีข้อมูลถึงวันที่ ${thaiDate(through)} เท่านั้น — ยอดและจำนวนวันลายังไม่ครบเดือน วันหลังจากนั้นคือ "ยังไม่มีข้อมูล" ไม่ใช่ศูนย์`
      : null,
  };
}

module.exports = { dataThrough };

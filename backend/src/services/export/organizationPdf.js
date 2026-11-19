const PDFDocument = require('pdfkit');
const { ORGANIZATION_NAME_TH, INSTITUTION_NAME_TH } = require('../../config/organization');

const REGULAR = require.resolve('../../assets/fonts/Sarabun-Regular.ttf');
const BOLD = require.resolve('../../assets/fonts/Sarabun-Bold.ttf');

const COLUMNS = [
  { key: 'employeeId', label: 'รหัส', x: 40, width: 40 },
  { key: 'employeeName', label: 'ชื่อ-นามสกุล', x: 84, width: 170 },
  { key: 'workDays', label: 'วันทำงาน', x: 258, width: 50 },
  { key: 'present', label: 'มา', x: 312, width: 40 },
  { key: 'late', label: 'สาย', x: 356, width: 40 },
  { key: 'lateMinutes', label: 'นาทีสาย', x: 400, width: 50 },
  { key: 'leaveRecordedDays', label: 'ลา(HIP)', x: 454, width: 50 },
];

function cell(row, key) {
  if (!row.hasMonthlySummary && !['employeeId', 'employeeName'].includes(key)) return key === 'workDays' ? 'ไม่มีสรุป' : '';
  const value = row[key];
  return value === null || value === undefined ? '' : String(value);
}

function renderOrganizationPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, compress: false });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      doc.registerFont('Sarabun', REGULAR);
      doc.registerFont('Sarabun-Bold', BOLD);
      doc.font('Sarabun').fontSize(11).text(`${ORGANIZATION_NAME_TH} · ${INSTITUTION_NAME_TH}`, { width: 515 });
      doc.font('Sarabun-Bold').fontSize(16).text(report.scope === 'organization' ? 'รายงานการมาทำงาน — ทั้งองค์กร' : 'รายงานการมาทำงาน — ทีม', { width: 515 });
      doc.font('Sarabun').fontSize(11);
      doc.text(report.periodLabel, { width: 515 });
      if (report.dataThrough && report.dataThrough.label) doc.text(report.dataThrough.partial ? report.dataThrough.note : report.dataThrough.label, { width: 515 });
      doc.text(`พนักงานในขอบเขต ${report.totals.employeesInScope} คน · มีสรุปรายเดือน ${report.totals.employeesWithData} · ไม่มี ${report.totals.employeesWithoutData}`, { width: 515 });
      doc.text(`รวม: มาทำงาน ${report.totals.present} · สาย ${report.totals.late} (${report.totals.lateMinutes} นาที) · ลา(HIP) ${report.totals.leaveRecordedDays === null ? 'ไม่มีข้อมูล' : report.totals.leaveRecordedDays} วัน`, { width: 515 });
      doc.text(report.notices.holidayNote, { width: 515 });
      doc.moveDown(0.6);

      const header = () => {
        const y = doc.y;
        doc.font('Sarabun-Bold').fontSize(10);
        for (const column of COLUMNS) doc.text(column.label, column.x, y, { width: column.width });
        doc.font('Sarabun');
        doc.y = y + 16;
      };
      header();
      for (const row of report.rows) {
        if (doc.y > 770) { doc.addPage(); header(); }
        const y = doc.y;
        doc.fontSize(10);
        for (const column of COLUMNS) doc.text(cell(row, column.key), column.x, y, { width: column.width, lineBreak: false });
        doc.y = y + 15;
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { renderOrganizationPdf };

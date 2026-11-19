const PDFDocument = require('pdfkit');
const { ORGANIZATION_NAME_TH, INSTITUTION_NAME_TH } = require('../../config/organization');

const REGULAR = require.resolve('../../assets/fonts/Sarabun-Regular.ttf');
const BOLD = require.resolve('../../assets/fonts/Sarabun-Bold.ttf');

const COLUMNS = [
  { key: 'employeeId', label: 'รหัส', x: 40, width: 44 },
  { key: 'employeeName', label: 'ชื่อ-นามสกุล', x: 88, width: 190 },
  { key: 'personal', label: 'ลากิจ', x: 282, width: 56 },
  { key: 'sick', label: 'ลาป่วย', x: 342, width: 56 },
  { key: 'vacation', label: 'ลาพักผ่อน', x: 402, width: 66 },
  { key: 'review', label: 'รอตรวจสอบ', x: 472, width: 80 },
];

function cell(row, key) {
  if (key === 'employeeId' || key === 'employeeName') return row[key];
  if (key === 'review') return row.recordedNeedsReview === null ? 'ไม่มีข้อมูล' : String(row.recordedNeedsReview);
  return row.recorded ? String(row.recorded[key].days) : 'ไม่มีข้อมูล';
}

function renderLeaveMonthlyPdf(report) {
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
      doc.font('Sarabun-Bold').fontSize(16).text('สรุปการลารายเดือน', { width: 515 });
      doc.font('Sarabun').fontSize(11).text(report.periodLabel, { width: 515 });
      if (report.recordedTotals) {
        const t = report.recordedTotals;
        doc.text(`รวม: ลากิจ ${t.byType.personal.days} · ลาป่วย ${t.byType.sick.days} · ลาพักผ่อน ${t.byType.vacation.days} วัน · รอตรวจสอบ ${t.needsReviewRecords} รายการ`, { width: 515 });
      } else {
        doc.text(report.recordedCoverage.note, { width: 515 });
      }
      doc.fontSize(9).text(report.notices.recorded, { width: 515 });
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

module.exports = { renderLeaveMonthlyPdf };

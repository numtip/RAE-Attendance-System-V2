const PDFDocument = require('pdfkit');
const { ORGANIZATION_NAME_TH, INSTITUTION_NAME_TH } = require('../../config/organization');

const REGULAR = require.resolve('../../assets/fonts/Sarabun-Regular.ttf');
const BOLD = require.resolve('../../assets/fonts/Sarabun-Bold.ttf');

const NONE = 'ไม่มีข้อมูล';
const COLUMNS = [
  { key: 'employeeId', label: 'รหัส', x: 40, width: 40 },
  { key: 'employeeName', label: 'ชื่อ-นามสกุล', x: 84, width: 150 },
  { key: 'personal', label: 'ลากิจ', x: 238, width: 40 },
  { key: 'sick', label: 'ลาป่วย', x: 282, width: 40 },
  { key: 'vacation', label: 'ลาพักผ่อน', x: 326, width: 52 },
  { key: 'recorded', label: 'รวม', x: 382, width: 36 },
  { key: 'approved', label: 'อนุมัติแล้ว', x: 422, width: 52 },
  { key: 'review', label: 'รอตรวจสอบ', x: 478, width: 74 },
];
const DETAIL_COLUMNS = [
  { key: 'dateLabel', label: 'วันที่', x: 40, width: 80 },
  { key: 'employeeName', label: 'ชื่อ-นามสกุล', x: 124, width: 130 },
  { key: 'typeLabel', label: 'ประเภท', x: 258, width: 50 },
  { key: 'partLabel', label: 'ช่วงเวลา', x: 312, width: 70 },
  { key: 'days', label: 'วัน', x: 386, width: 28 },
  { key: 'statusLabel', label: 'สถานะ', x: 418, width: 134 },
];

function cell(row, key) {
  if (key === 'employeeId' || key === 'employeeName') return row[key];
  if (key === 'review') return row.recordedNeedsReview === null ? NONE : String(row.recordedNeedsReview);
  if (key === 'recorded') return row.recordedTotals ? String(row.recordedTotals.recordedDays) : NONE;
  if (key === 'approved') return row.recordedTotals ? String(row.recordedTotals.approvedDays) : NONE;
  return row.recorded ? String(row.recorded[key].days) : NONE;
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
      const table = (columns, items, valueOf) => {
        const header = () => {
          const y = doc.y;
          doc.font('Sarabun-Bold').fontSize(10);
          for (const column of columns) doc.text(column.label, column.x, y, { width: column.width });
          doc.font('Sarabun');
          doc.y = y + 16;
        };
        header();
        for (const item of items) {
          if (doc.y > 770) { doc.addPage(); header(); }
          const y = doc.y;
          doc.fontSize(10);
          for (const column of columns) doc.text(valueOf(item, column.key), column.x, y, { width: column.width, lineBreak: false });
          doc.y = y + 15;
        }
      };
      doc.font('Sarabun').fontSize(11).text(`${ORGANIZATION_NAME_TH} · ${INSTITUTION_NAME_TH}`, { width: 515 });
      doc.font('Sarabun-Bold').fontSize(16).text(report.month ? 'สรุปการลารายเดือน' : 'สรุปการลารายปี', { width: 515 });
      doc.font('Sarabun').fontSize(11).text(report.periodLabel, { width: 515 });
      const f = report.filters || {};
      const filterText = [
        f.divisionName && `กอง: ${f.divisionName}`, f.typeLabel && `ประเภท: ${f.typeLabel}`,
        f.statusLabel && `สถานะ: ${f.statusLabel}`, f.employeeUid && 'เฉพาะพนักงานที่เลือก',
      ].filter(Boolean).join(' · ');
      if (filterText) doc.text(`ตัวกรอง: ${filterText}`, { width: 515 });
      if (report.dataThrough && report.dataThrough.label) doc.text(report.dataThrough.partial ? report.dataThrough.note : report.dataThrough.label, { width: 515 });
      if (report.recordedTotals) {
        const t = report.recordedTotals;
        doc.text(`รวมบันทึกจาก HIP: ลากิจ ${t.byType.personal.days} · ลาป่วย ${t.byType.sick.days} · ลาพักผ่อน ${t.byType.vacation.days} วัน (รวม ${t.all.recordedDays} วัน)`, { width: 515 });
        doc.text(`อนุมัติแล้ว ${t.all.approvedDays} วัน · รออนุมัติ ${t.all.awaitingApprovalDays} วัน · รอตรวจสอบ ${t.all.needsReviewRecords} รายการ (ไม่รวมในยอด)`, { width: 515 });
        if (report.recordedCoverage.note) doc.text(report.recordedCoverage.note, { width: 515 });
      } else {
        doc.text(report.recordedCoverage.note, { width: 515 });
      }
      doc.fontSize(9).text(report.notices.recorded, { width: 515 });
      doc.moveDown(0.6);
      if (report.byDivision && report.byDivision.length) {
        doc.font('Sarabun-Bold').fontSize(12).text('สรุปรายกอง', 40, doc.y, { width: 515 });
        doc.font('Sarabun');
        table(
          [
            { key: 'nameTh', label: 'กอง', x: 40, width: 190 }, { key: 'headcount', label: 'คน', x: 234, width: 30 },
            { key: 'recordedDays', label: 'รวม (วัน)', x: 268, width: 60 }, { key: 'approvedDays', label: 'อนุมัติแล้ว', x: 332, width: 64 },
            { key: 'awaitingApprovalDays', label: 'รออนุมัติ', x: 400, width: 60 }, { key: 'needsReviewRecords', label: 'รอตรวจสอบ', x: 464, width: 88 },
          ],
          report.byDivision,
          (item, key) => String(item[key]),
        );
        doc.moveDown(0.6);
      }
      doc.font('Sarabun-Bold').fontSize(12).text('สรุปรายบุคคล (วัน)', 40, doc.y, { width: 515 });
      doc.font('Sarabun');
      table(COLUMNS, report.rows, cell);
      if (report.records && report.records.length) {
        doc.addPage();
        doc.font('Sarabun-Bold').fontSize(12).text(`รายการลาโดยละเอียด (${report.records.length} รายการ)`, 40, doc.y, { width: 515 });
        doc.font('Sarabun');
        table(DETAIL_COLUMNS, report.records, (item, key) => (key === 'days' ? (item.dayFraction === null ? '-' : String(item.dayFraction)) : String(item[key])));
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { renderLeaveMonthlyPdf };

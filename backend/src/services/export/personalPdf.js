const PDFDocument = require('pdfkit');
const { ORGANIZATION_NAME_TH, INSTITUTION_NAME_TH } = require('../../config/organization');
const { describeBalances } = require('../leaveLabels');

const REGULAR = require.resolve('../../assets/fonts/Sarabun-Regular.ttf');
const BOLD = require.resolve('../../assets/fonts/Sarabun-Bold.ttf');

function renderPersonalPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, compress: false });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      doc.registerFont('Sarabun', REGULAR);
      doc.registerFont('Sarabun-Bold', BOLD);
      doc.font('Sarabun').fontSize(11).text(`${ORGANIZATION_NAME_TH} · ${INSTITUTION_NAME_TH}`, { width: 500 });
      doc.font('Sarabun-Bold').fontSize(16).text('รายงานการมาทำงานและการลา', { width: 500 });
      doc.moveDown(0.4);
      doc.font('Sarabun').fontSize(12);
      doc.text(`${report.employeeName} (${report.employeeId})`, { width: 500 });
      doc.text(`${report.department} · ${report.position}`, { width: 500 });
      doc.text(report.periodLabel, { width: 500 });
      doc.text(report.notices.holidayNote, { width: 500 });
      doc.moveDown(0.6);
      if (report.empty) {
        doc.text('ไม่มีข้อมูลการมาทำงานหรือการลาในช่วงนี้', { width: 500 });
      } else {
        doc.font('Sarabun-Bold').text('สรุป', { width: 500 });
        doc.font('Sarabun');
        if (report.hasMonthlySummary) {
          doc.text(`วันทำงาน ${report.workDays}`, { width: 500 });
          doc.text(`มาทำงาน ${report.present}`, { width: 500 });
          doc.text(`สาย ${report.late} (${report.lateMinutes} นาที)`, { width: 500 });
          doc.text(report.leaveRecordedDays === null ? 'ลา (บันทึกจาก HIP) ไม่มีข้อมูล' : `ลา (บันทึกจาก HIP) ${report.leaveRecordedDays} วัน${report.leaveNeedsReview ? ` · รอตรวจสอบ ${report.leaveNeedsReview} รายการ` : ''}`, { width: 500 });
        } else {
          doc.text('ไม่มีสรุปรายเดือนที่บันทึกไว้', { width: 500 });
        }
        for (const line of describeBalances(report.leaveBalances)) doc.text(`วันลาคงเหลือ — ${line.label}: ${line.text}`, { width: 500 });
        doc.moveDown(0.4);
        doc.font('Sarabun-Bold').text('รายการสแกนที่บันทึกไว้', { width: 500 });
        doc.font('Sarabun');
        if (report.scans.length === 0) {
          doc.text('ไม่มีรายการสแกนที่บันทึกไว้', { width: 500 });
        }
        for (const scan of report.scans) {
          doc.text(
            `${scan.dateLabel}  เข้า ${scan.checkInLabel}  ออก ${scan.checkOutLabel}  ${scan.statusLabel}`,
            { width: 500 },
          );
        }
        doc.moveDown(0.4);
        doc.font('Sarabun-Bold').text('รายการลาที่บันทึกไว้', { width: 500 });
        doc.font('Sarabun');
        if (report.leaveRows.length === 0) {
          doc.text('ไม่มีรายการลาที่บันทึกไว้', { width: 500 });
        }
        for (const row of report.leaveRows) {
          doc.text(`${row.typeLabel}  ${row.startLabel}${row.endLabel !== row.startLabel ? ` – ${row.endLabel}` : ''}${row.dayFraction != null ? `  ${row.dayFraction} วัน` : ''}  ${row.statusLabel}`, { width: 500 });
        }
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { renderPersonalPdf };

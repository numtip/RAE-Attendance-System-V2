/**
 * R-03 PDF renderer (pdfkit). Turns the canonical export model into a print-ready A4 document.
 *
 * Font: `Sarabun` (SIL OFL 1.1, shipped at `src/assets/fonts/`, licence beside it). It is registered from an
 * ABSOLUTE path because pdfkit resolves a name against its own bundled fonts otherwise — which would render
 * Thai as empty boxes. A missing font file throws, loudly, instead of silently falling back.
 *
 * KNOWN LIMITATION (documented, not worked around): pdfkit applies GSUB and shapes Thai correctly, but the
 * ToUnicode CMap it writes is not reversible for U+0E33 SARA AM — extracting `ทำงาน` yields the decomposed
 * `ทำางาน`. The VISUAL output is correct; only text extraction of words containing `ำ` is affected. Fixing it
 * would mean rewriting the CMap, which is out of scope for this slice.
 *
 * THAI LINE BREAKING: Thai has no spaces between words, so pdfkit's own breaker cannot wrap it and would
 * push a whole sentence past the margin. `wrapThai` therefore measures with `doc.widthOfString` and inserts
 * explicit breaks at Thai cluster boundaries (never between a base character and its combining marks).
 * No line is ever emitted wider than the content width.
 */
const PDFDocument = require('pdfkit');
const path = require('node:path');
const { HttpError } = require('../../utils/httpError');
const { formatThaiDateTime } = require('../../domain/attendanceReportPresentation');

const REGULAR = 'Sarabun';
const BOLD = 'Sarabun-Bold';
const FONT_REQUESTS = Object.freeze({
  [REGULAR]: '../../assets/fonts/Sarabun-Regular.ttf',
  [BOLD]: '../../assets/fonts/Sarabun-Bold.ttf',
});

const PAGE_MARGIN = Object.freeze({ top: 96, bottom: 56, left: 40, right: 40 });
const LINE_HEIGHT = 12;
const CELL_PADDING_X = 4;
const CELL_PADDING_Y = 3;
const MAX_CELL_LINES = 4;
const LABEL_COLUMN_WIDTH = 168;

/**
 * Absolute font paths, resolved from THIS module's location (never `process.cwd()`, which depends on how the
 * process was started) and validated to exist. A missing font throws `EXPORT_FONT_MISSING` rather than
 * falling back to a default font, which would render every Thai glyph as an empty box.
 */
function resolveFontFiles() {
  const resolved = {};
  for (const [name, request] of Object.entries(FONT_REQUESTS)) {
    try {
      resolved[name] = require.resolve(request);
    } catch {
      throw new HttpError(
        500,
        'EXPORT_FONT_MISSING',
        `Thai font file is missing: ${path.basename(request)}`,
      );
    }
  }
  return resolved;
}

/** True for the Thai block, which is where a naive breaker would go wrong. */
function isThaiCodePoint(cp) {
  return cp >= 0x0E00 && cp <= 0x0E7F;
}

/** Thai combining marks: a line must never break between a base character and one of these. */
function isThaiCombining(cp) {
  return cp === 0x0E31 || (cp >= 0x0E34 && cp <= 0x0E3A) || (cp >= 0x0E47 && cp <= 0x0E4E);
}

/**
 * Split text into the smallest units that may safely start a new line: one Thai cluster each, plus
 * whitespace-separated runs for anything Latin.
 */
function tokenizeForWrap(text) {
  const tokens = [];
  let latin = '';
  const flushLatin = () => {
    if (!latin) return;
    // Keep a Latin word whole where possible; whitespace becomes its own token so it can be dropped.
    for (const piece of latin.match(/\s+|\S+/g) || []) tokens.push(piece);
    latin = '';
  };

  const characters = Array.from(text);
  for (let index = 0; index < characters.length; index += 1) {
    const cp = characters[index].codePointAt(0);
    if (isThaiCodePoint(cp)) {
      flushLatin();
      let cluster = characters[index];
      while (index + 1 < characters.length
        && isThaiCombining(characters[index + 1].codePointAt(0))) {
        index += 1;
        cluster += characters[index];
      }
      tokens.push(cluster);
    } else {
      latin += characters[index];
    }
  }
  flushLatin();
  return tokens;
}

/** Greedy wrap; a single token wider than the column is hard-split so nothing can overflow. */
function wrapThai(text, maxWidth, measure) {
  const lines = [];
  const width = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : 1;

  for (const segment of String(text ?? '').split('\n')) {
    if (segment === '') {
      lines.push('');
      continue;
    }
    let current = '';
    const commit = () => {
      lines.push(current.replace(/\s+$/, ''));
      current = '';
    };
    for (const token of tokenizeForWrap(segment)) {
      if (current === '' && /^\s+$/.test(token)) continue; // never start a line with a space
      if (measure(token) > width) {
        // This token cannot fit on a line of its own: flush what we have, then break it character by
        // character. Checking this BEFORE the greedy append is what stops a long Latin word (or an
        // unbreakable cluster) from being pushed past the column edge.
        if (current !== '') commit();
        let piece = '';
        for (const character of Array.from(token)) {
          if (piece !== '' && measure(piece + character) > width) {
            lines.push(piece);
            piece = character;
          } else {
            piece += character;
          }
        }
        current = piece;
        continue;
      }
      if (current !== '' && measure(current + token) > width) commit();
      current += token;
    }
    commit();
  }

  return lines.length > 0 ? lines : [''];
}

/** Truncate to `MAX_CELL_LINES`, marking the cut with an ellipsis rather than silently dropping text. */
function capLines(lines) {
  if (lines.length <= MAX_CELL_LINES) return lines;
  const capped = lines.slice(0, MAX_CELL_LINES);
  capped[MAX_CELL_LINES - 1] = `${capped[MAX_CELL_LINES - 1].replace(/\s+$/, '')}…`;
  return capped;
}

/** A number stays a number; `null` is an unknown figure, not a zero. */
function formatCell(value) {
  if (value == null) return '—';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
  if (typeof value === 'boolean') return value ? 'ใช่' : 'ไม่ใช่';
  return String(value);
}

/** Measure with an explicit font/size, because `widthOfString` uses pdfkit's current state. */
function measureWith(doc, fontName, fontSize) {
  return (text) => {
    doc.font(fontName).fontSize(fontSize);
    return doc.widthOfString(String(text), { width: Infinity });
  };
}

function renderReportPdf(model, { now = () => new Date() } = {}) {
  return new Promise((resolve, reject) => {
    const generatedAt = now();
    let doc;
    try {
      const fonts = resolveFontFiles();
      doc = new PDFDocument({
        size: 'A4',
        margins: PAGE_MARGIN,
        bufferPages: true,
        info: {
          Title: `${model.kind} attendance report`,
          Author: 'RAE Attendance System',
          Producer: 'RAE Attendance System V2',
          Subject: model.isFinal ? 'final attendance report' : 'DRAFT attendance report',
          // Pin the PDF timestamps to the injected clock: without this pdfkit stamps `new Date()` and two
          // renders of the same report would differ byte-for-byte.
          CreationDate: generatedAt,
          ModDate: generatedAt,
        },
      });
      doc.registerFont(REGULAR, fonts[REGULAR]);
      doc.registerFont(BOLD, fonts[BOLD]);
    } catch (error) {
      reject(error);
      return;
    }

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    try {
      drawDocument(doc, model, generatedAt);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function drawDocument(doc, model, generatedAt) {
  const left = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  const context = { left, contentWidth, bottomLimit, y: doc.page.margins.top };

  if (model.watermark) drawDraftBanner(doc, model, context);

  doc.font(BOLD).fontSize(15).fillColor('#111111');
  doc.text(model.title, context.left, context.y, { width: contentWidth, lineBreak: false });
  context.y += 20;

  doc.font(REGULAR).fontSize(10).fillColor('#333333');
  const employeeLine = `${model.employee.nameTh} (${model.employee.employeeId}) · `
    + `${model.employee.department} · ${model.employee.position}`;
  for (const line of wrapThai(employeeLine, contentWidth, measureWith(doc, REGULAR, 10))) {
    doc.text(line, context.left, context.y, { width: contentWidth, lineBreak: false });
    context.y += LINE_HEIGHT;
  }
  const periodLine = `ช่วงเวลาของรายงาน: ${model.period.label} (${model.period.fromTh} - ${model.period.toTh})`;
  doc.text(periodLine, context.left, context.y, { width: contentWidth, lineBreak: false });
  context.y += 16;

  drawFactRows(doc, model.meta, context);

  for (const section of model.sections) {
    context.y += 6;
    if (section.type === 'days' || section.type === 'months') {
      drawTableSection(doc, section, context);
    } else {
      drawFactSection(doc, section, context);
    }
  }

  finishPages(doc, model, generatedAt, contentWidth);
}

function drawDraftBanner(doc, model, context) {
  const height = 58;
  const top = context.y;
  doc.save();
  doc.lineWidth(1.5).strokeColor('#B00020');
  doc.roundedRect(context.left, top, context.contentWidth, height, 4).stroke();
  doc.fillColor('#B00020').font(BOLD).fontSize(14);
  doc.text(model.watermark.label, context.left + 10, top + 8, { lineBreak: false });
  doc.fontSize(12);
  doc.text(model.watermark.text, context.left + 78, top + 10, { lineBreak: false });
  doc.font(REGULAR).fontSize(8.5).fillColor('#444444');
  doc.text(model.watermark.noteTh, context.left + 10, top + 32, {
    width: context.contentWidth - 20,
    lineBreak: false,
  });
  doc.restore();
  doc.fillOpacity(1).strokeOpacity(1);
  context.y = top + height + 10;
}

function drawFactSection(doc, section, context) {
  context.y += 4;
  doc.font(BOLD).fontSize(10.5).fillColor('#1F3B63');
  const titleLines = wrapThai(section.title, context.contentWidth, measureWith(doc, BOLD, 10.5));
  for (const line of titleLines) {
    doc.text(line, context.left, context.y, { width: context.contentWidth, lineBreak: false });
    context.y += 14;
  }
  drawFactRows(doc, section.rows ?? [], context);
}

function drawFactRows(doc, rows, context) {
  const labelMeasure = measureWith(doc, BOLD, 9);
  const valueMeasure = measureWith(doc, REGULAR, 9);
  const valueWidth = context.contentWidth - LABEL_COLUMN_WIDTH;

  for (const row of rows) {
    const labelLines = capLines(wrapThai(row.label, LABEL_COLUMN_WIDTH - 6, labelMeasure));
    const valueLines = capLines(wrapThai(formatCell(row.value), valueWidth - 6, valueMeasure));
    const height = Math.max(labelLines.length, valueLines.length) * LINE_HEIGHT + 4;
    if (context.y + height > context.bottomLimit) {
      doc.addPage();
      context.y = doc.page.margins.top;
    }

    doc.font(BOLD).fontSize(9).fillColor('#222222');
    labelLines.forEach((line, index) => {
      doc.text(line, context.left, context.y + 2 + index * LINE_HEIGHT, { lineBreak: false });
    });
    doc.font(REGULAR).fontSize(9).fillColor('#111111');
    valueLines.forEach((line, index) => {
      doc.text(line, context.left + LABEL_COLUMN_WIDTH, context.y + 2 + index * LINE_HEIGHT, {
        lineBreak: false,
      });
    });
    context.y += height;
  }
}

function drawTableSection(doc, section, context) {
  const columns = Array.isArray(section.columns) ? section.columns : [];
  if (columns.length === 0) return;

  const declared = columns.reduce((sum, column) => sum + (Number(column.width) || 12), 0);
  const widths = columns.map((column) => ((Number(column.width) || 12) / declared) * context.contentWidth);

  const headerFontSize = 8.5;
  const bodyFontSize = 8.5;
  const headerMeasure = measureWith(doc, BOLD, headerFontSize);
  const bodyMeasure = measureWith(doc, REGULAR, bodyFontSize);

  const headerLines = columns.map((column, index) => capLines(
    wrapThai(column.header ?? '', widths[index] - 2 * CELL_PADDING_X, headerMeasure),
  ));
  const headerHeight = Math.max(...headerLines.map((lines) => lines.length)) * LINE_HEIGHT
    + 2 * CELL_PADDING_Y;

  const drawHeaderRow = () => {
    doc.save();
    doc.rect(context.left, context.y, context.contentWidth, headerHeight).fill('#E8EDF3');
    doc.restore();
    doc.font(BOLD).fontSize(headerFontSize).fillColor('#222222');
    headerLines.forEach((lines, index) => {
      let x = context.left + widths.slice(0, index).reduce((sum, w) => sum + w, 0);
      lines.forEach((line, lineIndex) => {
        doc.text(line, x + CELL_PADDING_X, context.y + CELL_PADDING_Y + lineIndex * LINE_HEIGHT, {
          width: widths[index] - 2 * CELL_PADDING_X,
          align: columns[index].align === 'right' ? 'right' : 'left',
          lineBreak: false,
        });
      });
      x += widths[index];
    });
    context.y += headerHeight;
  };

  context.y += 4;
  doc.font(BOLD).fontSize(10.5).fillColor('#1F3B63');
  for (const line of wrapThai(section.title, context.contentWidth, measureWith(doc, BOLD, 10.5))) {
    doc.text(line, context.left, context.y, { width: context.contentWidth, lineBreak: false });
    context.y += 14;
  }

  drawHeaderRow();

  const rows = Array.isArray(section.rows) ? section.rows : [];
  rows.forEach((row, rowIndex) => {
    const cells = Array.from({ length: columns.length }, (_, index) => (
      capLines(wrapThai(formatCell(row?.[index]), widths[index] - 2 * CELL_PADDING_X, bodyMeasure))
    ));
    const height = Math.max(...cells.map((lines) => lines.length)) * LINE_HEIGHT + 2 * CELL_PADDING_Y;

    if (context.y + height > context.bottomLimit) {
      doc.addPage();
      context.y = doc.page.margins.top;
      drawHeaderRow();
    }

    if (rowIndex % 2 === 1) {
      doc.save();
      doc.rect(context.left, context.y, context.contentWidth, height).fill('#F7F8FA');
      doc.restore();
    }
    doc.font(REGULAR).fontSize(bodyFontSize).fillColor('#111111');
    let x = context.left;
    cells.forEach((lines, index) => {
      lines.forEach((line, lineIndex) => {
        doc.text(line, x + CELL_PADDING_X, context.y + CELL_PADDING_Y + lineIndex * LINE_HEIGHT, {
          width: widths[index] - 2 * CELL_PADDING_X,
          align: columns[index].align === 'right' ? 'right' : 'left',
          lineBreak: false,
        });
      });
      x += widths[index];
    });
    context.y += height;
  });
  context.y += 2;
}

/** After the content is laid out, stamp every buffered page with its header, footer and watermark. */
function finishPages(doc, model, generatedAt, contentWidth) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  const generatedLine = `สร้างเอกสารเมื่อ ${formatThaiDateTime(generatedAt) ?? '—'}`;
  const statusLine = `สถานะการคำนวณ: ${model.statusLabelTh}${model.isFinal ? ' (สรุปได้)' : ' (ฉบับร่าง)'}`;
  for (let index = 0; index < total; index += 1) {
    doc.switchToPage(range.start + index);
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const left = doc.page.margins.left;

    if (model.watermark) {
      doc.save();
      doc.fillOpacity(0.08).fillColor('#B00020');
      doc.rotate(-45, { origin: [pageWidth / 2, pageHeight / 2] });
      doc.font(BOLD).fontSize(96);
      const labelWidth = doc.widthOfString(model.watermark.label, { width: Infinity });
      doc.text(model.watermark.label, pageWidth / 2 - labelWidth / 2, pageHeight / 2, { lineBreak: false });
      doc.restore();
      doc.fillOpacity(1);
    }

    doc.font(BOLD).fontSize(10.5).fillColor('#111111');
    doc.text(model.title, left, 42, { width: contentWidth, lineBreak: false });
    doc.font(REGULAR).fontSize(8).fillColor('#555555');
    doc.text(`${model.employee.nameTh} · ${model.period.label} · ${model.employee.employeeId}`, left, 58, {
      width: contentWidth,
      lineBreak: false,
    });
    doc.moveTo(left, 74).lineTo(left + contentWidth, 74).lineWidth(0.6).strokeColor('#CCCCCC').stroke();

    doc.font(REGULAR).fontSize(8).fillColor('#666666');
    doc.text(generatedLine, left, pageHeight - 40, { lineBreak: false });
    const pageLabel = `หน้า ${index + 1} / ${total}`;
    const pageLabelWidth = doc.widthOfString(pageLabel, { width: Infinity });
    doc.text(pageLabel, left + contentWidth / 2 - pageLabelWidth / 2, pageHeight - 40, { lineBreak: false });
    doc.fillColor(model.isFinal ? '#666666' : '#B00020').font(BOLD);
    const statusWidth = doc.widthOfString(statusLine, { width: Infinity });
    doc.text(statusLine, left + contentWidth - statusWidth, pageHeight - 40, { lineBreak: false });
    doc.fillColor('#000000');
  }
}

module.exports = {
  renderReportPdf,
  wrapThai,
  tokenizeForWrap,
  formatCell,
  resolveFontFiles,
  REGULAR,
  BOLD,
};

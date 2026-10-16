/**
 * R-03 export service: turn an R-02 report into a downloadable PDF or XLSX.
 *
 * The whole point of this layer is that it DERIVES NOTHING. It calls `attendanceReportService` — the single
 * source of report data — and renders exactly what that service returned, so an exported total is the same
 * number the JSON endpoint reports. The only extra read is the employee display record (id, Thai name,
 * department, position) needed to put a name on the document; `national_id`, HMAC values, tokens, password
 * hashes, facescan ids and internal row ids are never selected, never written and never logged.
 *
 * Ordering matters and is deliberate:
 *
 *   1. `format` and `kind` are validated (pure parameter checks, no data access),
 *   2. the R-02 service is called, which enforces SCOPE before EXISTENCE (`assertCanReadEmployee`, then the
 *      employee lookup) and the period bounds,
 *   3. only then is the display name read and the artifact rendered.
 *
 * A failure anywhere in step 2 propagates unchanged (403/404/400), so an export can never be a side channel
 * around the R-02 authorization contract. A renderer failure is wrapped as `EXPORT_RENDER_FAILED` without
 * leaking internals; the one exception is our own `EXPORT_FONT_MISSING`, which is already a clear code.
 */
const { HttpError } = require('../utils/httpError');
const { createAttendanceReportService } = require('./attendanceReportService');
const { buildExportModel, safeExportFileName } = require('../domain/attendanceReportPresentation');
const { renderReportPdf } = require('./export/pdfRenderer');
const { writeXlsx } = require('./export/xlsxWriter');

const FORMATS = Object.freeze({
  pdf: {
    extension: 'pdf',
    contentType: 'application/pdf',
  },
  xlsx: {
    extension: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
});

const EXPORT_KINDS = Object.freeze(['day', 'month', 'academic_year']);

/** The two-column block used for the summary sheet: a bold label and its value. */
function summaryColumns() {
  return [
    { header: 'รายการ', width: 44, type: 'text', role: 'label' },
    { header: 'ค่า', width: 92 },
  ];
}

/**
 * One sheet for meta/totals/facts, plus one sheet per table section.
 *
 * Every sheet repeats the header line and (when the report is not final) the DRAFT banner, so no page of the
 * workbook can be printed without the honesty marker.
 */
function buildWorkbook(model) {
  const summaryRows = model.meta.map((row) => [row.label, row.value]);
  const tableSections = [];

  for (const section of model.sections ?? []) {
    if (section.type === 'days' || section.type === 'months') {
      tableSections.push(section);
      continue;
    }
    summaryRows.push([section.title]);
    for (const row of section.rows ?? []) summaryRows.push([row.label, row.value]);
  }

  const sheets = [{ name: 'สรุป', columns: summaryColumns(), rows: summaryRows }];
  for (const section of tableSections) {
    sheets.push({
      name: section.type === 'days' ? 'รายวัน' : 'รายเดือน',
      columns: (section.columns ?? []).map((column) => ({
        header: column.header,
        width: column.width,
        type: column.type,
      })),
      rows: section.rows ?? [],
    });
  }

  return {
    sheets,
    watermark: model.watermark,
    sheetHeaderText: `${model.title} · ${model.employee.nameTh} · ${model.period.label}`,
  };
}

function createExportService({ repositories, now = () => new Date() } = {}) {
  const reportService = createAttendanceReportService({ repositories, now });
  const employees = repositories?.employees;

  /**
   * The employee display record, and nothing else. A report needs a name on it; it does not need an
   * identifier that could be used to impersonate anyone, so only these four fields are copied out.
   */
  async function lookupEmployee(employeeUid) {
    const fallback = { employeeId: employeeUid == null ? '—' : String(employeeUid) };
    if (!employees || typeof employees.findByUid !== 'function') return fallback;
    const employee = await employees.findByUid(employeeUid);
    if (!employee) return fallback;
    const nameTh = [employee.firstNameTh, employee.lastNameTh]
      .filter((part) => typeof part === 'string' && part.trim() !== '')
      .join(' ')
      .trim();
    return {
      employeeId: employee.employeeId ?? employee.employeeUid ?? fallback.employeeId,
      nameTh: nameTh || employee.employeeId || '—',
      department: employee.department ?? '—',
      position: employee.position ?? '—',
    };
  }

  function normalizeFormat(format) {
    const value = format == null ? '' : String(format).trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(FORMATS, value)) {
      // Anything that is not exactly pdf/xlsx — including a traversal attempt — is a 400, never a file.
      throw new HttpError(400, 'EXPORT_INVALID_FORMAT', 'format is required and must be one of: pdf, xlsx');
    }
    return value;
  }

  function normalizeKind(kind) {
    const value = kind == null ? '' : String(kind).trim();
    if (!EXPORT_KINDS.includes(value)) {
      throw new HttpError(400, 'EXPORT_INVALID_KIND', 'kind must be one of: day, month, academic_year');
    }
    return value;
  }

  return {
    buildWorkbook,

    async exportReport(auth, {
      kind, employeeUid, date, year, month, format,
    } = {}) {
      // Step 1: parameter validation only. Nothing is read.
      const resolvedKind = normalizeKind(kind);
      const resolvedFormat = normalizeFormat(format);

      // Step 2: the R-02 service owns scope, existence and period validation. Let it throw.
      let payload;
      if (resolvedKind === 'day') {
        payload = await reportService.dayReport(auth, employeeUid, date);
      } else if (resolvedKind === 'month') {
        payload = await reportService.monthReport(auth, employeeUid, Number(year), Number(month));
      } else {
        payload = await reportService.academicYearReport(auth, employeeUid, Number(year));
      }

      // Step 3: a display name may be read now, and only now.
      const employee = await lookupEmployee(employeeUid);
      const generatedAt = now();
      const model = buildExportModel({ ...payload, employee }, { kind: resolvedKind, generatedAt });

      let buffer;
      try {
        buffer = resolvedFormat === 'pdf'
          ? await renderReportPdf(model, { now: () => generatedAt })
          : writeXlsx(buildWorkbook(model));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(500, 'EXPORT_RENDER_FAILED', `The ${resolvedFormat} renderer failed`);
      }

      const period = payload.report?.period ?? {};
      const periodLabel = period.date ?? period.key ?? period.academicYear ?? '';

      return {
        buffer,
        contentType: FORMATS[resolvedFormat].contentType,
        fileName: safeExportFileName({
          kind: resolvedKind,
          period: periodLabel,
          employeeUid,
          format: FORMATS[resolvedFormat].extension,
        }),
        report: payload,
      };
    },
  };
}

module.exports = { createExportService, buildWorkbook, FORMATS, EXPORT_KINDS };

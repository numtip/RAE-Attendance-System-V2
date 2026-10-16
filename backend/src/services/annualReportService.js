/**
 * R-05 annual HR report service.
 *
 * The ANNUAL layer, and it DERIVES NOTHING:
 *
 *   * every per-month number comes from `attendanceReportService` (R-02) — it does not recompute a day,
 *     re-derive a month or re-judge a status, so the annual figure and the monthly figure can never
 *     disagree;
 *   * every employee display field comes from the same source R-03 uses (`employees.findByUid`, copied
 *     out four fields deep, never a national id, a password hash or a token);
 *   * the rendered artifact reuses the R-03 renderer (`renderReportPdf` / the zero-dependency XLSX
 *     writer) and the R-03 watermark constants, so there is ONE watermark mechanism in this codebase.
 *
 * The model handed to those renderers is built in exactly the shape `buildExportModel`
 * (`domain/attendanceReportPresentation.js`) produces, because this slice may not modify that module:
 * same fields, same section types, same watermark object. The only annual-specific difference is the
 * title/period label, which must name the FISCAL or the ACADEMIC window rather than say "academic" for
 * both.
 *
 * Authorization reuses `assertCanReadEmployee` (services/access.js) — scope BEFORE existence, before any
 * read — so a cross-scope caller gets the JSON 403 envelope and an unknown employee in scope gets a 404.
 * The scope resolver is not re-implemented here. Both endpoints are read-only by construction: there is
 * no POST/derive variant.
 */
const { HttpError } = require('../utils/httpError');
const { formatBangkokWall } = require('../utils/bangkokTime');
const { assertCanReadEmployee } = require('./access');
const { createAttendanceReportService } = require('./attendanceReportService');
const { buildWorkbook, FORMATS } = require('./exportService');
const { renderReportPdf } = require('./export/pdfRenderer');
const { writeXlsx } = require('./export/xlsxWriter');
const {
  TOTALS_LABELS,
  STATUS_LABEL_TH,
  THAI_MONTHS_SHORT,
  DRAFT_LABEL,
  DRAFT_WATERMARK_TEXT,
  DRAFT_NOTE_TH,
  toBuddhistYear,
  formatThaiDate,
  formatThaiDateTime,
  statusReasonToThai,
  labelOf,
  safeExportFileName,
} = require('../domain/attendanceReportPresentation');
const {
  ANNUAL_VERDICT,
  ANNUAL_TOTAL_FIELDS,
  ANNUAL_NULLABLE_FIELD,
  buildMonthCoverage,
  buildAnnualTotals,
  annualVerdictOf,
  annualComputationStatusOf,
  isFinalMonthStatus,
  annualPeriodOf,
} = require('../domain/annualAttendanceReport');

/**
 * The exact Thai sentence R-03 uses for a figure that genuinely could not be derived
 * (`numberOrUnavailable` in `attendanceReportPresentation.js`). Reused verbatim rather than re-worded, so
 * a reader sees the same phrase for the same meaning in a monthly and an annual artifact.
 */
const UNAVAILABLE_TH = 'ไม่สามารถคำนวณได้';

/** The month-total fields copied out of the R-02 month body. `expectedWorkingDays` may be NULL. */
const MONTH_TOTAL_FIELDS = Object.freeze([
  'totalWorkDays',
  'totalPresent',
  'totalLate',
  'totalAbsent',
  'totalLeave',
  'totalLateMinutes',
  'totalEarlyMinutes',
  'totalWorkHours',
  'expectedWorkingDays',
  'pendingDays',
  'holidayDays',
]);

/** Thai titles for the two conventions. Composed from wording that already exists in this repo. */
const ANNUAL_TITLE_TH = Object.freeze({
  fiscal: 'รายงานการมาทำงานรายปีงบประมาณ',
  academic: 'รายงานการมาทำงานรายปีการศึกษา',
});

const EXPORT_KIND_SLUG = Object.freeze({
  fiscal: 'annual-fiscal',
  academic: 'annual-academic',
});

const ANNUAL_COLUMNS = Object.freeze([
  { key: 'key', header: 'เดือน', width: 12, type: 'text', align: 'left' },
  { key: 'status', header: 'สถานะการคำนวณ', width: 20, type: 'text', align: 'left' },
  { key: 'final', header: 'สรุปได้', width: 10, type: 'text', align: 'center' },
  { key: 'available', header: 'มีข้อมูล', width: 10, type: 'text', align: 'center' },
  { key: 'cutoff', header: 'ตัดข้อมูล', width: 13, type: 'text', align: 'center' },
  { key: 'present', header: 'มา (วัน)', width: 9, type: 'number', align: 'right' },
  { key: 'absent', header: 'ขาด (วัน)', width: 9, type: 'number', align: 'right' },
  { key: 'hours', header: 'ชั่วโมงรวม', width: 11, type: 'number', align: 'right' },
]);

/** A number stays a number; `null` becomes the same Thai sentence R-03 uses — never a 0. */
function numberOrUnavailable(value) {
  if (value == null) return UNAVAILABLE_TH;
  const num = Number(value);
  return Number.isFinite(num) ? num : String(value);
}

function countOrDash(value) {
  if (value == null) return '—';
  const num = Number(value);
  return Number.isFinite(num) ? num : String(value);
}

function pick(source, fields) {
  const out = {};
  for (const field of fields) out[field] = source?.[field] ?? null;
  return out;
}

/** Sorted, de-duplicated union of rule-version codes across the months. */
function unionOfLists(lists) {
  const set = new Set();
  for (const list of lists) {
    for (const value of Array.isArray(list) ? list : []) {
      if (value != null && value !== '') set.add(String(value));
    }
  }
  return Array.from(set).sort();
}

/** The employee display record and nothing else: no national id, no hash, no token. */
async function safeEmployeeDisplay(employees, employeeUid) {
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

/** The assignment window effective on an ISO day, or null when none covers it (never a guess). */
function codeEffectiveOn(windows, isoDate) {
  const hits = (Array.isArray(windows) ? windows : [])
    .filter((row) => (row.effectiveFrom == null || row.effectiveFrom <= isoDate)
      && (row.effectiveTo == null || row.effectiveTo >= isoDate))
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0));
  return hits.length > 0 ? (hits[0].employeeCode ?? null) : null;
}

/** The `meta` rows every artifact carries: provenance and the honesty verdict, in that order. */
function buildMetaRows(report, { generatedAt }) {
  const statusLabel = labelOf(STATUS_LABEL_TH, report.computationStatus, '—');
  const population = report.population ?? {};
  const ruleVersions = Array.isArray(report.ruleVersions) ? report.ruleVersions : [];
  const verdictTh = report.annualVerdict === ANNUAL_VERDICT.COMPLETE ? 'ครบถ้วน' : 'ยังไม่ครบถ้วน';
  const rows = [
    { label: 'สถานะการคำนวณ (computationStatus)', value: `${statusLabel} (${report.computationStatus ?? '—'})` },
    { label: 'สรุปเป็นผลสรุปได้ (isFinal)', value: report.isFinal === true ? 'ใช่ (true)' : 'ไม่ใช่ (false)' },
    { label: 'ผลสรุปรายปี (annualVerdict)', value: `${verdictTh} (${report.annualVerdict ?? '—'})` },
    {
      label: 'ประชากรของรายงาน (population)',
      value: `${countOrDash(population.employees)} คน · uid ${population.employeeUid ?? '—'} · `
        + `${countOrDash(population.dayRows)} แถวรายวัน`,
    },
    { label: 'วันที่ตัดข้อมูล (dateCutoff)', value: formatThaiDate(report.dateCutoff) ?? '—' },
    { label: 'เวอร์ชันกฎที่ใช้ (ruleVersions)', value: ruleVersions.length > 0 ? ruleVersions.join(', ') : '—' },
    { label: 'แหล่งข้อมูล (generatedFrom)', value: report.generatedFrom ?? '—' },
  ];
  const generated = formatThaiDateTime(generatedAt);
  if (generated) rows.push({ label: 'สร้างเอกสารเมื่อ', value: generated });
  return rows;
}

function totalsRows(totals) {
  return TOTALS_LABELS.map(([field, label]) => ({ label, value: numberOrUnavailable(totals?.[field]) }));
}

function monthTableRow(entry) {
  return [
    THAI_MONTHS_SHORT[Number(entry.month)]
      ? `${THAI_MONTHS_SHORT[Number(entry.month)]} ${toBuddhistYear(entry.year)}`
      : String(entry.key ?? '—'),
    labelOf(STATUS_LABEL_TH, entry.computationStatus),
    entry.isFinal === true ? 'สรุปได้' : 'ยังไม่สรุป',
    entry.reportAvailable === true ? 'มี' : 'ไม่มี',
    formatThaiDate(entry.dateCutoff, { short: true }) ?? '—',
    countOrDash(entry.totals?.totalPresent),
    countOrDash(entry.totals?.totalAbsent),
    countOrDash(entry.totals?.totalWorkHours),
  ];
}

function coverageRows(payload) {
  const coverage = payload.monthCoverage ?? {};
  const excluded = Array.isArray(coverage.monthsExcluded) ? coverage.monthsExcluded : [];
  return [
    { label: 'ช่วงเวลาของรายงาน', value: `${formatThaiDate(payload.report.period.from) ?? '—'} - ${formatThaiDate(payload.report.period.to) ?? '—'}` },
    { label: 'ช่วงเวลาปิดแล้ว', value: payload.yearSummary?.periodClosed === true ? 'ใช่' : 'ไม่ใช่' },
    { label: 'ข้อมูล ณ วันที่', value: formatThaiDate(payload.yearSummary?.asOf) ?? '—' },
    { label: 'เดือนในรอบปี', value: countOrDash(coverage.monthsInPeriod) },
    { label: 'เดือนที่ร่วมยอดรวม', value: (coverage.monthsContributed ?? []).join(', ') || '—' },
    {
      label: 'เดือนที่ไม่ร่วมยอดรวม',
      value: excluded.length > 0 ? excluded.map((item) => `${item.key} (${item.reason})`).join(', ') : '—',
    },
    { label: 'ครบถ้วนทั้งปี', value: coverage.complete === true ? 'ใช่' : 'ไม่ใช่' },
  ];
}

function availabilityRows(payload) {
  const availability = payload.totalsAvailability ?? {};
  const labels = new Map(TOTALS_LABELS.map(([field, label]) => [field, label]));
  const fields = [...ANNUAL_TOTAL_FIELDS, ANNUAL_NULLABLE_FIELD];
  const unavailable = fields.filter((field) => availability[field]?.available !== true);
  if (unavailable.length === 0) {
    return [{ label: 'ยอดรวมรายปี', value: 'ครบทุกตัวชี้วัด (มีตัวเลขทุกช่อง)' }];
  }
  return unavailable.map((field) => ({
    label: `${labels.get(field) ?? field} (${field})`,
    value: availability[field]?.reason ?? '—',
  }));
}

function caveatRows(caveats) {
  if (!Array.isArray(caveats) || caveats.length === 0) {
    return [{ label: 'caveats', value: 'ไม่มีข้อจำกัดที่บันทึกไว้' }];
  }
  // The detail is English prose authored by R-02, rendered as-is; the code stays traceable.
  return caveats.map((caveat) => ({ label: String(caveat?.code ?? '—'), value: caveat?.detail ?? '—' }));
}

/**
 * Annual-only reason codes, translated with wording that already exists in this repo. Anything else goes
 * through R-03's `statusReasonToThai` unchanged, so an R-02 code never gets a second translation.
 */
const ANNUAL_REASON_TH = Object.freeze({
  annual_period_not_closed: 'รอบปีนี้ยังไม่สิ้นสุด ช่วงเวลาจึงยังไม่ปิด',
  month_not_yet_started: 'มีเดือนในรอบปีที่ยังไม่เริ่มต้น จึงยังไม่มีข้อมูล',
});

function annualReasonToThai(code) {
  const raw = String(code ?? '').trim();
  if (Object.prototype.hasOwnProperty.call(ANNUAL_REASON_TH, raw)) return ANNUAL_REASON_TH[raw];
  return statusReasonToThai(raw);
}

function statusReasonRows(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  const translated = list.map(annualReasonToThai).filter(Boolean);
  if (translated.length === 0) {
    return [{ label: 'statusReasons', value: 'ไม่มี — รายงานนี้เป็นผลสรุปที่สมบูรณ์' }];
  }
  return translated.map((text, index) => ({ label: `เหตุผล ${index + 1}`, value: text }));
}

/**
 * The canonical export model for the annual report, in the shape `buildExportModel` produces so the
 * already-verified R-03 renderers consume it unchanged. The watermark object is the SAME shape and the
 * SAME constants — this is a reuse of the one watermark mechanism, not a second one.
 */
function buildAnnualExportModel({ payload, employee = {}, generatedAt = null }) {
  const report = payload.report;
  const period = report.period;
  const isFinal = report.isFinal === true;
  const label = period.labelTh;

  const sections = [
    { type: 'totals', title: `ยอดรวมของ${label}`, rows: totalsRows(payload.totals) },
    { type: 'months', title: `รายเดือนของ${label}`, columns: ANNUAL_COLUMNS, rows: payload.months.map(monthTableRow) },
    { type: 'facts', title: 'ความครบถ้วนของเดือน (monthCoverage)', rows: coverageRows(payload) },
    { type: 'facts', title: 'เหตุผลที่ยอดรวมรายปีว่าง (totalsAvailability)', rows: availabilityRows(payload) },
    { type: 'facts', title: 'ข้อจำกัดของข้อมูล (caveats)', rows: caveatRows(report.caveats) },
    {
      type: 'facts',
      title: 'เหตุผลที่รายงานนี้ยังไม่สมบูรณ์ (statusReasons)',
      rows: statusReasonRows(report.statusReasons),
    },
  ];

  return {
    kind: period.periodKind,
    title: ANNUAL_TITLE_TH[period.periodKind] ?? 'รายงานการมาทำงานรายปี',
    isFinal,
    computationStatus: report.computationStatus ?? null,
    statusLabelTh: labelOf(STATUS_LABEL_TH, report.computationStatus, '—'),
    watermark: isFinal ? null : { label: DRAFT_LABEL, text: DRAFT_WATERMARK_TEXT, noteTh: DRAFT_NOTE_TH },
    meta: buildMetaRows(report, { generatedAt }),
    employee: {
      employeeId: employee.employeeId ?? '—',
      nameTh: employee.nameTh ?? '—',
      department: employee.department ?? '—',
      position: employee.position ?? '—',
    },
    period: {
      label,
      fromTh: formatThaiDate(period.from) ?? '—',
      toTh: formatThaiDate(period.to) ?? '—',
    },
    sections,
    caveats: Array.isArray(report.caveats) ? report.caveats : [],
    statusReasons: statusReasonRows(report.statusReasons).map((row) => row.value),
  };
}

function createAnnualReportService({ repositories, now = () => new Date() } = {}) {
  const reportService = createAttendanceReportService({ repositories, now });
  const employees = repositories?.employees;
  const assignments = repositories?.employeeAssignments;

  const todayWallDate = () => formatBangkokWall(now()).slice(0, 10);

  /** `format` is REQUIRED with no default, exactly as R-03 does. A traversal attempt is a 400, never a file. */
  function normalizeFormat(format) {
    const value = format == null ? '' : String(format).trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(FORMATS, value)) {
      throw new HttpError(400, 'EXPORT_INVALID_FORMAT', 'format is required and must be one of: pdf, xlsx');
    }
    return value;
  }

  /**
   * Which employee code the person's own records were under in each month, from the effective-dated
   * `employee_assignment` windows. Read-only provenance, and optional: a container without the repository
   * simply reports nothing rather than guessing.
   */
  async function ownershipOf(employeeUid, months) {
    if (!assignments || typeof assignments.listByEmployeeUid !== 'function') {
      return {
        source: null,
        employeeCodeByMonth: {},
        distinctCodesInPeriod: [],
        codeChangedWithinPeriod: false,
        codeChangedAtMonths: [],
        crossEmployeeOwnershipDetection: {
          evaluated: false,
          reason: 'employee_assignment repository is not available in this container',
        },
      };
    }
    const windows = await assignments.listByEmployeeUid(employeeUid);
    const employeeCodeByMonth = {};
    const codeChangedAtMonths = [];
    let previous = null;
    for (const entry of months) {
      const code = codeEffectiveOn(windows, entry.from);
      employeeCodeByMonth[entry.key] = code;
      if (previous != null && code != null && code !== previous) codeChangedAtMonths.push(entry.key);
      if (code != null) previous = code;
    }
    const distinctCodesInPeriod = Array.from(
      new Set(Object.values(employeeCodeByMonth).filter((value) => value != null)),
    ).sort();
    return {
      source: 'employee_assignment',
      employeeCodeByMonth,
      distinctCodesInPeriod,
      codeChangedWithinPeriod: codeChangedAtMonths.length > 0,
      codeChangedAtMonths,
      crossEmployeeOwnershipDetection: {
        evaluated: false,
        reason: 'no repository method lists the other holders of an employee code, so an ownership '
          + 'change across employees cannot be established from the data this layer may read',
      },
    };
  }

  /** The annual report for ONE employee and ONE named convention. Read-only. */
  async function annualReport(auth, { periodKind, employeeUid, year } = {}) {
    const period = annualPeriodOf(periodKind, year);

    // Scope first, existence second — the same order R-02/R-03 use, before any data read.
    await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
    if (employees && typeof employees.findByUid === 'function') {
      const employee = await employees.findByUid(employeeUid);
      if (!employee) throw new HttpError(404, 'ANNUAL_UNKNOWN_EMPLOYEE', 'Employee was not found');
    }

    const today = todayWallDate();

    const months = [];
    for (const entry of period.months) {
      // Every number below comes from R-02's own month report. Nothing is recomputed here.
      const payload = await reportService.monthReport(auth, employeeUid, entry.year, entry.month);
      const report = payload.report;
      const started = today >= report.period.from;
      months.push({
        key: report.period.key,
        year: entry.year,
        month: entry.month,
        from: report.period.from,
        to: report.period.to,
        started,
        reportAvailable: payload.month != null,
        computationStatus: report.computationStatus,
        isFinal: started && isFinalMonthStatus(report.computationStatus),
        dateCutoff: report.dateCutoff,
        dayRows: report.population.dayRows,
        population: report.population,
        ruleVersions: Array.isArray(report.ruleVersions) ? report.ruleVersions : [],
        statusReasons: started ? report.statusReasons : ['month_not_yet_started'],
        caveats: Array.isArray(report.caveats) ? report.caveats : [],
        totals: payload.month ? pick(payload.month, MONTH_TOTAL_FIELDS) : null,
      });
    }

    const coverage = buildMonthCoverage(months);
    const { totals, availability } = buildAnnualTotals(months, coverage);
    const computationStatus = annualComputationStatusOf(months);
    const periodClosed = today > period.to;
    const annualVerdict = annualVerdictOf({ months, periodClosed });
    const isFinal = annualVerdict === ANNUAL_VERDICT.COMPLETE;

    const statusReasons = [];
    if (!periodClosed) statusReasons.push('annual_period_not_closed');
    for (const entry of months) {
      if (!entry.started) continue; // a month that has not happened is not "missing data"
      if (entry.reportAvailable !== true) statusReasons.push(`month_not_derived:${entry.key}`);
      else if (!entry.isFinal) statusReasons.push(`month_${entry.computationStatus}:${entry.key}`);
    }

    // Union of the month caveats, de-duplicated by code, in first-seen order.
    const caveatByCode = new Map();
    for (const entry of months) {
      for (const caveat of entry.caveats) {
        if (caveat?.code && !caveatByCode.has(caveat.code)) caveatByCode.set(caveat.code, caveat);
      }
    }

    const dateCutoff = months.map((entry) => entry.dateCutoff).filter(Boolean).sort().pop() ?? null;
    const dayRows = months.reduce((sum, entry) => sum + (Number(entry.dayRows) || 0), 0);

    const report = {
      kind: period.reportKind,
      period: { ...period },
      population: { employees: 1, employeeUid, dayRows },
      ruleVersions: unionOfLists(months.map((entry) => entry.ruleVersions)),
      dateCutoff,
      computationStatus,
      isFinal,
      annualVerdict,
      statusReasons,
      caveats: Array.from(caveatByCode.values()),
      generatedFrom: 'monthly_summary_via_attendanceReportService',
    };

    return {
      report,
      period: { ...period },
      annualVerdict,
      totals,
      totalsAvailability: availability,
      monthCoverage: coverage,
      ownership: await ownershipOf(employeeUid, months),
      months,
      yearSummary: {
        periodKind: period.periodKind,
        labelTh: period.labelTh,
        from: period.from,
        to: period.to,
        periodClosed,
        asOf: today,
        monthsInPeriod: months.length,
        monthsContributed: coverage.monthsContributed.length,
        monthsExcluded: coverage.monthsExcluded.length,
        complete: coverage.complete,
        totals,
      },
    };
  }

  /** The fiscal-year window, named by its Buddhist-Era year (e.g. 2569). */
  function fiscalYearReport(auth, employeeUid, fiscalYear) {
    return annualReport(auth, { periodKind: 'fiscal', employeeUid, year: fiscalYear });
  }

  /** The annual academic-year window (1 June - 31 May), named by the Gregorian year it starts. */
  function academicAnnualReport(auth, employeeUid, year) {
    return annualReport(auth, { periodKind: 'academic', employeeUid, year });
  }

  /** The Gregorian `YYYY-MM-YYYY-MM` slug for a filename. The Buddhist label never enters a filename. */
  function gregorianSlug(period) {
    return `${String(period.gregorianFrom).slice(0, 7)}-${String(period.gregorianTo).slice(0, 7)}`;
  }

  /** Render the annual report as a PDF or XLSX, reusing the R-03 renderer and watermark. */
  async function exportAnnualReport(auth, {
    periodKind, employeeUid, year, format,
  } = {}) {
    // Step 1: parameter validation only. Nothing is read.
    const resolvedFormat = normalizeFormat(format);

    // Step 2: the report service owns scope, existence and period validation. Let it throw.
    const payload = await annualReport(auth, { periodKind, employeeUid, year });

    // Step 3: a display name may be read now, and only now.
    const employee = await safeEmployeeDisplay(employees, employeeUid);
    const generatedAt = now();
    const model = buildAnnualExportModel({ payload, employee, generatedAt });

    let buffer;
    try {
      buffer = resolvedFormat === 'pdf'
        ? await renderReportPdf(model, { now: () => generatedAt })
        : writeXlsx(buildWorkbook(model));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, 'EXPORT_RENDER_FAILED', `The ${resolvedFormat} renderer failed`);
    }

    const period = payload.report.period;
    return {
      buffer,
      contentType: FORMATS[resolvedFormat].contentType,
      fileName: safeExportFileName({
        kind: EXPORT_KIND_SLUG[period.periodKind] ?? 'annual',
        period: gregorianSlug(period),
        employeeUid,
        format: FORMATS[resolvedFormat].extension,
      }),
      report: payload,
    };
  }

  return {
    annualReport,
    fiscalYearReport,
    academicAnnualReport,
    exportAnnualReport,
  };
}

module.exports = {
  createAnnualReportService,
  buildAnnualExportModel,
  ANNUAL_TITLE_TH,
  EXPORT_KIND_SLUG,
  UNAVAILABLE_TH,
};

const { HttpError } = require('../utils/httpError');
const { resolveScope } = require('./authorizationService');
const { bangkokDate } = require('./leaveEntitlementService');
const { createLeaveOwnerEntryService } = require('./leaveOwnerEntryService');
const { writeXlsx } = require('./export/xlsxWriter');
const { fiscalYearOf } = require('../domain/leavePolicyEngine');
const csv = require('../domain/hrLeaveCsv');
const { TYPE_MAP } = require('../imports/employeeProfileCli');
const { runLeaveHrImport } = require('../imports/leaveHrImportCli');
const { EXIT } = require('../imports/facescanImportCli');

const KIND_TH = Object.fromEntries(Object.entries(csv.APPOINTMENT_KINDS).map(([th, code]) => [code, th]));
const LEAVE_TYPE_TH = Object.fromEntries(Object.entries(csv.LEAVE_TYPES).map(([th, code]) => [code, th]));
const TYPE_TH = Object.fromEntries(Object.entries(TYPE_MAP).map(([th, code]) => [code, th]));
const LEAVE_ORDER = ['sick', 'personal', 'vacation'];
const EXISTING_SOURCE = 'ข้อมูลเดิมในระบบ';
const MAX_UPLOAD_CHARS = 900000;
const MAX_FINDINGS = 300;
const bad = (message) => new HttpError(400, 'VALIDATION_ERROR', message);

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
/** UTF-8 with a BOM so Excel opens Thai text correctly; the importer's parser strips it again. */
const BOM = String.fromCharCode(0xfeff);
const toCsv = (header, rows) => Buffer.from(`${BOM}${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`, 'utf8');

/**
 * Owner-only bulk data management on top of the existing HR leave import:
 *  - `exportTemplate`: the current profile / entitlement data in the import's own column layout (CSV, or an Excel
 *    copy for editing — saved back as CSV for upload). Contract staff are never listed.
 *  - `importFiles`: upload -> validation -> dry-run preview -> confirmed import, by calling the SAME function the
 *    `npm run leave:import-hr-data` tool runs (same rules, same SHA-256 idempotency, same audit rows).
 *  - `bulkEligibility`: confirm (or decline, or clear) the eligibility of several people at once, with the owner's
 *    reference, each person audited like a single entry.
 * Everything needs an executive with an organization grant. Nothing is invented: a blank cell stays blank.
 * Every employment type is listed (university, section, section contract, procurement); what a row may contain follows
 * the person's own policy, which the importer enforces.
 */
function createLeaveBulkManagementService(container) {
  const { repositories } = container;
  const now = container.now || (() => new Date());
  const ownerEntry = createLeaveOwnerEntryService({ repositories, now });

  async function requireOwner(auth) {
    const scope = await resolveScope(auth, repositories, 'data');
    if (!scope.all) throw new HttpError(403, 'FORBIDDEN', 'Only an executive with an organization grant can manage leave data');
  }

  async function onboardingPeople() {
    return (await repositories.employees.list())
      .filter((e) => e.status === undefined || e.status === 'active')
      .sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId), 'en', { numeric: true }));
  }

  return {
    async exportTemplate(auth, { kind, format = 'csv', year } = {}) {
      await requireOwner(auth);
      if (!['profile', 'entitlement'].includes(kind)) throw bad('kind must be profile or entitlement');
      if (!['csv', 'xlsx'].includes(format)) throw bad('format must be csv or xlsx');
      const today = bangkokDate(now());
      const currentFy = fiscalYearOf(today).be;
      const fy = year === undefined || year === '' ? currentFy : Number(year);
      if (!Number.isInteger(fy) || fy < 2569 || fy > currentFy + 1) throw bad(`year must be a fiscal year from 2569 to ${currentFy + 1}`);

      const people = await onboardingPeople();
      const uids = people.map((p) => p.employeeUid);
      let header; let rows; let sheetName; let notes;
      if (kind === 'profile') {
        const [facts, profiles] = await Promise.all([repositories.employees.listLeaveFacts(uids), repositories.leaveHr.listProfiles(uids)]);
        const factBy = new Map(facts.map((f) => [f.employeeUid, f]));
        const profileBy = new Map(profiles.map((p) => [p.employeeUid, p]));
        const c = csv.PROFILE_COLUMNS;
        header = [c.employeeId, c.name, c.type, c.hireDate, c.continuousServiceStart, c.appointmentKind, c.eligibilityConfirmed, c.eligibilityReference, c.sourceReference, c.note];
        rows = people.map((p) => {
          const pr = profileBy.get(p.employeeUid);
          const hire = factBy.get(p.employeeUid)?.hireDate ?? '';
          const hasData = Boolean(hire || pr?.continuousServiceStart || pr?.appointmentKind || pr?.eligibilityConfirmed !== undefined && pr?.eligibilityConfirmed !== null);
          // A row that already carries data needs a source to be uploaded again unchanged; a stored value without one
          // (e.g. a hire date set earlier) is labelled as existing data. A source-only difference is not a change.
          return [
            p.employeeId, `${p.firstNameTh || ''} ${p.lastNameTh || ''}`.trim(), TYPE_TH[p.employeeType] || '',
            hire, pr?.continuousServiceStart ?? '', pr?.appointmentKind ? KIND_TH[pr.appointmentKind] : '',
            pr?.eligibilityConfirmed === true ? 'ใช่' : (pr?.eligibilityConfirmed === false ? 'ไม่ใช่' : ''), pr?.eligibilityReference ?? '',
            pr?.sourceReference ?? (hasData ? EXISTING_SOURCE : ''), '',
          ];
        });
        sheetName = 'ข้อมูลบุคลากร';
        notes = ['กรอกเฉพาะข้อมูลที่ทราบจริง — เซลล์ว่าง = ไม่เปลี่ยนค่าที่บันทึกไว้, “-” = ลบค่า', 'วันที่: YYYY-MM-DD (ค.ศ.) หรือ DD/MM/YYYY (พ.ศ.)', 'ถ้ากรอกข้อมูลในแถวใด ต้องระบุ “แหล่งข้อมูล/เอกสารอ้างอิง” ในแถวนั้น', 'การยืนยันสิทธิ์: ใช่ / ไม่ใช่ (ต้องมีเลขที่หนังสือหรือเหตุผล)', 'แต่ละประเภทบุคลากรใช้หลักเกณฑ์ของตนเอง: พนักงานส่วนงานจ้างเหมาไม่ต้องกรอกวันที่เริ่มงานหรือยอดสะสม, พนักงานส่วนงานต้องมีวันที่เริ่มงานสำหรับลากิจและลาพักผ่อนเท่านั้น, ยอดสะสมและประเภทการบรรจุใช้กับพนักงานมหาวิทยาลัยเท่านั้น', 'บันทึกเป็นไฟล์ CSV (UTF-8) ก่อนอัปโหลดกลับเข้าระบบ'];
      } else {
        const hr = await repositories.leaveHr.listEntitlementsForYear(uids, fy);
        const hrBy = new Map(hr.map((r) => [`${r.employeeUid}|${r.leaveType}`, r]));
        const c = csv.ENTITLEMENT_COLUMNS;
        header = [c.employeeId, c.fiscalYearBe, c.leaveType, c.entitlementDays, c.carryoverDays, c.usageBaselineDays, c.usageBaselineThrough, c.sourceReference, c.note];
        rows = people.flatMap((p) => LEAVE_ORDER.map((type) => {
          const r = hrBy.get(`${p.employeeUid}|${type}`);
          return [p.employeeId, fy, LEAVE_TYPE_TH[type], r?.entitlementDays ?? '', r?.carryoverDays ?? '', r?.usageBaselineDays ?? '', r?.usageBaselineThrough ?? '', r?.sourceReference ?? '', ''];
        }));
        sheetName = 'สิทธิ์วันลา';
        notes = [`ปีงบประมาณ ${fy}: กรอกเฉพาะแถวที่ต้องการกำหนดสิทธิ์เอง — แถวที่เว้นว่างทั้งหมดจะถูกข้าม`, 'สิทธิ์ที่ได้รับในปีนี้ ไม่รวมยอดสะสมยกมา; ยอดสะสมใช้กับลาพักผ่อนเท่านั้น', 'ใช้ไปแล้วก่อนเริ่มนับในระบบ ต้องกรอกคู่กับ “นับถึงวันที่” (อยู่ในปีงบประมาณเดียวกัน)', 'ทุกแถวที่กรอกต้องระบุแหล่งข้อมูล/เอกสารอ้างอิง', 'บันทึกเป็นไฟล์ CSV (UTF-8) ก่อนอัปโหลดกลับเข้าระบบ'];
      }
      const stem = kind === 'profile' ? 'leave-profile-template' : `leave-entitlement-template-${fy}`;
      if (format === 'csv') return { filename: `${stem}.csv`, contentType: 'text/csv; charset=utf-8', buffer: toCsv(header, rows) };
      const buffer = writeXlsx({
        sheets: [
          { name: sheetName, columns: header.map((h) => ({ header: h, width: Math.max(14, Math.min(40, h.length + 4)) })), rows },
          { name: 'คำอธิบาย', columns: [{ header: 'วิธีใช้', width: 100 }], rows: notes.map((n) => [n]) },
        ],
      });
      return { filename: `${stem}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer };
    },

    /** Dry run by default; `confirm: true` applies. Both go through runLeaveHrImport, the CLI's own function. */
    async importFiles(auth, body = {}) {
      await requireOwner(auth);
      const { profile, entitlement } = body;
      const confirm = body.confirm === true;
      if (body.confirm !== undefined && typeof body.confirm !== 'boolean') throw bad('confirm must be true or false');
      const files = {};
      for (const [kind, text] of [['profile', profile], ['entitlement', entitlement]]) {
        if (text === undefined || text === null || text === '') continue;
        if (typeof text !== 'string' || text.length > MAX_UPLOAD_CHARS) throw bad(`the ${kind} file must be CSV text of at most ${MAX_UPLOAD_CHARS} characters`);
        files[kind] = text;
      }
      if (!Object.keys(files).length) throw bad('upload a profile file, an entitlement file, or both');
      const argv = [];
      for (const kind of Object.keys(files)) argv.push(`--${kind}`, `${kind}.csv`);
      argv.push('--report', 'report.csv');
      if (confirm) argv.push('--confirm', '--operator', auth.employeeUid);
      let reportText = '';
      const { exitCode, report } = await runLeaveHrImport(argv, {
        container,
        readFile: (name) => Buffer.from(files[name.replace('.csv', '')], 'utf8'),
        writeFile: (name, text) => { if (name === 'report.csv') reportText = text; },
      });
      const findings = reportText.split('\n').slice(1).filter(Boolean).map((line) => {
        const [kind, lineNo, level, code] = line.split(',');
        return { kind, line: Number(lineNo), level, code };
      });
      return {
        mode: report.mode || (confirm ? 'apply' : 'dry-run'), exitCode, ok: exitCode === EXIT.OK, written: Boolean(report.written),
        alreadyApplied: Boolean(report.alreadyApplied), blockingErrors: report.blockingErrors ?? 0, refused: report.refused || null,
        files: report.files || {}, preview: report.preview || null, applied: report.applied || null,
        findings: findings.slice(0, MAX_FINDINGS), findingsTruncated: findings.length > MAX_FINDINGS,
      };
    },

    async bulkEligibility(auth, body = {}) {
      await requireOwner(auth);
      const { employeeUids, confirmed } = body;
      if (!Array.isArray(employeeUids) || employeeUids.length < 1 || employeeUids.length > 100) throw bad('employeeUids must list 1 to 100 people');
      if (new Set(employeeUids).size !== employeeUids.length || employeeUids.some((u) => typeof u !== 'string')) throw bad('employeeUids must be distinct ids');
      if (confirmed !== true && confirmed !== false && confirmed !== null) throw bad('confirmed must be true, false or null (clear)');
      const today = bangkokDate(now());
      const reference = body.reference === undefined || body.reference === null || String(body.reference).trim() === '' ? `owner-bulk-confirm ${today}` : String(body.reference).trim();
      if (reference.length > 120) throw bad('reference is at most 120 characters');
      // Check every person BEFORE writing anything: one contract worker or unknown id refuses the whole request.
      const facts = await repositories.employees.listLeaveFacts(employeeUids);
      if (facts.length !== employeeUids.length) throw bad('an employee in the list was not found');
      if (facts.some((f) => f.status !== undefined && f.status !== 'active')) throw bad('an employee in the list is not active');
      let changed = 0;
      const failed = [];
      for (const uid of employeeUids) {
        try {
          const result = await ownerEntry.apply(auth, uid, { eligibility: confirmed === null ? { confirmed: null } : { confirmed, reference } });
          if (result.changed > 0) changed += 1;
        } catch (error) { failed.push({ employeeUid: uid, code: error.code || 'ERROR' }); }
      }
      return { requested: employeeUids.length, changed, unchanged: employeeUids.length - changed - failed.length, failed, reference: confirmed === null ? null : reference };
    },
  };
}

module.exports = { createLeaveBulkManagementService };

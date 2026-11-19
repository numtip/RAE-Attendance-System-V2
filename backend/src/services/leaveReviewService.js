const { HttpError } = require('../utils/httpError');
const { resolveScope } = require('./authorizationService');
const { reportHelpers } = require('./reportService');
const { PART_LABEL, REASON_LABEL, TYPE_LABEL, APPROVAL_LABEL } = require('./leaveLabels');

const { assertPeriod, monthBounds, thaiDate } = reportHelpers;

const FILTERS = ['needs_review', 'unverified', 'approved', 'rejected', 'all'];
const ACTIONS = ['approve', 'reject'];
const PARTS = { FULL: 1.0, AM: 0.5, PM: 0.5 };
const TYPES = ['personal', 'sick', 'vacation'];
const MAX_BATCH = 200;
const MAX_NOTE = 200;

/** One mutually exclusive bucket per record, in the order a reviewer thinks about it. */
function bucketOf(record) {
  if (record.approvalStatus === 'rejected') return 'rejected';
  if (record.reviewStatus === 'needs_review') return 'needs_review';
  return record.approvalStatus === 'approved' ? 'approved' : 'unverified';
}

function snapshot(record) {
  return `type=${record.leaveType};part=${record.dayPart};review=${record.reviewStatus};approval=${record.approvalStatus}`;
}

/**
 * Leave review: an EXECUTIVE with an organization grant (resolveScope('data').all) may list HIP-recorded
 * leave and decide on it. Nobody else may — not a manager, an admin, or an employee — and nothing is
 * granted implicitly. A decision only sets approval_status / classification on employee_leave_record and
 * appends an audit row; it never touches employee_leave, leave_balance or attendance, and deducts nothing.
 *
 * A `needs_review` record cannot be approved as it stands: the reviewer must say which part of the day
 * it was (FULL / AM / PM), so an ambiguous record never silently becomes a counted day.
 */
function createLeaveReviewService({ repositories }) {
  async function requireReviewer(auth) {
    const scope = await resolveScope(auth, repositories, 'data');
    if (!scope.all) {
      throw new HttpError(403, 'FORBIDDEN', 'Only an executive with an organization grant can review leave');
    }
  }

  return {
    async list(auth, query) {
      await requireReviewer(auth);
      const year = Number(query.year);
      const month = Number(query.month);
      assertPeriod(year, month);
      const filter = query.filter || 'needs_review';
      if (!FILTERS.includes(filter)) throw new HttpError(400, 'VALIDATION_ERROR', 'filter is invalid');

      const { start, end } = monthBounds(year, month);
      const employees = new Map((await repositories.employees.list()).map((employee) => [employee.employeeUid, employee]));
      const records = (await repositories.leaveRecords.listBetween(start, end)).map((record) => ({ record, bucket: bucketOf(record) }));
      const counts = { needs_review: 0, unverified: 0, approved: 0, rejected: 0 };
      for (const { bucket } of records) counts[bucket] += 1;

      const rows = records
        .filter(({ bucket }) => filter === 'all' || bucket === filter)
        .map(({ record, bucket }) => {
          const employee = employees.get(record.employeeUid);
          return {
            recordUid: record.recordUid,
            employeeId: employee ? employee.employeeId : null,
            employeeName: employee ? `${employee.firstNameTh} ${employee.lastNameTh}`.trim() : null,
            date: record.leaveDate,
            dateLabel: thaiDate(record.leaveDate),
            leaveType: record.leaveType,
            typeLabel: TYPE_LABEL[record.leaveType] || record.leaveType,
            dayPart: record.dayPart,
            partLabel: PART_LABEL[record.dayPart] || record.dayPart,
            dayFraction: record.dayFraction,
            bucket,
            approvalStatus: record.approvalStatus,
            approvalLabel: APPROVAL_LABEL[record.approvalStatus] || record.approvalStatus,
            reasonLabels: record.reviewReason ? record.reviewReason.split(',').map((code) => REASON_LABEL[code] || code) : [],
            source: record.sourceSystem === 'owner_manual_entry' ? 'owner' : 'hip',
            reviewedAt: record.reviewedAt || null,
            reviewNote: record.reviewNote || null,
          };
        })
        .sort((a, b) => a.date.localeCompare(b.date) || String(a.employeeId).localeCompare(String(b.employeeId), 'en', { numeric: true }));

      return { year, month, buddhistYear: year + 543, periodLabel: `${thaiDate(start)} – ${thaiDate(end)}`, filter, counts, rows };
    },

    async decide(auth, items) {
      await requireReviewer(auth);
      if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH) {
        throw new HttpError(400, 'VALIDATION_ERROR', `decisions must be an array of 1-${MAX_BATCH} items`);
      }
      const results = [];
      for (const item of items) {
        results.push(await decideOne(auth, item || {}));
      }
      return {
        results,
        applied: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
      };
    },
  };

  async function decideOne(auth, item) {
    const fail = (error) => ({ recordUid: String(item.recordUid || ''), ok: false, error });
    if (!item.recordUid || typeof item.recordUid !== 'string') return fail('record id is required');
    if (!ACTIONS.includes(item.action)) return fail('action must be approve or reject');
    const note = item.note === undefined || item.note === null ? null : String(item.note).trim();
    if (note !== null && note.length > MAX_NOTE) return fail(`note is longer than ${MAX_NOTE} characters`);

    const record = await repositories.leaveRecords.findByUid(item.recordUid);
    if (!record) return fail('record not found');

    const patch = {
      leaveType: record.leaveType,
      dayPart: record.dayPart,
      dayFraction: record.dayFraction,
      reviewStatus: record.reviewStatus,
      reviewReason: record.reviewReason,
      approvalStatus: item.action === 'approve' ? 'approved' : 'rejected',
    };

    if (item.leaveType !== undefined) {
      if (!TYPES.includes(item.leaveType)) return fail('leaveType is invalid');
      patch.leaveType = item.leaveType;
    }
    if (item.dayPart !== undefined) {
      if (!PARTS[item.dayPart]) return fail('dayPart must be FULL, AM or PM');
    }
    if (item.action === 'approve') {
      if (record.reviewStatus === 'needs_review') {
        // An ambiguous record becomes a counted day only by an explicit reclassification.
        if (!item.dayPart) return fail('a record under review needs dayPart (FULL, AM or PM) to be approved');
        patch.dayPart = item.dayPart;
        patch.dayFraction = PARTS[item.dayPart];
        patch.reviewStatus = 'candidate';
        patch.reviewReason = null;
      } else if (item.dayPart !== undefined && item.dayPart !== record.dayPart) {
        patch.dayPart = item.dayPart;
        patch.dayFraction = PARTS[item.dayPart];
      }
    } else if (item.dayPart !== undefined || item.leaveType !== undefined) {
      return fail('a rejection does not change the classification');
    }

    const outcome = await repositories.leaveRecords.applyDecision(record.recordUid, patch, {
      actorUid: auth.employeeUid,
      action: item.action,
      before: snapshot(record),
      after: snapshot({ ...patch }),
      note,
    });
    if (outcome.conflict) return fail('another record already has this employee, date and part');
    return { recordUid: record.recordUid, ok: true, approvalStatus: patch.approvalStatus };
  }
}

module.exports = { createLeaveReviewService, bucketOf };

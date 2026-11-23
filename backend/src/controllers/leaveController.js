const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');
const { fiscalYearOf } = require('../domain/leavePolicyEngine');
const { bangkokDate } = require('../services/leaveEntitlementService');

function createLeaveController(leaveService, overviewService, ownerEntryService) {
  return {
    list: asyncRoute(async (req, res) => {
      const data = await leaveService.list(req.auth, req.query.employeeUid, { year: req.query.year });
      success(res, data, 'รายการลา');
    }),
    balance: asyncRoute(async (req, res) => {
      // No `basis` is the long-standing calendar-year behaviour; `basis=fiscal&year=<BE fiscal year>` is opt-in.
      const basis = req.query.basis === undefined || req.query.basis === '' ? 'calendar' : String(req.query.basis);
      const fallbackYear = basis === 'fiscal' ? fiscalYearOf(bangkokDate(new Date())).be : new Date().getUTCFullYear();
      const year = Number(req.query.year || fallbackYear);
      const data = await leaveService.balance(req.auth, req.params.employeeUid, year, { basis });
      success(res, data, 'วันลาคงเหลือ');
    }),
    // One request for the whole organisation (fiscal basis). Executive or manager scope only.
    entitlements: asyncRoute(async (req, res) => {
      success(res, await overviewService.overview(req.auth, req.query), 'สิทธิ์วันลาตามปีงบประมาณ');
    }),
    // The owner's data entry. Executive with an organization grant only; every changed field is audited.
    saveEntitlementFacts: asyncRoute(async (req, res) => {
      overviewService.assertEnabled();
      const data = await ownerEntryService.apply(req.auth, req.params.employeeUid, req.body, { fiscalYearBe: req.query.year ? Number(req.query.year) : undefined });
      success(res, data, 'บันทึกข้อมูลสิทธิ์วันลาแล้ว');
    }),
    history: asyncRoute(async (req, res) => {
      const data = await leaveService.history(req.auth, req.params.employeeUid);
      success(res, data, 'ประวัติการลา');
    }),
  };
}

module.exports = { createLeaveController };

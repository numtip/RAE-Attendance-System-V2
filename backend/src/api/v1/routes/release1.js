const express = require('express');
const { notImplemented } = require('../../../utils/response');

const router = express.Router();

router.post('/auth/login', notImplemented);
router.post('/auth/refresh', notImplemented);
router.get('/auth/me', notImplemented);
router.get('/auth/sso/login', notImplemented);
router.get('/auth/sso/callback', notImplemented);
router.get('/auth/sso/me', notImplemented);
router.post('/auth/sso/logout', notImplemented);

router.get('/employees', notImplemented);
router.get('/employees/:employeeUid', notImplemented);

router.get('/attendance/daily/:date', notImplemented);
router.get('/attendance/monthly/:employeeUid/:year/:month', notImplemented);

router.get('/leave', notImplemented);
router.get('/leave/balance/:employeeUid', notImplemented);
router.get('/leave/history/:employeeUid', notImplemented);

module.exports = router;

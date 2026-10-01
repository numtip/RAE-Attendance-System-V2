const express = require('express');
const { success } = require('../../../utils/response');

const router = express.Router();

router.get('/', (_req, res) => {
  success(res, {
    status: 'healthy',
    service: 'rae-attendance-v2',
    version: '0.1.0',
  }, 'API is running');
});

module.exports = router;

const express = require('express');
const healthRoutes = require('./routes/health');
const release1Routes = require('./routes/release1');

const router = express.Router();

router.use('/health', healthRoutes);
router.use(release1Routes);

module.exports = router;

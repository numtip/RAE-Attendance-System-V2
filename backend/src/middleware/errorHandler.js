const { HttpError } = require('../utils/httpError');

function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    if (err.status === 405 && err.details?.allow) {
      res.set('Allow', String(err.details.allow));
    }
    if (err.status === 429 && err.details?.retryAfterSeconds) {
      res.set('Retry-After', String(err.details.retryAfterSeconds));
    }
    res.status(err.status).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' },
  });
}

module.exports = { errorHandler };

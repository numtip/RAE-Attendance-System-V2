function success(res, data, message, status = 200) {
  res.status(status).json({ success: true, data, message });
}

function failure(res, status, code, message) {
  res.status(status).json({
    success: false,
    error: { code, message },
  });
}

function notImplemented(req, res) {
  failure(res, 501, 'NOT_IMPLEMENTED', `Route ${req.method} ${req.originalUrl} is reserved for Release 1 and is not implemented yet`);
}

module.exports = { success, failure, notImplemented };

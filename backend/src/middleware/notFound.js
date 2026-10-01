const { failure } = require('../utils/response');

function notFound(_req, res) {
  failure(res, 404, 'NOT_FOUND', 'Route not found');
}

module.exports = { notFound };

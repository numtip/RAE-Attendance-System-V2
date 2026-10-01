const { HttpError } = require('../utils/httpError');

function assertCanReadEmployee(auth, employeeUid) {
  if (auth.role === 'admin' || auth.role === 'manager' || auth.employeeUid === employeeUid) {
    return;
  }
  throw new HttpError(403, 'FORBIDDEN', 'You can only read your own attendance and leave records');
}

module.exports = { assertCanReadEmployee };

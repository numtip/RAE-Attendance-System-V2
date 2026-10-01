const { assertInScope } = require('./authorizationService');

function assertCanReadEmployee(auth, employeeUid, repositories, domain = 'data') {
  return assertInScope(auth, employeeUid, repositories, domain);
}

module.exports = { assertCanReadEmployee };

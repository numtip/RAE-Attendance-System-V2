const { publicFields } = require('./employeeMapper');

class EmployeeRepository {
  constructor(rows) {
    this.rows = rows;
  }

  async findByEmail(email) {
    return this.rows.find((row) => row.email === email) || null;
  }

  async findByEmployeeId(employeeId) {
    const normalized = String(employeeId || '').trim();
    if (!normalized) return null;
    return this.rows.find((row) => row.employeeId === normalized) || null;
  }

  async findByUid(employeeUid) {
    const row = this.rows.find((item) => item.employeeUid === employeeUid);
    return row ? publicFields(row) : null;
  }

  async list() {
    return this.rows.map(publicFields);
  }
}

module.exports = { EmployeeRepository };

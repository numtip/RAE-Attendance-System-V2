function publicFields(row) {
  return {
    employeeUid: row.employeeUid,
    employeeId: row.employeeId,
    firstNameTh: row.firstNameTh,
    lastNameTh: row.lastNameTh,
    email: row.email,
    department: row.department,
    position: row.position,
    employeeType: row.employeeType,
    status: row.status,
    role: row.role,
  };
}

module.exports = { publicFields };

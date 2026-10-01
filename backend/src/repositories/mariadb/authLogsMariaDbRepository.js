function createAuthLogsMariaDbRepository(pool) {
  return {
    async append(entry) {
      await pool.query(
        `INSERT INTO auth_logs (
           employee_uid, email, event_type, success, ip_address, user_agent, error_message, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
        [
          entry.employeeUid ?? null,
          entry.email ?? null,
          entry.eventType,
          entry.success ? 1 : 0,
          entry.ipAddress ?? null,
          entry.userAgent ?? null,
          entry.errorMessage ?? null,
        ],
      );
    },
  };
}

module.exports = { createAuthLogsMariaDbRepository };

const { mapRow } = require('./rowMapper');

const LINK_COLUMNS = `
  l.id,
  l.employee_uid,
  l.provider_id,
  p.provider_key,
  l.provider_subject,
  l.subject_type,
  l.email_snapshot,
  l.personnel_id_snapshot,
  l.citizen_id_hash,
  l.status,
  l.confidence,
  l.source,
  l.approved_by,
  l.approved_at,
  l.created_at,
  l.updated_at
`;

function mapIdentityLink(row) {
  if (!row) return null;
  return {
    id: row.id,
    employeeUid: row.employee_uid,
    providerId: row.provider_id,
    providerKey: row.provider_key,
    providerSubject: row.provider_subject,
    subjectType: row.subject_type,
    emailSnapshot: row.email_snapshot,
    personnelIdSnapshot: row.personnel_id_snapshot,
    citizenIdHash: row.citizen_id_hash,
    status: row.status,
    confidence: row.confidence,
    source: row.source,
    enrichmentOutcome: null,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function createIdentityLinkMariaDbRepository(pool) {
  return {
    async findProviderByKey(providerKey) {
      const [rows] = await pool.query(
        `SELECT id, provider_key, name, status
         FROM identity_providers WHERE provider_key = ? LIMIT 1`,
        [providerKey],
      );
      const row = mapRow(rows[0]);
      if (!row) return null;
      return {
        id: row.id,
        providerKey: row.provider_key,
        name: row.name,
        status: row.status,
      };
    },

    async insertLink(input) {
      const now = new Date();
      const [result] = await pool.query(
        `INSERT INTO employee_identity_links (
           employee_uid, provider_id, provider_subject, subject_type,
           email_snapshot, personnel_id_snapshot, citizen_id_hash,
           status, confidence, source, approved_by, approved_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.employeeUid,
          input.providerId,
          input.providerSubject,
          input.subjectType || 'opaque',
          input.emailSnapshot ?? null,
          input.personnelIdSnapshot ?? null,
          input.citizenIdHash ?? null,
          input.status || 'candidate',
          input.confidence || 'unknown',
          input.source,
          input.approvedBy ?? null,
          input.approvedAt ?? null,
          now,
          now,
        ],
      );
      return this.findById(result.insertId);
    },

    async findByProviderSubject(providerKey, providerSubject) {
      const [rows] = await pool.query(
        `SELECT ${LINK_COLUMNS}
         FROM employee_identity_links l
         INNER JOIN identity_providers p ON p.id = l.provider_id
         WHERE p.provider_key = ? AND l.provider_subject = ?
         LIMIT 1`,
        [providerKey, providerSubject],
      );
      return mapIdentityLink(rows[0]);
    },

    async findById(id) {
      const [rows] = await pool.query(
        `SELECT ${LINK_COLUMNS}
         FROM employee_identity_links l
         INNER JOIN identity_providers p ON p.id = l.provider_id
         WHERE l.id = ?
         LIMIT 1`,
        [id],
      );
      return mapIdentityLink(rows[0]);
    },

    async findApprovedForEmployee(employeeUid, providerId) {
      const [rows] = await pool.query(
        `SELECT ${LINK_COLUMNS}
         FROM employee_identity_links l
         INNER JOIN identity_providers p ON p.id = l.provider_id
         WHERE l.employee_uid = ? AND l.provider_id = ? AND l.status = 'approved'
         LIMIT 1`,
        [employeeUid, providerId],
      );
      return mapIdentityLink(rows[0]);
    },

    async updateLink(id, patch) {
      const fields = [];
      const values = [];
      const mapping = {
        status: 'status',
        confidence: 'confidence',
        emailSnapshot: 'email_snapshot',
        approvedBy: 'approved_by',
        approvedAt: 'approved_at',
      };
      for (const [key, column] of Object.entries(mapping)) {
        if (patch[key] !== undefined) {
          fields.push(`${column} = ?`);
          values.push(patch[key]);
        }
      }
      if (fields.length === 0) {
        return this.findById(id);
      }
      fields.push('updated_at = ?');
      values.push(new Date());
      values.push(id);
      await pool.query(
        `UPDATE employee_identity_links SET ${fields.join(', ')} WHERE id = ?`,
        values,
      );
      return this.findById(id);
    },
  };
}

module.exports = { createIdentityLinkMariaDbRepository, mapIdentityLink };

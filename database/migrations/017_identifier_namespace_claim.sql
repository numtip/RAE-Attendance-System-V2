-- Namespace-collision guard for HIP / MJU identifiers (docs/IDENTITY_KIND_MAPPING.md). NOT applied to production by this PR.
--
-- Rule enforced in the database (for EVERY writer, not just the application):
--   a value used as facescan_id (HIP) or personnel_id (MJU) may belong to only ONE employee_uid across both types.
--   The same employee may hold equal text in both types. UNIQUE(id_type,id_value) from 013 still prevents the
--   same (type,value) on two employees.
--
-- Mechanism (atomic, no application locks)
--   employee_identifier_namespace_claim(claim_value PRIMARY KEY, employee_uid). AFTER INSERT/UPDATE/DELETE triggers
--   on employee_identifier claim the value with INSERT IGNORE (takes the PRIMARY KEY record lock, so
--   two concurrent transactions claiming the same value serialize), then re-read the holder with LOCK IN SHARE MODE
--   (latest committed version; shared locks only, so waiters do not upgrade and deadlock each other). A different holder => SIGNAL 45000 'IDENTIFIER_NAMESPACE_COLLISION' and the
--   triggering statement is rolled back. Deactivated rows keep their claim (same as UNIQUE(id_type,id_value)).
--
-- Safety
--   * Requires MariaDB >= 10.2.3 or MySQL >= 8.0.16 (same floor as 015); aborts before any DDL otherwise.
--   * Idempotent (IF NOT EXISTS / DROP TRIGGER IF EXISTS); rerun after a partial failure is safe.
--   * If cross-employee collisions already exist the file ABORTS before creating anything; run
--     database/preflight/017_preflight.sql first and resolve them (human review, never auto-merge).
--   * Needs the TRIGGER privilege; with binary logging enabled MariaDB/MySQL may also require
--     log_bin_trust_function_creators=1 or SUPER. Verify on the target BEFORE the approved window.
--   * Backfill never overwrites an existing claim.
--   * Rollback: database/rollbacks/017_identifier_namespace_claim.down.sql (drops triggers + derived table).

SET @server_version = VERSION();
SET @server_num =
    CAST(SUBSTRING_INDEX(@server_version, '.', 1) AS UNSIGNED) * 10000
  + CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(@server_version, '.', 2), '.', -1) AS UNSIGNED) * 100
  + CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(@server_version, '-', 1), '.', 3), '.', -1) AS UNSIGNED);
SET @server_supported = IF(
  @server_version LIKE '%MariaDB%', @server_num >= 100203, @server_num >= 80016
);
SET @ddl = IF(@server_supported,
  'SELECT 1',
  'SELECT * FROM ABORT_017_requires_MariaDB_10_2_3_or_MySQL_8_0_16');
PREPARE s0 FROM @ddl; EXECUTE s0; DEALLOCATE PREPARE s0;

SET @collisions = (
  SELECT COUNT(*) FROM (
    SELECT id_value FROM employee_identifier
    WHERE id_type IN ('facescan_id', 'personnel_id')
    GROUP BY id_value HAVING COUNT(DISTINCT employee_uid) > 1
  ) c
);
SET @ddl = IF(@collisions = 0,
  'SELECT 1',
  'SELECT * FROM ABORT_017_cross_employee_namespace_collisions_exist_see_preflight');
PREPARE s1 FROM @ddl; EXECUTE s1; DEALLOCATE PREPARE s1;

CREATE TABLE IF NOT EXISTS employee_identifier_namespace_claim (
  claim_value  VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  employee_uid VARCHAR(36)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (claim_value),
  KEY idx_identifier_namespace_claim_employee (employee_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO employee_identifier_namespace_claim (claim_value, employee_uid)
SELECT DISTINCT id_value, employee_uid
FROM employee_identifier
WHERE id_type IN ('facescan_id', 'personnel_id');

DROP TRIGGER IF EXISTS trg_employee_identifier_ns_ai;
CREATE TRIGGER trg_employee_identifier_ns_ai AFTER INSERT ON employee_identifier
FOR EACH ROW
BEGIN
  DECLARE holder VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  IF NEW.id_type IN ('facescan_id', 'personnel_id') THEN
    INSERT IGNORE INTO employee_identifier_namespace_claim (claim_value, employee_uid)
    VALUES (NEW.id_value, NEW.employee_uid);
    SELECT employee_uid INTO holder
      FROM employee_identifier_namespace_claim WHERE claim_value = NEW.id_value LOCK IN SHARE MODE;
    IF holder <> NEW.employee_uid THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'IDENTIFIER_NAMESPACE_COLLISION';
    END IF;
  END IF;
END;

DROP TRIGGER IF EXISTS trg_employee_identifier_ns_au;
CREATE TRIGGER trg_employee_identifier_ns_au AFTER UPDATE ON employee_identifier
FOR EACH ROW
BEGIN
  DECLARE holder VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  IF NOT (OLD.id_type <=> NEW.id_type AND OLD.id_value <=> NEW.id_value AND OLD.employee_uid <=> NEW.employee_uid) THEN
    IF OLD.id_type IN ('facescan_id', 'personnel_id') THEN
      DELETE FROM employee_identifier_namespace_claim
      WHERE claim_value = OLD.id_value
        AND NOT EXISTS (
          SELECT 1 FROM employee_identifier e
          WHERE e.id <> NEW.id AND e.id_value = OLD.id_value AND e.id_type IN ('facescan_id', 'personnel_id')
        );
    END IF;
    IF NEW.id_type IN ('facescan_id', 'personnel_id') THEN
      INSERT IGNORE INTO employee_identifier_namespace_claim (claim_value, employee_uid)
      VALUES (NEW.id_value, NEW.employee_uid);
      SELECT employee_uid INTO holder
        FROM employee_identifier_namespace_claim WHERE claim_value = NEW.id_value LOCK IN SHARE MODE;
      IF holder <> NEW.employee_uid THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'IDENTIFIER_NAMESPACE_COLLISION';
      END IF;
    END IF;
  END IF;
END;

DROP TRIGGER IF EXISTS trg_employee_identifier_ns_ad;
CREATE TRIGGER trg_employee_identifier_ns_ad AFTER DELETE ON employee_identifier
FOR EACH ROW
BEGIN
  IF OLD.id_type IN ('facescan_id', 'personnel_id') THEN
    DELETE FROM employee_identifier_namespace_claim
    WHERE claim_value = OLD.id_value
      AND NOT EXISTS (
        SELECT 1 FROM employee_identifier e
        WHERE e.id_value = OLD.id_value AND e.id_type IN ('facescan_id', 'personnel_id') AND e.id <> OLD.id
      );
  END IF;
END;

-- Rollback for 028_sso_login_attempt.
-- Only safe while SSO is off, or after every pending login has expired.
DROP TABLE IF EXISTS sso_login_attempt;

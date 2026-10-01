class JevError extends Error {
  constructor(code, message, { status, cause } = {}) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

module.exports = { JevError };

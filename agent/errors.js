class AgentCoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentCoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

module.exports = { AgentCoreError };

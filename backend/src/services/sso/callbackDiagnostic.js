const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENSITIVE_NAME = /token|secret|password|passwd|code|ticket|state|hash|signature|cookie|authorization|session|jwt/i;

function valueKind(name, value) {
  if (Array.isArray(value)) return 'array';
  if (value == null || value === '') return 'empty';
  const text = String(value);
  if (EMAIL_SHAPED.test(text)) return 'email-shaped';
  if (SENSITIVE_NAME.test(String(name)) || text.length >= 20) return 'token-shaped';
  if (/^\d+$/.test(text)) return 'numeric';
  return 'short-text';
}

function valueLength(value) {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + valueLength(item), 0);
  }
  if (value == null) return 0;
  return String(value).length;
}

function summarizeCallbackFields(query) {
  const source = query && typeof query === 'object' ? query : {};
  return Object.keys(source).sort().map((name) => ({
    name,
    type: valueKind(name, source[name]),
    length: valueLength(source[name]),
  }));
}

module.exports = { summarizeCallbackFields };

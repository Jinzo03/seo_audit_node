const HSTS_HEADER = 'strict-transport-security';

// Common security headers. "Absent" per the cahier de charge is treated
// here as "none of these are present at all" — a single missing header
// (e.g. just Referrer-Policy) isn't really what "security headers absent"
// means in practice. This is a deliberate interpretation, documented in
// the README alongside the other scoring interpretation calls.
const SECURITY_HEADERS = [
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
];

function hasHsts(headers) {
  if (!headers || typeof headers.get !== 'function') return false;
  return Boolean(headers.get(HSTS_HEADER));
}

function hasAnySecurityHeader(headers) {
  if (!headers || typeof headers.get !== 'function') return false;
  return SECURITY_HEADERS.some((name) => Boolean(headers.get(name)));
}

module.exports = { hasHsts, hasAnySecurityHeader, HSTS_HEADER, SECURITY_HEADERS };

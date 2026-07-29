const tls = require('tls');

/**
 * Opens a raw TLS handshake to hostname:port (no HTTP request, no page
 * content downloaded) and inspects the server's certificate. fetch() can't
 * give us this: an invalid cert just makes a normal request throw a generic
 * error, with no expiry date or reason why.
 *
 * Called through `tls.connect` (not a destructured import) so tests can
 * monkey-patch `require('tls').connect` the same way other tests in this
 * project monkey-patch `global.fetch` — no real bad-certificate server
 * needed to test the expired/self-signed/unreachable code paths.
 */
function checkCertificate(hostname, options = {}) {
  const { port = 443, timeoutMs = 8000 } = options;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let socket;
    try {
      socket = tls.connect({ host: hostname, port, servername: hostname, timeout: timeoutMs }, () => {
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        const authorizationError = socket.authorizationError || null;

        if (!cert || Object.keys(cert).length === 0) {
          socket.end();
          finish({ checked: true, valid: false, reason: 'No certificate returned', authorized: false });
          return;
        }

        const now = new Date();
        const validFrom = new Date(cert.valid_from);
        const validTo = new Date(cert.valid_to);
        const expired = now > validTo;
        const notYetValid = now < validFrom;
        const daysUntilExpiry = Math.round((validTo - now) / (1000 * 60 * 60 * 24));

        socket.end();
        finish({
          checked: true,
          valid: Boolean(authorized) && !expired && !notYetValid,
          authorized: Boolean(authorized),
          authorizationError,
          expired,
          notYetValid,
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          daysUntilExpiry,
        });
      });
    } catch (err) {
      finish({ checked: false, valid: false, reason: err.message, authorized: false });
      return;
    }

    socket.on('error', (err) => {
      finish({ checked: false, valid: false, reason: err.message, authorized: false });
    });

    socket.on('timeout', () => {
      socket.destroy();
      finish({ checked: false, valid: false, reason: 'TLS handshake timed out', authorized: false });
    });
  });
}

module.exports = { checkCertificate };

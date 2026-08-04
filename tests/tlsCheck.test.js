const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('tls');
const { EventEmitter } = require('node:events');
const { checkCertificate } = require('../src/crawler/tlsCheck');

function fakeSocket() {
  const emitter = new EventEmitter();
  emitter.end = () => {};
  emitter.destroy = () => {};
  return emitter;
}

describe('checkCertificate', () => {
  test('a valid, currently-in-range certificate reports valid: true', async () => {
    const original = tls.connect;
    tls.connect = (opts, cb) => {
      const socket = fakeSocket();
      socket.authorized = true;
      socket.authorizationError = null;
      socket.getPeerCertificate = () => ({
        valid_from: 'Jan 1 00:00:00 2020 GMT',
        valid_to: 'Jan 1 00:00:00 2035 GMT',
      });
      setImmediate(cb);
      return socket;
    };
    try {
      const result = await checkCertificate('example.com');
      assert.equal(result.valid, true);
      assert.equal(result.expired, false);
      assert.ok(result.daysUntilExpiry > 0);
    } finally {
      tls.connect = original;
    }
  });

  test('an expired certificate reports valid: false, expired: true', async () => {
    const original = tls.connect;
    tls.connect = (opts, cb) => {
      const socket = fakeSocket();
      socket.authorized = true; // chain is trusted, but dates are out of range
      socket.authorizationError = null;
      socket.getPeerCertificate = () => ({
        valid_from: 'Jan 1 00:00:00 2010 GMT',
        valid_to: 'Jan 1 00:00:00 2015 GMT', // long expired
      });
      setImmediate(cb);
      return socket;
    };
    try {
      const result = await checkCertificate('example.com');
      assert.equal(result.valid, false);
      assert.equal(result.expired, true);
    } finally {
      tls.connect = original;
    }
  });

  test('an untrusted/self-signed certificate reports valid: false, authorized: false', async () => {
    const original = tls.connect;
    tls.connect = (opts, cb) => {
      const socket = fakeSocket();
      socket.authorized = false;
      socket.authorizationError = 'DEPTH_ZERO_SELF_SIGNED_CERT';
      socket.getPeerCertificate = () => ({
        valid_from: 'Jan 1 00:00:00 2020 GMT',
        valid_to: 'Jan 1 00:00:00 2035 GMT',
      });
      setImmediate(cb);
      return socket;
    };
    try {
      const result = await checkCertificate('example.com');
      assert.equal(result.valid, false);
      assert.equal(result.authorized, false);
      assert.equal(result.authorizationError, 'DEPTH_ZERO_SELF_SIGNED_CERT');
    } finally {
      tls.connect = original;
    }
  });

  test('a connection error (unreachable host) resolves with checked: false rather than throwing', async () => {
    const original = tls.connect;
    tls.connect = () => {
      const socket = fakeSocket();
      setImmediate(() => socket.emit('error', new Error('ECONNREFUSED')));
      return socket;
    };
    try {
      const result = await checkCertificate('unreachable.example');
      assert.equal(result.checked, false);
      assert.equal(result.valid, false);
    } finally {
      tls.connect = original;
    }
  });

  test('a timeout resolves with checked: false rather than hanging', async () => {
    const original = tls.connect;
    tls.connect = () => {
      const socket = fakeSocket();
      setImmediate(() => socket.emit('timeout'));
      return socket;
    };
    try {
      const result = await checkCertificate('slow.example');
      assert.equal(result.checked, false);
      assert.match(result.reason, /timed out/);
    } finally {
      tls.connect = original;
    }
  });
});

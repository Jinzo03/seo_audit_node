const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app, auditJobs } = require('../src/server');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function eventually(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

describe('background audit jobs', () => {
  test('POST /audit starts a job and the status endpoint eventually returns a report URL', async () => {
    auditJobs.clear();

    const target = http.createServer((req, res) => {
      if (req.url === '/robots.txt' || req.url === '/sitemap.xml') {
        res.writeHead(404);
        res.end('');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end('<html><head><title>Home</title><meta name="viewport" content="width=device-width"></head><body>ok</body></html>');
    });
    const appServer = http.createServer(app);

    const targetPort = await listen(target);
    const appPort = await listen(appServer);

    try {
      const body = new URLSearchParams({
        url: `http://127.0.0.1:${targetPort}`,
        maxPages: '1',
      });
      const start = await fetch(`http://127.0.0.1:${appPort}/audit`, {
        method: 'POST',
        body,
        headers: { Accept: 'application/json' },
      });
      assert.equal(start.status, 202);

      const started = await start.json();
      assert.match(started.statusUrl, /^\/audit\/jobs\/\d+$/);

      const completed = await eventually(async () => {
        const status = await fetch(`http://127.0.0.1:${appPort}${started.statusUrl}`);
        const payload = await status.json();
        return payload.status === 'completed' ? payload : null;
      });

      assert.equal(completed.status, 'completed');
      assert.equal(completed.pagesCrawled, 1);
      assert.match(completed.reportUrl, /^\/report\/\d+$/);
    } finally {
      await close(appServer);
      await close(target);
    }
  });

  test('GET /audit/jobs/:id returns 404 for an unknown job', async () => {
    const appServer = http.createServer(app);
    const appPort = await listen(appServer);
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/audit/jobs/missing`);
      assert.equal(response.status, 404);
      const payload = await response.json();
      assert.equal(payload.error, 'Audit job not found');
    } finally {
      await close(appServer);
    }
  });
});

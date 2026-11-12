#!/usr/bin/env node
// Anonymous SharePoint downloads need the guest cookie and a browser user-agent.
// No live workbook and no secrets.
'use strict';
const assert = require('assert');
const http = require('http');
const { fetchBytesFollowingCookies, downloadXlsx } = require('../generate');

function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  let sawCookie = false;
  let sawBrowser = false;
  let fileHits = 0;
  const server = await listen((req, res) => {
    if (req.url.startsWith('/start')) {
      sawBrowser = /Mozilla\/5\.0/.test(req.headers['user-agent'] || '');
      res.writeHead(302, {
        Location: '/file.xlsx',
        'Set-Cookie': 'sp=guest; Path=/; HttpOnly',
      });
      res.end();
      return;
    }
    fileHits += 1;
    sawCookie = /(?:^|;\s*)sp=guest(?:;|$)/.test(req.headers.cookie || '');
    if (!sawCookie) {
      res.writeHead(401, { 'Content-Type': 'text/html' });
      res.end('<html>Sign in</html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    res.end(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
  });
  const port = server.address().port;
  try {
    const got = await fetchBytesFollowingCookies('http://127.0.0.1:' + port + '/start?download=1');
    assert.ok(sawBrowser, 'download should send a browser user-agent');
    assert.ok(sawCookie, 'redirect should carry the Set-Cookie');
    assert.strictEqual(got[0], 0x50);
    assert.strictEqual(got[1], 0x4b);
    await assert.rejects(
      () => fetchBytesFollowingCookies('http://127.0.0.1:' + port + '/file.xlsx'),
      /HTTP 401/
    );
    assert.strictEqual(fileHits, 2);
    await assert.rejects(
      () => downloadXlsx('https://example.com/nope.xlsx'),
      /host is not/
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('sharepoint download tests ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});

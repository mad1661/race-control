#!/usr/bin/env node
// Dashboard source resolution and the workflow wiring that publishes it.
// No live Apps Script, no workbook, no secrets.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveScheduleSource, fetchSharePointSnapshot, redactSecrets } = require('../generate');

const KEYS = ['FEED_CONFIG_TOKEN', 'SHAREPOINT_URL', 'SCHEDULE_SOURCE', 'ADMIN_SCRIPT_URL'];
const TOKEN = 'unit-test-token';
const WORKBOOK = 'https://contoso.sharepoint.com/sites/race/Shared Documents/book.xlsx';
const ADMIN = 'https://example.invalid/exec';

function capture(env, fn) {
  const prev = {};
  for (const key of KEYS) prev[key] = process.env[key];
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const origFetch = global.fetch;
  for (const method of ['log', 'warn', 'error']) {
    console[method] = (...args) => logs.push(args.map(String).join(' '));
  }
  let calls = 0;
  global.fetch = async (...args) => {
    calls += 1;
    if (fn.fetch) return fn.fetch(...args);
    throw new Error('unexpected fetch');
  };
  return Promise.resolve()
    .then(() => fn())
    .then(result => ({ result, logs, calls }))
    .finally(() => {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
      global.fetch = origFetch;
      for (const key of KEYS) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    });
}

function joined(logs) { return logs.join('\n'); }

(async () => {
  {
    const { result, logs, calls } = await capture({}, () => resolveScheduleSource());
    assert.strictEqual(result.source, 'sheets');
    assert.strictEqual(result.sharepointUrl, '');
    assert.strictEqual(result.linkFrom, 'none');
    assert.strictEqual(calls, 0);
    const text = joined(logs);
    assert.match(text, /Cannot read the admin dashboard \(FEED_CONFIG_TOKEN missing\)/);
    assert.match(text, /rss\/schedule-source\.json \(sheets\)/);
    assert.match(text, /::warning title=Admin schedule source unread::/);
    assert.doesNotMatch(text, /script\.google\.com/);
  }

  {
    let requested = '';
    const { result, logs, calls } = await capture(
      { FEED_CONFIG_TOKEN: TOKEN, ADMIN_SCRIPT_URL: ADMIN },
      Object.assign(() => resolveScheduleSource(), {
        fetch: async (url) => {
          requested = String(url);
          return {
            ok: true,
            text: async () => JSON.stringify({ ok: true, source: 'sharepoint', sharepointUrl: WORKBOOK }),
          };
        },
      })
    );
    assert.strictEqual(calls, 1);
    assert.strictEqual(result.source, 'sharepoint');
    assert.strictEqual(result.sharepointUrl, WORKBOOK);
    assert.strictEqual(result.linkFrom, 'apps-script');
    assert.ok(requested.startsWith(ADMIN + '?action=scheduleSourceForFeed&token='));
    assert.ok(requested.includes(encodeURIComponent(TOKEN)));
    const text = joined(logs);
    assert.match(text, /Schedule source from Apps Script: sharepoint/);
    assert.doesNotMatch(text, /unit-test-token/);
    assert.doesNotMatch(text, /contoso\.sharepoint\.com/);
    assert.doesNotMatch(text, /Cannot read the admin dashboard/);
  }

  {
    const { result, logs } = await capture(
      { FEED_CONFIG_TOKEN: TOKEN, ADMIN_SCRIPT_URL: ADMIN, SHAREPOINT_URL: WORKBOOK },
      Object.assign(() => resolveScheduleSource(), {
        fetch: async () => ({
          ok: true,
          text: async () => JSON.stringify({
            ok: true,
            source: 'sharepoint',
            sharepointUrl: 'https://fabrikam.sharepoint.com/sites/other/book.xlsx',
          }),
        }),
      })
    );
    assert.strictEqual(result.source, 'sharepoint');
    assert.strictEqual(result.sharepointUrl, WORKBOOK);
    assert.strictEqual(result.linkFrom, 'secret');
    const text = joined(logs);
    assert.match(text, /Schedule source from Apps Script: sharepoint/);
    assert.doesNotMatch(text, /contoso\.sharepoint\.com/);
    assert.doesNotMatch(text, /fabrikam\.sharepoint\.com/);
    assert.doesNotMatch(text, /unit-test-token/);
  }

  {
    const { result, logs } = await capture(
      { FEED_CONFIG_TOKEN: TOKEN, ADMIN_SCRIPT_URL: ADMIN },
      Object.assign(() => resolveScheduleSource(), {
        fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'Unauthorized' }) }),
      })
    );
    assert.strictEqual(result.source, 'sheets');
    const text = joined(logs);
    assert.match(text, /Apps Script schedule source was not usable \(HTTP 200\); using rss\/schedule-source\.json/);
    assert.match(text, /::warning title=Admin schedule source unread::/);
  }

  {
    const { result, logs } = await capture(
      { FEED_CONFIG_TOKEN: TOKEN, ADMIN_SCRIPT_URL: ADMIN, SHAREPOINT_URL: WORKBOOK },
      Object.assign(() => resolveScheduleSource(), {
        fetch: async () => { throw new Error('boom ' + TOKEN + ' ' + WORKBOOK + '?download=1&token=' + TOKEN); },
      })
    );
    assert.strictEqual(result.source, 'sheets');
    const text = joined(logs);
    assert.match(text, /Apps Script schedule source failed/);
    assert.doesNotMatch(text, /unit-test-token/);
    assert.doesNotMatch(text, /contoso\.sharepoint\.com/);
    assert.match(text, /\[FEED_CONFIG_TOKEN\]|\[redacted\]|\[sharepoint-link\]/);
  }

  {
    const { result, logs, calls } = await capture(
      { SCHEDULE_SOURCE: 'sheets', FEED_CONFIG_TOKEN: TOKEN, ADMIN_SCRIPT_URL: ADMIN },
      () => resolveScheduleSource()
    );
    assert.strictEqual(calls, 0);
    assert.strictEqual(result.source, 'sheets');
    assert.match(joined(logs), /Schedule source from SCHEDULE_SOURCE env: sheets/);
    assert.doesNotMatch(joined(logs), /Cannot read the admin dashboard/);
  }

  {
    const { result, calls } = await capture(
      { SCHEDULE_SOURCE: 'sharepoint', SHAREPOINT_URL: WORKBOOK },
      () => resolveScheduleSource()
    );
    assert.strictEqual(calls, 0);
    assert.strictEqual(result.source, 'sharepoint');
    assert.strictEqual(result.linkFrom, 'secret');
    assert.strictEqual(result.sharepointUrl, WORKBOOK);
  }

  await assert.rejects(
    () => fetchSharePointSnapshot({ source: 'sharepoint', sharepointUrl: '', linkFrom: 'none' }),
    /Sheets was not used as a fallback/
  );

  process.env.FEED_CONFIG_TOKEN = TOKEN;
  process.env.SHAREPOINT_URL = WORKBOOK;
  try {
    const out = redactSecrets('SharePoint workbook: ' + WORKBOOK + '?download=1 token=' + TOKEN + ' raw ' + TOKEN);
    assert.doesNotMatch(out, /unit-test-token/);
    assert.doesNotMatch(out, /contoso\.sharepoint\.com/);
    assert.match(out, /\[SHAREPOINT_URL\]/);
  } finally {
    delete process.env.FEED_CONFIG_TOKEN;
    delete process.env.SHAREPOINT_URL;
  }

  const yml = fs.readFileSync(path.join(__dirname, '../../.github/workflows/feed.yml'), 'utf8');
  const gen = yml.slice(yml.indexOf('- id: gen'), yml.indexOf('- name: Commit feed'));
  assert.match(gen, /FEED_CONFIG_TOKEN:\s*\$\{\{\s*secrets\.FEED_CONFIG_TOKEN\s*\}\}/);
  assert.match(gen, /SHAREPOINT_URL:\s*\$\{\{\s*secrets\.SHAREPOINT_URL\s*\}\}/);
  assert.match(gen, /run: node rss\/generate\.js/);
  const commit = yml.slice(yml.indexOf('- name: Commit feed'), yml.indexOf('- name: Record run health'));
  assert.match(commit, /git add feed\.xml rss\/state days\.json schedule-meta\.json/);
  assert.match(commit, /git add -A -- schedule\.json/);
  const assemble = yml.slice(yml.indexOf('- name: Assemble site'), yml.indexOf('actions/upload-pages-artifact'));
  assert.match(assemble, /schedule-meta\.json/);
  assert.match(assemble, /schedule\.json/);
  assert.doesNotMatch(assemble, /sms-admin\.html/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-feed-add-'));
  const script = path.join(dir, 'stage.sh');
  fs.writeFileSync(script, `
set -euo pipefail
git add feed.xml rss/state days.json schedule-meta.json
if [ -f schedule.json ] || git cat-file -e HEAD:schedule.json 2>/dev/null; then
  git add -A -- schedule.json
fi
`);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'schedule-meta.json'), '{"source":"sheets"}\n');
  fs.writeFileSync(path.join(dir, 'feed.xml'), '<rss/>\n');
  fs.mkdirSync(path.join(dir, 'rss', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'rss', 'state', 'snapshot.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'days.json'), '{}\n');
  execFileSync('bash', [script], { cwd: dir, stdio: 'pipe' });
  const stagedFirst = git('diff', '--cached', '--name-only').toString();
  assert.match(stagedFirst, /schedule-meta\.json/);
  assert.doesNotMatch(stagedFirst, /schedule\.json/);
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(dir, 'schedule-meta.json'), '{"source":"sharepoint"}\n');
  fs.writeFileSync(path.join(dir, 'schedule.json'), '{"source":"sharepoint"}\n');
  execFileSync('bash', [script], { cwd: dir, stdio: 'pipe' });
  const stagedShare = git('diff', '--cached', '--name-only').toString();
  assert.match(stagedShare, /schedule-meta\.json/);
  assert.match(stagedShare, /schedule\.json/);
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'sharepoint');
  fs.writeFileSync(path.join(dir, 'schedule-meta.json'), '{"source":"sheets"}\n');
  fs.unlinkSync(path.join(dir, 'schedule.json'));
  execFileSync('bash', [script], { cwd: dir, stdio: 'pipe' });
  const stagedBack = git('diff', '--cached', '--name-status').toString();
  assert.match(stagedBack, /schedule-meta\.json/);
  assert.match(stagedBack, /D\s+schedule\.json/);

  console.log('schedule-source tests ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

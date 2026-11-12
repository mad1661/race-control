#!/usr/bin/env node
// Race Control RSS generator.
// Fetches every day tab of the public DRS run-order sheet through the same gviz
// endpoint the page uses, diffs against the previous snapshot, and writes an
// RSS 2.0 feed of real changes. No dependencies; Node 18+ (global fetch).
//
// Usage: node generate.js [--out ../feed.xml] [--state ./state]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readXlsxGrids, formatExcelNumber } = require('./xlsx-grid');

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const HERE = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const STATE_DIR = path.resolve(arg('--state', process.env.STATE_DIR || path.join(HERE, 'state')));
const FEED_OUT = path.resolve(arg('--out', process.env.FEED_OUT || path.join(HERE, '..', 'feed.xml')));
const SNAPSHOT = path.join(STATE_DIR, 'snapshot.json');
const ITEMS = path.join(STATE_DIR, 'items.json');
// Discovered Day tabs, published next to feed.xml so the page can load the current event's GIDs.
const DAYS_OUT = path.resolve(process.env.DAYS_OUT || path.join(path.dirname(FEED_OUT), 'days.json'));
const SCHEDULE_SOURCE_FILE = path.join(HERE, 'schedule-source.json');
// Public, no share link: the page reads this to decide gviz vs schedule.json.
const SCHEDULE_META_OUT = path.resolve(process.env.SCHEDULE_META_OUT || path.join(path.dirname(FEED_OUT), 'schedule-meta.json'));
const SCHEDULE_JSON_OUT = path.resolve(process.env.SCHEDULE_JSON_OUT || path.join(path.dirname(FEED_OUT), 'schedule.json'));
const PAGE_URL = process.env.PAGE_URL || config.pageUrl;
const FEED_URL = process.env.FEED_URL || config.feedUrl;
const MAX_ITEMS = config.maxItems || 50;
const SUMMARIZE_OVER = config.summarizeOver || 25;
// Every exit (success or failure) writes this so a broken run is visible in the repo.
const LAST_RUN = path.join(STATE_DIR, 'last-run.json');
// Network hardening: Google gviz/htmlview hiccups are common on busy weekends.
const FETCH_TRIES = 5;
const backoff = attempt => new Promise(r => setTimeout(r, 2000 * (attempt + 1))); // 2s,4s,6s,8s (~20s worst case per tab)
// Give up retrying after this so the script always exits (and writes last-run.json) before the
// workflow's 5-minute job timeout kills it.
const DEADLINE = Date.now() + 210000;
const pastDeadline = () => Date.now() > DEADLINE;

// ---------- parsing (mirrors parseDay() in index.html for the Google Sheet) ----------
// The public Sheet writes a "Thursday, November 12, 2026" string in column C.
// A DRS workbook does not: the Excel date serial sits near column G, above
// ELIMINATOR. A styled serial of 5 becomes "Thursday, January 04, 1900" and
// must not win over the real serial (46338 is Thursday, November 12, 2026).
const clean = v => String(v ?? '').trim();
const datePattern = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), /;
function excelSerialDate(raw) {
  const s = clean(raw);
  if (!/^\d+(\.\d+)?$/.test(s)) return '';
  const n = Number(s);
  if (!(n >= 20000 && n < 80000)) return '';
  return formatExcelNumber(n, 'date');
}
function plausibleWrittenDate(raw) {
  const s = clean(raw);
  if (!datePattern.test(s)) return '';
  const y = /(\d{4})\s*$/.exec(s);
  if (!y) return s;
  const year = Number(y[1]);
  if (year < 2020 || year > 2100) return '';
  return s;
}
function findScheduleDate(top) {
  for (const r of top) {
    const v = plausibleWrittenDate(r && r[2]);
    if (v) return v;
  }
  let bestSerial = null;
  let bestWritten = null;
  for (const r of top) {
    if (!r) continue;
    for (let c = 0; c < r.length; c++) {
      const serial = excelSerialDate(r[c]);
      if (serial) {
        const dist = Math.abs(c - 6);
        if (!bestSerial || dist < bestSerial.dist) bestSerial = { text: serial, dist };
      }
      const written = plausibleWrittenDate(r[c]);
      if (written) {
        const dist = Math.abs(c - 6);
        if (!bestWritten || dist < bestWritten.dist) bestWritten = { text: written, dist };
      }
    }
  }
  if (bestSerial) return bestSerial.text;
  if (bestWritten) return bestWritten.text;
  return '';
}
function titleFromTop(top, radioRow) {
  const fromPa = clean(radioRow && radioRow[5]);
  if (fromPa) return fromPa;
  let name = '';
  for (const r of top) {
    const v = clean(r && r[5]);
    if (!v || /^ELIMINATOR$/i.test(v) || datePattern.test(v)) continue;
    if (v.length > name.length) name = v;
  }
  let powered = '';
  for (const r of top) {
    for (const cell of r || []) {
      const v = clean(cell);
      if (/^powered by\b/i.test(v)) { powered = v; break; }
    }
    if (powered) break;
  }
  if (name && powered && !name.toLowerCase().includes('powered by')) name = name + ' ' + powered;
  return name || 'Race weekend';
}
function eventRadio(top, radioRow) {
  const direct = clean(radioRow && radioRow[4]) || clean(radioRow && radioRow[2]).replace(/^PA Broadcast:\s*/i, '');
  if (direct) return direct;
  for (const r of top) {
    for (const cell of r || []) {
      const v = clean(cell);
      if (/^\d+(\.\d+)?\s*FM$/i.test(v)) return v;
    }
  }
  return '';
}
function cellNote(v) {
  const s = clean(v);
  if (!s || s === '#N/A' || /^12:00 AM$/i.test(s)) return '';
  // DRS stores turnaround fractions in the comments column as raw numbers.
  if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return '';
  return s;
}
function parseDay(rows, label, gid) {
  const header = rows.findIndex(r => /^ELIMINATOR$/i.test(clean(r[5])));
  if (header < 0) throw new Error(`${label}: daily column layout has changed`);
  const top = rows.slice(0, header);
  const date = findScheduleDate(top);
  const radioRow = top.find(r => /^PA Broadcast:/i.test(clean(r[2]))) || [];
  const title = titleFromTop(top, radioRow);
  const radio = eventRadio(top, radioRow);
  const items = [];
  for (const r of rows.slice(header + 1)) {
    const name = clean(r[5]);
    if (!name || name.startsWith('#')) continue;
    items.push({ scheduled: clean(r[2]), actual: clean(r[3]), name, round: clean(r[6]), note: cellNote(r[11]) });
  }
  if (!date) throw new Error(`${label}: schedule date is missing`);
  return { label, gid, date, title, radio, items };
}

async function fetchTab(gid) {
  const params = new URLSearchParams({ gid, headers: '0', range: 'A1:L1000', tqx: 'out:json' });
  const url = `https://docs.google.com/spreadsheets/d/${config.sheetId}/gviz/tq?${params}`;
  let lastError;
  for (let attempt = 0; attempt < FETCH_TRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'race-control-rss/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const start = text.indexOf('('), end = text.lastIndexOf(')');
      if (start < 0 || end < start) throw new Error('unexpected gviz response');
      const json = JSON.parse(text.slice(start + 1, end));
      if (json.status !== 'ok' || !json.table?.rows) throw new Error('gviz status ' + json.status);
      const width = json.table.cols.length;
      return json.table.rows.map(row => Array.from({ length: width }, (_, i) => { const c = row.c[i]; return c ? clean(c.f ?? c.v) : ''; }));
    } catch (e) {
      lastError = e;
      console.warn(`tab ${gid}: attempt ${attempt + 1}/${FETCH_TRIES} failed (${e.message})`);
      if (pastDeadline()) break;
      if (attempt < FETCH_TRIES - 1) await backoff(attempt);
    }
  }
  throw new Error(`tab ${gid}: ${lastError.message} after ${FETCH_TRIES} tries`);
}

// ---------- Day tab discovery ----------
// The DRS gets new tab GIDs for every event, so read the live tab list from the public
// htmlview page instead of trusting hardcoded GIDs. config.tabs is only a fallback when
// the htmlview page cannot be fetched at all.
const unescapeJs = s => s.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');
function parseTabList(html) {
  const tabs = [], re = /items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)"[^}]*?gid:\s*"(\d+)"/g;
  let m;
  while ((m = re.exec(html))) tabs.push({ name: unescapeJs(m[1]).trim(), gid: m[2] });
  return tabs;
}
function dayTabs(tabs) {
  const seen = new Set();
  return tabs.map(t => ({ ...t, n: (/^Day\s*(\d+)$/i.exec(t.name) || [])[1] }))
    .filter(t => t.n && !seen.has(+t.n) && seen.add(+t.n))
    .sort((a, b) => a.n - b.n)
    .map(t => [`Day ${+t.n}`, t.gid]);
}
async function discoverTabs() {
  const url = `https://docs.google.com/spreadsheets/d/${config.sheetId}/htmlview`;
  let html, lastError;
  for (let attempt = 0; attempt < FETCH_TRIES && html === undefined; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'race-control-rss/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (e) {
      lastError = e;
      console.warn(`tab list: attempt ${attempt + 1}/${FETCH_TRIES} failed (${e.message})`);
      if (pastDeadline()) break;
      if (attempt < FETCH_TRIES - 1) await backoff(attempt);
    }
  }
  if (html === undefined) {
    if (config.tabs?.length) { console.warn(`Tab discovery failed (${lastError.message}); using config.tabs fallback`); return { tabs: config.tabs, source: 'config' }; }
    throw new Error(`could not load sheet tab list: ${lastError.message}`);
  }
  const all = parseTabList(html);
  const tabs = dayTabs(all);
  if (!tabs.length) throw new Error(`no "Day N" tabs found in sheet ${config.sheetId} (saw: ${all.map(t => t.name).join(', ') || 'none'})`);
  return { tabs, source: 'htmlview' };
}

async function fetchGoogleSnapshot() {
  const { tabs, source } = await discoverTabs();
  console.log(`Day tabs (${source}): ` + tabs.map(([l, g]) => `${l}=${g}`).join(', '));
  const days = [];
  for (const [label, gid] of tabs) days.push(parseDay(await fetchTab(gid), label, gid));
  return { fetchedAt: new Date().toISOString(), days, tabs, scheduleSource: 'sheets' };
}

function toDownloadUrl(raw) {
  const u = new URL(String(raw || '').trim());
  if (u.protocol !== 'https:') throw new Error('SharePoint link must be https');
  const host = u.hostname.toLowerCase();
  const allowed = host === 'sharepoint.com' || host.endsWith('.sharepoint.com') || host === '1drv.ms' ||
    host === 'onedrive.live.com' || host.endsWith('.onedrive.live.com');
  if (!allowed) throw new Error('SharePoint link host is not sharepoint.com, 1drv.ms, or onedrive.live.com');
  u.searchParams.delete('web');
  if (!u.searchParams.has('download')) u.searchParams.set('download', '1');
  return u.toString();
}

function snapshotFromXlsxBuffer(buf) {
  const grids = readXlsxGrids(buf);
  const named = grids.map(g => ({ name: g.name, gid: 'sharepoint' }));
  const tabs = dayTabs(named);
  if (!tabs.length) {
    throw new Error('no "Day N" sheets in the SharePoint workbook (saw: ' + grids.map(g => g.name).join(', ') + ')');
  }
  const byName = new Map(grids.map(g => [g.name.trim().toLowerCase(), g.rows]));
  const days = [];
  for (const [label] of tabs) {
    const rows = byName.get(label.toLowerCase());
    if (!rows) throw new Error(label + ' was listed but has no rows');
    days.push(parseDay(rows, label, 'sharepoint'));
  }
  return { fetchedAt: new Date().toISOString(), days, tabs, scheduleSource: 'sharepoint' };
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REDIRECT_HOST_SUFFIXES = ['sharepoint.com', 'sharepointonline.com', '1drv.ms', '1drv.com', 'onedrive.live.com', 'live.com', 'office.net', 'office.com', 'microsoft.com', 'microsoftonline.com', 'msocdn.com'];

function hostMatches(hostname, suffix) {
  const host = String(hostname || '').toLowerCase();
  return host === suffix || host.endsWith('.' + suffix);
}
function redirectHostOk(hostname) {
  return REDIRECT_HOST_SUFFIXES.some(s => hostMatches(hostname, s));
}
function parseSetCookie(raw, requestUrl) {
  const parts = String(raw || '').split(';').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const eq = parts[0].indexOf('=');
  if (eq <= 0) return null;
  const name = parts[0].slice(0, eq).trim();
  const value = parts[0].slice(eq + 1).trim();
  if (!name) return null;
  let domain = '';
  let cookiePath = '/';
  for (const attr of parts.slice(1)) {
    const i = attr.indexOf('=');
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : attr.slice(i + 1).trim();
    if (key === 'domain' && val) domain = val.replace(/^\./, '').toLowerCase();
    else if (key === 'path' && val) cookiePath = val;
  }
  if (!domain) {
    try { domain = new URL(requestUrl).hostname.toLowerCase(); } catch (e) { return null; }
  }
  return { name, value, domain, path: cookiePath || '/' };
}
function absorbCookies(jar, res, requestUrl) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const c = parseSetCookie(raw, requestUrl);
    if (!c) continue;
    const i = jar.findIndex(x => x.name === c.name && x.domain === c.domain && x.path === c.path);
    if (i >= 0) jar[i] = c;
    else jar.push(c);
  }
}
function cookieHeader(jar, url) {
  let u;
  try { u = new URL(url); } catch (e) { return ''; }
  const host = u.hostname.toLowerCase();
  const pathName = u.pathname || '/';
  const pairs = [];
  for (const c of jar) {
    if (!(host === c.domain || host.endsWith('.' + c.domain))) continue;
    const p = c.path || '/';
    if (pathName !== p && !pathName.startsWith(p.endsWith('/') ? p : p + '/')) continue;
    pairs.push(c.name + '=' + c.value);
  }
  return pairs.join('; ');
}
function isZip(buf) {
  return buf && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}
function fatalDownload(message) {
  return /HTTP 401|HTTP 403|sign-in page|unexpected host|host is not|must be https|not an xlsx|left https|too many redirects|too large/.test(message);
}

// Anonymous SharePoint links 302 through a guest cookie. Node fetch follows the
// redirect but drops Set-Cookie, and a non-browser User-Agent is answered 401.
// A browser user-agent plus that cookie returns the xlsx. Graph sign-in is not used.
async function fetchBytesFollowingCookies(startUrl) {
  let url = String(startUrl);
  const jar = [];
  const originHost = new URL(url).hostname.toLowerCase();
  for (let hop = 0; hop < 12; hop++) {
    const headers = { 'user-agent': BROWSER_UA, accept: '*/*' };
    const cookie = cookieHeader(jar, url);
    if (cookie) headers.cookie = cookie;
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000), headers });
    absorbCookies(jar, res, url);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.arrayBuffer().catch(() => {});
      if (!loc) throw new Error('SharePoint redirect had no Location header');
      const next = new URL(loc, url);
      if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new Error('SharePoint redirect was not http(s)');
      const nextHost = next.hostname.toLowerCase();
      const local = originHost === '127.0.0.1' || originHost === 'localhost';
      if (next.protocol !== 'https:' && !local) throw new Error('SharePoint redirect left https');
      if (nextHost !== originHost && !redirectHostOk(nextHost)) {
        throw new Error('SharePoint download redirected to an unexpected host (' + nextHost + ')');
      }
      url = next.toString();
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('SharePoint returned HTTP ' + res.status + '. Share the workbook so anyone with the link can view (no Microsoft sign-in). Graph auth is not used, and Sheets was not substituted.');
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 30 * 1024 * 1024) throw new Error('SharePoint workbook is too large');
    return buf;
  }
  throw new Error('SharePoint download followed too many redirects');
}

async function downloadXlsx(rawUrl) {
  const url = toDownloadUrl(rawUrl);
  let lastError;
  for (let attempt = 0; attempt < FETCH_TRIES; attempt++) {
    try {
      const buf = await fetchBytesFollowingCookies(url);
      if (!isZip(buf)) {
        const head = buf.slice(0, 400).toString('utf8').toLowerCase();
        if (head.includes('<html') || head.includes('<!doctype')) {
          throw new Error('SharePoint returned a sign-in page instead of the workbook. Share it so anyone with the link can view. Graph auth is not used.');
        }
        throw new Error('link did not return an xlsx. Share the workbook so anyone with the link can view, and paste the file link (not a folder). Graph sign-in is not used.');
      }
      return buf;
    } catch (e) {
      lastError = e;
      console.warn(`SharePoint download attempt ${attempt + 1}/${FETCH_TRIES} failed (${redactSecrets(e.message)})`);
      if (fatalDownload(e.message) || pastDeadline()) break;
      if (attempt < FETCH_TRIES - 1) await backoff(attempt);
    }
  }
  throw new Error('SharePoint workbook: ' + redactSecrets(lastError.message));
}

// Strip workbook links and the feed token before anything is logged or committed.
function redactSecrets(text) {
  let s = String(text ?? '');
  for (const key of ['FEED_CONFIG_TOKEN', 'SHAREPOINT_URL']) {
    const value = (process.env[key] || '').trim();
    if (value) s = s.split(value).join('[' + key + ']');
  }
  s = s.replace(/([?&]token=)[^&\s'"]+/gi, '$1[redacted]');
  // Download URLs gain ?download=1, so they are not always identical to the secret.
  s = s.replace(/https?:\/\/[^\s'"]+/gi, (url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      const share = host === 'sharepoint.com' || host.endsWith('.sharepoint.com') || host === '1drv.ms' ||
        host === 'onedrive.live.com' || host.endsWith('.onedrive.live.com');
      return share ? '[sharepoint-link]' : url;
    } catch (e) { return url; }
  });
  return s;
}

function jobWarning(message) {
  const text = redactSecrets(message).replace(/[\r\n]+/g, ' ');
  console.warn(text);
  console.log('::warning title=Admin schedule source unread::' + text);
}

function linkSourceLabel(from) {
  if (from === 'secret') return 'SHAREPOINT_URL secret';
  if (from === 'apps-script') return 'Apps Script';
  if (from === 'file') return 'rss/schedule-source.json';
  return 'none';
}

async function resolveScheduleSource() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(SCHEDULE_SOURCE_FILE, 'utf8')); } catch (e) { file = {}; }
  const envSource = (process.env.SCHEDULE_SOURCE || '').trim().toLowerCase();
  const envUrl = (process.env.SHAREPOINT_URL || '').trim();
  let source = envSource || String(file.source || 'sheets').toLowerCase();
  let sharepointUrl = envUrl || String(file.sharepointUrl || '').trim();
  let linkFrom = envUrl ? 'secret' : (sharepointUrl ? 'file' : 'none');
  const admin = (process.env.ADMIN_SCRIPT_URL || file.adminScriptUrl || '').trim();
  const token = (process.env.FEED_CONFIG_TOKEN || '').trim();
  // Env SCHEDULE_SOURCE wins so an operator can force a source without Apps Script.
  if (envSource) {
    console.log('Schedule source from SCHEDULE_SOURCE env: ' + (envSource === 'sharepoint' ? 'sharepoint' : 'sheets') + ' (admin dashboard not consulted)');
  } else if (token && admin) {
    try {
      const join = admin.includes('?') ? '&' : '?';
      const url = admin + join + 'action=scheduleSourceForFeed&token=' + encodeURIComponent(token);
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
        headers: { 'user-agent': 'race-control-rss/1.0' },
      });
      const j = JSON.parse(await res.text());
      if (res.ok && j && j.ok && (j.source === 'sheets' || j.source === 'sharepoint')) {
        source = j.source;
        if (!envUrl && j.sharepointUrl) {
          sharepointUrl = String(j.sharepointUrl).trim();
          linkFrom = sharepointUrl ? 'apps-script' : linkFrom;
        }
        console.log('Schedule source from Apps Script: ' + source);
      } else {
        jobWarning('Apps Script schedule source was not usable (HTTP ' + res.status + '); using rss/schedule-source.json');
      }
    } catch (e) {
      jobWarning('Apps Script schedule source failed (' + e.message + '); using rss/schedule-source.json');
    }
  } else {
    const missing = [];
    if (!token) missing.push('FEED_CONFIG_TOKEN');
    if (!admin) missing.push('admin script URL');
    const fileSource = String(file.source || 'sheets').toLowerCase() === 'sharepoint' ? 'sharepoint' : 'sheets';
    jobWarning('Cannot read the admin dashboard (' + missing.join(' and ') + ' missing). Using rss/schedule-source.json (' + fileSource + '). Pass FEED_CONFIG_TOKEN and the admin script URL into this job so the dashboard switch reaches the board.');
  }
  if (source !== 'sharepoint') source = 'sheets';
  return { source, sharepointUrl, linkFrom };
}

async function fetchSharePointSnapshot(src) {
  if (!src.sharepointUrl) {
    throw new Error('Schedule source is SharePoint but no workbook link is available. Save the link on the admin dashboard and set FEED_CONFIG_TOKEN (script property + GitHub secret), or set secret SHAREPOINT_URL. Sheets was not used as a fallback, so nothing was published.');
  }
  console.log('SharePoint workbook link from ' + linkSourceLabel(src.linkFrom));
  const snap = snapshotFromXlsxBuffer(await downloadXlsx(src.sharepointUrl));
  console.log('SharePoint Day tabs: ' + snap.tabs.map(([l]) => l).join(', '));
  return snap;
}

async function fetchSnapshot() {
  const src = await resolveScheduleSource();
  console.log('Schedule source: ' + src.source);
  if (src.source === 'sharepoint') return fetchSharePointSnapshot(src);
  return fetchGoogleSnapshot();
}

// ---------- diffing ----------
const weekday = date => date.split(',')[0];
const shortDate = date => date.replace(/,\s*\d{4}$/, '');
function roundText(round) {
  const m = /^(R|Q|TT|E)\s*-?\s*(\d+)$/i.exec(round);
  if (!m) return round;
  const kind = { R: 'Round', Q: 'Qualifying', TT: 'Time Trial', E: 'Elimination' }[m[1].toUpperCase()];
  return `${kind} ${m[2]}`;
}
const session = it => it.round ? `${it.name} ${roundText(it.round)}` : it.name;
const populated = snap => snap.days.filter(d => d.items.length);
// Event name from the first tab that has a real 'PA Broadcast:' row title (tabs without one fall back to 'Race weekend').
const eventTitle = snap => (snap.days.find(d => d.title && d.title !== 'Race weekend') || {}).title || '';

function matchSessions(prev, cur) {
  // 1) exact name+round matches, nth occurrence to nth occurrence
  const pairs = [], usedP = new Set(), usedC = new Set();
  const key = it => (it.name + '|' + it.round).toLowerCase();
  const pool = new Map();
  prev.forEach((it, i) => { const k = key(it); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(i); });
  cur.forEach((it, j) => { const list = pool.get(key(it)); if (list && list.length) { const i = list.shift(); pairs.push([i, j]); usedP.add(i); usedC.add(j); } });
  // 2) same name, different round (round changed), paired in sheet order
  const restP = prev.map((_, i) => i).filter(i => !usedP.has(i));
  for (const j of cur.map((_, j) => j).filter(j => !usedC.has(j))) {
    const k = restP.findIndex(i => prev[i].name.toLowerCase() === cur[j].name.toLowerCase());
    if (k >= 0) { const i = restP.splice(k, 1)[0]; pairs.push([i, j]); usedP.add(i); usedC.add(j); }
  }
  return {
    pairs,
    removed: prev.map((_, i) => i).filter(i => !usedP.has(i)),
    added: cur.map((_, j) => j).filter(j => !usedC.has(j)),
  };
}

function diffDay(p, c) {
  const day = weekday(c.date), out = [];
  const { pairs, removed, added } = matchSessions(p.items, c.items);
  for (const i of removed) out.push(`${day}: ${session(p.items[i])} removed from the run order`);
  for (const j of added) {
    const it = c.items[j], before = c.items[j - 1];
    let text = `${day}: ${session(it)} added to the run order`;
    if (it.scheduled) text += ` at ${it.scheduled}`;
    else if (before) text += `, after ${session(before)}`;
    if (it.note) text += ` (${it.note})`;
    out.push(text);
  }
  pairs.sort((a, b) => a[1] - b[1]);
  for (const [i, j] of pairs) {
    const a = p.items[i], b = c.items[j];
    let label = session(b);
    if (a.round !== b.round) {
      out.push(`${day}: ${a.name} changed from ${roundText(a.round) || 'no round'} to ${roundText(b.round) || 'no round'}`);
    }
    if (a.scheduled !== b.scheduled) {
      if (a.scheduled && b.scheduled) out.push(`${day}: ${label} moved from ${a.scheduled} to ${b.scheduled}`);
      else if (b.scheduled) out.push(`${day}: ${label} now scheduled for ${b.scheduled}`);
      else out.push(`${day}: ${label} no longer has a set time (was ${a.scheduled}); it follows the run order`);
    }
    if (a.note !== b.note) {
      if (b.note && a.note) out.push(`${day}: ${label} note changed to "${b.note}"`);
      else if (b.note) out.push(`${day}: ${label} note added: "${b.note}"`);
      else out.push(`${day}: ${label} note removed (was "${a.note}")`);
    }
  }
  return out;
}

function diffSnapshots(prev, cur) {
  const changes = [];
  const prevDays = populated(prev), curDays = populated(cur);
  const dayKey = d => d.gid + '|' + d.date;
  const prevMap = new Map(prevDays.map(d => [dayKey(d), d]));
  const curMap = new Map(curDays.map(d => [dayKey(d), d]));
  const eventBefore = eventTitle(prev), eventNow = eventTitle(cur);
  if (eventBefore && eventNow && eventBefore !== eventNow) {
    return [{ summary: `Run order updated for ${eventNow}`, details: curDays.map(d => `${d.date}: ${d.items.length} sessions`) }];
  }
  for (const d of prevDays) if (!curMap.has(dayKey(d))) changes.push(`${shortDate(d.date)} removed from the run order`);
  for (const d of curDays) {
    const before = prevMap.get(dayKey(d));
    if (!before) changes.push(`Run order posted for ${shortDate(d.date)} (${d.items.length} session${d.items.length === 1 ? '' : 's'})`);
    else changes.push(...diffDay(before, d));
  }
  const radioBefore = prev.days.map(d => d.radio).find(Boolean) || '', radioNow = cur.days.map(d => d.radio).find(Boolean) || '';
  if (radioBefore !== radioNow && radioNow) changes.push(`PA broadcast is now ${radioNow}`);
  if (changes.length > SUMMARIZE_OVER) {
    return [{ summary: `${changes.length} changes to the run order`, details: changes }];
  }
  return changes.map(text => ({ summary: text }));
}

// ---------- RSS ----------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
function renderFeed(items, lastBuild) {
  const body = items.map(it => [
    '    <item>',
    `      <title>${esc(it.title)}</title>`,
    `      <link>${esc(PAGE_URL)}</link>`,
    `      <description>${esc(it.description)}</description>`,
    `      <guid isPermaLink="false">${esc(it.guid)}</guid>`,
    `      <pubDate>${new Date(it.date).toUTCString()}</pubDate>`,
    '    </item>',
  ].join('\n')).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(config.feedTitle)}</title>
    <link>${esc(PAGE_URL)}</link>
    <description>${esc(config.feedDescription)}</description>
    <language>en-us</language>
    <atom:link href="${esc(FEED_URL)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date(lastBuild).toUTCString()}</lastBuildDate>
    <ttl>5</ttl>
${body}
  </channel>
</rss>
`;
}

function makeItem(change, when, n) {
  const title = change.summary;
  const html = '<p>' + esc(title) + '</p>' +
    (change.details ? '<ul>' + change.details.map(d => '<li>' + esc(d) + '</li>').join('') + '</ul>' : '') +
    '<p>All run orders are subject to change. Times are shown exactly as published by the event.</p>';
  const guid = 'race-control-' + crypto.createHash('sha1').update(when + '|' + n + '|' + title).digest('hex').slice(0, 20);
  return { guid, date: when, title, description: html };
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

async function notifyPhones(items) {
  if (!config.ntfy?.enabled || !items.length) return;
  const topic = config.ntfy.topic;
  if (!topic || /REPLACE_ME/.test(topic)) { console.warn('ntfy enabled but topic not set; skipping'); return; }
  const title = items.length === 1 ? 'Run order change' : `${items.length} run order changes`;
  const message = items.slice(0, 6).map(i => i.title).join('\n') + (items.length > 6 ? `\n+${items.length - 6} more` : '');
  try {
    const res = await fetch(`${config.ntfy.server.replace(/\/$/, '')}/${encodeURIComponent(topic)}`, {
      method: 'POST', body: message, signal: AbortSignal.timeout(15000),
      headers: { Title: title, Click: PAGE_URL },
    });
    if (!res.ok) console.warn('ntfy returned HTTP', res.status);
  } catch (e) { console.warn('ntfy failed:', e.message); }
}

// last-run.json: {ok, at, error, lastOkAt, consecutiveFailures}. Written on every exit; success clears error.
// Only the health fields live here (no timestamps of no-change runs beyond `at`), committed by CI.
function writeLastRun(ok, error) {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(LAST_RUN, 'utf8')); } catch (e) {}
  const at = new Date().toISOString();
  const out = ok
    ? { ok: true, at, error: null, lastOkAt: at, consecutiveFailures: 0 }
    : { ok: false, at, error: redactSecrets(String(error || 'unknown error')).slice(0, 500), lastOkAt: prev.lastOkAt || null,
        consecutiveFailures: (prev.consecutiveFailures || 0) + 1 };
  try { writeAtomic(LAST_RUN, JSON.stringify(out, null, 2) + '\n'); } catch (e) { console.error('could not write last-run.json:', e.message); }
  return out;
}

function datesUnusable(snap) {
  const days = populated(snap);
  return days.length > 0 && days.every(d => {
    const y = /(\d{4})\s*$/.exec(String(d.date || ''));
    const year = y ? Number(y[1]) : 0;
    return year < 2020 || year > 2100;
  });
}

async function main() {
  const cur = await fetchSnapshot(); // throws (and changes nothing) if any tab fails
  const prev = fs.existsSync(SNAPSHOT) ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) : null;
  let items = fs.existsSync(ITEMS) ? JSON.parse(fs.readFileSync(ITEMS, 'utf8')) : [];
  const when = cur.fetchedAt;
  const prevSource = prev ? (prev.scheduleSource || 'sheets') : null;
  const sourceChanged = !!(prev && prevSource !== (cur.scheduleSource || 'sheets'));
  let changes;
  if (!prev) {
    const days = populated(cur);
    const event = eventTitle(cur) || 'Race weekend';
    changes = [{ summary: `Run order published: ${event}`, details: days.map(d => `${d.date}: ${d.items.length} sessions`) }];
  } else if (sourceChanged || datesUnusable(prev)) {
    // Switching Sheets ↔ SharePoint, or replacing the Excel-epoch dates from the
    // first SharePoint publish, must not text the list about the baseline change.
    changes = [];
    console.log(sourceChanged
      ? `Schedule source changed ${prevSource} -> ${cur.scheduleSource}; baseline reset, no alert item.`
      : 'Schedule dates corrected from an unusable baseline; no alert item.');
  } else {
    changes = diffSnapshots(prev, cur);
  }
  const fresh = changes.map((c, n) => makeItem(c, when, n));
  // Newest run first; within a run, top-to-bottom sheet order.
  if (fresh.length) items = [...fresh, ...items].slice(0, MAX_ITEMS);
  // Only rewrite the snapshot when the schedule content changed, so CI commits stay quiet.
  const sameContent = prev && JSON.stringify(prev.days) === JSON.stringify(cur.days) &&
    (prev.scheduleSource || 'sheets') === (cur.scheduleSource || 'sheets');
  if (!sameContent) writeAtomic(SNAPSHOT, JSON.stringify(cur, null, 2) + '\n');
  if (fresh.length) writeAtomic(ITEMS, JSON.stringify(items, null, 2) + '\n');
  if (fresh.length || !fs.existsSync(FEED_OUT)) writeAtomic(FEED_OUT, renderFeed(items, items[0]?.date || when));
  // days.json is the Google GID fast path. Leave it alone in SharePoint mode so a
  // later switch back to Sheets still has numeric gids (the page falls through to names anyway).
  let daysChanged = false;
  if ((cur.scheduleSource || 'sheets') !== 'sharepoint') {
    const daysJson = JSON.stringify({ sheetId: config.sheetId, tabs: cur.tabs }, null, 2) + '\n';
    daysChanged = !fs.existsSync(DAYS_OUT) || fs.readFileSync(DAYS_OUT, 'utf8') !== daysJson;
    if (daysChanged) writeAtomic(DAYS_OUT, daysJson);
  }
  let scheduleChanged = false;
  const meta = JSON.stringify({
    source: cur.scheduleSource === 'sharepoint' ? 'sharepoint' : 'sheets',
    label: cur.scheduleSource === 'sharepoint' ? 'SharePoint' : 'Google Sheets',
  }, null, 2) + '\n';
  if (!fs.existsSync(SCHEDULE_META_OUT) || fs.readFileSync(SCHEDULE_META_OUT, 'utf8') !== meta) {
    writeAtomic(SCHEDULE_META_OUT, meta);
    scheduleChanged = true;
  }
  if (cur.scheduleSource === 'sharepoint') {
    const pageDays = cur.days.map(d => ({
      label: d.label, gid: d.gid, date: d.date, title: d.title, radio: d.radio,
      items: d.items.map(it => ({
        scheduled: it.scheduled || '', actual: it.actual || '', name: it.name, round: it.round || '', note: it.note || '',
      })),
    }));
    const scheduleJson = JSON.stringify({ source: 'sharepoint', days: pageDays }, null, 2) + '\n';
    if (!fs.existsSync(SCHEDULE_JSON_OUT) || fs.readFileSync(SCHEDULE_JSON_OUT, 'utf8') !== scheduleJson) {
      writeAtomic(SCHEDULE_JSON_OUT, scheduleJson);
      scheduleChanged = true;
    }
  } else if (fs.existsSync(SCHEDULE_JSON_OUT)) {
    fs.unlinkSync(SCHEDULE_JSON_OUT);
    scheduleChanged = true;
  }
  console.log(fresh.length ? `${fresh.length} new item(s):\n` + fresh.map(i => '  - ' + i.title).join('\n') : 'No changes.');
  if (daysChanged) console.log('Day tabs changed; wrote ' + DAYS_OUT);
  if (scheduleChanged) console.log('Schedule publish files changed (' + (cur.scheduleSource || 'sheets') + ').');
  // Machine-readable flag for CI: did the published files change?
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${fresh.length || daysChanged || scheduleChanged ? 'true' : 'false'}\n`);
  await notifyPhones(prev ? fresh : []);
}

if (require.main === module) {
  (async () => {
    let ok = false, error = null;
    try {
      await main();
      ok = true;
    } catch (e) {
      error = redactSecrets(e.message);
      console.error('Feed not updated:', error);
    } finally {
      const r = writeLastRun(ok, error);
      if (!ok) console.error(`::error title=Race Control feed failed::${error} (failure #${r.consecutiveFailures} in a row; last good run ${r.lastOkAt || 'unknown'})`);
    }
    process.exit(ok ? 0 : 1);
  })();
}

module.exports = { parseDay, toDownloadUrl, snapshotFromXlsxBuffer, diffSnapshots, resolveScheduleSource, fetchSharePointSnapshot, fetchBytesFollowingCookies, downloadXlsx, redactSecrets };

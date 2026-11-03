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
const { readXlsxGrids } = require('./xlsx-grid');

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

// ---------- parsing (mirrors parseDay() in index.html) ----------
const clean = v => String(v ?? '').trim();
const datePattern = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), /;
function parseDay(rows, label, gid) {
  const header = rows.findIndex(r => /^ELIMINATOR$/i.test(clean(r[5])));
  if (header < 0) throw new Error(`${label}: daily column layout has changed`);
  const top = rows.slice(0, header);
  const date = clean((top.find(r => datePattern.test(clean(r[2]))) || [])[2]);
  const radioRow = top.find(r => /^PA Broadcast:/i.test(clean(r[2]))) || [];
  const title = clean(radioRow[5]) || 'Race weekend';
  const radio = clean(radioRow[4]) || clean(radioRow[2]).replace(/^PA Broadcast:\s*/i, '');
  const items = [];
  for (const r of rows.slice(header + 1)) {
    const name = clean(r[5]);
    if (!name || name.startsWith('#')) continue;
    items.push({ scheduled: clean(r[2]), actual: clean(r[3]), name, round: clean(r[6]), note: clean(r[11]) });
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

async function downloadXlsx(rawUrl) {
  const url = toDownloadUrl(rawUrl);
  let lastError;
  for (let attempt = 0; attempt < FETCH_TRIES; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
        headers: { 'user-agent': 'race-control-rss/1.0', accept: '*/*' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        throw new Error('link did not return an xlsx. Share the workbook so anyone with the link can view, and paste the file link (not a folder). Graph sign-in is not used.');
      }
      return buf;
    } catch (e) {
      lastError = e;
      console.warn(`SharePoint download attempt ${attempt + 1}/${FETCH_TRIES} failed (${e.message})`);
      if (pastDeadline()) break;
      if (attempt < FETCH_TRIES - 1) await backoff(attempt);
    }
  }
  throw new Error('SharePoint workbook: ' + lastError.message);
}

async function resolveScheduleSource() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(SCHEDULE_SOURCE_FILE, 'utf8')); } catch (e) { file = {}; }
  const envSource = (process.env.SCHEDULE_SOURCE || '').trim().toLowerCase();
  const envUrl = (process.env.SHAREPOINT_URL || '').trim();
  let source = envSource || String(file.source || 'sheets').toLowerCase();
  let sharepointUrl = envUrl || String(file.sharepointUrl || '').trim();
  const admin = (process.env.ADMIN_SCRIPT_URL || file.adminScriptUrl || '').trim();
  const token = (process.env.FEED_CONFIG_TOKEN || '').trim();
  // Env SCHEDULE_SOURCE wins so an operator can force Sheets without Apps Script.
  if (!envSource && token && admin) {
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
        if (!envUrl && j.sharepointUrl) sharepointUrl = String(j.sharepointUrl).trim();
        console.log('Schedule source from Apps Script: ' + source);
      } else {
        console.warn('Apps Script schedule source was not usable; using rss/schedule-source.json');
      }
    } catch (e) {
      console.warn('Apps Script schedule source failed (' + e.message + '); using rss/schedule-source.json');
    }
  }
  if (source !== 'sharepoint') source = 'sheets';
  return { source, sharepointUrl };
}

async function fetchSharePointSnapshot(src) {
  if (!src.sharepointUrl) {
    throw new Error('Schedule source is SharePoint but no workbook link is available. Save the link on the admin dashboard and set FEED_CONFIG_TOKEN (script property + GitHub secret), or set secret SHAREPOINT_URL. Sheets was not used as a fallback, so nothing was published.');
  }
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
    : { ok: false, at, error: String(error || 'unknown error').slice(0, 500), lastOkAt: prev.lastOkAt || null,
        consecutiveFailures: (prev.consecutiveFailures || 0) + 1 };
  try { writeAtomic(LAST_RUN, JSON.stringify(out, null, 2) + '\n'); } catch (e) { console.error('could not write last-run.json:', e.message); }
  return out;
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
  } else if (sourceChanged) {
    // Switching Sheets ↔ SharePoint must not text the whole list about the baseline change.
    changes = [];
    console.log(`Schedule source changed ${prevSource} -> ${cur.scheduleSource}; baseline reset, no alert item.`);
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
      error = e.message;
      console.error('Feed not updated:', e.message);
    } finally {
      const r = writeLastRun(ok, error);
      if (!ok) console.error(`::error title=Race Control feed failed::${error} (failure #${r.consecutiveFailures} in a row; last good run ${r.lastOkAt || 'unknown'})`);
    }
    process.exit(ok ? 0 : 1);
  })();
}

module.exports = { parseDay, toDownloadUrl, snapshotFromXlsxBuffer, diffSnapshots };

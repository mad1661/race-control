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
const PAGE_URL = process.env.PAGE_URL || config.pageUrl;
const FEED_URL = process.env.FEED_URL || config.feedUrl;
const MAX_ITEMS = config.maxItems || 50;
const SUMMARIZE_OVER = config.summarizeOver || 25;

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
    // Column L notes render on the public page, but they are not part of the run order the feed tracks.
    items.push({ scheduled: clean(r[2]), name, round: clean(r[6]) });
  }
  if (!date) throw new Error(`${label}: schedule date is missing`);
  return { label, gid, date, title, radio, items };
}

async function fetchTab(gid) {
  const params = new URLSearchParams({ gid, headers: '0', range: 'A1:L1000', tqx: 'out:json' });
  const url = `https://docs.google.com/spreadsheets/d/${config.sheetId}/gviz/tq?${params}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
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
    } catch (e) { lastError = e; await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); }
  }
  throw new Error(`tab ${gid}: ${lastError.message}`);
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
  for (let attempt = 0; attempt < 3 && html === undefined; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'race-control-rss/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (e) { lastError = e; await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); }
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

async function fetchSnapshot() {
  const { tabs, source } = await discoverTabs();
  console.log(`Day tabs (${source}): ` + tabs.map(([l, g]) => `${l}=${g}`).join(', '));
  const days = [];
  for (const [label, gid] of tabs) days.push(parseDay(await fetchTab(gid), label, gid));
  return { fetchedAt: new Date().toISOString(), days, tabs };
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
// Fields that define the published run order. Session notes (and any other leftover keys) are dropped
// so a note-only sheet edit does not diff, rewrite the snapshot, or produce a feed item.
function scheduleView(snap) {
  return snap.days.map(d => ({
    label: d.label,
    gid: d.gid,
    date: d.date,
    title: d.title,
    radio: d.radio,
    items: d.items.map(it => ({ scheduled: it.scheduled, name: it.name, round: it.round })),
  }));
}
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

async function main() {
  const cur = await fetchSnapshot(); // throws (and changes nothing) if any tab fails
  const prev = fs.existsSync(SNAPSHOT) ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) : null;
  let items = fs.existsSync(ITEMS) ? JSON.parse(fs.readFileSync(ITEMS, 'utf8')) : [];
  const when = cur.fetchedAt;
  let changes;
  if (!prev) {
    const days = populated(cur);
    const event = eventTitle(cur) || 'Race weekend';
    changes = [{ summary: `Run order published: ${event}`, details: days.map(d => `${d.date}: ${d.items.length} sessions`) }];
  } else {
    changes = diffSnapshots(prev, cur);
  }
  const fresh = changes.map((c, n) => makeItem(c, when, n));
  // Newest run first; within a run, top-to-bottom sheet order.
  if (fresh.length) items = [...fresh, ...items].slice(0, MAX_ITEMS);
  // Only rewrite the snapshot when the published run order changed, so note-only edits stay quiet in CI.
  const sameContent = prev && JSON.stringify(scheduleView(prev)) === JSON.stringify(scheduleView(cur));
  if (!sameContent) writeAtomic(SNAPSHOT, JSON.stringify({ fetchedAt: cur.fetchedAt, days: scheduleView(cur) }, null, 2) + '\n');
  if (fresh.length) writeAtomic(ITEMS, JSON.stringify(items, null, 2) + '\n');
  if (fresh.length || !fs.existsSync(FEED_OUT)) writeAtomic(FEED_OUT, renderFeed(items, items[0]?.date || when));
  // days.json carries no timestamp so it only changes (and commits) when the sheet's Day tabs change.
  const daysJson = JSON.stringify({ sheetId: config.sheetId, tabs: cur.tabs }, null, 2) + '\n';
  const daysChanged = !fs.existsSync(DAYS_OUT) || fs.readFileSync(DAYS_OUT, 'utf8') !== daysJson;
  if (daysChanged) writeAtomic(DAYS_OUT, daysJson);
  console.log(fresh.length ? `${fresh.length} new item(s):\n` + fresh.map(i => '  - ' + i.title).join('\n') : 'No changes.');
  if (daysChanged) console.log('Day tabs changed; wrote ' + DAYS_OUT);
  // Machine-readable flag for CI: did the published files change?
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${fresh.length || daysChanged ? 'true' : 'false'}\n`);
  await notifyPhones(prev ? fresh : []);
}

main().catch(e => { console.error('Feed not updated:', e.message); process.exit(1); });

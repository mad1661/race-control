#!/usr/bin/env node
// Patch-deploy the feed data files to Firebase Hosting (race-control-feed).
// Clones the live release and replaces ONLY the listed files; every other live
// file (index.html, sms-admin.html, images...) is kept byte-for-byte.
// Never use `firebase deploy` for hosting on this site: it wipes live files.
// Credentials: FIREBASE_DEPLOY_SA env = service-account JSON (hosting admin only).
// Skips the release entirely when the live files already match.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const SITE = process.env.FIREBASE_SITE || 'race-control-feed';
const FILES = ['feed.xml', 'days.json', 'schedule-meta.json', 'schedule.json'];
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const API = 'https://firebasehosting.googleapis.com/v1beta1';
const b64u = b => Buffer.from(b).toString('base64url');

async function token() {
  const sa = JSON.parse(process.env.FIREBASE_DEPLOY_SA || '{}');
  if (!sa.private_key) throw new Error('FIREBASE_DEPLOY_SA missing');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.hosting',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64u(sig) }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('token rejected: ' + (j.error_description || j.error));
  return j.access_token;
}
async function api(tok, method, p, body) {
  const r = await fetch(API + p, { method, headers: { Authorization: 'Bearer ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} ${r.status}: ${j.error && j.error.message}`);
  return j;
}
(async () => {
  const tok = await token();
  const ch = await api(tok, 'GET', `/sites/${SITE}/channels/live`);
  const live = ch.release.version;
  const tree = {};
  let pageToken = '';
  do {
    const j = await api(tok, 'GET', `/${live.name}/files?pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`);
    for (const f of j.files || []) tree[f.path] = f.hash;
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  const blobs = new Map(); let changed = [];
  for (const f of FILES) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    let buf = fs.readFileSync(p);
    if (f === 'feed.xml') buf = Buffer.from(buf.toString().replace(/href="[^"]+" rel="self"/, `href="https://${SITE}.web.app/feed.xml" rel="self"`));
    // Hash is over gzip bytes; compare via content hash of the live file instead of gzip bytes.
    const liveBody = tree['/' + f] ? await fetch(`https://${SITE}.web.app/${f}?nocache=${Date.now()}`).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null) : null;
    if (liveBody && Buffer.compare(Buffer.from(liveBody), buf) === 0) continue;
    const gz = zlib.gzipSync(buf, { level: 9 });
    const h = crypto.createHash('sha256').update(gz).digest('hex');
    tree['/' + f] = h; blobs.set(h, gz); changed.push(f);
  }
  if (!changed.length) { console.log('firebase: live already matches, nothing to deploy'); return; }
  const ver = await api(tok, 'POST', `/sites/${SITE}/versions`, { config: live.config || {} });
  const pop = await api(tok, 'POST', `/${ver.name}:populateFiles`, { files: tree });
  for (const h of pop.uploadRequiredHashes || []) {
    const gz = blobs.get(h);
    if (!gz) throw new Error('hosting asked for unknown hash ' + h.slice(0, 12));
    const r = await fetch(`${pop.uploadUrl}/${h}`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/octet-stream' }, body: gz });
    if (!r.ok) throw new Error('upload failed ' + r.status);
  }
  await api(tok, 'PATCH', `/${ver.name}?updateMask=status`, { status: 'FINALIZED' });
  await api(tok, 'POST', `/sites/${SITE}/releases?versionName=${encodeURIComponent(ver.name)}`, { message: 'GitHub Actions feed patch: ' + changed.join(', ') });
  console.log(`firebase: patched ${changed.join(', ')} -> ${ver.name} (${Object.keys(tree).length} files kept live)`);
})().catch(e => { console.error('firebase patch FAILED:', e.message); process.exit(1); });

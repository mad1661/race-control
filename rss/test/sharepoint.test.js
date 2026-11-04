'use strict';
const assert = require('assert');
const zlib = require('zlib');
const { formatExcelNumber, readXlsxGrids } = require('../xlsx-grid');
const http = require('http');
const { parseDay, toDownloadUrl, snapshotFromXlsxBuffer, fetchBytesFollowingCookies, downloadXlsx } = require('../generate');

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function zip(files) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data, method] of files) {
    const nameBuf = Buffer.from(name);
    const stored = method === 8 ? zlib.deflateRawSync(data) : data;
    const useMethod = method === 8 ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(useMethod, 8);
    const crc = crc32(data);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(useMethod, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += local.length + nameBuf.length + stored.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

assert.strictEqual(formatExcelNumber(0.4375, 'time'), '10:30 AM');
assert.strictEqual(formatExcelNumber(45962, 'date').includes('2025') || formatExcelNumber(45962, 'date').includes(','), true);

const serial = (Date.UTC(2026, 10, 1) - Date.UTC(1899, 11, 30)) / 86400000;
assert.strictEqual(formatExcelNumber(serial, 'date'), 'Sunday, November 1, 2026');
assert.strictEqual(formatExcelNumber(46338, 'date'), 'Thursday, November 12, 2026');

const shared =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<si><t>Sunday, November 01, 2026</t></si>' +
  '<si><t>PA Broadcast: 88.5 FM</t></si>' +
  '<si><t>NHRA Nationals</t></si>' +
  '<si><t>ELIMINATOR</t></si>' +
  '<si><t>8:00 AM</t></si>' +
  '<si><t>TOP FUEL</t></si>' +
  '<si><t>R-1</t></si>' +
  '<si><t>Pit note</t></si>' +
  '<si><t>FUNNY CAR</t></si>' +
  '</sst>';
const styles =
  '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="18"/></cellXfs></styleSheet>';
const sheet =
  '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
  '<row r="1"><c r="C1" t="s"><v>0</v></c></row>' +
  '<row r="2"><c r="C2" t="s"><v>1</v></c><c r="E2" t="s"><v>1</v></c><c r="F2" t="s"><v>2</v></c></row>' +
  '<row r="3"><c r="F3" t="s"><v>3</v></c></row>' +
  '<row r="4"><c r="C4" s="1"><v>0.4375</v></c><c r="D4" t="s"><v>4</v></c><c r="F4" t="s"><v>5</v></c><c r="G4" t="s"><v>6</v></c><c r="L4" t="s"><v>7</v></c></row>' +
  '<row r="5"><c r="F5" t="s"><v>8</v></c><c r="G5" t="inlineStr"><is><t>R-2</t></is></c></row>' +
  '</sheetData></worksheet>';
const workbook =
  '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Notes" sheetId="1" r:id="rId1"/><sheet name="Day 1" sheetId="2" r:id="rId2"/></sheets></workbook>';
const rels =
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/>' +
  '</Relationships>';
const notes = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ignore</t></is></c></row></sheetData></worksheet>';

const buf = zip([
  ['xl/workbook.xml', Buffer.from(workbook), 0],
  ['xl/_rels/workbook.xml.rels', Buffer.from(rels), 0],
  ['xl/sharedStrings.xml', Buffer.from(shared), 8],
  ['xl/styles.xml', Buffer.from(styles), 0],
  ['xl/worksheets/sheet1.xml', Buffer.from(notes), 0],
  ['xl/worksheets/sheet2.xml', Buffer.from(sheet), 0],
]);

const grids = readXlsxGrids(buf);
assert.deepStrictEqual(grids.map(g => g.name), ['Notes', 'Day 1']);
const snap = snapshotFromXlsxBuffer(buf);
assert.strictEqual(snap.scheduleSource, 'sharepoint');
assert.strictEqual(snap.days.length, 1);
const day = snap.days[0];
assert.strictEqual(day.date, 'Sunday, November 01, 2026');
assert.strictEqual(day.title, 'NHRA Nationals');
assert.strictEqual(day.items.length, 2);
assert.strictEqual(day.items[0].name, 'TOP FUEL');
assert.strictEqual(day.items[0].scheduled, '10:30 AM');
assert.strictEqual(day.items[0].actual, '8:00 AM');
assert.strictEqual(day.items[0].round, 'R-1');
assert.strictEqual(day.items[0].note, 'Pit note');
assert.strictEqual(day.items[1].name, 'FUNNY CAR');
assert.strictEqual(day.items[1].round, 'R-2');

const parsed = parseDay(grids[1].rows, 'Day 1', 'sharepoint');
assert.strictEqual(parsed.items[0].scheduled, '10:30 AM');

const dl = toDownloadUrl('https://contoso.sharepoint.com/:x:/s/DRS/EeToken?e=abc&web=1');
const u = new URL(dl);
assert.strictEqual(u.searchParams.get('download'), '1');
assert.strictEqual(u.searchParams.get('web'), null);
assert.strictEqual(u.searchParams.get('e'), 'abc');
assert.throws(() => toDownloadUrl('http://contoso.sharepoint.com/file.xlsx'), /https/);
assert.throws(() => toDownloadUrl('https://example.com/file.xlsx'), /host/);

// PC2 / DRS workbook: date serial in column G, not a weekday string in column C.
// A 1900-formatted serial elsewhere must not win. Numeric junk in column L is not a note.
const pc2Rows = [
  ['', '', '', 'MOPAR', '', ''],
  ['', '', '', '106.1 FM', '', 'NHRA Finals'],
  ['', '', '', 'powered by Dodge', '', '', '46338', '', '', '', '', '', '', '', '', '', '', '', 'Friday, January 05, 1900'],
  ['', '', '', 'Actual', 'Projected', 'ELIMINATOR', 'Q, TT', 'Number'],
  ['', '', '', '', '', '', '', 'of cars'],
  ['', 'TF Q-1', '8:00 AM', '', '', 'Top Fuel', 'Q-1', '16', '', '', '', '9.2592592592592587E-3'],
  ['', 'FC Q-1', '8:30 AM', '8:32 AM', '', 'Funny Car', 'Q-1', '', '', '', '', 'Finals Eliminations on'],
  ['', 'PS Q-1', '9:00 AM', '', '', 'Pro Stock', 'Q-1'],
  ['', 'PM R-1', '9:30 AM', '', '', 'Pro Mod', 'R-1'],
];
const finals = parseDay(pc2Rows, 'Day 1', 'sharepoint');
assert.strictEqual(finals.date, 'Thursday, November 12, 2026');
assert.strictEqual(finals.title, 'NHRA Finals powered by Dodge');
assert.strictEqual(finals.radio, '106.1 FM');
assert.deepStrictEqual(finals.items.map(i => i.name), ['Top Fuel', 'Funny Car', 'Pro Stock', 'Pro Mod']);
assert.strictEqual(finals.items[0].scheduled, '8:00 AM');
assert.strictEqual(finals.items[0].round, 'Q-1');
assert.strictEqual(finals.items[0].note, '');
assert.strictEqual(finals.items[1].actual, '8:32 AM');
assert.strictEqual(finals.items[1].note, 'Finals Eliminations on');

// Sheets gviz still wins when column C already has the written date.
const sheetRows = [
  ['', '', 'Thursday, October 29, 2026', '', '', '', '46324'],
  ['', '', 'PA Broadcast: 106.1 FM', '', '', 'MOPAR NHRA Las Vegas Nationals powered by Dodge'],
  ['', '', 'Scheduled', '', '', 'ELIMINATOR', 'Q, TT'],
  ['', '', '8:00 AM', '7:58 AM', '', 'Stock', 'Q-1', '', '', '', '', 'pit hold'],
];
const vegas = parseDay(sheetRows, 'Day 1', '907931825');
assert.strictEqual(vegas.date, 'Thursday, October 29, 2026');
assert.strictEqual(vegas.title, 'MOPAR NHRA Las Vegas Nationals powered by Dodge');
assert.strictEqual(vegas.items[0].name, 'Stock');
assert.strictEqual(vegas.items[0].note, 'pit hold');
assert.strictEqual(vegas.items[0].actual, '7:58 AM');

const pc2Sheet =
  '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
  '<row r="2"><c r="D2" t="inlineStr"><is><t>106.1 FM</t></is></c><c r="F2" t="inlineStr"><is><t>NHRA Finals</t></is></c></row>' +
  '<row r="3"><c r="D3" t="inlineStr"><is><t>powered by Dodge</t></is></c><c r="G3"><v>46338</v></c>' +
  '<c r="S3" t="inlineStr"><is><t>Friday, January 05, 1900</t></is></c></row>' +
  '<row r="4"><c r="F4" t="inlineStr"><is><t>ELIMINATOR</t></is></c></row>' +
  '<row r="6"><c r="C6" t="inlineStr"><is><t>8:00 AM</t></is></c><c r="F6" t="inlineStr"><is><t>Top Fuel</t></is></c><c r="G6" t="inlineStr"><is><t>Q-1</t></is></c></row>' +
  '<row r="7"><c r="C7" t="inlineStr"><is><t>8:30 AM</t></is></c><c r="F7" t="inlineStr"><is><t>Funny Car</t></is></c><c r="G7" t="inlineStr"><is><t>Q-1</t></is></c></row>' +
  '</sheetData></worksheet>';
const pc2Day2 =
  '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
  '<row r="3"><c r="G3"><v>46339</v></c><c r="F3" t="inlineStr"><is><t>NHRA Finals</t></is></c></row>' +
  '<row r="4"><c r="F4" t="inlineStr"><is><t>ELIMINATOR</t></is></c></row>' +
  '<row r="6"><c r="C6" t="inlineStr"><is><t>10:00 AM</t></is></c><c r="F6" t="inlineStr"><is><t>Pro Stock</t></is></c><c r="G6" t="inlineStr"><is><t>R-1</t></is></c></row>' +
  '</sheetData></worksheet>';
const pc2Book =
  '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="1 Pager" sheetId="1" r:id="rId1"/><sheet name="Day 1" sheetId="2" r:id="rId2"/><sheet name="Day 2" sheetId="3" r:id="rId3"/></sheets></workbook>';
const pc2Rels =
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/>' +
  '<Relationship Id="rId3" Type="worksheet" Target="worksheets/sheet3.xml"/>' +
  '</Relationships>';
const pc2Buf = zip([
  ['xl/workbook.xml', Buffer.from(pc2Book), 0],
  ['xl/_rels/workbook.xml.rels', Buffer.from(pc2Rels), 0],
  ['xl/worksheets/sheet1.xml', Buffer.from(notes), 0],
  ['xl/worksheets/sheet2.xml', Buffer.from(pc2Sheet), 0],
  ['xl/worksheets/sheet3.xml', Buffer.from(pc2Day2), 0],
]);
const pc2Snap = snapshotFromXlsxBuffer(pc2Buf);
assert.strictEqual(pc2Snap.scheduleSource, 'sharepoint');
assert.deepStrictEqual(pc2Snap.tabs.map(t => t[0]), ['Day 1', 'Day 2']);
assert.strictEqual(pc2Snap.days[0].date, 'Thursday, November 12, 2026');
assert.strictEqual(pc2Snap.days[1].date, 'Friday, November 13, 2026');
assert.deepStrictEqual(pc2Snap.days[0].items.map(i => i.name), ['Top Fuel', 'Funny Car']);
assert.strictEqual(pc2Snap.days[0].title, 'NHRA Finals powered by Dodge');
assert.strictEqual(pc2Snap.days[1].items[0].name, 'Pro Stock');
assert.strictEqual(pc2Snap.days[1].items[0].round, 'R-1');

function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
(async () => {
  let sawCookie = false;
  let sawBrowser = false;
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
    await assert.rejects(
      () => downloadXlsx('https://example.com/nope.xlsx'),
      /host/
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('sharepoint xlsx ok:', day.items.map(i => i.name).join(', '), '+', finals.items.map(i => i.name).join(', '));
})().catch(err => {
  console.error(err);
  process.exit(1);
});

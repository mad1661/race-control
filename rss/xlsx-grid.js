'use strict';
// Minimal xlsx reader (ZIP + worksheet XML). No npm dependencies.
// Enough for the DRS Day-tab layout: shared strings, inline strings, and
// Excel date/time serials. Not a general spreadsheet library.
const zlib = require('zlib');

function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function colIndex(letters) {
  let n = 0;
  for (const ch of String(letters || '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('file is not an xlsx/zip');
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff > buf.length || cdOff + cdSize > buf.length) throw new Error('xlsx central directory is out of range');
  const files = {};
  let p = cdOff;
  const end = cdOff + cdSize;
  while (p + 46 <= end) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (localOff + 30 > buf.length) throw new Error('bad local header for ' + name);
    const lhNameLen = buf.readUInt16LE(localOff + 26);
    const lhExtra = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhNameLen + lhExtra;
    if (dataStart + compSize > buf.length) throw new Error('truncated zip entry ' + name);
    const comp = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error('unsupported zip method ' + method + ' in ' + name);
    files[name.replace(/\\/g, '/')] = data;
  }
  return files;
}

function sharedStrings(xml) {
  const out = [];
  const parts = String(xml || '').split(/<si\b[^>]*>/i).slice(1);
  for (const si of parts) {
    let body = si.split(/<\/si>/i)[0] || '';
    body = body.replace(/<rPh\b[\s\S]*?<\/rPh>/gi, '');
    const texts = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(m => decodeXml(m[1]));
    out.push(texts.join(''));
  }
  return out;
}

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function parseXfs(stylesXml) {
  if (!stylesXml) return [];
  const xml = String(stylesXml);
  const custom = {};
  for (const m of xml.matchAll(/<numFmt\b[^>]*\/?>/g)) {
    const tag = m[0];
    const id = /numFmtId="(\d+)"/.exec(tag);
    const code = /formatCode="([^"]*)"/.exec(tag);
    if (id && code) custom[id[1]] = code[1];
  }
  const cellXfs = xml.split(/<cellXfs\b[^>]*>/i)[1] || '';
  const body = cellXfs.split(/<\/cellXfs>/i)[0] || '';
  const xfs = [];
  for (const m of body.matchAll(/<xf\b[^>]*>/g)) {
    const idm = /numFmtId="(\d+)"/.exec(m[0]);
    const id = idm ? parseInt(idm[1], 10) : 0;
    let kind = 'number';
    if (BUILTIN_DATE.has(id)) kind = (id >= 18 && id <= 21) ? 'time' : (id === 22 ? 'datetime' : 'date');
    else if (custom[id]) {
      const code = custom[id].replace(/\[[^\]]*\]/g, '');
      const hasH = /h/i.test(code);
      const hasD = /d|y/i.test(code);
      if (hasH && hasD) kind = 'datetime';
      else if (hasH) kind = 'time';
      else if (hasD) kind = 'date';
    }
    xfs.push({ kind });
  }
  return xfs;
}

function formatExcelNumber(n, kind) {
  if (kind === 'time' || (kind === 'datetime' && n < 1)) {
    let mins = Math.round((n % 1) * 24 * 60);
    mins = ((mins % 1440) + 1440) % 1440;
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    const ap = h >= 12 ? 'PM' : 'AM';
    h %= 12;
    if (h === 0) h = 12;
    return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
  }
  if (kind === 'date' || kind === 'datetime') {
    const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000;
    const d = new Date(ms);
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const day = String(d.getUTCDate()).padStart(2, '0');
    return weekdays[d.getUTCDay()] + ', ' + months[d.getUTCMonth()] + ' ' + day + ', ' + d.getUTCFullYear();
  }
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

function sheetPaths(workbookXml, relsXml) {
  const rels = {};
  for (const m of String(relsXml || '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0]);
    const target = /Target="([^"]+)"/.exec(m[0]);
    if (id && target) rels[id[1]] = target[1];
  }
  const sheets = [];
  for (const m of String(workbookXml || '').matchAll(/<sheet\b[^>]*>/g)) {
    const name = /name="([^"]+)"/.exec(m[0]);
    const rid = /r:id="([^"]+)"/.exec(m[0]);
    if (!name || !rid || !rels[rid[1]]) continue;
    let target = rels[rid[1]].replace(/\\/g, '/');
    if (!target.startsWith('xl/')) target = 'xl/' + target.replace(/^\//, '');
    sheets.push({ name: decodeXml(name[1]).trim(), path: target });
  }
  return sheets;
}

function parseSheetXml(xml, strings, xfs) {
  const rows = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/gi;
  let m;
  while ((m = rowRe.exec(String(xml || '')))) {
    const rAttr = /r="(\d+)"/.exec(m[1]);
    const rIndex = rAttr ? parseInt(rAttr[1], 10) - 1 : rows.length;
    const row = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/gi;
    let c;
    while ((c = cellRe.exec(m[2]))) {
      const attrs = c[1] || '';
      const inner = c[2] || '';
      const ref = /\br="([A-Z]+)\d+"/i.exec(attrs);
      const col = ref ? colIndex(ref[1]) : row.length;
      const t = /\bt="([^"]+)"/.exec(attrs);
      const type = t ? t[1] : 'n';
      const sAttr = /\bs="(\d+)"/.exec(attrs);
      const style = sAttr ? xfs[parseInt(sAttr[1], 10)] : null;
      let val = '';
      if (type === 'inlineStr') {
        val = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(x => decodeXml(x[1])).join('');
      } else if (type === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        val = strings[parseInt(v ? v[1] : '0', 10)] || '';
      } else if (type === 'str') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        val = decodeXml(v ? v[1] : '');
      } else if (type === 'b') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        val = v && v[1] === '1' ? 'TRUE' : 'FALSE';
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (!v) val = '';
        else {
          const num = parseFloat(v[1]);
          const kind = style && style.kind;
          if (kind && kind !== 'number' && !Number.isNaN(num)) val = formatExcelNumber(num, kind);
          else if (!Number.isNaN(num) && (col === 2 || col === 3) && num > 0 && num < 1) val = formatExcelNumber(num, 'time');
          else if (!Number.isNaN(num) && (col === 2 || col === 3) && num > 20000 && num < 80000) val = formatExcelNumber(num, 'date');
          else val = v[1];
        }
      }
      row[col] = val;
    }
    rows[rIndex] = row;
  }
  const width = rows.reduce((n, r) => Math.max(n, r ? r.length : 0), 12);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const line = [];
    for (let c = 0; c < width; c++) line.push(r[c] != null ? String(r[c]) : '');
    out.push(line);
  }
  return out;
}

function readXlsxGrids(buf) {
  const files = readZip(buf);
  const workbook = files['xl/workbook.xml'];
  if (!workbook) throw new Error('xlsx is missing xl/workbook.xml');
  const rels = files['xl/_rels/workbook.xml.rels'] || Buffer.from('');
  const strings = sharedStrings(files['xl/sharedStrings.xml'] || '');
  const xfs = parseXfs(files['xl/styles.xml'] || '');
  return sheetPaths(workbook.toString('utf8'), rels.toString('utf8')).map(sheet => {
    const xml = files[sheet.path];
    if (!xml) throw new Error('xlsx is missing ' + sheet.path + ' for ' + sheet.name);
    return { name: sheet.name, rows: parseSheetXml(xml.toString('utf8'), strings, xfs) };
  });
}

module.exports = { readXlsxGrids, formatExcelNumber, decodeXml, colIndex };

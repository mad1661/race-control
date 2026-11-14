#!/usr/bin/env node
// SharePoint workbooks keep the schedule date as an Excel serial near column G.
// A styled serial of 5 must not become the published day.
'use strict';
const assert = require('assert');
const { parseDay } = require('../generate');

function cells(pairs) {
  const row = [];
  for (const [i, v] of pairs) row[i] = v;
  return row;
}

const header = cells([[5, 'ELIMINATOR']]);
const session = cells([
  [2, '8:00 AM'],
  [5, 'Top Fuel'],
  [6, 'Q-1'],
  [11, '2.3148148148148147E-3'],
]);

const sharepoint = parseDay([
  cells([
    [2, 'Thursday, January 04, 1900'],
    [5, 'NHRA Finals'],
    [6, '46338'],
  ]),
  cells([[1, 'powered by Dodge'], [4, '107.5 FM']]),
  header,
  session,
], 'Day 1', 'sharepoint');
assert.strictEqual(sharepoint.date, 'Thursday, November 12, 2026');
assert.strictEqual(sharepoint.title, 'NHRA Finals powered by Dodge');
assert.strictEqual(sharepoint.radio, '107.5 FM');
assert.strictEqual(sharepoint.items[0].name, 'Top Fuel');
assert.strictEqual(sharepoint.items[0].note, '');

const sheets = parseDay([
  cells([[2, 'Thursday, November 12, 2026']]),
  cells([[2, 'PA Broadcast: 107.5 FM'], [5, 'In-N-Out Burger NHRA Finals']]),
  header,
  cells([[2, '9:00 AM'], [5, 'Funny Car'], [6, 'R-1'], [11, 'Moved up']]),
], 'Day 1', '123');
assert.strictEqual(sheets.date, 'Thursday, November 12, 2026');
assert.strictEqual(sheets.title, 'In-N-Out Burger NHRA Finals');
assert.strictEqual(sheets.radio, '107.5 FM');
assert.strictEqual(sheets.items[0].note, 'Moved up');

console.log('schedule date tests ok');

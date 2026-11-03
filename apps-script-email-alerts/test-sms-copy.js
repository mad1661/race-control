'use strict';
// Pure checks against Code.gs: generic one-segment copy, and manual mode does not auto-send.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');

function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing ' + name);
  let depth = 0;
  let started = false;
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') {
      depth--;
      if (started && depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

const CONFIG = {
  RACE_CONTROL_URL: 'https://www.nhraracer.com/racecontrol',
  SMS_MAX_CHARS: 160,
  SMS_MANUAL_MAX_SEGMENTS: 6,
};
const api = new Function('CONFIG', [
  extract('gsmSafe_'),
  extract('smsSegments_'),
  extract('scheduleAlertBody_'),
  extract('testSmsText_'),
  extract('smsText_'),
  extract('prepareManualText_'),
  extract('decideSmsAction_'),
  'return { smsText_, smsSegments_, scheduleAlertBody_, testSmsText_, decideSmsAction_, gsmSafe_, prepareManualText_ };',
].join('\n'))(CONFIG);

const body = api.smsText_({ title: 'Top Fuel moved from 1:15 PM to 1:40 PM', more: 4 });
assert.strictEqual(body, 'There has been a change in the schedule.\nhttps://www.nhraracer.com/racecontrol\nReply STOP to unsubscribe');
assert.ok(body.length <= 160, 'body length ' + body.length);
assert.strictEqual(api.smsSegments_(body), 1);
assert.ok(!body.includes('Top Fuel'));
assert.ok(!body.includes('more change'));
assert.ok(body.includes('Reply STOP to unsubscribe'));
assert.strictEqual(api.scheduleAlertBody_(), body);

const testBody = api.testSmsText_();
assert.ok(testBody.includes('Not a schedule change'));
assert.ok(testBody.includes('Reply STOP to unsubscribe'));
assert.ok(testBody.length <= 160);
assert.strictEqual(api.smsSegments_(testBody), 1);
assert.ok(!testBody.includes('Top Fuel'));

assert.strictEqual(api.decideSmsAction_(false, false), 'skip');
assert.strictEqual(api.decideSmsAction_(false, true), 'skip');
assert.strictEqual(api.decideSmsAction_(true, true), 'pending');
assert.strictEqual(api.decideSmsAction_(true, false), 'send');

const fixed = api.prepareManualText_(undefined, false);
assert.strictEqual(fixed.ok, true);
assert.strictEqual(fixed.text, body);
assert.strictEqual(fixed.segments, 1);
const edited = api.prepareManualText_('Pits open at 8:00.\nhttps://www.nhraracer.com/racecontrol\nReply STOP to unsubscribe', true);
assert.strictEqual(edited.ok, true);
assert.strictEqual(edited.segments, 1);
assert.ok(edited.text.includes('Pits open at 8:00.'));
const curly = api.prepareManualText_('It\u2019s a change.\nReply STOP to unsubscribe', true);
assert.strictEqual(curly.ok, true);
assert.ok(curly.text.includes("It's a change."));
assert.strictEqual(curly.segments, api.smsSegments_(curly.text));
assert.strictEqual(api.prepareManualText_('   ', true).ok, false);
const tooLong = api.prepareManualText_('x'.repeat(70) + '\n'.repeat(20) + 'Reply STOP', true);
assert.strictEqual(tooLong.ok, true);
const huge = '😀'.repeat(400);
const over = api.prepareManualText_(huge, true);
assert.strictEqual(over.ok, false);
assert.ok(/segments/.test(over.error));

const setMode = extract('setSmsMode_');
assert.ok(setMode.includes('clearSmsPending_'));
assert.ok(!setMode.includes('sendSms'));
const setEnabled = extract('setSmsEnabled_');
assert.ok(setEnabled.includes('clearSmsPending_'));
const sendPending = extract('sendPendingUpdate_');
assert.ok(!sendPending.includes('sendTestSmsToList'));
assert.ok(sendPending.includes('prepareManualText_'));
assert.ok(!sendPending.includes('Nothing new to send'));
assert.ok(sendPending.includes('SMS_ENABLED'));
const adminTest = extract('sendAdminTestSms_');
assert.ok(adminTest.includes('sendQuoMessage_'));
assert.ok(!adminTest.includes('getPhones_'));
const feed = extract('scheduleSourceForFeed_');
assert.ok(feed.includes('FEED_CONFIG_TOKEN') || feed.includes('PROP_FEED_CONFIG_TOKEN'));
const push = extract('pushScheduleSourceMode_');
assert.ok(push.includes("current.sharepointUrl = ''"));
const hostOk = new Function(extract('sharePointHostOk_') + '\nreturn sharePointHostOk_;')();
assert.strictEqual(hostOk('nhra.sharepoint.com'), true);
assert.strictEqual(hostOk('contoso-my.sharepoint.com'), true);
assert.strictEqual(hostOk('1drv.ms'), true);
assert.strictEqual(hostOk('example.com'), false);
assert.strictEqual(hostOk('notsharepoint.com'), false);

const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'sms-admin.html'), 'utf8');
assert.ok(!adminHtml.includes('>Turn on<') && !adminHtml.includes('>Turn off<'));
assert.ok(!adminHtml.includes('setSmsEnabled'));
assert.ok(!adminHtml.includes('btnOn') && !adminHtml.includes('btnOff'));
assert.ok(adminHtml.includes('id="btnUnlock"'));
assert.ok(adminHtml.includes('id="dash" class="locked"'));
assert.ok(adminHtml.includes('id="manualText"'));
assert.ok(adminHtml.includes('Unlock the dashboard'));
assert.ok(adminHtml.includes('>Unlock</button>'));
assert.ok(adminHtml.includes('One PIN opens every setting below.'));
function extractHtml(name) {
  const start = adminHtml.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing ' + name);
  let depth = 0;
  let started = false;
  for (let j = start; j < adminHtml.length; j++) {
    if (adminHtml[j] === '{') { depth++; started = true; }
    else if (adminHtml[j] === '}') {
      depth--;
      if (started && depth === 0) return adminHtml.slice(start, j + 1);
    }
  }
  throw new Error('unclosed ' + name);
}
const ui = new Function([
  extractHtml('isGsm7'),
  extractHtml('segmentCount'),
  extractHtml('sendButtonState'),
  'return { segmentCount, sendButtonState };',
].join('\n'))();
assert.strictEqual(ui.segmentCount(body), api.smsSegments_(body));
assert.strictEqual(ui.segmentCount(curly.text), api.smsSegments_(curly.text));
assert.strictEqual(ui.segmentCount('😀'), api.smsSegments_('😀'));
const manualIdle = ui.sendButtonState({ mode: 'manual', pending: null, sending: false, enabled: false }, false);
assert.strictEqual(manualIdle.disabled, false);
assert.strictEqual(manualIdle.label, 'Send update');
const autoState = ui.sendButtonState({ mode: 'auto', pending: { at: 'x' }, sending: false, enabled: true }, false);
assert.strictEqual(autoState.disabled, true);
assert.strictEqual(autoState.label, 'Automatic is on');
const sending = ui.sendButtonState({ mode: 'manual', sending: true, pending: null }, false);
assert.strictEqual(sending.disabled, true);
assert.strictEqual(sending.label, 'Sending…');

console.log('sms copy ok:', body.length, 'chars, 1 segment');
console.log('test copy ok:', testBody.length, 'chars');
console.log('mode decisions ok');

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
};
const api = new Function('CONFIG', [
  extract('gsmSafe_'),
  extract('smsSegments_'),
  extract('scheduleAlertBody_'),
  extract('testSmsText_'),
  extract('smsText_'),
  extract('decideSmsAction_'),
  'return { smsText_, smsSegments_, scheduleAlertBody_, testSmsText_, decideSmsAction_, gsmSafe_ };',
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

const setMode = extract('setSmsMode_');
assert.ok(setMode.includes('clearSmsPending_'));
assert.ok(!setMode.includes('sendSms'));
const setEnabled = extract('setSmsEnabled_');
assert.ok(setEnabled.includes('clearSmsPending_'));
const sendPending = extract('sendPendingUpdate_');
assert.ok(!sendPending.includes('sendTestSmsToList'));
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

console.log('sms copy ok:', body.length, 'chars, 1 segment');
console.log('test copy ok:', testBody.length, 'chars');
console.log('mode decisions ok');

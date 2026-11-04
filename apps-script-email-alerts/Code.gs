/**
 * Race Control schedule-change alerts — SMS ONLY.
 * Polls the Race Control RSS feed every 5 minutes. When the newest item
 * changes, texts every active phone signup. No Grok Bot involvement.
 * Reads the feed from Firebase AND from GitHub (raw), using whichever is newer,
 * so a stalled Firebase sync cannot silently stop alerts.
 *
 * SMS PROVIDER (2026-10-28): QUO (OpenPhone) is the weekend path.
 *   Quo number (860) 847-8135 = +18608478135, Sole Prop 10DLC approved.
 *   Quo is used whenever QUO_API_KEY + QUO_FROM are set. Telnyx is only a
 *   fallback when Quo is not configured (Telnyx is blocked: not 10DLC registered).
 *   Force a provider with Script Property SMS_PROVIDER = quo | telnyx.
 *
 * SMS MASTER SWITCH: Script Property SMS_ENABLED ('true' | 'false', default
 *   false when unset). When off, checkFeedAndAlert still records the newest
 *   feed item as seen (lastFeedGuid), so turning SMS on later does NOT blast a
 *   backlog. Toggle from https://race-control-feed.web.app/sms-admin.html
 *   (calls this script's web app; PIN in Script Property SMS_ADMIN_PIN).
 *
 * EMAIL ALERTS DISCONTINUED (2026-10-28). checkFeedAndAlert no longer sends
 * email. The SES / MailApp helpers below are kept only for a manual one-off.
 *
 * Script Properties (Project Settings → Script properties):
 *   SMS_ENABLED           — 'true' to send texts; anything else = off (default off)
 *   SMS_ADMIN_PIN         — PIN for the Firebase admin page toggle (never in code/HTML)
 *   SMS_PROVIDER          — optional: quo | telnyx (default: quo if configured)
 *   QUO_API_KEY           — Quo API key (Quo → Settings → API). Script Properties ONLY.
 *   QUO_FROM              — +18608478135
 *   QUO_TEST_TO           — +16103349559 (Mark) for sendTestSms
 *   QUO_BATCH_SIZE        — optional, recipients per Quo request (default 1; see note)
 *   TELNYX_API_KEY / TELNYX_FROM / TELNYX_TEST_TO — fallback only
 *   (Legacy email one-off only) SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY /
 *   SES_FROM / SES_REGION / SES_TEST_TO / SES_FALLBACK_MAILAPP
 *
 * Quo note: the API accepts up to 10 numbers in `to`, but multiple numbers in
 * one message create a GROUP text (recipients see each other's numbers and
 * reply-all). So the default is 1 recipient per request, sent in parallel
 * chunks via fetchAll (~8 req/sec, under Quo's 10 req/sec limit). Only raise
 * QUO_BATCH_SIZE if group texts are really wanted.
 *
 * Large lists: if a send would run past ~4.5 minutes (measured from the start
 * of the trigger run), the script saves its place (smsQueue* properties) and
 * the next 5-minute trigger run resumes. Running totals carry across resumes.
 *
 * SCALE HARDENING (2026-10-28, see SCALE.md):
 *   - LockService: checkFeedAndAlert and sendTestSmsToList take the script lock.
 *     If a previous run still holds it (long blast), the new run exits quietly
 *     and the next 5-minute trigger retries, so overlapping runs never double-send.
 *   - Last-run summary: every blast writes lastSmsAt / lastSmsSent / lastSmsFailed /
 *     lastSmsTotal / lastSmsTitle / lastSmsStatus / lastSmsProvider /
 *     lastSmsDailyLimit / lastSmsError / lastSmsSegments to Script Properties.
 *     smsStatus (admin JSON) returns them as `lastSms` (counts only, no numbers).
 *   - When a finished blast has failures, the log gets one line:
 *     "ALERT: N of M SMS failed ..." (search Executions for ALERT).
 *   - Turning the switch OFF mid-blast stops the running send within ~10 s.
 *   - Alert text is one GSM-7 segment (<=160 chars). It does NOT list what changed.
 *     Default body: "There has been a change in the schedule." + Race Control link + STOP.
 *
 * SEND MODE (2026-11): Script Property SMS_SEND_MODE = auto (default) | manual.
 *   Manual still records lastFeedGuid (no lost tracking, no backlog on Manual→Auto
 *   or OFF→ON) but does not text until the admin page "Send update" button.
 *   QUO_SMS_COST_USD optional per-segment estimate (default 0.01, Quo's published
 *   API rate for local US/Canada SMS). SCHEDULE_SOURCE = sheets | sharepoint and
 *   SHAREPOINT_URL live in Script Properties. FEED_CONFIG_TOKEN lets the feed job
 *   read them. GH_CONTENTS_TOKEN optionally commits the mode (never the share link)
 *   to rss/schedule-source.json.
 *
 * SIGNUPS (2026-10-28): PRIVATE FIRESTORE, not the Sheet.
 *   The Race Control page writes new signups to Firestore collection smsSubscribers
 *   (project race-control-feed), doc id = E.164 phone, status active|stopped.
 *   Firestore rules block ALL browser reads. This script reads the list with the
 *   script owner's own Google OAuth token (scope datastore; owner needs IAM on the
 *   project), or via the listActivePhones Cloud Function + FIREBASE_PHONES_SECRET
 *   once Functions are deployed. See PHONES-FIREBASE.md.
 *   PHONES_SOURCE Script Property: firestore (default) | sheet (legacy) | both.
 *   If the Firestore read fails, the script falls back to the Sheet and logs a warning.
 *   The old Google Form / Sheet is a read-only archive after migration.
 */

var CONFIG = {
  SPREADSHEET_ID: '14OQ07vvYIISXqpZSwYEYcCdzeeNjraS0vCOEGPWZBOo',
  FEED_URL: 'https://race-control-feed.web.app/feed.xml',
  // Same feed straight from the GitHub repo. Firebase only updates when the box sync
  // runs, so we read both and use whichever has the newer top item (same guids, no dupes).
  FEED_URL_BACKUP: 'https://raw.githubusercontent.com/mad1661/race-control/main/feed.xml',
  RACE_CONTROL_URL: 'https://www.nhraracer.com/racecontrol',
  SMS_ADMIN_PAGE: 'https://race-control-feed.web.app/sms-admin.html',
  FORM_RESPONSES_TAB: 'Form Responses 1',
  NOTIFY_TAB: 'Notify',
  UNSUBSCRIBED_TAB: 'Unsubscribed',
  PROP_LAST_GUID: 'lastFeedGuid',
  PROP_LAST_TITLE: 'lastFeedTitle',
  PROP_LAST_TS: 'lastFeedTs',
  PROP_SMS_ENABLED: 'SMS_ENABLED',
  FIREBASE_PROJECT: 'race-control-feed',
  FIRESTORE_COLLECTION: 'smsSubscribers',
  PROP_PHONES_SOURCE: 'PHONES_SOURCE',            // firestore | sheet | both
  PROP_PHONES_URL: 'FIREBASE_PHONES_URL',         // optional listActivePhones URL (Cloud Function)
  PROP_PHONES_SECRET: 'FIREBASE_PHONES_SECRET',   // shared secret for that function
  PROP_SMS_ADMIN_PIN: 'SMS_ADMIN_PIN',
  PROP_SMS_PROVIDER: 'SMS_PROVIDER',
  PROP_SMS_UPDATED_AT: 'SMS_ENABLED_UPDATED_AT',
  PROP_QUO_KEY: 'QUO_API_KEY',
  PROP_QUO_FROM: 'QUO_FROM',
  PROP_QUO_TEST_TO: 'QUO_TEST_TO',
  PROP_QUO_BATCH: 'QUO_BATCH_SIZE',
  QUO_DEFAULT_FROM: '+18608478135',
  QUO_API_URL: 'https://api.quo.com/v1/messages',
  QUO_API_VERSION: '2026-03-30',
  QUO_MAX_TO: 10,               // Quo API limit per request
  QUO_PARALLEL: 5,              // requests per fetchAll chunk
  QUO_CHUNK_SLEEP_MS: 650,      // ~7-8 req/sec, under Quo's 10 req/sec
  SMS_TIME_BUDGET_MS: 270000,   // stop and resume next run after ~4.5 min
  PROP_QUEUE_GUID: 'smsQueueGuid',
  PROP_QUEUE_OFFSET: 'smsQueueOffset',
  PROP_QUEUE_TEXT: 'smsQueueText',
  PROP_QUEUE_STATS: 'smsQueueStats',  // JSON running totals across resumed runs
  // Account-level block (Quo 402 out of prepaid credits, 401/403 bad key/suspended).
  // The blast PAUSES with the queue kept, retries every trigger run, and sends
  // automatically once the account is fixed (instead of burning the alert as "43 failed").
  PROP_QUEUE_BLOCKED: 'smsQueueBlocked',            // reason text while paused
  PROP_QUEUE_BLOCKED_SINCE: 'smsQueueBlockedSince', // ISO time the pause started
  // Quo 400 "User Opted Out" (code 0201400): the phone replied STOP to Quo. The script
  // takes it off the list (Firestore status=stopped, stopSource quo-opt-out) when the
  // blast finishes, and records it: smsStatus lastSms.optedOut / optOutRemoved (masked),
  // full numbers in the ops email + PIN-gated ?action=optOuts. See OPT-OUTS.md.
  PROP_OPTOUT_LOG: 'smsOptOutLog',                  // JSON [{phone, at, source, title}] newest last (max 200)
  OPTOUT_LOG_MAX: 200,
  OPTOUT_STOP_SOURCE: 'quo-opt-out-0201400',
  PROP_OPS_EMAIL: 'OPS_ALERT_EMAIL',                // optional: who gets an ops email on a pause/failure
  BLOCKED_MAX_MS: 3 * 60 * 60 * 1000,               // give up on a paused alert after 3 h (stale by then)
  // Watchdog (runs inside the reliable 5-min Apps Script trigger, not on the box):
  WATCHDOG_EVERY_MS: 10 * 60 * 1000,
  FIREBASE_LAG_ALERT_MS: 20 * 60 * 1000,  // Firebase feed behind GitHub this long = box sync stalled
  // Optional off-box replacement for kick-feed.sh: Script Property GH_DISPATCH_TOKEN =
  // fine-grained PAT (repo mad1661/race-control, Actions: read & write). Unset = off.
  PROP_GH_TOKEN: 'GH_DISPATCH_TOKEN',
  GH_WORKFLOW_DISPATCH_URL: 'https://api.github.com/repos/mad1661/race-control/actions/workflows/feed.yml/dispatches',
  LOCK_WAIT_MS: 5000,           // wait this long for the script lock, then exit quietly
  SWITCH_CHECK_EVERY: 10,       // re-read SMS_ENABLED every N chunks during a blast
  SMS_MAX_CHARS: 160,           // one GSM-7 segment
  PIN_MAX_FAILS: 10,            // per hour, then the toggle is locked for the hour
  PROP_SMS_MODE: 'SMS_SEND_MODE',                 // auto (default) | manual
  PROP_PENDING_GUID: 'smsPendingGuid',
  PROP_PENDING_TITLE: 'smsPendingTitle',
  PROP_PENDING_AT: 'smsPendingAt',
  PROP_COST_USD: 'QUO_SMS_COST_USD',              // optional override; default below
  DEFAULT_COST_USD: 0.01,                         // Quo API local (US/Canada) SMS, per segment
  PROP_SCHEDULE_SOURCE: 'SCHEDULE_SOURCE',        // sheets (default) | sharepoint
  PROP_SHAREPOINT_URL: 'SHAREPOINT_URL',
  PROP_FEED_CONFIG_TOKEN: 'FEED_CONFIG_TOKEN',    // feed job reads source+URL with this
  PROP_GH_CONTENTS_TOKEN: 'GH_CONTENTS_TOKEN',    // optional: commit mode to the repo
  GH_CONTENTS_API: 'https://api.github.com/repos/mad1661/race-control/contents/rss/schedule-source.json',
  SCHEDULE_SHEET_ID: '1D7r0i8yevR9bBOAEO9I34pqw5Iy8vqNzwSX0uDFbfr0',
  TEST_SMS_MAX_PER_HOUR: 8,
  PROP_TELNYX_KEY: 'TELNYX_API_KEY',
  PROP_TELNYX_FROM: 'TELNYX_FROM',
  PROP_TELNYX_TEST_TO: 'TELNYX_TEST_TO',
  PROP_SES_KEY_ID: 'SES_ACCESS_KEY_ID',
  PROP_SES_SECRET: 'SES_SECRET_ACCESS_KEY',
  PROP_SES_REGION: 'SES_REGION',
  PROP_SES_FROM: 'SES_FROM',
  PROP_SES_TEST_TO: 'SES_TEST_TO',
  PROP_SES_FALLBACK: 'SES_FALLBACK_MAILAPP',
  SES_DEFAULT_REGION: 'us-east-1',
  SES_SEND_DELAY_MS: 80,          // ~12/sec; SES production default is 14/sec
  SES_THROTTLE_RETRY_MS: 1100     // one retry after a throttle (sandbox is 1/sec)
};

var EMAIL_RE_ = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Start time of the current execution; the SMS time budget counts from here so
// slow feed/phone reads cannot push a send past Apps Script's 6-minute limit.
var RUN_STARTED_ = 0;

/**
 * 5-minute trigger entry point. Holds the script lock for the whole run so two
 * overlapping runs (a long blast + the next trigger) can never send twice.
 */
function checkFeedAndAlert() {
  RUN_STARTED_ = Date.now();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) {
    console.log('Lock busy: a previous run is still working (probably a big send). Exiting; the next 5-minute run retries.');
    return;
  }
  try {
    checkFeedAndAlertLocked_();
  } finally {
    lock.releaseLock();
  }
  try { kickFeedWorkflow_(); } catch (e) { console.warn('kickFeedWorkflow_ failed: ' + e); }
  try { watchdog_(); } catch (e) { console.warn('watchdog_ failed: ' + e); }
}

/**
 * Off-box feed kick: dispatches the GitHub "Run order feed" workflow every trigger run
 * when GH_DISPATCH_TOKEN is set. Removes the dependency on the box staying awake.
 */
function kickFeedWorkflow_() {
  var p = PropertiesService.getScriptProperties();
  var tok = String(p.getProperty(CONFIG.PROP_GH_TOKEN) || '').trim();
  if (!tok) return;
  var res = UrlFetchApp.fetch(CONFIG.GH_WORKFLOW_DISPATCH_URL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ ref: 'main' })
  });
  var code = res.getResponseCode();
  p.setProperties({ ghKickAt: new Date().toISOString(), ghKickCode: String(code) });
  if (code !== 204) {
    console.error('ALERT: GitHub feed dispatch failed HTTP ' + code + ' ' + String(res.getContentText()).slice(0, 200));
    raiseIssue_('ghkick', 'GitHub feed workflow dispatch failing (HTTP ' + code + '). Check GH_DISPATCH_TOKEN.');
  } else {
    clearIssue_('ghkick');
  }
}

/**
 * Silent-stall watchdog (every ~10 min). Each problem emails OPS_ALERT_EMAIL once when it
 * starts and once when it clears; the state is also returned by ?action=smsStatus (health).
 *  - firebase: Firebase feed.xml behind GitHub feed.xml > 20 min (box watch-sync asleep/stalled)
 *  - feed: no feed source readable
 *  - sms: alert paused on an account block (Quo credits / key)
 */
function watchdog_() {
  var p = PropertiesService.getScriptProperties();
  var last = Date.parse(p.getProperty('watchdogAt') || '') || 0;
  if (last && Date.now() - last < CONFIG.WATCHDOG_EVERY_MS) return;
  p.setProperty('watchdogAt', new Date().toISOString());
  var fb = null, gh = null;
  try { fb = fetchFeedTop_(CONFIG.FEED_URL); } catch (e) {}
  try { gh = fetchFeedTop_(CONFIG.FEED_URL_BACKUP); } catch (e) {}
  if (!fb && !gh) raiseIssue_('feed', 'Neither Firebase nor GitHub feed.xml is readable.');
  else clearIssue_('feed');
  if (fb && gh && gh.ts > fb.ts && Date.now() - gh.ts > CONFIG.FIREBASE_LAG_ALERT_MS) {
    raiseIssue_('firebase', 'Firebase feed is behind GitHub by ' + Math.round((gh.ts - fb.ts) / 60000) +
      ' min (newest on GitHub: "' + gh.title.slice(0, 80) + '"). Box watch-sync.sh is stalled or the box is asleep. ' +
      'SMS still goes out (script reads GitHub too) but the Firebase page/feed is stale.');
  } else if (fb && gh) {
    clearIssue_('firebase');
  }
  var blocked = p.getProperty(CONFIG.PROP_QUEUE_BLOCKED);
  if (blocked) raiseIssue_('sms', 'SMS alerts PAUSED: ' + blocked);
  else clearIssue_('sms');
}

function raiseIssue_(key, msg) {
  var p = PropertiesService.getScriptProperties();
  var k = 'issue_' + key;
  var had = p.getProperty(k);
  p.setProperty(k, JSON.stringify({ since: had ? JSON.parse(had).since : new Date().toISOString(), msg: msg }));
  if (!had) {
    console.error('ALERT: ' + msg);
    opsAlert_('Race Control PROBLEM: ' + msg.slice(0, 90), msg + '\n\nStatus: ' + CONFIG.SMS_ADMIN_PAGE);
  }
}

function clearIssue_(key) {
  var p = PropertiesService.getScriptProperties();
  var had = p.getProperty('issue_' + key);
  if (!had) return;
  p.deleteProperty('issue_' + key);
  var msg = '';
  try { msg = JSON.parse(had).msg; } catch (e) {}
  console.log('RECOVERED: ' + msg);
  opsAlert_('Race Control RECOVERED: ' + msg.slice(0, 90), 'Cleared: ' + msg);
}

function healthIssues_() {
  var p = PropertiesService.getScriptProperties().getProperties();
  var out = {};
  Object.keys(p).forEach(function (k) {
    if (k.indexOf('issue_') === 0) { try { out[k.slice(6)] = JSON.parse(p[k]); } catch (e) {} }
  });
  return out;
}

/**
 * One-time manual helper: re-send the CURRENT newest feed alert to the whole list
 * (e.g. after topping up Quo credits, to deliver the change that failed with 402).
 * Queues it; the next 5-min trigger run sends it. Respects the master switch.
 */
function resendLatestAlert() {
  var item = fetchLatestItem_();
  if (!item) throw new Error('Could not read the feed.');
  if (PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_QUEUE_GUID)) throw new Error('A send is already queued.');
  saveSmsQueue_(item.id, 0, smsText_(item), null);
  console.log('Queued for the next trigger run: ' + smsText_(item).split('\n')[0]);
}

function checkFeedAndAlertLocked_() {
  var props = PropertiesService.getScriptProperties();

  // Finish a send that ran out of time on the previous run (big lists),
  // or retry one that is paused on an account block (e.g. Quo out of credits).
  if (props.getProperty(CONFIG.PROP_QUEUE_GUID)) {
    if (props.getProperty(CONFIG.PROP_QUEUE_BLOCKED)) refreshBlockedQueue_();
    if (props.getProperty(CONFIG.PROP_QUEUE_GUID)) {
      resumeSmsQueue_();
      return;
    }
  }

  var item = fetchLatestItem_();
  if (!item) return;

  var lastGuid = props.getProperty(CONFIG.PROP_LAST_GUID);
  var lastTitle = props.getProperty(CONFIG.PROP_LAST_TITLE);
  if (item.id === lastGuid && item.title === lastTitle) return;
  // Never go backwards: if one feed source is behind (cache / stalled sync) and the
  // newer one failed this run, don't re-send an older item.
  var lastTs = parseInt(props.getProperty(CONFIG.PROP_LAST_TS), 10) || 0;
  if (item.ts && lastTs && item.ts < lastTs) {
    console.log('Feed top item is older than the last one seen (a source is behind); skipping: ' + item.title);
    return;
  }

  // Mark seen FIRST: whether SMS is on or off, this item is never re-sent and
  // flipping SMS on later does not blast a backlog.
  props.setProperties({ lastFeedGuid: item.id, lastFeedTitle: item.title, lastFeedTs: String(item.ts || 0) });

  var action = decideSmsAction_(isSmsEnabled_(), isManualMode_());
  if (action === 'skip') {
    clearSmsPending_();
    console.log('SMS master switch is OFF (SMS_ENABLED != true). Skipped SMS for: ' + item.title);
    return;
  }
  if (action === 'pending') {
    setSmsPending_(item);
    console.log('SMS mode is MANUAL. Change tracked, not sent: ' + item.title);
    return;
  }

  // SMS-only. Email alerts were discontinued 2026-10-28 — do not call sendEmails_ here.
  clearSmsPending_();
  var phones = getPhones_(getUnsubscribed_().phones);
  sendSmsBatch_(phones, item);
}

/* ------------------------------------------------------------------ */
/* Email — DISCONTINUED for live alerts. Kept for manual one-off use.   */
/* Nothing below in this section is called by checkFeedAndAlert.        */
/* ------------------------------------------------------------------ */

function sendEmails_(emails, item) {
  var unsubUrl = getUnsubscribeBaseUrl_();
  var subject = 'Race Control update: ' + item.title;
  var ses = getSesConfig_();

  if (ses) {
    // No MailApp quota gate here; SES enforces its own send rate / 24h quota.
    var sent = 0, failed = 0, viaMail = 0;
    emails.forEach(function (to, i) {
      if (i > 0) Utilities.sleep(CONFIG.SES_SEND_DELAY_MS);
      var body = buildEmailBody_(item, to, unsubUrl);
      try {
        var id = sendSesEmail_(ses, to, subject, body, unsubLink_(unsubUrl, to));
        sent++;
        console.log('SES sent to ' + to + ' (MessageId ' + id + ')');
      } catch (e) {
        console.error('SES email failed for ' + to + ': ' + e);
        // Per-recipient safety net (e.g. sandbox + unverified recipient, bad keys).
        if (ses.fallbackMailApp && MailApp.getRemainingDailyQuota() > 0) {
          try {
            MailApp.sendEmail(to, subject, body);
            viaMail++;
            console.warn('Sent to ' + to + ' via MailApp fallback.');
            return;
          } catch (e2) {
            console.error('MailApp fallback failed for ' + to + ': ' + e2);
          }
        }
        failed++;
      }
    });
    console.log('SES: ' + sent + ' sent, ' + viaMail + ' via MailApp fallback, ' + failed +
      ' failed, of ' + emails.length + '.');
    return;
  }

  // Fallback: MailApp (Gmail quota gate applies only here).
  var remaining = MailApp.getRemainingDailyQuota();
  emails.slice(0, remaining).forEach(function (to) {
    try {
      MailApp.sendEmail(to, subject, buildEmailBody_(item, to, unsubUrl));
    } catch (e) {
      console.error('Email failed for ' + to + ': ' + e);
    }
  });
  if (emails.length > remaining) {
    console.warn('Daily MailApp quota hit; skipped ' + (emails.length - remaining) + ' recipients.');
  }
}

function unsubLink_(unsubUrl, to) {
  return unsubUrl ? unsubUrl + '?email=' + encodeURIComponent(to) : '';
}

function buildEmailBody_(item, to, unsubUrl) {
  var link = unsubLink_(unsubUrl, to);
  return [
    item.title,
    '',
    'Race Control: ' + CONFIG.RACE_CONTROL_URL,
    item.link ? 'Feed item: ' + item.link : '',
    'Feed: ' + CONFIG.FEED_URL,
    '',
    'You signed up for Race Control change alerts.',
    link
      ? 'Unsubscribe: ' + link
      : 'To unsubscribe, reply to this email with the word UNSUBSCRIBE.'
  ].filter(function (line, i, arr) { return line !== '' || (i > 0 && arr[i - 1] !== ''); }).join('\n');
}

/** Returns SES settings if the required Script Properties are set, else null. */
function getSesConfig_() {
  var p = PropertiesService.getScriptProperties();
  var keyId = (p.getProperty(CONFIG.PROP_SES_KEY_ID) || '').trim();
  var secret = (p.getProperty(CONFIG.PROP_SES_SECRET) || '').trim();
  var from = (p.getProperty(CONFIG.PROP_SES_FROM) || '').trim();
  if (!keyId || !secret || !from) return null;
  return {
    keyId: keyId,
    secret: secret,
    from: from,
    region: (p.getProperty(CONFIG.PROP_SES_REGION) || '').trim() || CONFIG.SES_DEFAULT_REGION,
    fallbackMailApp: String(p.getProperty(CONFIG.PROP_SES_FALLBACK) || 'true').trim().toLowerCase() !== 'false'
  };
}

/**
 * SES API v2 SendEmail (one recipient). Returns MessageId; throws on failure.
 * Retries once on throttling (HTTP 429 / TooManyRequests).
 */
function sendSesEmail_(ses, to, subject, textBody, unsubscribeUrl) {
  var simple = {
    Subject: { Data: encodeSubject_(subject), Charset: 'UTF-8' },
    Body: { Text: { Data: textBody, Charset: 'UTF-8' } }
  };
  if (unsubscribeUrl) {
    simple.Headers = [{ Name: 'List-Unsubscribe', Value: '<' + unsubscribeUrl + '>' }];
  }
  var payload = JSON.stringify({
    FromEmailAddress: ses.from,
    Destination: { ToAddresses: [to] },
    Content: { Simple: simple }
  });

  var res = sesRequest_(ses, 'POST', '/v2/email/outbound-emails', payload);
  if (res.code === 429 || (res.code >= 400 && /TooManyRequests|Throttl/i.test(res.text))) {
    Utilities.sleep(CONFIG.SES_THROTTLE_RETRY_MS);
    res = sesRequest_(ses, 'POST', '/v2/email/outbound-emails', payload);
  }
  if (res.code < 200 || res.code >= 300) {
    throw new Error('SES HTTP ' + res.code + ' ' + res.text.slice(0, 400));
  }
  try {
    return JSON.parse(res.text).MessageId || '';
  } catch (e) {
    return '';
  }
}

/** SigV4-signed request to the SES v2 endpoint. */
function sesRequest_(ses, method, path, body) {
  var host = 'email.' + ses.region + '.amazonaws.com';
  var bodyBytes = Utilities.newBlob(body || '').getBytes();
  var headers = signAwsV4_({
    method: method,
    host: host,
    path: path,
    query: '',
    region: ses.region,
    service: 'ses',
    bodyBytes: bodyBytes,
    accessKeyId: ses.keyId,
    secretAccessKey: ses.secret,
    date: new Date()
  });
  var res = UrlFetchApp.fetch('https://' + host + path, {
    method: method.toLowerCase(),
    contentType: 'application/json',
    headers: headers,
    payload: bodyBytes,
    muteHttpExceptions: true
  });
  return { code: res.getResponseCode(), text: res.getContentText() || '' };
}

/**
 * AWS Signature Version 4. Signs host + x-amz-date + x-amz-content-sha256 only
 * (UrlFetchApp sets Host itself; Content-Type is left unsigned on purpose).
 * Returns headers to send (Authorization, X-Amz-Date, X-Amz-Content-Sha256).
 */
function signAwsV4_(o) {
  var amzDate = Utilities.formatDate(o.date, 'UTC', "yyyyMMdd'T'HHmmss'Z'");
  var dateStamp = amzDate.slice(0, 8);
  var payloadHash = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, o.bodyBytes));

  var canonicalHeaders =
    'host:' + o.host + '\n' +
    'x-amz-content-sha256:' + payloadHash + '\n' +
    'x-amz-date:' + amzDate + '\n';
  var signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  var canonicalRequest = [
    o.method.toUpperCase(),
    o.path,
    o.query || '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  var scope = dateStamp + '/' + o.region + '/' + o.service + '/aws4_request';
  var stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex_(canonicalRequest)
  ].join('\n');

  var signingKey = awsSigningKey_(o.secretAccessKey, dateStamp, o.region, o.service);
  var signature = hex_(Utilities.computeHmacSha256Signature(bytes_(stringToSign), signingKey));

  return {
    'X-Amz-Date': amzDate,
    'X-Amz-Content-Sha256': payloadHash,
    Authorization: 'AWS4-HMAC-SHA256 Credential=' + o.accessKeyId + '/' + scope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signature
  };
}

function awsSigningKey_(secret, dateStamp, region, service) {
  var kDate = Utilities.computeHmacSha256Signature(bytes_(dateStamp), bytes_('AWS4' + secret));
  var kRegion = Utilities.computeHmacSha256Signature(bytes_(region), kDate);
  var kService = Utilities.computeHmacSha256Signature(bytes_(service), kRegion);
  return Utilities.computeHmacSha256Signature(bytes_('aws4_request'), kService);
}

function bytes_(s) {
  return Utilities.newBlob(String(s)).getBytes();
}

function sha256Hex_(s) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes_(s)));
}

function hex_(byteArr) {
  return byteArr.map(function (b) {
    var h = (b & 0xff).toString(16);
    return h.length === 1 ? '0' + h : h;
  }).join('');
}

/** SES subjects must be 7-bit ASCII; wrap anything else as an RFC 2047 encoded-word. */
function encodeSubject_(s) {
  s = String(s || '');
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Utilities.base64Encode(bytes_(s)) + '?=';
}

/**
 * Run once after pasting SES properties. Sends one test email via SES to
 * SES_TEST_TO, or to the first Form/Notify signup if SES_TEST_TO is blank.
 * (In the SES sandbox the recipient must also be a verified identity.)
 */
function sendTestSes() {
  var ses = getSesConfig_();
  if (!ses) {
    throw new Error('Set Script Properties SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY and SES_FROM first (SES_REGION optional, default us-east-1).');
  }
  var to = (PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_SES_TEST_TO) || '').trim();
  if (!to) {
    var list = getEmails_(getUnsubscribed_().emails);
    if (!list.length) throw new Error('No SES_TEST_TO and no Form/Notify emails found.');
    to = list[0];
  }
  var item = { title: 'SES test from Race Control alerts', link: '' };
  var unsubUrl = getUnsubscribeBaseUrl_();
  var id = sendSesEmail_(ses, to, 'Race Control test email (SES)', buildEmailBody_(item, to, unsubUrl), unsubLink_(unsubUrl, to));
  console.log('SES test sent to ' + to + ' via ' + ses.region + ' (MessageId ' + id + ')');
  return id;
}

/* ------------------------------------------------------------------ */
/* SMS: master switch, provider choice, Quo (primary), Telnyx (fallback) */
/* ------------------------------------------------------------------ */

/** Master switch. Script Property SMS_ENABLED must be exactly 'true'. Default OFF. */
function isSmsEnabled_() {
  var v = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_SMS_ENABLED);
  return String(v || '').trim().toLowerCase() === 'true';
}

function setSmsEnabled_(enabled, source) {
  var now = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperties({
    SMS_ENABLED: enabled ? 'true' : 'false',
    SMS_ENABLED_UPDATED_AT: now
  });
  console.log('SMS master switch set ' + (enabled ? 'ON' : 'OFF') + ' via ' + (source || '?') + ' at ' + now);
  if (!enabled) {
    clearSmsQueue_();
    clearSmsPending_(); // OFF→ON must not leave a Manual change waiting to blast
  }
  return now;
}

/**
 * Returns { name: 'quo'|'telnyx', key, from, batch } or null.
 * Quo wins whenever QUO_API_KEY + QUO_FROM are set, unless SMS_PROVIDER=telnyx.
 */
function getSmsProvider_() {
  var p = PropertiesService.getScriptProperties();
  var pref = String(p.getProperty(CONFIG.PROP_SMS_PROVIDER) || '').trim().toLowerCase();
  var quoKey = String(p.getProperty(CONFIG.PROP_QUO_KEY) || '').trim();
  var quoFrom = String(p.getProperty(CONFIG.PROP_QUO_FROM) || '').trim();
  var tKey = String(p.getProperty(CONFIG.PROP_TELNYX_KEY) || '').trim();
  var tFrom = String(p.getProperty(CONFIG.PROP_TELNYX_FROM) || '').trim();
  var quo = (quoKey && quoFrom) ? {
    name: 'quo', key: quoKey, from: quoFrom,
    batch: Math.max(1, Math.min(CONFIG.QUO_MAX_TO, parseInt(p.getProperty(CONFIG.PROP_QUO_BATCH), 10) || 1))
  } : null;
  var telnyx = (tKey && tFrom) ? { name: 'telnyx', key: tKey, from: tFrom, batch: 1 } : null;
  if (pref === 'telnyx' && telnyx) return telnyx;
  return quo || telnyx;
}

/**
 * What to do with a newly seen feed item.
 * skip = SMS off (already recorded as seen). pending = Manual, do not text.
 * send = Automatic. Manual→Auto never calls this for an old item; that item is already seen.
 */
function decideSmsAction_(enabled, manual) {
  if (!enabled) return 'skip';
  if (manual) return 'pending';
  return 'send';
}

/** Fixed alert body. Does not include the feed title or what changed. One GSM-7 segment. */
function scheduleAlertBody_() {
  var text = gsmSafe_('There has been a change in the schedule.\n' + CONFIG.RACE_CONTROL_URL + '\nReply STOP to unsubscribe');
  if (text.length > CONFIG.SMS_MAX_CHARS) text = text.slice(0, CONFIG.SMS_MAX_CHARS);
  return text;
}

/** One-number admin test. Not a schedule alert and not sent to the list. */
function testSmsText_() {
  var text = gsmSafe_('Race Control test text. Not a schedule change.\n' + CONFIG.RACE_CONTROL_URL + '\nReply STOP to unsubscribe');
  if (text.length > CONFIG.SMS_MAX_CHARS) text = text.slice(0, CONFIG.SMS_MAX_CHARS);
  return text;
}

/**
 * Alert text for a feed item. `item` is accepted so callers stay the same, and
 * ignored on purpose: the SMS never lists what changed.
 */
function smsText_(item) {
  return scheduleAlertBody_();
}

/** Swap common "smart" characters for plain ones so the text stays GSM-7 (160/segment, not 70). */
function gsmSafe_(s) {
  return String(s || '')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2007\u202F\t]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

/** Rough segment count for one message (GSM-7 vs UCS-2), for the last-run summary. */
function smsSegments_(text) {
  text = String(text || '');
  var gsm = /^[A-Za-z0-9 \n\r@$_!"#%&'()*+,\-.\/:;<=>?\u00A3\u00A5\u00E8\u00E9\u00F9\u00EC\u00F2\u00C7\u00D8\u00F8\u00C5\u00E5\u00C6\u00E6\u00DF\u00C9\u00C4\u00D6\u00D1\u00DC\u00A7\u00BF\u00E4\u00F6\u00F1\u00FC\u00E0\u00A1\u00A4]*$/.test(text);
  var ext = gsm ? (text.match(/[\^{}\\\[\]~|\u20AC]/g) || []).length : 0;
  var len = text.length + ext;
  if (gsm) return len <= 160 ? 1 : Math.ceil(len / 153);
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

/** Sends one alert to all phones (resumable). Does nothing if the switch is off. */
function sendSmsBatch_(phones, item) {
  if (!isSmsEnabled_()) {
    console.log('SMS master switch is OFF; skipped ' + phones.length + ' SMS.');
    return;
  }
  var provider = getSmsProvider_();
  var text = smsText_(item);
  if (!provider) {
    console.error('ALERT: No SMS provider configured (QUO_API_KEY + QUO_FROM, or TELNYX_API_KEY + TELNYX_FROM); skipped ' +
      phones.length + ' SMS. Alerts are SMS-only, so no one was notified.');
    saveLastSmsSummary_({ status: 'no provider', total: phones.length, failed: phones.length, text: text,
      error: 'No SMS provider configured' });
    return;
  }
  if (!phones.length) {
    console.warn('SMS: no active phones on the list; nothing sent for: ' + item.title);
    saveLastSmsSummary_({ status: 'no phones', provider: provider.name, total: 0, text: text });
    return;
  }
  sendSmsFrom_(provider, phones, text, item.id, 0, null, true);
}

/**
 * Sends `text` to phones[offset..]. If the time budget runs out, saves the
 * queue (guid + offset + text + running totals) so the next trigger run resumes.
 * `stats` = running totals from earlier runs of the same blast (or null).
 * `respectSwitch` = stop if SMS_ENABLED is turned off mid-send (live alerts).
 * Callers must hold the script lock.
 */
function sendSmsFrom_(provider, phones, text, guid, offset, stats, respectSwitch) {
  var started = RUN_STARTED_ || Date.now();
  stats = stats || { sent: 0, failed: 0, dailyLimit: 0, error: '', startedAt: new Date().toISOString() };
  var optOuts = [].concat(stats.optOuts || []);  // opted-out phones this blast (removed from the list when it ends)
  var sent = 0, failed = 0, dailyLimit = 0, firstError = '', i = offset, loops = 0;
  console.log('SMS via ' + provider.name + ' from ' + provider.from + ': ' + (phones.length - offset) +
    ' recipient(s) starting at #' + offset + ' of ' + phones.length + ' (' + smsSegments_(text) + ' segment(s) each).');

  var totals = function () {
    return {
      sent: stats.sent + sent, failed: stats.failed + failed, dailyLimit: stats.dailyLimit + dailyLimit,
      error: stats.error || firstError, startedAt: stats.startedAt, optOuts: optOuts.slice()
    };
  };
  var summarize = function (status) {
    var t = totals();
    saveLastSmsSummary_({ status: status, provider: provider.name, total: phones.length, sent: t.sent,
      failed: t.failed, dailyLimit: t.dailyLimit, error: t.error, text: text, startedAt: t.startedAt,
      optOuts: t.optOuts });
    return t;
  };
  // Opt-outs are removed only when the blast ends (complete / switched off), never mid-blast:
  // a resumed run re-reads the list and continues at a saved offset, so shrinking it early would skip people.
  var removeOptOuts = function () {
    if (optOuts.length) removeOptedOutPhones_(optOuts, text.split('\n')[0], phones.length);
  };
  var noteFail = function (who, err) {
    failed += who.length || 1;
    if (/Daily Conversation Limit/i.test(err)) dailyLimit += who.length || 1;
    if (!firstError) firstError = String(err);
    console.error(provider.name + ' SMS failed for ' + [].concat(who).join(',') + ': ' + err);
  };

  while (i < phones.length) {
    if (Date.now() - started > CONFIG.SMS_TIME_BUDGET_MS) {
      var t = totals();
      saveSmsQueue_(guid, i, text, t);
      summarize('in progress');
      console.warn('SMS time budget hit; this run sent ' + sent + ', failed ' + failed + '. Resuming at #' + i +
        ' of ' + phones.length + ' on the next trigger run (so far ' + t.sent + ' sent, ' + t.failed + ' failed).');
      return;
    }
    if (respectSwitch && loops > 0 && loops % CONFIG.SWITCH_CHECK_EVERY === 0 && !isSmsEnabled_()) {
      clearSmsQueue_();
      var st = summarize('stopped (switch turned off)');
      removeOptOuts();
      console.warn('SMS switch turned OFF mid-send; stopped at #' + i + ' of ' + phones.length + ' (' +
        st.sent + ' sent, ' + st.failed + ' failed, ' + (phones.length - i) + ' not texted).');
      return;
    }
    loops++;
    if (provider.name === 'quo') {
      // Up to QUO_PARALLEL requests at once, each with `provider.batch` recipients (1 = no group texts).
      var groups = [];
      for (var g = 0; g < CONFIG.QUO_PARALLEL && i < phones.length; g++) {
        groups.push(phones.slice(i, i + provider.batch));
        i += provider.batch;
      }
      var results;
      try {
        results = sendQuoMessages_(provider.key, provider.from, groups, text);
      } catch (e) {
        // fetchAll itself threw (network / UrlFetch quota). Count this chunk as failed and keep going.
        results = groups.map(function () { return { ok: false, error: 'fetchAll error: ' + e }; });
      }
      var chunkStart = i - groups.reduce(function (n, gr) { return n + gr.length; }, 0);
      var blockedAt = -1, blockedWhy = '';
      results.forEach(function (r, k) {
        if (blockedAt >= 0) return;
        var why = respectSwitch ? accountBlockReason_(r) : '';  // live alerts pause; tests just count failures
        if (why) { blockedAt = k; blockedWhy = why; if (!firstError) firstError = String(r.error); return; }
        if (r.ok) sent += groups[k].length;
        else if (isOptOutResult_(r)) {
          groups[k].forEach(function (ph) { if (optOuts.indexOf(ph) < 0) optOuts.push(ph); });
          console.warn('Quo: opted out (replied STOP) - will remove from the list: ' + groups[k].join(','));
        } else noteFail(groups[k], r.error);
      });
      if (blockedAt >= 0) {
        var resumeAt = chunkStart;
        for (var b = 0; b < blockedAt; b++) resumeAt += groups[b].length;
        pauseBlockedSend_(guid, resumeAt, text, totals(), blockedWhy, phones.length, provider.name);
        return;
      }
      if (i < phones.length) Utilities.sleep(CONFIG.QUO_CHUNK_SLEEP_MS);
    } else {
      try {
        sendTelnyxMessage_(provider.key, provider.from, phones[i], text);
        sent++;
      } catch (e) {
        noteFail([phones[i]], e);
      }
      i++;
    }
  }
  var wasBlocked = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_QUEUE_BLOCKED);
  clearSmsQueue_();
  var done = summarize('complete');
  removeOptOuts();
  if (wasBlocked) { console.log('SMS account block cleared; the paused alert finished sending.'); clearIssue_('sms'); }
  console.log('SMS done via ' + provider.name + ': ' + done.sent + ' sent, ' + done.failed + ' failed, ' +
    optOuts.length + ' opted out (removed), of ' +
    phones.length + ' (this run: ' + sent + ' sent, ' + failed + ' failed).');
  if (done.failed > 0) {
    var msg = 'ALERT: ' + done.failed + ' of ' + phones.length + ' SMS failed' +
      (done.dailyLimit ? ' (' + done.dailyLimit + ' hit Quo\'s Daily Conversation Limit - upgrade Quo/10DLC or wait until tomorrow)' : '') +
      '. First error: ' + scrubNumbers_(done.error).slice(0, 200);
    console.error(msg);
    if (respectSwitch) opsAlert_('Race Control SMS: ' + done.failed + ' of ' + phones.length + ' failed', msg);
  }
}

/** Quo 400 "User has opted out of receiving messages" (code 0201400). Not an account block, not a real failure. */
function isOptOutResult_(r) {
  if (!r || r.ok) return false;
  var e = String(r.error || '');
  return /0201400/.test(e) || (r.code === 400 && /opted out/i.test(e));
}

/** +15156507902 -> +1•••••••7902 (for the public status endpoint). */
function maskPhone_(ph) {
  var s = String(ph || '');
  return s.length > 6 ? s.slice(0, 2) + '•••••••' + s.slice(-4) : '•••';
}

/**
 * Take opted-out phones off the list: Firestore status=stopped (stopSource quo-opt-out-0201400)
 * + Unsubscribed tab, append to the opt-out log (Script Property smsOptOutLog), and send ONE
 * ops email with the full numbers (private feedback for the admin). Never texts anyone.
 */
function removeOptedOutPhones_(phones, title, listSize) {
  var src = CONFIG.OPTOUT_STOP_SOURCE, at = new Date().toISOString(), removed = [], failedRm = [];
  phones.forEach(function (ph) {
    var ok = false;
    try { ok = stopFirestorePhone_(ph, src); } catch (e) { console.warn('Firestore stop error (opt-out): ' + e); }
    try { ensureUnsubscribedSheet_().appendRow([new Date(), '', ph, src]); } catch (e2) { /* sheet optional */ }
    (ok ? removed : failedRm).push(ph);
  });
  appendOptOutLog_(phones.map(function (ph) {
    return { phone: ph, at: at, source: src, removed: removed.indexOf(ph) >= 0, title: String(title || '').slice(0, 120) };
  }));
  var body = 'Quo says these ' + phones.length + ' number(s) opted out (replied STOP), so the last text could not go to them:\n\n' +
    phones.map(function (ph) { return '  ' + ph + (removed.indexOf(ph) >= 0 ? '  - removed from the list' : '  - REMOVE FAILED, set status=stopped in Firestore'); }).join('\n') +
    '\n\nThey are now status=stopped in Firestore smsSubscribers (stopSource ' + src + ') and will not count as failures again.' +
    '\nList size for that text: ' + listSize + '. Active now: ' + (listSize - removed.length) + '.' +
    '\nText: ' + String(title || '') + '\nFull opt-out history: sms-admin ?action=optOuts (PIN).';
  console.warn('SMS opt-outs removed from the list: ' + removed.join(',') + (failedRm.length ? ' (remove FAILED: ' + failedRm.join(',') + ')' : ''));
  opsAlert_('Race Control SMS: ' + phones.length + ' opted-out number(s) removed', body, true);
  return removed;
}

function appendOptOutLog_(entries) {
  var p = PropertiesService.getScriptProperties();
  var log = [];
  try { log = JSON.parse(p.getProperty(CONFIG.PROP_OPTOUT_LOG) || '[]') || []; } catch (e) {}
  log = log.concat(entries).slice(-CONFIG.OPTOUT_LOG_MAX);
  p.setProperty(CONFIG.PROP_OPTOUT_LOG, JSON.stringify(log));
}

function getOptOutLog_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_OPTOUT_LOG) || '[]') || []; } catch (e) { return []; }
}

/**
 * Manual (run from the editor): find subscribers who replied STOP to the Quo number
 * WITHOUT texting anyone (read-only Quo API: GET /v1/phone-numbers + GET /v1/messages per
 * active phone, incoming messages in the last `days` days). Removes them like a 0201400.
 * Use it to catch opt-outs between blasts, e.g. right after pasting this code.
 */
function findQuoOptOuts(days) {
  days = days || 14;
  var prov = getSmsProvider_();
  if (!prov || prov.name !== 'quo') throw new Error('Quo is not configured (QUO_API_KEY / QUO_FROM).');
  var hdr = { Authorization: prov.key, 'Quo-Api-Version': CONFIG.QUO_API_VERSION };
  var pnRes = UrlFetchApp.fetch('https://api.quo.com/v1/phone-numbers', { method: 'get', headers: hdr, muteHttpExceptions: true });
  if (pnRes.getResponseCode() !== 200) throw new Error('Quo phone-numbers HTTP ' + pnRes.getResponseCode() + ' ' + pnRes.getContentText().slice(0, 200));
  var pn = (JSON.parse(pnRes.getContentText()).data || []).filter(function (x) { return normalizePhone_(x.number || x.phoneNumber) === normalizePhone_(prov.from); })[0];
  if (!pn) throw new Error('Quo number ' + prov.from + ' not found in /v1/phone-numbers.');
  var after = new Date(Date.now() - days * 86400000).toISOString();
  var phones = getPhones_(getUnsubscribed_().phones), hits = [];
  var STOP_RE = /^\s*(stop|stopall|stop all|unsubscribe|cancel|end|quit|opt ?out|revoke)\b/i;
  for (var i = 0; i < phones.length; i += 5) {
    var reqs = phones.slice(i, i + 5).map(function (ph) {
      return { url: 'https://api.quo.com/v1/messages?phoneNumberId=' + encodeURIComponent(pn.id) + '&participants=' + encodeURIComponent(ph) +
        '&createdAfter=' + encodeURIComponent(after) + '&maxResults=50', method: 'get', headers: hdr, muteHttpExceptions: true };
    });
    UrlFetchApp.fetchAll(reqs).forEach(function (res, k) {
      var ph = phones[i + k];
      if (res.getResponseCode() !== 200) { console.warn('Quo messages HTTP ' + res.getResponseCode() + ' for one phone'); return; }
      var msgs = (JSON.parse(res.getContentText()).data || []).filter(function (m) { return m.direction === 'incoming'; });
      msgs.sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
      var last = null;
      msgs.forEach(function (m) { var t = String(m.text || ''); if (STOP_RE.test(t)) last = 'stop'; else if (/^\s*(start|unstop|yes)\b/i.test(t)) last = 'start'; });
      if (last === 'stop') hits.push(ph);
    });
    Utilities.sleep(CONFIG.QUO_CHUNK_SLEEP_MS);
  }
  console.log('findQuoOptOuts: checked ' + phones.length + ' active phones; replied STOP: ' + (hits.join(', ') || 'none'));
  if (hits.length) removeOptedOutPhones_(hits, 'findQuoOptOuts (STOP replies, last ' + days + ' days)', phones.length);
  return hits;
}

/** Remove anything that looks like a phone number (summary is shown on a public status endpoint). */
function scrubNumbers_(s) {
  return String(s || '').replace(/\+?\d[\d\s().-]{8,}\d/g, '[number]');
}

/** Save the last blast's health to Script Properties (counts only, never numbers). */
function saveLastSmsSummary_(o) {
  var text = String(o.text || '');
  PropertiesService.getScriptProperties().setProperties({
    lastSmsAt: new Date().toISOString(),
    lastSmsStartedAt: String(o.startedAt || new Date().toISOString()),
    lastSmsStatus: String(o.status || ''),
    lastSmsProvider: String(o.provider || 'none'),
    lastSmsTotal: String(o.total || 0),
    lastSmsSent: String(o.sent || 0),
    lastSmsFailed: String(o.failed || 0),
    lastSmsDailyLimit: String(o.dailyLimit || 0),
    lastSmsSegments: String(text ? smsSegments_(text) : 0),
    lastSmsTitle: text.split('\n')[0].slice(0, 160),
    lastSmsError: scrubNumbers_(o.error).slice(0, 200),
    lastSmsOptedOut: String((o.optOuts || []).length),
    lastSmsOptOutMasked: (o.optOuts || []).map(maskPhone_).join(',')
  });
}

/** Last blast summary for smsStatus / the admin page. null if no blast has run since this code was pasted. */
function getLastSmsSummary_() {
  var p = PropertiesService.getScriptProperties().getProperties();
  if (!p.lastSmsAt) return null;
  var n = function (k) { return parseInt(p[k], 10) || 0; };
  return {
    at: p.lastSmsAt,
    startedAt: p.lastSmsStartedAt || '',
    status: p.lastSmsStatus || '',
    provider: p.lastSmsProvider || '',
    title: p.lastSmsTitle || '',
    total: n('lastSmsTotal'),
    sent: n('lastSmsSent'),
    failed: n('lastSmsFailed'),
    dailyLimitHits: n('lastSmsDailyLimit'),
    segmentsEach: n('lastSmsSegments'),
    error: p.lastSmsError || '',
    optedOut: n('lastSmsOptedOut'),                                       // Quo 0201400 this blast (not counted in failed)
    optOutRemoved: p.lastSmsOptOutMasked ? p.lastSmsOptOutMasked.split(',') : []  // masked; full list: ?action=optOuts + PIN
  };
}

function saveSmsQueue_(guid, offset, text, stats) {
  var o = {};
  o[CONFIG.PROP_QUEUE_GUID] = String(guid || 'queued');
  o[CONFIG.PROP_QUEUE_OFFSET] = String(offset);
  o[CONFIG.PROP_QUEUE_TEXT] = text;
  o[CONFIG.PROP_QUEUE_STATS] = JSON.stringify(stats || {});
  PropertiesService.getScriptProperties().setProperties(o);
}

function clearSmsQueue_() {
  var p = PropertiesService.getScriptProperties();
  [CONFIG.PROP_QUEUE_GUID, CONFIG.PROP_QUEUE_OFFSET, CONFIG.PROP_QUEUE_TEXT, CONFIG.PROP_QUEUE_STATS,
    CONFIG.PROP_QUEUE_BLOCKED, CONFIG.PROP_QUEUE_BLOCKED_SINCE].forEach(function (k) { p.deleteProperty(k); });
}

/**
 * Account-level failure that will hit EVERY recipient (so keep the alert queued, don't burn it):
 * Quo 402 "Not Enough Credits", 401 bad key, 403 forbidden/suspended. '' otherwise.
 */
function accountBlockReason_(r) {
  if (!r || r.ok) return '';
  var e = String(r.error || '');
  if (r.code === 402 || /not enough (prepaid )?credits|insufficient (funds|balance|credits)/i.test(e)) return 'Quo out of prepaid credits (HTTP 402) - add credits / turn on auto-recharge in Quo billing';
  if (r.code === 401) return 'Quo API key rejected (HTTP 401) - check QUO_API_KEY';
  if (r.code === 403 && !/opt|stop|unsubscrib|blocked recipient/i.test(e)) return 'Quo refused the account (HTTP 403) - check Quo account/number status';
  return '';
}

/** Pause a blast on an account block: keep the queue so the next trigger run retries it. */
function pauseBlockedSend_(guid, offset, text, stats, why, total, providerName) {
  var p = PropertiesService.getScriptProperties();
  var first = !p.getProperty(CONFIG.PROP_QUEUE_BLOCKED);
  saveSmsQueue_(guid, offset, text, stats);
  var since = p.getProperty(CONFIG.PROP_QUEUE_BLOCKED_SINCE) || new Date().toISOString();
  p.setProperties({ smsQueueBlocked: why, smsQueueBlockedSince: since });
  saveLastSmsSummary_({ status: 'PAUSED: ' + why, provider: providerName, total: total, sent: stats.sent,
    failed: stats.failed, dailyLimit: stats.dailyLimit, error: stats.error, text: text, startedAt: stats.startedAt });
  var msg = 'ALERT: SMS PAUSED - ' + why + '. ' + (total - offset) + ' of ' + total +
    ' subscribers not texted yet; will retry every 5 min and send automatically once fixed (gives up after ' +
    Math.round(CONFIG.BLOCKED_MAX_MS / 3600000) + ' h). Paused since ' + since + '. Alert: ' + text.split('\n')[0];
  console.error(msg);
  if (first) raiseIssue_('sms', 'SMS alerts PAUSED: ' + why);  // one ops email per incident (deduped with watchdog)
}

/**
 * While paused on an account block: if a newer schedule change arrived, swap it in
 * (restart at #0 so everyone gets the latest); if paused too long, drop the stale alert.
 */
function refreshBlockedQueue_() {
  var p = PropertiesService.getScriptProperties();
  var since = Date.parse(p.getProperty(CONFIG.PROP_QUEUE_BLOCKED_SINCE) || '') || 0;
  var item = null;
  try { item = fetchLatestItem_(); } catch (e) {}
  if (item) {
    var lastTs = parseInt(p.getProperty(CONFIG.PROP_LAST_TS), 10) || 0;
    var isNew = !(item.id === p.getProperty(CONFIG.PROP_LAST_GUID) && item.title === p.getProperty(CONFIG.PROP_LAST_TITLE)) &&
      !(item.ts && lastTs && item.ts < lastTs);
    if (isNew) {
      p.setProperties({ lastFeedGuid: item.id, lastFeedTitle: item.title, lastFeedTs: String(item.ts || 0) });
      if (isManualMode_()) {
        setSmsPending_(item);
        console.log('SMS paused and mode is MANUAL. Newer change is pending, not swapped into the blast: ' + item.title);
      } else {
        saveSmsQueue_(item.id, 0, smsText_(item), null);
        console.log('SMS paused; newer change replaces the queued alert: ' + item.title);
      }
    }
  }
  if (since && Date.now() - since > CONFIG.BLOCKED_MAX_MS) {
    var why = p.getProperty(CONFIG.PROP_QUEUE_BLOCKED) || '';
    var text = p.getProperty(CONFIG.PROP_QUEUE_TEXT) || '';
    clearSmsQueue_();
    saveLastSmsSummary_({ status: 'dropped (paused over ' + Math.round(CONFIG.BLOCKED_MAX_MS / 3600000) + ' h: ' + why + ')',
      provider: 'quo', total: 0, text: text, error: why });
    console.error('ALERT: dropped a paused SMS alert after ' + Math.round(CONFIG.BLOCKED_MAX_MS / 3600000) + ' h still blocked (' + why + '). Next schedule change will try again.');
  }
}

/** Optional ops email (Script Property OPS_ALERT_EMAIL). Never throws; never texts subscribers. */
function opsAlert_(subject, body, keepNumbers) {
  try {
    var to = String(PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_OPS_EMAIL) || '').trim();
    if (!to || typeof MailApp === 'undefined') return;
    MailApp.sendEmail(to, subject.slice(0, 200), keepNumbers ? String(body) : scrubNumbers_(body));
  } catch (e) {
    console.warn('opsAlert_ failed: ' + e);
  }
}

/**
 * Continue a saved send (caller holds the script lock). Phones are re-read in
 * the same order (Firestore returns docs ordered by phone/doc id).
 */
function resumeSmsQueue_() {
  var p = PropertiesService.getScriptProperties();
  var guid = p.getProperty(CONFIG.PROP_QUEUE_GUID);
  var offset = parseInt(p.getProperty(CONFIG.PROP_QUEUE_OFFSET), 10) || 0;
  var text = p.getProperty(CONFIG.PROP_QUEUE_TEXT) || '';
  var stats = null;
  try { stats = JSON.parse(p.getProperty(CONFIG.PROP_QUEUE_STATS) || 'null'); } catch (e) {}
  var provider = getSmsProvider_();
  if (!isSmsEnabled_() || !provider || !text) {
    console.log('Dropping saved SMS queue (switch off, no provider, or no text).');
    clearSmsQueue_();
    if (stats) {
      saveLastSmsSummary_({ status: 'dropped (switch off or no provider)', provider: provider ? provider.name : 'none',
        sent: stats.sent, failed: stats.failed, dailyLimit: stats.dailyLimit, error: stats.error, text: text,
        startedAt: stats.startedAt });
    }
    return;
  }
  sendSmsFrom_(provider, getPhones_(getUnsubscribed_().phones), text, guid, offset, stats, true);
}

/**
 * Quo: send one message per group in parallel (UrlFetchApp.fetchAll).
 * groups = [[+1...], [+1...], ...]; each group max 10 (one group = one message).
 * Returns [{ok, code, error, id}] in the same order. Retries a plain 429 (rate
 * limit) once after 1.5 s; a "Daily Conversation Limit" 429 is NOT retried (it
 * will not clear until Quo's daily window resets).
 */
function sendQuoMessages_(apiKey, from, groups, content) {
  var build = function (to) {
    return {
      url: CONFIG.QUO_API_URL,
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: apiKey, 'Quo-Api-Version': CONFIG.QUO_API_VERSION },
      payload: JSON.stringify({ content: content, from: from, to: to }),
      muteHttpExceptions: true
    };
  };
  var reqs = groups.map(build);
  var res = UrlFetchApp.fetchAll(reqs);
  var out = res.map(parseQuoResponse_);
  var retry = [];
  out.forEach(function (r, k) { if (r.code === 429 && !/Daily Conversation Limit/i.test(r.error)) retry.push(k); });
  if (retry.length) {
    Utilities.sleep(1500);
    var res2 = UrlFetchApp.fetchAll(retry.map(function (k) { return reqs[k]; }));
    retry.forEach(function (k, j) { out[k] = parseQuoResponse_(res2[j]); });
  }
  return out;
}

function parseQuoResponse_(res) {
  var code = res.getResponseCode();
  var body = res.getContentText() || '';
  if (code >= 200 && code < 300) {
    var id = '';
    try { id = (JSON.parse(body).data || {}).id || ''; } catch (e) {}
    return { ok: true, code: code, id: id, error: '' };
  }
  return { ok: false, code: code, id: '', error: 'HTTP ' + code + ' ' + body.slice(0, 300) };
}

/** Quo: one message to toArray (1-10 numbers). Returns message id; throws on failure. */
function sendQuoMessage_(apiKey, from, toArray, content) {
  if (!Array.isArray(toArray)) toArray = [toArray];
  if (!toArray.length || toArray.length > CONFIG.QUO_MAX_TO) throw new Error('Quo `to` must have 1-10 numbers.');
  var r = sendQuoMessages_(apiKey, from, [toArray], content)[0];
  if (!r.ok) throw new Error('Quo ' + r.error);
  return r.id;
}

function sendTelnyxMessage_(apiKey, from, to, text) {
  var res = UrlFetchApp.fetch('https://api.telnyx.com/v2/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify({ from: from, to: to, text: text }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('HTTP ' + code + ' ' + res.getContentText().slice(0, 300));
  }
  return res.getContentText();
}

function truncateSms_(s) {
  s = String(s || '');
  return s.length <= 300 ? s : s.slice(0, 297) + '...';
}

/**
 * One test SMS (ignores the master switch; it only goes to the test number).
 * Quo → QUO_TEST_TO; Telnyx fallback → TELNYX_TEST_TO.
 */
function sendTestSms() {
  var p = PropertiesService.getScriptProperties();
  var provider = getSmsProvider_();
  if (!provider) throw new Error('Set QUO_API_KEY + QUO_FROM (or TELNYX_API_KEY + TELNYX_FROM) first.');
  var to = provider.name === 'quo'
    ? (p.getProperty(CONFIG.PROP_QUO_TEST_TO) || p.getProperty(CONFIG.PROP_TELNYX_TEST_TO))
    : p.getProperty(CONFIG.PROP_TELNYX_TEST_TO);
  to = normalizePhone_(to);
  if (!to) throw new Error('Set Script Property ' + (provider.name === 'quo' ? 'QUO_TEST_TO' : 'TELNYX_TEST_TO') + ' first.');
  var text = 'Race Control test SMS (' + provider.name + '). Reply STOP to unsubscribe.\n' + CONFIG.RACE_CONTROL_URL;
  var id = provider.name === 'quo'
    ? sendQuoMessage_(provider.key, provider.from, [to], text)
    : sendTelnyxMessage_(provider.key, provider.from, to, text);
  console.log('Test SMS sent via ' + provider.name + ' from ' + provider.from + ' to ' + to + ' (' + String(id).slice(0, 80) + ')');
  return id;
}

/**
 * Full-list test: texts every active signup (Firestore/Sheet) via the live Quo path.
 * Ignores the master switch so you can still blast a test while OFF if needed.
 * Does NOT touch lastFeedGuid. Message is clearly labeled as a test.
 */
function sendTestSmsToList() {
  RUN_STARTED_ = Date.now();
  var provider = getSmsProvider_();
  if (!provider) throw new Error('Set QUO_API_KEY + QUO_FROM (or TELNYX) first.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) throw new Error('A send is already running (script lock busy). Try again in a few minutes.');
  try {
    if (PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_QUEUE_GUID)) {
      throw new Error('A resumable send is still queued; wait for it to finish (or turn SMS OFF to cancel it).');
    }
    var phones = getPhones_(getUnsubscribed_().phones);
    if (!phones.length) throw new Error('No active phones on the signup list.');
    // ASCII only, under 160 chars = 1 segment per phone.
    var text = 'Race Control TEST text - not a schedule change.\n' + CONFIG.RACE_CONTROL_URL + '\nReply STOP to unsubscribe';
    console.log('Full-list test: ' + phones.length + ' phones via ' + provider.name + ' from ' + provider.from);
    sendSmsFrom_(provider, phones, text, 'test-list-' + Date.now(), 0, null, false);
    return phones.length;
  } finally {
    lock.releaseLock();
  }
}

/**
 * One-time helper: sets the non-secret SMS properties if they are blank.
 * Does NOT set QUO_API_KEY or SMS_ADMIN_PIN (enter those by hand).
 * SMS_ENABLED starts 'false'.
 */
function setupQuoProps() {
  var p = PropertiesService.getScriptProperties();
  var defaults = { QUO_FROM: CONFIG.QUO_DEFAULT_FROM, QUO_TEST_TO: '+16103349559', SMS_ENABLED: 'false' };
  Object.keys(defaults).forEach(function (k) {
    if (!p.getProperty(k)) p.setProperty(k, defaults[k]);
  });
  var prov = getSmsProvider_();
  console.log('SMS_ENABLED=' + p.getProperty('SMS_ENABLED') + ', provider=' + (prov ? prov.name : 'none') +
    ', QUO_API_KEY ' + (p.getProperty('QUO_API_KEY') ? 'set' : 'MISSING') +
    ', SMS_ADMIN_PIN ' + (p.getProperty('SMS_ADMIN_PIN') ? 'set' : 'MISSING'));
}

/**
 * Newest feed item from the Firebase feed and the GitHub copy, whichever is newer
 * (by the top item's pubDate). Either source alone is enough; null only if both fail.
 */
function fetchLatestItem_() {
  var urls = [CONFIG.FEED_URL, CONFIG.FEED_URL_BACKUP].filter(String);
  var best = null;
  urls.forEach(function (url) {
    var it = null;
    try { it = fetchFeedTop_(url); } catch (e) { console.warn('Feed read failed for ' + url + ': ' + e); }
    if (it && (!best || it.ts > best.ts)) best = it;
  });
  if (!best) console.error('ALERT: could not read the Race Control feed from any source; no SMS check this run.');
  return best;
}

function fetchFeedTop_(url) {
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } });
  if (res.getResponseCode() !== 200) {
    console.warn('Feed fetch failed: HTTP ' + res.getResponseCode() + ' for ' + url);
    return null;
  }
  var root = XmlService.parse(res.getContentText()).getRootElement();
  var channel = root.getChild('channel');
  var first = channel ? channel.getChild('item') : null;
  if (!first) return null;
  var title = first.getChildText('title') || '';
  var link = first.getChildText('link') || '';
  var id = first.getChildText('guid') || first.getChildText('pubDate') || title;
  // Items from the same generator run share a pubDate; one SMS covers them all.
  var pub = (first.getChildText('pubDate') || '').trim();
  var more = 0;
  if (pub) {
    channel.getChildren('item').forEach(function (it, k) {
      if (k > 0 && (it.getChildText('pubDate') || '').trim() === pub) more++;
    });
  }
  var ts = Date.parse(pub) || 0;
  return { title: title.trim(), link: link.trim(), id: id.trim(), more: more, ts: ts };
}

function getUnsubscribed_() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var emails = {};
  var phones = {};
  var sheet = ss.getSheetByName(CONFIG.UNSUBSCRIBED_TAB);
  if (sheet && sheet.getLastRow() >= 2) {
    var values = sheet.getDataRange().getValues();
    var headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var emailCol = headerCol_(headers, ['email']);
    var phoneCol = headerCol_(headers, ['phone', 'mobile']);
    values.slice(1).forEach(function (row) {
      if (emailCol !== -1) {
        var e = String(row[emailCol] || '').trim().toLowerCase();
        if (e) emails[e] = true;
      }
      if (phoneCol !== -1) {
        var p = normalizePhone_(row[phoneCol]);
        if (p) phones[p] = true;
      }
    });
  }
  // Also treat Notify Status = unsubscribed|stopped|inactive
  readRows_(ss, CONFIG.NOTIFY_TAB).forEach(function (r) {
    var status = String(r.status || '').trim().toLowerCase();
    if (status === 'unsubscribed' || status === 'stopped' || status === 'inactive') {
      if (r.email) emails[String(r.email).trim().toLowerCase()] = true;
      var p = normalizePhone_(r.phone);
      if (p) phones[p] = true;
    }
  });
  return { emails: emails, phones: phones };
}

function getEmails_(unsubEmails) {
  unsubEmails = unsubEmails || {};
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var seen = {};
  var out = [];
  var add = function (raw) {
    var email = String(raw || '').trim().toLowerCase();
    if (!email || !EMAIL_RE_.test(email) || seen[email] || unsubEmails[email]) return;
    seen[email] = true;
    out.push(email);
  };
  readRows_(ss, CONFIG.FORM_RESPONSES_TAB).forEach(function (r) { add(r.email); });
  readRows_(ss, CONFIG.NOTIFY_TAB).forEach(function (r) {
    var status = String(r.status || '').trim().toLowerCase();
    if (status === '' || status === 'active') add(r.email);
  });
  return out;
}

function getPhones_(unsubPhones) {
  unsubPhones = unsubPhones || {};
  var src = String(PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_PHONES_SOURCE) || 'firestore').toLowerCase();
  var list = [];
  if (src === 'firestore' || src === 'both') {
    try {
      list = list.concat(getFirestorePhones_());
    } catch (e) {
      console.warn('Firestore phone read FAILED, falling back to Sheet: ' + e);
      src = 'sheet';
    }
  }
  if (src === 'sheet' || src === 'both') list = list.concat(getSheetPhones_());
  var seen = {};
  return list.filter(function (p) {
    p = normalizePhone_(p);
    if (!p || seen[p] || unsubPhones[p]) return false;
    seen[p] = true;
    return true;
  }).map(normalizePhone_);
}

/** Legacy: phones from the Google Sheet (archive after the Firestore move). */
function getSheetPhones_() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var out = [];
  readRows_(ss, CONFIG.FORM_RESPONSES_TAB).forEach(function (r) { out.push(r.phone); });
  readRows_(ss, CONFIG.NOTIFY_TAB).forEach(function (r) {
    var status = String(r.status || '').trim().toLowerCase();
    if (status === '' || status === 'active') out.push(r.phone);
  });
  return out.map(normalizePhone_).filter(String);
}

/* ------------------------------------------------------------------ */
/* Firestore (private phone list)                                      */
/* ------------------------------------------------------------------ */

function firestoreBase_() {
  return 'https://firestore.googleapis.com/v1/projects/' + CONFIG.FIREBASE_PROJECT + '/databases/(default)/documents';
}

/** Active phones from Firestore. Function+secret if configured, else REST with owner's OAuth. */
function getFirestorePhones_() {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty(CONFIG.PROP_PHONES_URL);
  var secret = p.getProperty(CONFIG.PROP_PHONES_SECRET);
  if (url && secret) {
    var r = UrlFetchApp.fetch(url, { method: 'get', headers: { 'X-Phones-Secret': secret }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error('listActivePhones HTTP ' + r.getResponseCode());
    return JSON.parse(r.getContentText()).phones || [];
  }
  var res = UrlFetchApp.fetch(firestoreBase_() + ':runQuery', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
    payload: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: CONFIG.FIRESTORE_COLLECTION }],
      where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'active' } } }
    } })
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Firestore runQuery HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  var rows = JSON.parse(res.getContentText()) || [];
  var out = [];
  rows.forEach(function (row) {
    var f = row.document && row.document.fields;
    if (f && f.phone && f.phone.stringValue) out.push(f.phone.stringValue);
  });
  return out;
}

/** Mark a phone stopped in Firestore (used by the web unsubscribe link). */
function stopFirestorePhone_(phone, source) {
  phone = normalizePhone_(phone);
  if (!phone) return false;
  var url = firestoreBase_() + '/' + CONFIG.FIRESTORE_COLLECTION + '/' + encodeURIComponent(phone) +
    '?updateMask.fieldPaths=phone&updateMask.fieldPaths=status&updateMask.fieldPaths=stoppedAt&updateMask.fieldPaths=stopSource';
  var res = UrlFetchApp.fetch(url, {
    method: 'patch',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
    payload: JSON.stringify({ fields: {
      phone: { stringValue: phone },
      status: { stringValue: 'stopped' },
      stoppedAt: { timestampValue: new Date().toISOString() },
      stopSource: { stringValue: source || 'web' }
    } })
  });
  if (res.getResponseCode() !== 200) console.warn('Firestore stop failed for a phone: HTTP ' + res.getResponseCode());
  return res.getResponseCode() === 200;
}

/** Run once from the editor: log how many active phones Firestore returns (numbers not logged). */
function testFirestorePhones() {
  var phones = getFirestorePhones_();
  console.log('Firestore active phones: ' + phones.length);
}

/**
 * One-time (safe to re-run): copy Sheet phones into Firestore as active.
 * Never overwrites an existing doc (precondition exists=false), so stopped
 * numbers stay stopped. Skips numbers on the Unsubscribed tab / Notify stopped.
 */
function migrateSheetPhonesToFirestore() {
  var unsub = getUnsubscribed_().phones;
  var phones = getSheetPhones_();
  var seen = {}, created = 0, existed = 0, failed = 0, skipped = 0;
  phones.forEach(function (phone) {
    if (!phone || seen[phone]) return;
    seen[phone] = true;
    if (unsub[phone]) { skipped++; return; }
    var url = firestoreBase_() + '/' + CONFIG.FIRESTORE_COLLECTION + '/' + encodeURIComponent(phone) +
      '?currentDocument.exists=false';
    var now = new Date().toISOString();
    var res = UrlFetchApp.fetch(url, {
      method: 'patch',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
      payload: JSON.stringify({ fields: {
        phone: { stringValue: phone },
        status: { stringValue: 'active' },
        source: { stringValue: 'sheet-migration' },
        createdAt: { timestampValue: now },
        consentAt: { timestampValue: now },
        consentVersion: { stringValue: 'google-form-legacy' },
        migratedFrom: { stringValue: 'Google Sheet' }
      } })
    });
    var code = res.getResponseCode();
    if (code === 200) created++;
    else if (code === 409 || code === 400 && /exist/i.test(res.getContentText())) existed++;
    else { failed++; console.warn('Migrate HTTP ' + code + ': ' + res.getContentText().slice(0, 200)); }
  });
  console.log('Migration: created ' + created + ', already in Firestore ' + existed + ', skipped (unsubscribed) ' + skipped + ', failed ' + failed);
}

function normalizePhone_(raw) {
  var digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) digits = '1' + digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
  if (digits.length >= 11 && digits.length <= 15) return '+' + digits;
  return '';
}

function headerCol_(headers, keys) {
  // Exact match first, then first header that contains a key (Google Forms
  // titles like "Mobile phone number (for text alerts)").
  var i, k, h;
  for (i = 0; i < headers.length; i++) {
    h = headers[i];
    for (k = 0; k < keys.length; k++) {
      if (h === keys[k]) return i;
    }
  }
  for (i = 0; i < headers.length; i++) {
    h = headers[i];
    for (k = 0; k < keys.length; k++) {
      if (h.indexOf(keys[k]) !== -1) return i;
    }
  }
  return -1;
}

function readRows_(ss, tabName) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var emailCol = headerCol_(headers, ['email']);
  if (emailCol === -1) emailCol = 1;
  var statusCol = headerCol_(headers, ['status']);
  var phoneCol = headerCol_(headers, ['phone', 'mobile']);
  return values.slice(1).map(function (row) {
    return {
      email: row[emailCol],
      phone: phoneCol === -1 ? '' : row[phoneCol],
      status: statusCol === -1 ? '' : row[statusCol]
    };
  });
}

function ensureUnsubscribedSheet_() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.UNSUBSCRIBED_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.UNSUBSCRIBED_TAB);
    sheet.getRange(1, 1, 1, 4).setValues([['Timestamp', 'Email', 'Phone', 'Source']]);
  }
  return sheet;
}

function recordUnsubscribe_(email, phone, source) {
  email = String(email || '').trim().toLowerCase();
  phone = normalizePhone_(phone);
  if (!email && !phone) return false;
  var sheet = ensureUnsubscribedSheet_();
  sheet.appendRow([new Date(), email, phone, source || 'web']);
  if (phone) {
    try { stopFirestorePhone_(phone, source || 'web'); } catch (e) { console.warn('Firestore stop error: ' + e); }
  }
  return true;
}

function getUnsubscribeBaseUrl_() {
  try {
    var url = ScriptApp.getService().getUrl();
    return url || '';
  } catch (e) {
    return '';
  }
}

function isManualMode_() {
  return String(PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_SMS_MODE) || 'auto').trim().toLowerCase() === 'manual';
}

/** Any mode change drops a waiting manual send and does not text it. */
function setSmsMode_(mode) {
  var next = String(mode || '').trim().toLowerCase() === 'manual' ? 'manual' : 'auto';
  var prev = isManualMode_() ? 'manual' : 'auto';
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_SMS_MODE, next);
  if (prev !== next) {
    clearSmsPending_();
    console.log('SMS mode ' + prev + ' -> ' + next + '. Pending change cleared and NOT sent.');
  }
  return next;
}

function setSmsPending_(item) {
  PropertiesService.getScriptProperties().setProperties({
    smsPendingGuid: String(item && item.id || ''),
    smsPendingTitle: String(item && item.title || '').slice(0, 180),
    smsPendingAt: new Date().toISOString()
  });
}

function clearSmsPending_() {
  var p = PropertiesService.getScriptProperties();
  [CONFIG.PROP_PENDING_GUID, CONFIG.PROP_PENDING_TITLE, CONFIG.PROP_PENDING_AT].forEach(function (k) {
    p.deleteProperty(k);
  });
}

function getSmsPending_() {
  var p = PropertiesService.getScriptProperties();
  var guid = p.getProperty(CONFIG.PROP_PENDING_GUID);
  if (!guid) return null;
  return { at: p.getProperty(CONFIG.PROP_PENDING_AT) || '', title: p.getProperty(CONFIG.PROP_PENDING_TITLE) || 'Schedule change' };
}

function smsCostRate_() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_COST_USD);
  var n = parseFloat(raw);
  if (!(n >= 0) || n > 5 || !isFinite(n)) n = CONFIG.DEFAULT_COST_USD;
  return Math.round(n * 10000) / 10000;
}

function smsCostReport_(phoneCount) {
  var rate = smsCostRate_();
  var seg = smsSegments_(scheduleAlertBody_());
  var last = getLastSmsSummary_();
  var blast = (typeof phoneCount === 'number') ? Math.round(phoneCount * seg * rate * 100) / 100 : null;
  var lastCost = null;
  if (last && typeof last.sent === 'number') {
    var segs = last.segmentsEach || seg;
    lastCost = {
      sent: last.sent,
      failed: last.failed,
      segmentsEach: segs,
      estimatedUsd: Math.round(last.sent * segs * rate * 100) / 100
    };
  }
  return {
    currency: 'USD',
    rateUsd: rate,
    estimate: true,
    rateNote: 'Quo API local SMS (US/Canada) is $0.01 per segment. Estimate only, not the live Quo balance. Override with Script Property QUO_SMS_COST_USD.',
    activeNumbers: typeof phoneCount === 'number' ? phoneCount : null,
    segmentsPerAlert: seg,
    estimatedBlastUsd: blast,
    lastBlast: lastCost
  };
}

/**
 * PIN-gated manual blast of the generic schedule text. Same lock, resume, and
 * opt-out path as an automatic alert. Does nothing when nothing is pending.
 */
/** Caller (handleSmsAction_) has already checked the PIN. */
function sendPendingUpdate_() {
  if (!isSmsEnabled_()) return { ok: false, error: 'Text alerts are OFF. Turn them on before sending.' };
  if (!isManualMode_()) return { ok: false, error: 'Send update is only for Manual mode.' };
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty(CONFIG.PROP_PENDING_GUID)) return { ok: false, error: 'Nothing new to send.' };
  if (p.getProperty(CONFIG.PROP_QUEUE_GUID)) return { ok: false, error: 'A send is already in progress.' };
  var provider = getSmsProvider_();
  if (!provider) return { ok: false, error: 'No SMS provider configured.' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) return { ok: false, error: 'A send is already running. Try again in a few minutes.' };
  var pendingGuid = '';
  var pendingTitle = '';
  try {
    pendingGuid = p.getProperty(CONFIG.PROP_PENDING_GUID) || '';
    pendingTitle = p.getProperty(CONFIG.PROP_PENDING_TITLE) || '';
    if (!pendingGuid) return { ok: false, error: 'Nothing new to send.' };
    if (p.getProperty(CONFIG.PROP_QUEUE_GUID)) return { ok: false, error: 'A send is already in progress.' };
    var phones = getPhones_(getUnsubscribed_().phones);
    if (!phones.length) return { ok: false, error: 'No active numbers on the list.' };
    var text = smsText_(null);
    RUN_STARTED_ = Date.now();
    clearSmsPending_();
    try {
      sendSmsFrom_(provider, phones, text, pendingGuid, 0, null, true);
    } catch (e) {
      setSmsPending_({ id: pendingGuid, title: pendingTitle });
      return { ok: false, error: scrubNumbers_(e).slice(0, 300) };
    }
    var st = smsStatus_();
    st.ok = true;
    return st;
  } finally {
    lock.releaseLock();
  }
}

function sendAdminTestSms_(pin, rawPhone) {
  var pinCheck = checkAdminPin_(pin);
  if (!pinCheck.ok) return { ok: false, error: pinCheck.error };
  var raw = String(rawPhone || '');
  if (/[,;\n]/.test(raw)) return { ok: false, error: 'Enter one phone number. This does not text the list.' };
  var to = normalizePhone_(raw);
  if (!to) return { ok: false, error: 'Enter a valid phone number.' };
  var cache = CacheService.getScriptCache();
  var n = parseInt(cache.get('smsTestSends'), 10) || 0;
  if (n >= CONFIG.TEST_SMS_MAX_PER_HOUR) return { ok: false, error: 'Test text limit reached for this hour. Try again later.' };
  var provider = getSmsProvider_();
  if (!provider) return { ok: false, error: 'No SMS provider configured.' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) return { ok: false, error: 'A send is already running. Try again in a few minutes.' };
  try {
    var text = testSmsText_();
    if (provider.name === 'quo') sendQuoMessage_(provider.key, provider.from, [to], text);
    else sendTelnyxMessage_(provider.key, provider.from, to, text);
    cache.put('smsTestSends', String(n + 1), 3600);
    console.log('Admin test SMS via ' + provider.name + ' to ' + maskPhone_(to) + ' (' + smsSegments_(text) + ' segment). List was not texted.');
    return { ok: true, toMasked: maskPhone_(to), segments: smsSegments_(text), provider: provider.name };
  } catch (e) {
    console.error('Admin test SMS failed: ' + e);
    return { ok: false, error: scrubNumbers_(e).slice(0, 300) };
  } finally {
    lock.releaseLock();
  }
}

function getScheduleSourceMode_() {
  var v = String(PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_SCHEDULE_SOURCE) || 'sheets').trim().toLowerCase();
  return v === 'sharepoint' ? 'sharepoint' : 'sheets';
}

function sharePointHostOk_(host) {
  host = String(host || '').toLowerCase();
  function ends(suf) { return host.length >= suf.length && host.slice(host.length - suf.length) === suf; }
  return host === 'sharepoint.com' || ends('.sharepoint.com') || host === '1drv.ms' ||
    host === 'onedrive.live.com' || ends('.onedrive.live.com');
}

function validateSharePointUrl_(url) {
  url = String(url || '').trim();
  if (!url) return { ok: false, error: 'Paste the SharePoint or OneDrive file link.' };
  if (!/^https:\/\//i.test(url)) return { ok: false, error: 'The link must start with https://' };
  if (url.length > 2000) return { ok: false, error: 'That link is too long.' };
  var host = '';
  try { host = url.split('/')[2].toLowerCase().split(':')[0]; } catch (e) {}
  if (!sharePointHostOk_(host)) return { ok: false, error: 'Use a sharepoint.com or 1drv.ms / onedrive.live.com file link that anyone with the link can view.' };
  return { ok: true, url: url };
}

function setScheduleSource_(source, sharepointUrl) {
  source = String(source || '').trim().toLowerCase() === 'sharepoint' ? 'sharepoint' : 'sheets';
  var p = PropertiesService.getScriptProperties();
  var url = String(sharepointUrl || '').trim();
  if (source === 'sharepoint' || url) {
    if (source === 'sharepoint' && !url) url = String(p.getProperty(CONFIG.PROP_SHAREPOINT_URL) || '').trim();
    if (url) {
      var v = validateSharePointUrl_(url);
      if (!v.ok) return v;
      url = v.url;
    }
  }
  if (source === 'sharepoint' && !url) return { ok: false, error: 'Paste the SharePoint workbook link first.' };
  var props = {};
  props[CONFIG.PROP_SCHEDULE_SOURCE] = source;
  if (url) props[CONFIG.PROP_SHAREPOINT_URL] = url;
  p.setProperties(props);
  var push = pushScheduleSourceMode_(source);
  var bridge = !!String(p.getProperty(CONFIG.PROP_FEED_CONFIG_TOKEN) || '').trim();
  var note = push.note;
  if (!push.pushed && bridge) note += ' The feed job can still read this on its next run if GitHub secret FEED_CONFIG_TOKEN matches this script.';
  if (!push.pushed && !bridge) note += ' Set FEED_CONFIG_TOKEN (script + GitHub secret) or GH_CONTENTS_TOKEN so the feed follows this switch. Until then it stays on rss/schedule-source.json (Google Sheets).';
  return {
    ok: true,
    source: source,
    sharepointConfigured: !!String(p.getProperty(CONFIG.PROP_SHAREPOINT_URL) || '').trim(),
    githubPushed: push.pushed,
    note: note
  };
}

/** Commits the mode only. The share link never goes into git. */
function pushScheduleSourceMode_(source) {
  var token = String(PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_GH_CONTENTS_TOKEN) || '').trim();
  if (!token) return { pushed: false, note: 'Saved on the script. GH_CONTENTS_TOKEN is not set, so GitHub was not updated.' };
  var headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'race-control-apps-script' };
  var current = { source: 'sheets', sheetId: CONFIG.SCHEDULE_SHEET_ID, sharepointUrl: '', adminScriptUrl: '' };
  var sha = '';
  var get = UrlFetchApp.fetch(CONFIG.GH_CONTENTS_API, { method: 'get', headers: headers, muteHttpExceptions: true });
  var code = get.getResponseCode();
  if (code === 200) {
    try {
      var body = JSON.parse(get.getContentText());
      sha = body.sha || '';
      var decoded = Utilities.newBlob(Utilities.base64Decode(String(body.content || '').replace(/\s/g, ''))).getDataAsString();
      var parsed = JSON.parse(decoded);
      if (parsed && typeof parsed === 'object') current = parsed;
    } catch (e) {}
  } else if (code !== 404) {
    return { pushed: false, note: 'Saved on the script. GitHub read failed (HTTP ' + code + ').' };
  }
  current.source = source;
  current.sharepointUrl = '';
  if (!current.sheetId) current.sheetId = CONFIG.SCHEDULE_SHEET_ID;
  var text = JSON.stringify(current, null, 2) + '\n';
  var payload = {
    message: 'Schedule source: ' + source,
    content: Utilities.base64Encode(text).replace(/\s/g, ''),
    branch: 'main'
  };
  if (sha) payload.sha = sha;
  var put = UrlFetchApp.fetch(CONFIG.GH_CONTENTS_API, {
    method: 'put', contentType: 'application/json', headers: headers,
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var pcode = put.getResponseCode();
  if (pcode === 200 || pcode === 201) return { pushed: true, note: 'Saved. Pushed the mode to rss/schedule-source.json. The share link stays in Script Properties only.' };
  if (pcode === 404) return { pushed: false, note: 'Saved on the script. GitHub returned HTTP 404. That usually means GH_CONTENTS_TOKEN cannot see mad1661/race-control (GitHub hides a private repo this way) or the token is not contents:write. rss/schedule-source.json has to be on main before an update; a missing file is created by this request. The share link was not written.' };
  return { pushed: false, note: 'Saved on the script. GitHub update failed (HTTP ' + pcode + ').' };
}

/** Feed job only. Token is FEED_CONFIG_TOKEN, not the admin PIN. */
function scheduleSourceForFeed_(token) {
  var p = PropertiesService.getScriptProperties();
  var real = String(p.getProperty(CONFIG.PROP_FEED_CONFIG_TOKEN) || '').trim();
  var given = String(token || '').trim();
  if (!real || given.length !== real.length) return { ok: false, error: 'Unauthorized' };
  var mismatch = 0;
  for (var i = 0; i < real.length; i++) mismatch |= real.charCodeAt(i) ^ given.charCodeAt(i);
  if (mismatch) return { ok: false, error: 'Unauthorized' };
  var mode = getScheduleSourceMode_();
  return {
    ok: true,
    source: mode,
    sharepointUrl: mode === 'sharepoint' ? String(p.getProperty(CONFIG.PROP_SHAREPOINT_URL) || '').trim() : ''
  };
}

/**
 * Web app (Deploy → Web app, Execute as: Me, Who has access: Anyone).
 *   ?email=… or ?phone=…        unsubscribe (unchanged)
 *   ?action=smsStatus           public JSON: enabled, phoneCount, cost, mode, pending, lastSms. No full phone numbers. No share link.
 *   ?action=setSmsEnabled&enabled=1|0&pin=…   PIN-gated toggle (GET fallback)
 *   action=setSmsMode|sendPending|sendTestSms|setScheduleSource|getScheduleSource + pin
 *   action=scheduleSourceForFeed&token=…      feed job only (FEED_CONFIG_TOKEN)
 *   action=optOuts + pin (POST preferred)     PIN-gated: full list of Quo opted-out numbers removed
 * doPost (text/plain JSON body) is what sms-admin.html uses, so the PIN is not put in a URL.
 */
function doGet(e) {
  e = e || { parameter: {} };
  var q = e.parameter || {};
  if (q.action) return handleSmsAction_(q);

  var email = q.email || '';
  var phone = q.phone || '';
  var ok = recordUnsubscribe_(email, phone, 'web');
  var msg = ok
    ? 'You’re unsubscribed from Race Control alerts.'
    : 'Provide ?email= or ?phone= to unsubscribe.';
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font-family:Arial,sans-serif;padding:32px;max-width:420px;margin:auto;color:#111">' +
    '<h1 style="font-size:22px">Race Control</h1><p>' + msg + '</p>' +
    '<p style="color:#666;font-size:13px"><a href="' + CONFIG.RACE_CONTROL_URL + '">Back to Race Control</a></p></body>'
  );
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  var q = {};
  Object.keys((e && e.parameter) || {}).forEach(function (k) { q[k] = e.parameter[k]; });
  Object.keys(body).forEach(function (k) { q[k] = body[k]; });
  return handleSmsAction_(q);
}

function handleSmsAction_(q) {
  var action = String(q.action || '');
  if (action === 'smsStatus' || action === 'smsConfig') return json_(smsStatus_());
  if (action === 'setSmsEnabled') {
    var check = checkAdminPin_(q.pin);
    if (!check.ok) return json_({ ok: false, error: check.error });
    var v = String(q.enabled).toLowerCase();
    var enabled = v === '1' || v === 'true' || v === 'on';
    setSmsEnabled_(enabled, 'admin page');
    var st = smsStatus_();
    st.ok = true;
    return json_(st);
  }
  if (action === 'optOuts') {  // PIN-gated: full opted-out numbers removed by the script
    var chk = checkAdminPin_(q.pin);
    if (!chk.ok) return json_({ ok: false, error: chk.error });
    return json_({ ok: true, optOuts: getOptOutLog_() });
  }
  if (action === 'setSmsMode') {
    var modeCheck = checkAdminPin_(q.pin);
    if (!modeCheck.ok) return json_({ ok: false, error: modeCheck.error });
    setSmsMode_(q.mode);
    var modeStatus = smsStatus_();
    modeStatus.ok = true;
    return json_(modeStatus);
  }
  if (action === 'sendPending') {
    var pendingCheck = checkAdminPin_(q.pin);
    if (!pendingCheck.ok) return json_({ ok: false, error: pendingCheck.error });
    return json_(sendPendingUpdate_());
  }
  if (action === 'sendTestSms') {
    return json_(sendAdminTestSms_(q.pin, q.phone));
  }
  if (action === 'setScheduleSource') {
    var srcCheck = checkAdminPin_(q.pin);
    if (!srcCheck.ok) return json_({ ok: false, error: srcCheck.error });
    var saved = setScheduleSource_(q.source, q.sharepointUrl);
    if (!saved.ok) return json_(saved);
    var srcStatus = smsStatus_();
    srcStatus.ok = true;
    srcStatus.githubPushed = !!saved.githubPushed;
    srcStatus.note = saved.note;
    return json_(srcStatus);
  }
  if (action === 'getScheduleSource') {
    var getSrc = checkAdminPin_(q.pin);
    if (!getSrc.ok) return json_({ ok: false, error: getSrc.error });
    return json_({
      ok: true,
      source: getScheduleSourceMode_(),
      sharepointUrl: String(PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_SHAREPOINT_URL) || '')
    });
  }
  if (action === 'scheduleSourceForFeed') return json_(scheduleSourceForFeed_(q.token));
  return json_({ ok: false, error: 'Unknown action' });
}

function smsStatus_() {
  var p = PropertiesService.getScriptProperties();
  var prov = getSmsProvider_();
  var count = smsPhoneCount_();
  var manual = isManualMode_();
  return {
    enabled: isSmsEnabled_(),
    updatedAt: p.getProperty(CONFIG.PROP_SMS_UPDATED_AT) || '',
    provider: prov ? prov.name : 'none',
    from: prov ? prov.from : '',
    sending: !!p.getProperty(CONFIG.PROP_QUEUE_GUID),
    blocked: p.getProperty(CONFIG.PROP_QUEUE_BLOCKED)
      ? { reason: p.getProperty(CONFIG.PROP_QUEUE_BLOCKED), since: p.getProperty(CONFIG.PROP_QUEUE_BLOCKED_SINCE) || '' }
      : null,
    phoneCount: count,
    lastSms: getLastSmsSummary_(),   // last blast health (counts only) or null
    mode: manual ? 'manual' : 'auto',
    pending: manual ? getSmsPending_() : null,
    alertPreview: scheduleAlertBody_(),
    cost: smsCostReport_(count),
    schedule: {
      source: getScheduleSourceMode_(),
      sharepointConfigured: !!String(p.getProperty(CONFIG.PROP_SHAREPOINT_URL) || '').trim(),
      feedTokenSet: !!String(p.getProperty(CONFIG.PROP_FEED_CONFIG_TOKEN) || '').trim(),
      contentsTokenSet: !!String(p.getProperty(CONFIG.PROP_GH_CONTENTS_TOKEN) || '').trim()
    },
    health: { issues: healthIssues_(), watchdogAt: p.getProperty('watchdogAt') || '',
      ghKickAt: p.getProperty('ghKickAt') || '', ghKickCode: p.getProperty('ghKickCode') || '' },
    note: 'Race Control schedule-change SMS master switch'
  };
}

/** Number of phones a send would text right now (active, de-duped, minus unsubscribed). Count only, never the numbers. null if the list can't be read. */
function smsPhoneCount_() {
  try {
    return getPhones_(getUnsubscribed_().phones).length;
  } catch (e) {
    console.warn('phoneCount failed: ' + e);
    try { return getFirestorePhones_().length; } catch (e2) { return null; }
  }
}

/** PIN check with a simple lockout: PIN_MAX_FAILS wrong tries per hour. */
function checkAdminPin_(pin) {
  var p = PropertiesService.getScriptProperties();
  var real = String(p.getProperty(CONFIG.PROP_SMS_ADMIN_PIN) || '').trim();
  if (!real) return { ok: false, error: 'SMS_ADMIN_PIN is not set in Script Properties.' };
  var cache = CacheService.getScriptCache();
  var fails = parseInt(cache.get('smsPinFails'), 10) || 0;
  if (fails >= CONFIG.PIN_MAX_FAILS) return { ok: false, error: 'Too many wrong PINs. Try again in an hour.' };
  if (String(pin || '').trim() !== real) {
    cache.put('smsPinFails', String(fails + 1), 3600);
    return { ok: false, error: 'Wrong PIN.' };
  }
  return { ok: true };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkFeedAndAlert') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkFeedAndAlert').timeBased().everyMinutes(5).create();
}

/** Optional: record the current feed item as "seen" without alerting anyone. */
function primeLastSeen() {
  var item = fetchLatestItem_();
  if (!item) return;
  PropertiesService.getScriptProperties().setProperties({ lastFeedGuid: item.id, lastFeedTitle: item.title, lastFeedTs: String(item.ts || 0) });
}

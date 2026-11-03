# Paste / deploy — Race Control ops (Nov 2026)

Do these in order. Nothing here contains `QUO_API_KEY` or `SMS_ADMIN_PIN`.

## 1. Apps Script (required for SMS copy, Manual send, dashboard, test text, source toggle)

1. Open the Race Control alerts project → **Code.gs** → select all → paste `apps-script-email-alerts/Code.gs` → **Save**.
2. `appsscript.json` is unchanged. No new OAuth scopes.
3. **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy.** The `/exec` URL stays the same.
4. Leave the 5-minute `checkFeedAndAlert` trigger alone. Do not run `sendTestSmsToList`.
5. Optional, once, in **Project Settings → Script properties** (not in git):
   - `QUO_SMS_COST_USD` — only if you want a rate other than `0.01` (Quo’s published API price for US/Canada SMS, per segment).
   - `FEED_CONFIG_TOKEN` — any long random string. Add the **same** value as a GitHub Actions secret named `FEED_CONFIG_TOKEN` on `mad1661/race-control`. That is what lets the feed job follow the Sheets / SharePoint switch. The share link stays in the script, not in git.
   - `GH_CONTENTS_TOKEN` — optional fine-grained PAT with **contents: write** on this repo. If set, saving the source on the dashboard also commits the mode to `rss/schedule-source.json`. It never writes the share link.
6. Check: open `https://script.google.com/macros/s/…/exec?action=smsStatus` (the existing URL). You should see `mode`, `cost`, `schedule`, and `alertPreview`. `alertPreview` must be the generic schedule sentence, not a class name. No full phone numbers.

## 2. Firebase hosting — admin page (required for the dashboard UI)

`sms-admin.html` and `sms-config.json` sit at the **repo root**, which is what `https://race-control-feed.web.app/sms-admin.html` serves.

Deploy those two files to Hosting **without** wiping `index.html`, `feed.xml`, or `days.json`. From a machine that already has Firebase login for `race-control-feed`:

```bash
# If Hosting’s public directory is this repo root:
firebase deploy --only hosting --project race-control-feed --non-interactive
```

If that command would publish a different folder, copy `sms-admin.html` onto the existing file at the site root instead. `sms-config.json` already has the public web-app URL. Do not put the PIN or API key in it.

Until the new Code.gs is deployed, the new page still shows ON/OFF from the old script. Cost, Manual, Send update, Text test, and SharePoint light up after step 1.

## 3. Public page (look + Sheets/SharePoint hook)

`index.html` is the only public page. Wix and Firebase must get the **same bytes**.

- Firebase: same hosting deploy as above (or the usual sync that already publishes `index.html` and `feed.xml`).
- Wix: paste this `index.html` into the Race Control HTML embed at https://www.nhraracer.com/racecontrol and Publish.

Also publish `schedule-meta.json` next to `feed.xml`. The feed job writes it. In SharePoint mode it also writes `schedule.json`. The sync that copies `feed.xml` to Firebase has to copy those too, or the public page stays on Google Sheets.

GitHub Pages is updated by `.github/workflows/feed.yml` on push.

## 4. What you do not re-run

- `setupTrigger`
- `setupQuoProps` (optional; still will not set the key or the PIN)
- A full-list test. Use **Text test** on the dashboard for one number.

## Behavior after paste

- Texts say: “There has been a change in the schedule.” plus the Race Control link and Reply STOP. They do not name the class.
- **Automatic** (default) matches today: next new feed item texts the list.
- **Manual**: the feed is still marked seen, nothing goes out until **Send update**. Manual → Automatic, and OFF → ON, do not send a backlog.
- Dashboard shows active count, estimated blast cost (`count × segments × rate`), and last-blast cost from sent × segments.
- **Google Sheets** stays the schedule source until someone picks SharePoint and the feed run succeeds.
- Opt-out pruning (Quo `0201400`) is unchanged.

## SharePoint workbook

- Share the `.xlsx` so **anyone with the link can view** (no Microsoft login). Graph is not used.
- Paste the file link (`….sharepoint.com/:x:/…` or a OneDrive `1drv.ms` link), not a folder.
- Same layout as the DRS sheet: tabs named `Day 1`, `Day 2`, … Column C scheduled time, D actual start, F class (`ELIMINATOR` header), G round, L note. A date like `Sunday, November 01, 2026` in column C above the header. Text-formatted times are the safest. Excel time/date cells are converted when the file is downloaded.
- If the download is not an xlsx, the feed run fails and **does not publish a diff** (Sheets is not silently substituted).
- The public page in SharePoint mode reads `schedule.json` from the feed job (about every 5–15 minutes), not a live 60-second refresh.

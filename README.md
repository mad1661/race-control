# Race Control · Run Order

Single-file page (`index.html`) that reads the public DRS run-order Google Sheet
(id `1D7r0i8yevR9bBOAEO9I34pqw5Iy8vqNzwSX0uDFbfr0`) through the gviz feed, plus an
RSS feed of run-order changes (`feed.xml`) built by `rss/generate.js`.

- `index.original.html` - Mark's original, kept verbatim for reference (not deployed).
- `index.html` - current page. Feed link is relative (`feed.xml`), so page and feed must be hosted together.
- `rss/generate.js` - Node 18+, no dependencies. Fetches all day tabs, diffs against `rss/state/snapshot.json`,
  appends plain-English items to `rss/state/items.json` (last 50) and rewrites `feed.xml` only when something changed.
  If any tab fails to fetch or parse, it exits 1 and changes nothing (no false "removed" items).
- `rss/config.json` - sheet tabs, page/feed URLs, summarize threshold, ntfy settings (off).
- `rss/test/simulate.sh` - live test in a temp dir: two runs, fake edits, third run, XML check.
- `.github/workflows/feed.yml` - every-5-minute GitHub Actions job: run generator, commit state, deploy to GitHub Pages.

No secrets anywhere: the sheet is public and the job uses only the built-in `GITHUB_TOKEN`.

## Turn it on (GitHub Pages + Actions, free)
1. Create a **public** repo `mad1661/race-control` (public = unlimited free Actions minutes and free Pages).
2. Push this folder's contents (excluding `index.original.html` if you prefer) to `main`.
   Pushing `.github/workflows/` needs a token with `workflow` scope (`gh auth refresh -s workflow`) or add the file in the GitHub web UI.
3. Repo Settings -> Pages -> Source: **GitHub Actions**.
4. Actions tab -> "Run order feed" -> Run workflow (or the push triggers it).
5. Page: https://mad1661.github.io/race-control/  Feed: https://mad1661.github.io/race-control/feed.xml
   If the repo name/owner differs, update `pageUrl`/`feedUrl` in `rss/config.json`.

Notes: GitHub cron is best-effort (often 5-15 min late under load). GitHub disables scheduled workflows in
public repos after 60 days with no repo activity; re-enable from the Actions tab before the next event.

## Phone push (optional, free): ntfy.sh
Set `ntfy.enabled` to `true` in `rss/config.json`. Subscribers install the free ntfy app and subscribe to the
topic in `ntfy.topic`. Anyone who knows the topic can read it (and could post to it), so treat it as public.

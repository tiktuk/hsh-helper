# AGENTS.md

Chrome extension (Manifest V3) that makes the guide availability grid on
`hsh.gomus.de/guide/availables` usable: one click marks a whole 90-minute tour
block instead of 18 five-minute cells. `README.md` describes it for the user;
this file is for working on it.

## Layout

- `extension/manifest.json` – MV3, content script on `https://hsh.gomus.de/guide/*`, `storage` permission only.
- `extension/content/content.js` – everything that runs on the page: grid model, block view, writes, panel UI, month invoice.
- `extension/content/ical.js` – the iCal reader for the calendar feed (see Calendar feed). Loaded before `content.js`, same isolated world, exposes one global `TAH_ICAL`.
- `extension/content/stats.js` – the statistics tab (see Statistics). Loaded after `content.js`, exposes one global `TAH_STATS` and takes its page helpers from `window.TAH_PAGE`.
- `extension/content/stats.css` – the stats view and the sidebar entry.
- `extension/vendor/chart.umd.min.js` – Chart.js 4.4.7 UMD, vendored unchanged (see Statistics).
- `extension/assets/bike.jpg` – the guide's cargo e-bike, shown in the statistics card (see Statistics).
- `extension/popup/` – settings (block length, preset times, working-hours window); links to the settings page.
- `extension/options/` – invoice letterhead (sender, recipient, Steuernummer, bank, texts, signature, number range), the list of iCal feed addresses, the statistics assumptions and the bike photo.
- `extension/background.js` – service worker; opens the invoice tab (`chrome.tabs.create`) and fetches the calendar feed (see Calendar feed).
- `extension/invoice/` – the printable invoice page (`chrome-extension://` URL): rows from `chrome.storage.local`, letter from the settings.
- `tools/dev-inject.js` – loads the content script into an already-open page (see Verification).
- `tools/stats-harness.html` – opens the stats view with mock bookings, without login or extension (see Statistics).
- `tools/grid-harness.html` – a stand-in availability grid for the block view, without login (see Verification).
- `tools/make_icons.py` – regenerates `extension/icons/*.png`.

No build step, no dependencies, no test runner. Plain JS, loaded unpacked.

## Verification

There is no automated test suite. Verify against the real page, in this order:

1. `chrome://extensions` → reload the extension (content scripts are cached until then). The
   reload button can be clicked from Playwright with
   `page.locator('#dev-reload-button').first().evaluate((el) => el.click())` – a normal
   `click()` fails the visibility check on `chrome://` pages.
2. Open `https://hsh.gomus.de/guide/availables?start_at=<next monday>` and exercise the change.
3. Assert on `td.timestampbutton` classes (`not_set`, `available_no_bookings`,
   `not_available_no_bookings`, `available_with_bookings`, `not_available_with_bookings`), and on
   the cell markup – a cell must contain an `<i>` and its `textContent` must be empty. Visible
   `<` or `\` in a cell means the response parsing broke again.
4. Reload the page and re-check: the server is the source of truth, the DOM is not.
5. Undo/restore everything you changed. This is live availability data for a real guide, on days
   that may already have bookings.

Faster iteration without reloading the extension: run `tools/dev-inject.js` through the Playwright
MCP tool `browser_run_code_unsafe`. It stubs `chrome.storage`, then injects the CSS and script.
Note it cannot run twice in one page (top-level `const` redeclaration), so reload first.

`tools/dev-inject.js` also stubs `chrome.storage.local` and `chrome.runtime.sendMessage`, capturing
writes on `window.__tahLocal` / `window.__tahSync`, so the whole invoice flow can be exercised on
the live calendar page without installing anything (it only issues GETs). The feed stub answers
`window.__tahIcalTexts[url]` (falling back to `window.__tahIcalText`), so several calendars can be
faked at once; set `window.__tahLocal.icalFeeds` before injecting.

The block view and the calendar overlay need no login either: serve the repo root
(`python3 -m http.server 8817`), open `tools/grid-harness.html`, seed `window.__tahLocal` /
`window.__tahIcalTexts`, then run `tools/dev-inject.js`. The stand-in grid is the same 288 × 7
markup, so `readGrid()`, the block view, the chips and the tooltips all run for real. Use it for
layout and calendar changes; writes and the site's own response parsing still need the live page.

The statistics view needs no login at all: `tools/stats-harness.html` (served from the repo root,
`python3 -m http.server 8817`) runs the real `stats.js` and `stats.css` against mock bookings and a
stubbed `chrome.storage`. Use it for layout, chart and forecast changes; only the data source
(`fetchMonthBookings` / `enrichBooking`) needs the live site.

Loading the unpacked extension into a Playwright-launched Chrome does not work – Chrome refuses
`--load-extension` under automation. Test the popup, `options/options.html` and `invoice/invoice.html`
by serving the repo root over HTTP with a stubbed `chrome.storage` (`addInitScript`; the options page
also needs `local.remove`, the invoice page `local.get({ invoice, signature })`). For print layout use
`browser_emulate_media { media: "print" }` — `Page.printToPDF` is not reachable through the MCP
sandbox, so assert on computed styles (`display`, `breakBefore`) instead. Chrome's heuristic caching
of those files is aggressive; call `Network.clearBrowserCache` before believing a CSS/JS change.

## How the site works (learned the hard way)

- The grid is `table.available-table`, 288 rows × 7 day columns. Each cell is
  `td.timestampbutton.available-table-cell` with `data-timestamp` (unix seconds) and `id="avail_<ts>"`.
  Row order is chronological; column order follows the `thead` day headers.
- Clicking a cell toggles `not_set → available → not_available → not_set` (three states, not two).
  Booked cells carry their own `*_with_bookings` states.
- One POST per cell to `/guide/availables/toggle_available_date` with `form_update_td_id=<ts>` and
  the CSRF token from `meta[name=csrf-token]`. The response is JavaScript containing
  `$('#avail_<ts>').replaceWith('...')`; the payload is a **single-quoted JS string with escaped
  quotes and `\/`**, so unescape it properly before parsing (`unescapeJsString`) – handling only
  `\'` leaves `<\/i>` in the DOM and renders markup as text.
- The extension mutates the existing `<td>` in place (`className` + `innerHTML`) instead of
  replacing it, because the site binds its click handler directly to each cell element.
- The site's own bulk endpoint (`/guide/availables/generate_available_dates.23`) answers `422` even
  from its own modal, so it is unusable. Do not build on it.
- Write in parallel but modestly (8 concurrent); ~26 ms per request, so 126 cells ≈ 2–3 s.
- Cells without the `clickable` class are in the past and silently ignore writes – filter them and
  report the count instead of pretending the block was applied.
- Day headers: the `thead th` also contains a hidden dropdown ("Kernzeit auf verfügbar setzen"), so
  `th.innerText` returns that menu too. Read `th.querySelector('small')` instead.

## Views

The default view replaces the site's table with `#tah-block-view`: one row per preset start time,
one cell per day, each cell aggregating the 18 underlying five-minute cells (`summarize()` returns
`available` / `unavailable` / `not_set` / `mixed`, plus `readOnly` when none of those cells is
`clickable` any more). A block that is entirely in the past is still drawn from its cells — the site
colours them in the five-minute view too — but `readOnly` means no click handler, no day-head
buttons and a dimmed cell. Do not go back to painting such a block `past`: a finished week then
looks empty, which reads as "my availability is gone" (the user hit exactly that). `past` survives
only for a block with no cells at all, i.e. a preset whose time is missing from the grid. Clicking
a cell toggles the whole block between available and not set. The day headers carry a ✓/✗ pair (`dayHeadNode`) that sets the whole
day – restricted to the working-hours range (`dayCells`) – and clears it again when the matching
button is already active; the row headers carry the same pair (`rowHeadNode`) for the other axis,
setting that block on every day of the week — or only Monday to Friday while
`chrome.storage.sync.weekdaysOnly` is on, which is the default (the **nur Mo–Fr (Zeilen ✓/✗)**
checkbox in the panel switches it off). It is a row-button setting only: `dayHeadNode`, Alt+Klick,
Shift+Klick and plain clicks must stay unaffected by it. The filter is by column weekday
(`weekdayOf(dateKey)`), so the row button's own state also only looks at those days. The original table stays in the DOM (just `display: none`), so the
grid model, writes, undo and Shift/Alt selection all keep working unchanged – any write must call
`refreshBlockView()` afterwards, and `applyView()` is the single place that swaps the two tables.

The panel (`buildPanel`) is deliberately thin: title, an `Ansicht` row, a `Filter` row with the
`nur Mo–Fr (Zeilen ✓/✗)` and working-hours checkboxes (both left-aligned under the segmented
control, not pushed to the edges), one `Woche` row with the week-fill button, hint and status line.
It has no start-time, duration or day-picker inputs — the block length and the row times are the
settings (`chrome.storage.sync.duration` / `presets`), so there is exactly one place to change them
(the popup). Do not reintroduce `#tah-duration` / `#tah-start` lookups in the view code; read
`state.settings` instead.

**Ganze Woche verfügbar** (`openWeekFillDialog` → `weekFillPlan` → `applyToCells`) fills the empty
blocks of the week. It is a planner plus the ordinary write path, not a new writer: it collects the
cells, `applyToCells` does the toggling, progress, undo and status (with an optional fourth `note`
argument for what a bulk action left alone — keep that note in the status line, the undo button has
to stay next to the count). The rules the plan encodes:

- Only `not_set` blocks are filled. `unavailable` **and** `mixed` blocks are skipped, so the busy
  part of a partially available block survives; a whole-week fill must never clear a "nicht
  verfügbar". `readOnly` blocks and blocks without cells count as skipped (past), like everywhere.
- A block is skipped when any *selected* calendar has an entry overlapping it (`feedClash`), read
  from each feed's own `days` map rather than the merged one — a calendar hidden from the view can
  still be respected. All-day entries span 0–1440 and therefore block the whole day; that is
  deliberately different from the stripes, which ignore them.
- The weekend is included only when the dialog's checkbox is on, and it defaults to
  `!weekdaysOnly`, i.e. off, matching the row buttons.
- Rows hidden by the working-hours filter (`hideOutside`) are not filled either — same overlap test
  as `applyRowVisibility`, so the fill never writes a row the user cannot see.
- Adjacent preset rows share five-minute cells (13:55–15:25 and 14:55–16:25 overlap by half an
  hour), so the plan dedupes by cell id; without that, `plan.blocks × 18` and the number of writes
  disagree and cells are toggled twice.
- The dialog is `#tah-week-dialog` on `document.body` (fixed, z-index 100, above the sticky panel),
  with the calendars that have loaded, the weekend switch and a live count; **Verfügbar setzen** is
  disabled when there is nothing to set. Escape and a backdrop click close it without writing, and
  the plan is recomputed at click time, so what the summary promised is what gets written.


## Calendar feed

The guide's own calendars (personal `.ics` URLs, several of them) are overlaid on the block view;
the extension only ever reads them. Three pieces:

- `content/ical.js` parses a feed: dependency-free RFC 5545 subset — unfolding, `VEVENT`,
  `DTSTART`/`DTEND`/`DURATION`, `VALUE=DATE`, `TZID`/`Z`, `EXDATE`, `RECURRENCE-ID` overrides, and
  `RRULE` with FREQ/INTERVAL/BYDAY/COUNT/UNTIL. `VTIMEZONE` is ignored because `Intl.DateTimeFormat`
  gives the offset for any IANA zone; occurrences are generated in the feed's *wall clock* and
  converted per instance, which is what keeps a 10:00 tour at 10:00 across a DST change. BYSETPOS
  and BYMONTHDAY are not implemented. `TAH_ICAL.eventsByDay(text, dayKeys)` returns
  `{ 'YYYY-MM-DD': [{ start, end, allDay, title }] }` — minutes from local midnight, multi-day timed
  events clipped per day, all-day entries spanning 0–1440. It knows nothing about *which* feed a
  text came from; merging is `content.js`'s job.
- `background.js` fetches one address (`tah-fetch-ical`). That hop is not optional: a content-script
  `fetch` is a cross-origin request from `hsh.gomus.de` and dies on CORS, while a service-worker
  fetch with a host permission does not. The origins are granted at runtime from the options page
  (`chrome.permissions.request` + `optional_host_permissions` in the manifest) because the URLs are
  user-supplied — all feeds go into **one** request call, which must be the first thing the click
  handler does, since an `await` before it can consume the user gesture.
- `content.js` caches each text in `chrome.storage.local.icalCache`, a map keyed by address
  (15 min TTL per feed), and renders.

Providers hand the same feed out under three schemes: `https://` (Google and most), `webcal://`
(Apple) and `webdav://` / `webdavs://` (WebDAV servers, e.g. Nextcloud, mailbox.org). The stored
address keeps whatever was pasted; the scheme is rewritten to `http(s)://` only at fetch time
(`feedCandidates()` in `background.js`). `webcal://` and `webdavs://` mean TLS; plain `webdav://` is
ambiguous (davfs2 means HTTP, calendar apps mean TLS), so it is tried over `https` first and `http`
second, and `originPatterns()` in `options.js` requests both origins so the second attempt is not
killed by a missing permission. Do not "clean up" a URL on save: rewriting it in storage would break
the user's link for other clients and change the `icalCache` key.

Storage shape — `chrome.storage.local`, never sync:

- `icalFeeds`: `[{ id, url, label, color, on }]`. `label` empty means "use the server name"
  (`feedTitle()`), `color` empty means "take the palette colour by position" (`FEED_COLORS`, mirrored
  in `options.js`), `on` is the per-calendar switch. `readFeedList()` still falls back to the old
  single `icalUrl` key, and `options.js` deletes that key once the list is saved; keep both paths
  until no installed copy can be that old.
- `icalCache`: `{ [url]: { text, fetchedAt } }`, with `cacheMap()` upgrading the old single-entry
  shape. It is written **once per load** by `saveCalendarCache()` — a write per feed would have each
  parallel fetch save the map as it looked before the others answered and drop their entries. The
  same call prunes addresses that are no longer configured, because every feed's text counts against
  the shared 10 MB local quota. Calendars that are merely switched off keep their copy.
- `icalOn`: the master switch. Off means no bar and no overlay at all.

Fetching is `Promise.all` over the enabled feeds, each in its own `try`/`catch` (`loadFeed`), then
`mergeCalendarDays()` concatenates the day maps, sorts each day by start, and stamps `feed` (the
title) and `color` onto every entry. A feed's name only appears in tooltips while more than one
calendar is enabled — with a single feed it is noise. A failing feed keeps its last good text and is
marked with `error` (stale text, `(Stand HH:MM)` in the chip's tooltip); one dead calendar must never
blank the others, which is what the old single-feed code did.

Changes to `icalFeeds` / `icalOn` arrive through `storage.onChanged` and go through
`loadCalendarSettings()` (which keeps a feed's already-fetched days, but only while its URL is
unchanged) and `loadCalendar(false)` — not a forced reload, the cache answers for the feeds that did
not change.

Rendering is deliberately minimal — **no event text in the grid**. A block that overlaps a timed
event gets `tah-block-conflict`, an inset stripe in that feed's colour (`--tah-feed`, set on the
cell; the earliest clash wins, the tooltip names them all), and the event's time and title in the
cell's `title`; the day header carries the whole day's list in its own `title`. All-day entries never
stripe, because one "Urlaub" would mark the entire week, so the header tooltip is the only place
they appear. The visible extra is `tah-cal-bar` above the table: one `tah-cal-chip` per calendar
(dot in the feed colour, `aria-pressed`, dashed and hollow when hidden) which toggles that feed and
writes the choice back to `icalFeeds`, then the week's count, then the error — either the message
itself (one feed) or "N Kalender nicht erreichbar" with the details in the `title` — and the
**Aktualisieren** / **Erneut** link. The chips are inside `#tah-block-view`, so a re-render
(`refreshBlockView()`) replaces them; toggling only re-merges, it never refetches.


## Invoices

The calendar page (`/guide/calendar?start_at=YYYY-MM-01`) gets a **Rechnung**
button in the month header; the panel is prefilled from the `legend` ("November
2026"), not from the URL, because the header is re-rendered by the site's own
month links. Month navigation is a full page load, so re-mounting is enough.

Data comes from the bookings list, not the calendar grid:

- `GET /guide/bookings?start_at=<month>-01&end_at=<next month>-01&per_page=200&status[]=20&status[]=25&status[]=50&guide_status_types[]=11&guide_status_types[]=15&guide_status_types[]=20&guide_status_types[]=30&guide_status_types[]=500`
  – `status[]` 20/25/50 are Gebucht, Abgeschlossen and Storniert; the guide
  statuses include Unbestätigt, because past shifts count even when the guide
  never confirmed them. **30 (Guidewechsel/Storno) is mandatory**: cancelled and
  completed bookings lose their guide assignment, so without it they are missing
  from the response entirely — the filter defaults in the UI hide them the same
  way. Note `guide_status_types` must be repeated per value; a comma-joined
  single param returns nothing. 200 covers a month (the site defaults to 25).
- `end_at` is **inclusive of that whole day**, so `<next month>-01` also returns the bookings of
  the 1st of the following month. `fetchMonthBookings()` drops rows whose `date` does not start
  with the requested month; without that, April 2026 billed the two 1 May tours that the May
  invoice lists again.
- Each `tr.booking-list-item` carries `id="booking<id>"`; the date group sits in
  the preceding `tr.sticky-top` ("1. November 2026"), the time and the duration
  (105 minutes) in the "Datum: … Uhr / Dauer: …" cell. The booking status badge
  ("Gebucht" / "storniert") is the first badge of the second cell. Do not read the
  row's `canceled` class: every row has it, booked ones additionally `no-costs`.
- The price is **not** in the list. It is the `td.price` of the "Abrechnung" box
  on `/guide/bookings/<id>` (Honorar `97,50 €`, Ausfallhonorar `49,00 €` for a
  group cancellation), one detail request per booking. The customer is the `dd`
  of the "Kundendaten" box; it is empty for public tours, so fall back to the
  `Gruppenbezeichnung` in `.booking-comment` (that block also holds other lines)
  and then to the tour title.
- The Abrechnung box is also the billability test: it is empty when the guide
  cancelled, or when the guide was moved off a booking that is still Gebucht
  (a reassignment, e.g. `48577`). `loadInvoiceRows()` drops rows with no amount
  and reports the count, so a group cancellation (49 €) stays in and an
  assignment the guide did not do does not. Every future booking already carries
  its Honorar, so a missing amount really means "not billable".
- The panel previews the month (count, sum, number) as soon as it opens and
  whenever the month changes: `previewInvoice()` loads the rows and shows
  `peekInvoiceNumber()`, which must not claim a number. Only **Rechnung
  erstellen** calls `assignInvoiceNumber()` and writes the number map; it reuses
  the rows the preview already loaded, so the invoice matches what was on screen.
- Numbers live in `chrome.storage.sync.invoiceNumbers` (`{ '2026-11': 'RE-2026-100' }`),
  assigned from `invoiceStart` + `invoicePrefix` and reused for the same month.
  Only trailing digits count when finding the highest number, since prefixes
  contain digits too.
- The payload is written to `chrome.storage.local.invoice`; `background.js`
  opens `invoice/invoice.html`, which reads it and draws the letter from the
  settings (`chrome.storage.sync`, defaults in `invoice.js` mirroring
  `options/options.js`). It cannot be opened from
  the page directly (`chrome-extension://` URLs are blocked for web content).
  The worker opens it with `sender.tab.windowId` and `active: true`; without
  that Chrome picks the focused window and the tab shows up somewhere else.
  A failed `tabs.create` is reported back and surfaced, never swallowed.
- The letter mirrors the paper invoices the guide actually sends: sender and
  recipient blocks, `Rechnung <Nummer>`, `Honorar für <Monat>`, Steuernummer,
  greeting, intro, the two assurance clauses, bank details, closing, signature —
  then the services table (`Buchung | Datum | von | bis | Angebotstitel | Kunde |
  Honorar`, `bis` computed from the duration) on a second page
  (`page-break-before`). Empty settings are skipped, not printed as blanks. If no
  sender name is set the invoice falls back to the payload's `guide` and shows a
  screen-only warning bar; the warning is `display: none` in print.
- Settings that describe the person (sender, tax number, bank, texts) are
  `chrome.storage.sync`. The signature image is **local only** —
  `chrome.storage.local.signature` as a data URL, shrunk to 800 px wide on
  upload — because it blows past the 8 KB per-item sync quota.
- A month without bookings keeps **Rechnung erstellen** disabled and says so in
  the panel, instead of failing after the click. The button is also disabled
  while a preview loads, so a click cannot race the preview.

## Statistics

A seventh sidebar entry (**Statistik**, `Alt+S`) opens `#tah-stats`: a fixed
view over the content area, not a separate page. The site's sidebar and top bar
stay visible and clickable, which is what makes it read as a tab of the booking
system. `position()` measures the sidebar's right edge and the top bar's height
on every open/resize; a `MutationObserver` on `body.class` follows the rail's
collapse toggle. The panel is inserted into `document.body`, so no page layout
rule can clip it.

`stats.js` is an IIFE that returns `TAH_STATS = { installNav, open, close,
toggle }`. `installShortcuts()` calls `installNav()` **before** `annotateNav()`,
so the tab takes part in the Alt+1…9 order (it lands before the help link).
`content.js` exposes its helpers as `window.TAH_PAGE` — do not reach into its
top-level names from stats.js: both files share one isolated world, so a
top-level `const` with the same name is a redeclaration error that kills the
whole script.

Data is the same two sources the invoice uses, only wider:

- `fetchMonthBookings(month)` per month in the range (12 requests for a year),
  then `enrichBooking(row)` per booking for the price. A year is a few hundred
  detail requests on the first look — that is why the view loads month by month,
  shows progress, and caches.
- `chrome.storage.local.statsMonths` – list rows per month, 2 h TTL.
  `chrome.storage.local.bookingDetails` – price/fee/offer/category/participants
  per booking id, 7 days TTL, refetched when the row's cancellation status
  changed, pruned after 400 days. **↻** forces both. Switching periods after the
  first load issues no requests.
- Only rows with `price > 0` count as work, exactly like the invoice: a group
  cancellation brings its Ausfallhonorar, a guide cancellation or reassignment
  has no amount.
- Who cancelled is **not** written anywhere readable: a group cancellation and a
  guide cancellation both show "Die Buchung wurde storniert" and "Dein Status:
  Es wurde ein Guidewechsel durchgeführt" in the Hinweise (checked against the
  live detail pages). The Ausfallhonorar is the only difference — the group pays
  one, the guide's cancellation leaves the Abrechnung box empty. `aggregate()`
  therefore splits `cancelled && price > 0` (Kundschaft) from
  `cancelled && price <= 0` (durch dich), and keeps `!cancelled && price <= 0`
  (Guidewechsel) apart: the guide did not cancel that one, the museum moved it.
  Do not "improve" this by reading the Hinweise.

`enrichBooking` also fills `offer` (`Angebot`), `category`
(`Angebotskategorie`) and `participants` (`Teilnehmende`) from the detail page's
`<dt>/<dd>` pairs. `row.tour` is left alone — it is the list's group label and
the invoice prints it. `fetchMonthBookings` throws "Nicht angemeldet" when the
response contains a password field, because a logged-out session redirects to the
login form and still answers `200`.

**Noch ausstehend** (`pendingCard`) is the one figure that is not about the
period on screen: it sums every billable, non-cancelled booking from now to the
end of a twelve-month horizon (`PENDING_MONTHS` → `pendingRange()`), whatever
year is selected. Group cancellations are excluded — their Ausfallhonorar is
income, but not a tour that is going to happen — and the start *time* is
compared, so this morning's tour is earned, not pending, by the evening.
`loadPending()` runs **after** the period load, never in parallel: both read and
write the same `statsMonths` map and two writers would each save it as it looked
before the other answered. It runs once per open (↻ forces it) and fills in only
its own card (`renderPending()` swaps `#tah-pending`), so the charts underneath
are not rebuilt under the reader. `close()` bumps `view.pendingToken`;
`loadBookings()`'s `isStale` predicate watches it per month and per detail
request, so a closed view stops spending requests. `loadBookings()` takes an
explicit `months` list and that `isStale` callback for exactly this — the pending
load reuses the same month and detail caches.

The card shares a row with the forecast (`pipelineRow`, `.tah-pipeline`: two
equal columns, one below 900 px), and the row exists **only in the year view**,
next to a forecast that is itself about a whole year. A week or month view has
neither, which is also why `loadPending()` returns unless the period is `year`:
nothing would be drawn, so nothing should be fetched.

**Jahresübersicht** (`#tah-yearstrip`) is the one figure that is not about the
period: a row of 365/366 squares in the sticky header, one per day of the
anchor's year. Colour is the number of billable tours that day (`tah-day-n0…n4`,
four and more share the darkest); a red bar along the bottom edge means at least
one Absage by the group, an amber bar along the top edge one by the guide (a day
can carry both — borders, not `box-shadow`, or the second rule would overwrite
the first), and a dark tick under the row marks today. Tours count only with
`price > 0`, exactly like the KPIs; a cancelled row without an amount paints the
amber bar and is not a tour. The squares are a few pixels wide because
366 days have to fit one row; below ~1100 px the row scrolls horizontally
(`minmax(2px, 1fr)` columns). Hovering shows a tooltip with the day's tours, its
income, its Ausfallhonorar and its own cancellations — `position: fixed`, because
the row is a scroll container and an absolute tooltip would be clipped; Escape
closes it before it closes the view.
Clicking a square opens that day's week and a month cell that month, which is
what the optional `anchor` on `setPeriod(period, anchor)` is for (the segmented
control still starts at today). The band under the row marks the period on
screen and is hidden in the year view, where it would span the whole row.

The row under the squares (`#tah-strip-months`, `monthStats()`) is the same year
one step coarser: one cell per month, in a grid with the squares' column
template, spanning its own days. It replaced the plain month labels — the month
name lives in the cell, because the cell carries the figures anyway: the income
(tours plus Ausfallhonorar, exactly `aggregate()`'s `income`), the number of
tours on the right of the name, and the same `tah-day-n0…n4` fill as the squares,
so the strip stays one heatmap. The level is the month's income within the
year's own range — the weakest month on the year gets the lightest fill, the best
the darkest — and **not** its share of zero: a steady year would otherwise be
twelve identical squares, and the row answers "which months carried the year".
A month without a booking is `n0` with a dash, never "0 €", and a year that has
not answered yet says "…" (`loaded` on each stat). Hovering opens the same
tooltip with the month's income, tours, workdays and cancellations; clicking
opens the month. Both `view.stripMonths` (the 12 stats, keyed by `YYYY-MM`) and
`view.stripNodes` are rebuilt by `renderStrip()`, and the tooltip reads the map
rather than recomputing, so it can never disagree with the cell it sits on.

**Einnahmen je Tag** (`#tah-heat`, `heatCard`) is the year as a calendar, in the
body and in the year view only — next to the pipeline row, before the workload
block. The strip above draws the same year as one row of 366 squares; this card is
the one you read, so it has 7 weekday rows × 53/54 week columns, month labels over
their own columns, and a **Weniger … Mehr** legend. The grid starts on the Monday
of the week that holds 1 January and ends on the Sunday of the week that holds 31
December, so the first and last column carry days of the neighbouring years; those
are `tah-heat-pad` and are not drawn at all. A leap year that starts on a Sunday
needs 54 columns (2012), which still fits.

The fill is the day's **income**, not its tour count (the strip already counts
tours): `heatIncome()` = the tours' Honorar plus the Ausfallhonorar of the group's
cancellations, exactly `aggregate()`'s `income`. It uses the strip's own ramp
(`tah-day-n0…n4`) and the month row's rule — `heatScale()` takes the min and max of
the year's earning days and `heatLevel()` spreads 1…4 over that span, so a steady
year does not collapse into one step. Cancellation bars keep their meaning at 2 px
(a 16/17 px square is not a 6 px one), and today gets a ring.

The card is drawn from `view.data.bookings` through `stripDays()` — **not** from
`view.strip`, which `useStripFromData()` only fills *after* `render()`. Its day map
is kept as `view.heat` and `showStripTip()` reads it first (`stripEntry()`), so a
cell never says "lädt …" while the header strip is still loading; `load()` and
`close()` clear `view.heat` so a period change cannot leave the strip's tooltip
answering from a stale year. The tooltip is the strip's own, so the lines, the
Escape handling and the "Klick öffnet die Woche" hint are not duplicated. A click
on a square opens that day's week, a click on a month label opens the month.

The grid is a fixed `--heat-cell: 17px` (53 columns = 1057 px, 54 = 1077 px, inside
the 1106 px the card has at full width); narrower windows scroll it sideways.
Month labels, weekday labels and the squares are one inner grid, which is what
keeps the labels over their own columns and rows — the price is that the weekday
labels scroll with the weeks. Do not put a `background` on `.tah-heat-cell`: it
would win over the shared `tah-day-n0…n4` ramp and every square would come out the
same pale grey.

The year view already holds its year, so the strip is derived from
`view.data.bookings` (`useStripFromData`) and costs nothing. Every other period
loads the year through `loadBookings` in `loadYearStrip()`, **after** the period
load and never beside it — both write `statsMonths` — keeping the squares of the
year already drawn while it reloads. That is a year of detail pages the first
time a week or month is opened: the same first-look cost as the year view, and
the caches make every later look free. `view.stripToken` stops the load on close
or a period change, and `loadBookings()` no longer writes its caches once
`isStale()` is true, so an abandoned year cannot overwrite a newer one.

The forecast (year view only, like the pending card next to it) cuts the year
into weeks. Completed whole weeks inside the year give the median weekly income;
each remaining week is estimated at `max(booked in that week, median × remaining
fraction)`, the band uses the same weeks' p25/p75, and fewer than three completed
weeks fall back to the year's daily average. The cumulative chart's current-month
point is the actual income; the dashed line starts there. A past year shows only
"abgeschlossen", a future year only "geplant" — no forecast is invented for
either.

The commute and pause figures (`workload()`) answer what an hour is really worth
once the day is spent at the museum, not just during the tour. A workday is one
date with at least one billable tour; it runs from the first start to the last
end, so a split shift is paid per tour but spent per day. `commuteKm` is one way
and ridden twice per workday at `commuteSpeed` (the guide stays on site between
two tours); `prepMinutes` is added once per workday. The six assumptions
(`commuteKm`, `commuteSpeed`, `prepMinutes`, `gapLimit`, `bikeWhPerKm`,
`electricityPrice`) live in `chrome.storage.sync` and are edited on the **options
page**, not in the view: the view only prints them under the bike photo, and
`chrome.storage.onChanged` reloads them while it is open. The effective rate is
`income / (span + commute + prep)`; the paid rate is `income / tour minutes`, and
`lost` prices the pauses at the paid rate. Electricity is
`kmTotal × bikeWhPerKm / 1000` kWh at `electricityPrice`, i.e. at the socket,
including charging losses, not the battery's nominal capacity. A day is
*efficient* when its pause is at most `gapLimit` minutes, *medium* up to twice
that, *long* beyond; the KPI grid reports the counts — eight equal cards, four
per row, because a three-card row over a four-card row reads as two tables — and
the workload chart stacks work, pause and commute per bucket. A day's `gap` is
the sum of its pauses, which is what *Wartezeit*, *Ø Pause je Arbeitstag* and
*Längste Wartezeit an einem Tag* (`longestDay`) print; **Längste Pause** is
`longest`, one `breaks` entry — the longest single stretch between two tours,
with its own window. A day's `gap` may only be printed next to its first and
last tour when the label says it is the day's total: three tours make 1,8 h out
of a 09:55–17:00 day, and labelled "Längste Pause" that read as one seven-hour
hole. The **bike card** in the right column
of that block holds the photo, the period's kilometres and kWh/€ under it, and
the assumptions it was calculated from. It is read-only: the settings have one
place, the options page, and the view must not grow a second one.
`buildStats` keeps the raw `bookings` so `recompute()` can redraw after a
settings change without refetching detail pages.

The bike photo is `assets/bike.jpg`, bundled and listed in
`web_accessible_resources` because the page loads it through an `<img>` in the
content script's DOM. A custom photo is `chrome.storage.local.bikePhoto` (data
URL, 800 px wide JPEG, written by the options page like the invoice signature);
the view falls back to the bundled file when it is missing or broken. It is only
displayed in the dashboard card, never uploaded anywhere. `tools/stats-harness.html`
stubs `sync`, `local` and `runtime.getURL`, otherwise the card would show
defaults and no bike.

Chart.js is **vendored** in `vendor/` and loaded as a content script on every
guide page (~206 KB, ~10 ms). That is the one deliberate exception to
"dependency-free": the user asked for a real charting library, and MV3 may not
load one from a CDN. Do not switch to a remote `<script>`, and do not move the
library into the page's main world.

`tools/stats-harness.html` renders the view from mock bookings without a login:
serve the repo root (`python3 -m http.server 8817`) and open
`/tools/stats-harness.html`. It stubs `chrome.storage` and `TAH_PAGE`, so it
exercises the real `stats.js` and `stats.css`; keep the mock uneven (cancelled
rows, rows without an amount, varying prices) or the forecast band collapses to a
line and the skipped-count note disappears.

## Shortcuts

`installShortcuts()` runs on every guide page. `Alt+1…9` map to the site's own
`nav[role=navigation] ul.nav > li > a` in DOM order, so the sidebar stays the
single source of truth; the key is also written into each link's `title` so it
is discoverable. `Alt+R` is two-step: closed panel → open + preview, open panel
with a ready preview → the same click as the button (so it bills the month).
It returns `false` (without `preventDefault`) on pages that have no panel.
`Alt+S` toggles the statistics view through `TAH_STATS.toggle()`; it also returns
`false` when the view is not there, so the key is never swallowed needlessly.

`Alt+P` / `Alt+N` click the month arrows, which are plain links to
`?start_at=<month>`. Their labels are bootstrap tooltips (`data-original-title`),
so the target month is read from the href instead — and matched to exactly
`current ∓ 1`. The middle "aktueller Monat" link always points at **today's**
month rather than the one on screen, so a `<` / `>` comparison can resolve the
wrong arrow once you have navigated away from today. Navigating is a full page
load, which is why the shortcuts go through `link.click()` rather than
`location.assign`: the site's own handler stays in charge.

Match on `event.code`, not `event.key`: with Alt held, macOS and German layouts
produce `®` / `¡` instead of the letter or digit. Synthetic `KeyboardEvent`s
dispatched from the page world do reach the content script's listener, which is
how the shortcuts are tested through Playwright.

## Sidebar labels

The sidebar is an icon rail (`body.mini-navbar`) and the site hides `.nav-label`
with it, which leaves six icons nobody can tell apart (seven with the stats tab).
The extension prints the labels as 10 px captions under the icons. The rules are
gated on `body.tah-nav-labels`, set by `applyNavLabels()` from
`chrome.storage.sync.navLabels` (popup checkbox, default on) — without the class
the rail looks exactly like the site's.

The rail grows from 70 px to 92 px, because the longest label
("Verfügbarkeiten") is ~82 px at that size; `#page-wrapper`'s margin and the
fixed footer have to follow, or the page sits underneath it. The overrides are
guarded with `:not(.fixed-sidebar):not(.canvas-menu)`: in those modes the
sidebar is wide and prints the labels inline, and the flex column would break
them. `text-box: trim-both cap alphabetic` removes the font's leading so the gap
under an icon is the flex gap; it is a progressive enhancement (Chrome 133+).

## Data gotchas

- The site's calendar export stores **UTC** (`DTSTART:20261003T105500Z`), while the site and grid
  show local time (that booking is "12:55 Uhr"). Convert with `Europe/Berlin` before deriving any
  time from it. All times in the extension are local wall-clock time. The export itself is personal
  data and is gitignored, not part of this repo.
- The museum's tours are fixed in UTC, so their local start times shift by an hour at DST.
  Presets are static local times; that is a known limitation, not a bug.
- The availability rules on the page are also authoritative: toggling a cell inside a rule's window
  makes the server snap it back. Do not assume a write "sticks" without reloading.

## Versions and changelog

`version` in `extension/manifest.json` and `CHANGELOG.md` move together, in the
same commit as the change. SemVer: a new feature bumps the minor, a fix the
patch, a rework the major — leave the version alone when nothing user-visible
changed (docs, comments, a refactor). `chrome://extensions` shows that number on
the extension's card, which is how an installed copy tells whether its **Update**
actually arrived.

A changelog entry is what the person using the extension reads, not a commit
log: English, one bullet per change under `Added` / `Changed` / `Fixed`, the
German UI name in bold where there is one (**Jahresübersicht**, **Ganze Woche
verfügbar**), and a sentence about what it now does rather than which function
moved. `## [1.3.0] - YYYY-MM-DD`, newest release first.

## Conventions

- UI strings are German (the site is German), code and comments are English.
- Match the site's look: Bootstrap 3-ish, `#1e4b8c` accent, 12 px panel text.
- Keep the extension dependency-free; no frameworks, no bundler. The single
  exception is the vendored Chart.js in `vendor/` (see Statistics) — it is a
  checked-in file, not a dependency the build resolves.
- German numbers: `toLocaleString('de-DE')`. A plain `${Math.round(x * 10) / 10}`
  prints `4.5`, which reads wrong next to `4,5 h`.
- Never break the site's native behaviour: a plain click must stay a single-slot toggle, and the
  extension must not swallow clicks it does not handle.

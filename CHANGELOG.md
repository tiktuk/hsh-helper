# Changelog

What changed in HSH-Helper, newest first, in the spirit of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The version is the
`version` in `extension/manifest.json` and follows SemVer: a new feature bumps
the minor, a fix the patch, a rework the major. `chrome://extensions` shows the
same number on the extension's card.

Entries up to 1.2.0 were reconstructed from the git history when this file was
started; from 1.3.0 on, each release is written when it is cut.

## [1.3.0] - 2026-11-04

### Added

- **Jahresübersicht** above the statistics: one small square per day of the
  year, as dark as the day was busy, with a red mark when a booking of that day
  was cancelled. Hovering names the day's tours, its income and any
  Ausfallhonorar; a click opens that day's week, a click on a month name opens
  the month. A line under the row marks the period on screen, a tick today.
- **Noch ausstehend** card in the year view: the money already booked but not
  yet earned, from today up to a year ahead, with the next tour and the split
  over the months.
- **Ganze Woche verfügbar** fills the week's empty blocks in one go, skipping
  blocks that are marked unavailable and days a picked calendar already covers.
  A dialog shows what it would set before anything is written.
- Several calendars in the availability overlay, each with its own name and
  colour, and `webcal://` as well as `webdav://` / `webdavs://` feed addresses.

### Changed

- A calendar feed that fails keeps its last copy and says so, instead of
  blanking the overlay for every calendar.

## [1.2.0] - 2026-11-03

### Added

- The statistics count the ride and the pauses: effective hourly rate, waiting
  time and what it costs in lost honorar, and how many days run efficiently.
- A bike card with the photo, the period's kilometres and the electricity (kWh
  and €) under it. The assumptions behind the figures are edited on the options
  page, not in the view.

## [1.1.0] - 2026-11-02

### Added

- **Statistik** tab in the sidebar (`Alt+S`): income per week, month and year,
  the split between Honorar and Ausfallhonorar, work hours, participants,
  offers and start times, plus a forecast to the end of the year.

## [1.0.0] - 2026-11-01

### Added

- One block per tour instead of 18 five-minute cells on the availability grid,
  with ✓ / ✗ buttons for a whole day and a whole row (Monday to Friday by
  default, the working-hours window respected).
- The guide's own iCal calendar as an overlay on the block view.
- The monthly invoice on the calendar page: letterhead, signature and number
  range from the settings, group cancellations billed at their Ausfallhonorar.
- Labels under the sidebar icons, and `Alt+1…9`, `Alt+R`, `Alt+P` / `Alt+N` as
  shortcuts.
- Settings in the popup (block length, preset times, working hours) and on the
  options page.

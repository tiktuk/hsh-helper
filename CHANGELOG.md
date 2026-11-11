# Changelog

What changed in HSH-Helper, newest first, in the spirit of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The version is the
`version` in `extension/manifest.json` and follows SemVer: a new feature bumps
the minor, a fix the patch, a rework the major. `chrome://extensions` shows the
same number on the extension's card.

Entries up to 1.2.0 were reconstructed from the git history when this file was
started; from 1.3.0 on, each release is written when it is cut.

## [Unreleased]

### Added

- **Einnahmen je Tag** in the year view: the year as a calendar — one column per
  week, one row per weekday, each day as dark as it earned. A weekday row that
  stays pale all year is a day you are never booked on, which one row of 366
  squares cannot show. The colour is the day's income (Honorar and
  Ausfallhonorar) between the quietest and the busiest day of the year; a red
  edge still marks a cancellation by the group, an amber one a cancellation by
  you, and today keeps its ring. Hovering names the day's tours, its income and
  any cancellation, a click opens that day's week, a click on a month name opens
  the month.
- **Jahresübersicht** gets a month row: under the squares, one cell per month
  with its name, its income and its number of tours, filled in the same colours
  as the day squares — the weakest month of the year lightest, the best darkest.
  Hovering shows the month's income, tours, workdays and cancellations; a click
  still opens the month. The plain month labels are gone, the names live in the
  cells now.

## [1.3.0] - 2026-11-04

### Added

- **Jahresübersicht** above the statistics: one small square per day of the
  year, as dark as the day was busy, with a red mark when the group cancelled a
  booking of that day and an amber one when the guide cancelled it. Hovering
  names the day's tours, its income and any Ausfallhonorar; a click opens that
  day's week, a click on a month name opens the month. A line under the row
  marks the period on screen, a tick today.
- **Noch ausstehend** card in the year view: the money already booked but not
  yet earned, from today up to a year ahead, with the next tour and the split
  over the months.
- **Ganze Woche verfügbar** fills the week's empty blocks in one go, skipping
  blocks that are marked unavailable and days a picked calendar already covers.
  A dialog shows what it would set before anything is written.
- Several calendars in the availability overlay, each with its own name and
  colour, and `webcal://` as well as `webdav://` / `webdavs://` feed addresses.
- **Absagen** is split into **Absagen (Kundschaft)** and **Absagen (durch
  dich)**, in the figures and on the year strip. The booking page does not say
  who cancelled; the Ausfallhonorar does — the group's cancellation carries one,
  the guide's has no amount at all. The Absagequote now says it counts the
  group's cancellations only, and the footer keeps Guidewechsel apart from the
  guide's own cancellations.

### Changed

- A calendar feed that fails keeps its last copy and says so, instead of
  blanking the overlay for every calendar.

### Fixed

- **Längste Pause** printed the day's total waiting time next to the whole
  workday, so a 09:55–17:00 day with three tours read "1,8 h (09:55–17:00)". It
  is the longest single stretch between two tours now, with its own window, and
  the day with the most waiting in total has its own line under
  **Auffälligkeiten** (*Längste Wartezeit an einem Tag*).
- The electricity line in **Auffälligkeiten** said "undefined Wh/km"; the
  assumption never reached the figures.

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

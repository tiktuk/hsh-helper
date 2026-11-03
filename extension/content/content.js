'use strict';

const SLOT_SECONDS = 300;
const CYCLE = ['not_set', 'available', 'unavailable'];
const TOGGLE_URL = '/guide/availables/toggle_available_date';
const CONCURRENCY = 8;

const DEFAULTS = {
  duration: 90,
  presets: ['09:55', '10:55', '11:55', '12:55', '13:55', '14:55', '16:35'],
  altClickBlock: true,
  hideOutside: true,
  weekdaysOnly: true,
  navLabels: true,
  dayFrom: '09:55',
  dayTo: '18:30',
  view: 'blocks',
  invoiceStart: 1,
  invoicePrefix: '',
};

const state = {
  settings: { ...DEFAULTS },
  anchor: null,
  busy: false,
  undo: null,
  undoTimeout: null,
  calendar: { feeds: [], on: true, days: {}, fetchedAt: 0 },
  invoicePreview: null,
  invoiceToken: 0,
};

/* ---------- helpers ---------- */

const gridTable = () => document.querySelector('table.available-table');

function stateOfClass(cls) {
  if (cls.includes('not_available')) return 'unavailable';
  if (cls.includes('available_')) return 'available';
  return 'not_set';
}

function csrfToken() {
  const meta = document.querySelector('meta[name=csrf-token]');
  return meta ? meta.content : '';
}

function unescapeJsString(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, esc) => {
    if (esc.length > 1) return String.fromCharCode(parseInt(esc.slice(1), 16));
    switch (esc) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return esc; // \' \" \\ \/ and anything else
    }
  });
}

function parseReplace(js) {
  const m = js.match(/\.replaceWith\('((?:[^'\\]|\\.)*)'\)/s);
  if (!m) return null;
  const html = unescapeJsString(m[1]);
  const doc = new DOMParser().parseFromString(`<table><tbody><tr>${html}</tr></tbody></table>`, 'text/html');
  const td = doc.querySelector('td');
  return td ? { cls: td.className, inner: td.innerHTML } : null;
}

const CELL_MARKUP = {
  not_set: '<small><i class="fa fa-square-o"></i></small>',
  unavailable: '<small><i class="fa fa-square-o"></i></small>',
  available: '<small><i class="fa fa-check-square-o"></i></small>',
};

const looksBroken = (cell) => !cell.querySelector('i, span, div, a') || /[<\\]/.test(cell.textContent);

function paintCell(cell, parsed) {
  cell.className = parsed.cls;
  cell.innerHTML = parsed.inner;
  if (looksBroken(cell)) cell.innerHTML = CELL_MARKUP[stateOfClass(cell.className)];
}

async function toggleCell(cell) {
  const token = csrfToken();
  const body = new URLSearchParams({ form_update_td_id: cell.dataset.timestamp, authenticity_token: token });
  const res = await fetch(TOGGLE_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-Token': token,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/javascript, */*',
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const parsed = parseReplace(await res.text());
  if (parsed) {
    // Mutate in place so the site's own click handler stays bound.
    paintCell(cell, parsed);
  } else {
    const next = CYCLE[(CYCLE.indexOf(stateOfClass(cell.className)) + 1) % CYCLE.length];
    cell.className = cell.className.replace(/not_set|not_available_no_bookings|available_no_bookings/, '');
    cell.classList.add(next === 'not_set' ? 'not_set' : next === 'available' ? 'available_no_bookings' : 'not_available_no_bookings');
    cell.innerHTML = CELL_MARKUP[next];
  }
}

async function pool(items, limit, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/* ---------- grid model ---------- */

function readGrid() {
  const t = gridTable();
  if (!t) return null;
  const headers = [...t.querySelectorAll('thead th')].slice(1).map((th) => {
    // the th also holds a hidden dropdown with "Kernzeit ..." actions, so read the label only
    const small = th.querySelector('small');
    return (small ? small.textContent : th.innerText).trim().split('\n')[0].trim();
  });
  const cols = headers.map(() => []);
  t.querySelectorAll('tbody tr').forEach((tr) => {
    tr.querySelectorAll('td.timestampbutton').forEach((td, i) => {
      if (cols[i]) cols[i].push(td);
    });
  });
  return { t, headers, cols };
}

function findCellAtTime(col, hh, mm) {
  return col.find((td) => {
    const d = new Date(Number(td.dataset.timestamp) * 1000);
    return d.getHours() === hh && d.getMinutes() === mm;
  });
}

function blockCells(col, startTs, durationMin) {
  const end = startTs + durationMin * 60;
  return col.filter((td) => {
    const ts = Number(td.dataset.timestamp);
    return ts >= startTs && ts < end;
  });
}

/* ---------- writes ---------- */

function status(text, { undo = false } = {}) {
  const el = document.querySelector('#tah-status');
  if (!el) return;
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text;
  el.append(span);
  if (undo) {
    const btn = document.createElement('button');
    btn.className = 'tah-link';
    btn.textContent = 'Rückgängig';
    btn.addEventListener('click', undoLast);
    el.append(' ', btn);
  }
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('#tah-panel button, #tah-panel input').forEach((el) => {
    el.disabled = busy;
  });
}

async function applyToCells(cells, target, label, note = '') {
  if (state.busy) return;
  const clickable = cells.filter((c) => c.classList.contains('clickable'));
  const skipped = cells.length - clickable.length;
  if (!clickable.length) {
    status(skipped ? 'Keine bearbeitbaren Slots (Vergangenheit).' : 'Keine Slots gefunden.');
    return;
  }

  const changed = [];
  let done = 0;
  setBusy(true);
  status(`${label}: 0/${clickable.length} …`);

  try {
    await pool(clickable, CONCURRENCY, async (cell) => {
      const before = { ts: cell.dataset.timestamp, state: stateOfClass(cell.className) };
      if (before.state !== target) {
        let guard = 0;
        while (stateOfClass(cell.className) !== target && guard++ < 4) {
          await toggleCell(cell);
        }
        if (stateOfClass(cell.className) === target) changed.push(before);
      }
      done += 1;
      status(`${label}: ${done}/${clickable.length} …`);
    });
  } catch (err) {
    status(`Fehler: ${err.message}`);
    setBusy(false);
    return;
  }
  setBusy(false);
  refreshBlockView();

  // `note` says what a bulk action left alone, e.g. the busy blocks a week fill
  // skipped. It is a tail on the status line, not a second one: the undo button
  // has to stay next to the count.
  const tail = `${skipped ? `, ${skipped} übersprungen` : ''}${note ? ` · ${note}` : ''}`;

  if (!changed.length) {
    status(`${label}: bereits aktuell (${clickable.length} Slots)${tail}.`);
    return;
  }

  state.undo = changed;
  clearTimeout(state.undoTimeout);
  state.undoTimeout = setTimeout(() => {
    state.undo = null;
    status(`${label}: ${changed.length} Slots geändert${tail}.`);
  }, 20000);

  status(`${label}: ${changed.length} Slots geändert${tail}.`, { undo: true });
}

async function undoLast() {
  if (!state.undo || state.busy) return;
  const changes = state.undo;
  state.undo = null;
  setBusy(true);
  status('Rückgängig …');
  try {
    await pool(changes, CONCURRENCY, async (change) => {
      const cell = document.getElementById(`avail_${change.ts}`);
      if (!cell) return;
      let guard = 0;
      while (stateOfClass(cell.className) !== change.state && guard++ < 4) {
        await toggleCell(cell);
      }
    });
    status(`Rückgängig: ${changes.length} Slots wiederhergestellt.`);
  } catch (err) {
    status(`Fehler beim Rückgängig: ${err.message}`);
  }
  setBusy(false);
  refreshBlockView();
}

/* ---------- actions ---------- */

function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value || '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

function cellsBetween(a, b) {
  const grid = readGrid();
  if (!grid) return [];
  const rows = [...grid.t.querySelectorAll('tbody tr')];
  const iA = rows.indexOf(a.closest('tr'));
  const iB = rows.indexOf(b.closest('tr'));
  if (iA < 0 || iB < 0) return [];
  const [from, to] = iA <= iB ? [iA, iB] : [iB, iA];
  const colA = a.cellIndex - 1;
  const colB = b.cellIndex - 1;
  const [c0, c1] = colA <= colB ? [colA, colB] : [colB, colA];
  const cells = [];
  for (let c = c0; c <= c1; c++) {
    for (const td of grid.cols[c] || []) {
      const row = rows.indexOf(td.closest('tr'));
      if (row >= from && row <= to) cells.push(td);
    }
  }
  return cells;
}

function blockFromCell(cell) {
  const grid = readGrid();
  if (!grid) return [];
  const colIndex = cell.cellIndex - 1;
  const col = grid.cols[colIndex];
  if (!col) return [];
  const duration = state.settings.duration;
  return blockCells(col, Number(cell.dataset.timestamp), duration);
}

/* ---------- row visibility ---------- */

function minutesOf(ts) {
  const d = new Date(Number(ts) * 1000);
  return d.getHours() * 60 + d.getMinutes();
}

function rowSpan(tr) {
  const cell = tr.querySelector('td.timestampbutton');
  if (cell) {
    const start = minutesOf(cell.dataset.timestamp);
    return { start, end: start + 5 };
  }
  const label = tr.querySelector('td')?.textContent || '';
  const m = label.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) };
}

function applyRowVisibility() {
  const t = gridTable();
  if (!t) return;
  const on = state.settings.hideOutside;
  const from = parseTime(state.settings.dayFrom);
  const to = parseTime(state.settings.dayTo);
  const lo = from ? from.hh * 60 + from.mm : 0;
  const hi = to ? to.hh * 60 + to.mm : 24 * 60;
  for (const tr of t.querySelectorAll('tbody tr')) {
    const span = rowSpan(tr);
    const outside = on && span && (span.end <= lo || span.start >= hi);
    tr.classList.toggle('tah-row-hidden', Boolean(outside));
  }
}

/* ---------- block view ---------- */

function addMinutes(hhmm, mins) {
  const t = parseTime(hhmm);
  if (!t) return '';
  const total = (t.hh * 60 + t.mm + mins) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function summarize(cells) {
  const active = cells.filter((c) => c.classList.contains('clickable'));
  // A block that is over still has a state worth showing: the site colours
  // those cells in the five-minute view too, it just refuses writes. Fall back
  // to every cell and mark the result read-only instead of painting it grey.
  const target = active.length ? active : cells;
  if (!target.length) return { kind: 'past', counts: null, total: 0, booked: false, readOnly: true };

  const counts = { available: 0, unavailable: 0, not_set: 0 };
  let booked = false;
  for (const c of target) {
    counts[stateOfClass(c.className)] += 1;
    if (c.className.includes('with_bookings')) booked = true;
  }
  const total = target.length;
  const kind =
    counts.available === total
      ? 'available'
      : counts.unavailable === total
        ? 'unavailable'
        : counts.not_set === total
          ? 'not_set'
          : 'mixed';
  return { kind, counts, total, booked, readOnly: active.length === 0 };
}

function blockRows() {
  const grid = readGrid();
  if (!grid) return [];
  const duration = state.settings.duration;
  return state.settings.presets.map((time) => {
    const t = parseTime(time);
    const cells = grid.cols.map((col) => {
      const start = t && findCellAtTime(col, t.hh, t.mm);
      return start ? blockCells(col, Number(start.dataset.timestamp), duration) : [];
    });
    return { time, end: addMinutes(time, duration), cells };
  });
}

async function toggleBlock(cells, label, kind) {
  await applyToCells(cells, kind === 'available' ? 'not_set' : 'available', label);
  refreshBlockView();
}

/* ---------- whole week ---------- */

// Whether any of the picked calendars has something in that block. All-day
// entries count here, unlike the stripes in the grid: a holiday really is a
// blocked day, and filling it would offer tours while the guide is away.
function feedClash(dateKey, startMin, endMin, feedIds) {
  for (const feed of state.calendar.feeds) {
    if (!feedIds.has(feed.id)) continue;
    const entries = (feed.days || {})[dateKey] || [];
    if (entries.some((entry) => entry.start < endMin && entry.end > startMin)) return true;
  }
  return false;
}

// What "the whole week" would touch: every block that is still empty, minus the
// ones that are already busy (unavailable or mixed) and the ones a picked
// calendar covers. Past blocks are left alone as everywhere else, and rows the
// working-hours filter hides are not filled either — a click the user cannot see
// coming is worse than one more option.
function weekFillPlan({ feeds, weekend }) {
  const grid = readGrid();
  const plan = { cells: [], blocks: 0, days: new Set(), available: 0, busy: 0, events: 0, past: 0 };
  if (!grid) return plan;

  const keys = columnKeys(grid);
  const duration = state.settings.duration;
  const from = parseTime(state.settings.dayFrom);
  const to = parseTime(state.settings.dayTo);
  const lo = from ? from.hh * 60 + from.mm : 0;
  const hi = to ? to.hh * 60 + to.mm : 24 * 60;
  // Adjacent rows share five-minute cells (13:55–15:25 and 14:55–16:25 overlap
  // by half an hour), so a cell can be in two blocks. It is written once.
  const seen = new Set();

  for (const row of blockRows()) {
    const start = parseTime(row.time);
    if (!start) continue;
    const startMin = start.hh * 60 + start.mm;
    if (state.settings.hideOutside && (startMin >= hi || startMin + duration <= lo)) continue;

    row.cells.forEach((cells, i) => {
      const dateKey = keys[i];
      if (!dateKey) return;
      const day = weekdayOf(dateKey);
      if (!weekend && (day === 0 || day === 6)) return;

      const info = summarize(cells);
      if (info.kind === 'available') {
        plan.available += 1;
        return;
      }
      if (!cells.length || info.readOnly) {
        plan.past += 1;
        return;
      }
      if (info.kind !== 'not_set') {
        plan.busy += 1;
        return;
      }
      if (feedClash(dateKey, startMin, startMin + duration, feeds)) {
        plan.events += 1;
        return;
      }
      plan.blocks += 1;
      plan.days.add(dateKey);
      for (const cell of cells) {
        if (seen.has(cell.id)) continue;
        seen.add(cell.id);
        plan.cells.push(cell);
      }
    });
  }
  return plan;
}

function planNote(plan) {
  const parts = [];
  if (plan.busy) parts.push(`${plan.busy} belegt`);
  if (plan.events) parts.push(`${plan.events} mit Termin`);
  if (plan.past) parts.push(`${plan.past} vergangen`);
  return parts.join(', ');
}

function closeWeekDialog() {
  const dialog = document.querySelector('#tah-week-dialog');
  if (!dialog) return;
  document.removeEventListener('keydown', onWeekDialogKey, true);
  dialog.remove();
}

function onWeekDialogKey(event) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  closeWeekDialog();
}

// The dialog is the two choices that change the outcome — which calendars block
// a time, and whether the weekend is part of "the week" — plus a live count, so
// the result is known before the writes start.
function openWeekFillDialog() {
  if (state.busy || document.querySelector('#tah-week-dialog')) return;
  if (!readGrid()) return;

  const picked = new Set(state.calendar.feeds.filter((feed) => feed.on).map((feed) => feed.id));
  let weekend = !state.settings.weekdaysOnly;

  const dialog = el('div', {
    id: 'tah-week-dialog',
    class: 'tah-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'tah-week-title',
  });
  const box = el('div', { class: 'tah-modal-box' });
  box.append(el('h3', { id: 'tah-week-title', text: 'Ganze Woche verfügbar' }));
  box.append(
    el('p', {
      class: 'tah-modal-sub',
      text: `${state.settings.presets.length} Blöcke à ${state.settings.duration} Min · belegte Zeiten bleiben belegt`,
    })
  );

  if (state.calendar.feeds.length) {
    const feeds = el('fieldset', { class: 'tah-modal-feeds' });
    feeds.append(el('legend', { text: 'Termine dieser Kalender auslassen' }));
    for (const feed of state.calendar.feeds) {
      const label = el('label', { class: 'tah-check' });
      const input = el('input', { type: 'checkbox' });
      input.checked = picked.has(feed.id);
      input.addEventListener('change', () => {
        if (input.checked) picked.add(feed.id);
        else picked.delete(feed.id);
        refresh();
      });
      label.append(input, el('span', { text: `${feedTitle(feed)}${feed.error ? ' (nicht erreichbar)' : ''}` }));
      feeds.append(label);
    }
    box.append(feeds);
  }

  const weekendLabel = el('label', { class: 'tah-check' });
  const weekendInput = el('input', { id: 'tah-week-weekend', type: 'checkbox' });
  weekendInput.checked = weekend;
  weekendInput.addEventListener('change', () => {
    weekend = weekendInput.checked;
    refresh();
  });
  weekendLabel.append(weekendInput, el('span', { text: 'Wochenende mitnehmen (Sa + So)' }));
  box.append(weekendLabel);

  const summary = el('p', { class: 'tah-modal-summary' });
  box.append(summary);

  const actions = el('div', { class: 'tah-modal-actions' });
  const cancel = el('button', { class: 'tah-btn tah-btn-quiet', type: 'button', text: 'Abbrechen' });
  cancel.addEventListener('click', closeWeekDialog);
  const apply = el('button', { class: 'tah-btn', type: 'button', text: 'Verfügbar setzen' });
  apply.addEventListener('click', () => {
    const plan = weekFillPlan({ feeds: picked, weekend });
    closeWeekDialog();
    applyToCells(plan.cells, 'available', 'Ganze Woche', planNote(plan));
  });
  actions.append(cancel, apply);
  box.append(actions);

  function refresh() {
    const plan = weekFillPlan({ feeds: picked, weekend });
    apply.disabled = plan.blocks === 0;
    if (!plan.blocks) {
      const note = planNote(plan);
      const done = plan.available ? `${plan.available} bereits verfügbar` : '';
      summary.textContent = `Nichts zu setzen${[done, note].filter(Boolean).join(', ') ? `: ${[done, note].filter(Boolean).join(', ')}` : ''}.`;
      return;
    }
    // "an 1 Tag" reads badly, so the day count only appears once it is plural.
    const days = plan.days.size > 1 ? ` an ${plan.days.size} Tagen` : '';
    const note = planNote(plan);
    summary.textContent = `Setzt ${plan.blocks} ${plan.blocks === 1 ? 'Block' : 'Blöcke'}${days} auf verfügbar${note ? ` · ausgelassen: ${note}` : ''}.`;
  }

  dialog.append(box);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeWeekDialog();
  });
  document.addEventListener('keydown', onWeekDialogKey, true);
  document.body.append(dialog);
  refresh();
  apply.focus();
}

function blockCellNode(cells, label, when) {
  const info = summarize(cells);
  const td = el('td', { class: `tah-block-cell tah-block-${info.kind}${info.readOnly ? ' tah-block-readonly' : ''}` });

  const icon = el('i', { class: `fa ${info.kind === 'available' ? 'fa-check-square-o' : 'fa-square-o'}` });
  td.append(icon);

  if (info.kind === 'mixed') td.append(el('small', { text: `${info.counts.available}/${info.total}` }));
  if (info.booked) td.append(el('i', { class: 'fa fa-fw fa-bookmark tah-block-booked' }));

  const clashes = when ? conflictsOn(when.dateKey, when.startMin, when.endMin) : [];
  if (clashes.length) {
    td.classList.add('tah-block-conflict');
    // The stripe takes the colour of the calendar it collides with; with
    // several at once the earliest one wins, the tooltip names them all.
    td.style.setProperty('--tah-feed', clashes[0].color || FEED_COLORS[0]);
    td.title = clashes
      .map((entry) => `Termin ${clockLabel(entry.start)}–${clockLabel(entry.end)}: ${eventLabel(entry)}`)
      .join('\n');
  }

  if (info.counts) {
    const own = `${label} · ${info.counts.available}/${info.total} verfügbar${info.readOnly ? ' (Vergangenheit)' : ''}`;
    td.title = td.title ? `${own}\n${td.title}` : own;
  }
  if (!info.readOnly) td.addEventListener('click', () => toggleBlock(cells, label, info.kind));
  return td;
}

function dayCells(col) {
  const from = parseTime(state.settings.dayFrom);
  const to = parseTime(state.settings.dayTo);
  const lo = from ? from.hh * 60 + from.mm : 0;
  const hi = to ? to.hh * 60 + to.mm : 24 * 60;
  return col.filter((td) => {
    const m = minutesOf(td.dataset.timestamp);
    return m >= lo && m < hi;
  });
}

function dayHeadNode(col, header, dateKey) {
  const th = el('th', { class: 'tah-day-head' });
  th.append(el('span', { class: 'tah-day-name', text: header.replace(',', '') }));

  const cells = dayCells(col);
  const info = summarize(cells);
  const range = `${state.settings.dayFrom}–${state.settings.dayTo}`;
  const tools = el('div', { class: 'tah-day-tools' });

  const make = (kind, icon, title) => {
    const btn = el('button', {
      class: `tah-daybtn${info.kind === kind ? ' tah-daybtn-on' : ''} tah-daybtn-${kind}`,
      type: 'button',
      title: `${header.replace(',', '')}: ${range} ${title}`,
    });
    btn.append(el('i', { class: `fa ${icon}` }));
    if (info.readOnly) {
      // Nothing in this day can be written any more; keep the state visible but
      // do not offer a button that would only report "Vergangenheit".
      btn.disabled = true;
      btn.title = `${header.replace(',', '')}: ${range} (Vergangenheit)`;
    } else {
      btn.addEventListener('click', () =>
        applyToCells(cells, info.kind === kind ? 'not_set' : kind, `${header.replace(',', '')} ${range} ${title}`)
      );
    }
    return btn;
  };

  tools.append(make('available', 'fa-check', 'verfügbar'));
  tools.append(make('unavailable', 'fa-times', 'nicht verfügbar'));
  th.append(tools);

  const tip = dayTooltip(dateKey);
  if (tip) th.title = tip;
  return th;
}

// The row header carries the same ✓/✗ pair as the day headers, the other way
// round: one click sets this block on every day of the week — or only Monday to
// Friday while `weekdaysOnly` is on, which is the default.
function weekdayOf(dateKey) {
  if (!dateKey) return 0;
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function rowHeadNode(row, label, keys) {
  const th = el('th', { class: 'tah-block-label' });
  th.append(el('span', { class: 'tah-block-time', text: label }));

  const weekdaysOnly = state.settings.weekdaysOnly;
  const picked = weekdaysOnly
    ? row.cells.filter((_, i) => {
        const day = weekdayOf(keys[i]);
        return day >= 1 && day <= 5;
      })
    : row.cells;
  const cells = picked.flat();
  const scope = weekdaysOnly ? 'Mo–Fr' : 'ganze Woche';
  const info = summarize(cells);
  const tools = el('div', { class: 'tah-block-tools' });

  const make = (kind, icon, title) => {
    const btn = el('button', {
      class: `tah-daybtn${info.kind === kind ? ' tah-daybtn-on' : ''} tah-daybtn-${kind}`,
      type: 'button',
      title: `${label}: ${scope} ${title}`,
    });
    btn.append(el('i', { class: `fa ${icon}` }));
    if (info.readOnly) {
      // Nothing in this block can be written any more; keep the state visible
      // but do not offer a button that would only report "Vergangenheit".
      btn.disabled = true;
      btn.title = `${label}: ${scope} ${title} (Vergangenheit)`;
    } else {
      btn.addEventListener('click', () =>
        applyToCells(cells, info.kind === kind ? 'not_set' : kind, `${label} ${scope} ${title}`)
      );
    }
    return btn;
  };

  tools.append(make('available', 'fa-check', 'verfügbar'));
  tools.append(make('unavailable', 'fa-times', 'nicht verfügbar'));
  th.append(tools);
  return th;
}

function renderBlockView() {
  const host = document.querySelector('#tah-block-view');
  const grid = readGrid();
  if (!host || !grid) return;

  const duration = state.settings.duration;
  const from = parseTime(state.settings.dayFrom);
  const to = parseTime(state.settings.dayTo);
  const lo = from ? from.hh * 60 + from.mm : 0;
  const hi = to ? to.hh * 60 + to.mm : 24 * 60;

  const table = el('table', { class: 'tah-block-table' });
  const keys = columnKeys(grid);
  const headRow = el('tr');
  headRow.append(el('th', { class: 'tah-block-label', text: 'Block' }));
  grid.headers.forEach((header, i) => headRow.append(dayHeadNode(grid.cols[i], header, keys[i])));
  table.append(el('thead', {}, [headRow]));

  const tbody = el('tbody');
  for (const row of blockRows()) {
    const t = parseTime(row.time);
    const startMin = t ? t.hh * 60 + t.mm : 0;
    if (state.settings.hideOutside && (startMin + duration <= lo || startMin >= hi)) continue;
    const tr = el('tr');
    const label = `${row.time}–${row.end}`;
    tr.append(rowHeadNode(row, label, keys));
    row.cells.forEach((cells, i) => {
      const when = { dateKey: keys[i], startMin, endMin: startMin + duration };
      tr.append(blockCellNode(cells, `${label} ${grid.headers[i] || ''}`.trim(), when));
    });
    tbody.append(tr);
  }
  table.append(tbody);

  const bar = calendarBar();
  host.replaceChildren(...(bar ? [bar, table] : [table]));
}

function refreshBlockView() {
  if (state.settings.view !== 'slots') renderBlockView();
}

function applyView() {
  const grid = readGrid();
  const host = document.querySelector('#tah-block-view');
  if (!grid || !host) return;
  const blocks = state.settings.view !== 'slots';
  grid.t.style.display = blocks ? 'none' : '';
  host.style.display = blocks ? '' : 'none';
  document.querySelectorAll('.tah-seg').forEach((btn) => {
    btn.classList.toggle('tah-seg-on', btn.dataset.view === (blocks ? 'blocks' : 'slots'));
  });
  if (blocks) renderBlockView();
}

/* ---------- calendar feed ---------- */

const CALENDAR_TTL = 15 * 60 * 1000;

// One colour per calendar, so a chip and the stripe of the block it collides
// with can be told apart. Mirrored in options.js, which lets the colour be
// picked; a feed without one falls back by its position.
const FEED_COLORS = ['#b3261e', '#1e4b8c', '#2e7d32', '#6a1b9a', '#ef6c00', '#00695c'];

// The columns are dated by their cells, not by the header text, which the site
// renders with its own abbreviations.
function dateKeyOf(td) {
  const d = new Date(Number(td.dataset.timestamp) * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function columnKeys(grid) {
  return grid.cols.map((col) => (col[0] ? dateKeyOf(col[0]) : ''));
}

function clockLabel(minutes) {
  const total = Math.round(minutes);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function dayEvents(dateKey) {
  return (dateKey && state.calendar.days[dateKey]) || [];
}

function conflictsOn(dateKey, startMin, endMin) {
  // All-day entries stay out of this: one "Urlaub" would otherwise stripe the
  // whole week. They live in the day header's tooltip instead.
  return dayEvents(dateKey).filter((entry) => !entry.allDay && entry.start < endMin && entry.end > startMin);
}

// Events are not drawn — the day header only carries them in its tooltip, and a
// colliding block gets a stripe. Keeps the grid readable at a glance.
// A feed's name rides along in the tooltip, but only once there is more than
// one calendar: with a single feed it would just be noise.
function eventLabel(entry) {
  return entry.feed ? `${entry.title} (${entry.feed})` : entry.title;
}

function eventLine(entry) {
  if (entry.allDay) return `${entry.title} (ganztägig${entry.feed ? `, ${entry.feed}` : ''})`;
  return `${clockLabel(entry.start)}–${clockLabel(entry.end)} ${eventLabel(entry)}`;
}

function dayTooltip(dateKey) {
  return dayEvents(dateKey).map(eventLine).join('\n');
}

function timeLabel(ms) {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

// A feed without a name is labelled by its server, which is enough to tell two
// calendars apart and needs no upkeep.
function feedTitle(feed) {
  if (feed.label) return feed.label;
  const match = /^[a-z][a-z0-9+.-]*:/i.exec(String(feed.url || ''));
  if (!match) return 'Kalender';
  try {
    return new URL(`https:${feed.url.slice(match[0].length)}`).hostname || 'Kalender';
  } catch {
    return 'Kalender';
  }
}

// `icalFeeds` is the current shape. `icalUrl` is the single feed the extension
// had before it could hold several, and is still read so an existing setup keeps
// working until the settings page is saved once.
function readFeedList(stored) {
  const list = Array.isArray(stored.icalFeeds) ? stored.icalFeeds : [];
  const feeds = list
    .filter((feed) => feed && typeof feed.url === 'string' && feed.url.trim())
    .map((feed, index) => ({
      id: typeof feed.id === 'string' && feed.id ? feed.id : `feed-${index + 1}`,
      url: feed.url.trim(),
      label: typeof feed.label === 'string' ? feed.label.trim() : '',
      color: typeof feed.color === 'string' ? feed.color : '',
      on: feed.on !== false,
    }));
  if (feeds.length || !stored.icalUrl) return feeds;
  const legacy = String(stored.icalUrl).trim();
  return legacy ? [{ id: 'feed-1', url: legacy, label: '', color: '', on: true }] : [];
}

// The grid does not care which calendar an entry came from, so the enabled feeds
// are merged into one day map and sorted by start. Name and colour ride along on
// each entry for the tooltip and the stripe.
function mergeCalendarDays() {
  const calendar = state.calendar;
  const named = calendar.feeds.filter((feed) => feed.on).length > 1;
  const days = {};
  let fetchedAt = 0;
  for (const feed of calendar.feeds) {
    if (!feed.on) continue;
    fetchedAt = Math.max(fetchedAt, feed.fetchedAt || 0);
    for (const [dateKey, list] of Object.entries(feed.days || {})) {
      if (!days[dateKey]) days[dateKey] = [];
      for (const entry of list) days[dateKey].push({ ...entry, feed: named ? feedTitle(feed) : '', color: feed.color });
    }
  }
  for (const list of Object.values(days)) list.sort((a, b) => a.start - b.start);
  calendar.days = days;
  calendar.fetchedAt = fetchedAt;
}

function storedFeed(feed) {
  return { id: feed.id, url: feed.url, label: feed.label, color: feed.color, on: feed.on };
}

async function loadCalendarSettings() {
  const stored = await chrome.storage.local.get({ icalFeeds: null, icalUrl: '', icalOn: true });
  const known = new Map(state.calendar.feeds.map((feed) => [feed.id, feed]));
  state.calendar.feeds = readFeedList(stored).map((feed, index) => {
    // Days already fetched survive a settings change, but only for the same
    // address: editing a URL must not keep showing the old calendar's entries.
    const previous = known.get(feed.id);
    const reuse = previous && previous.url === feed.url;
    return {
      ...feed,
      color: feed.color || FEED_COLORS[index % FEED_COLORS.length],
      days: reuse ? previous.days : {},
      fetchedAt: reuse ? previous.fetchedAt : 0,
      error: reuse ? previous.error : '',
    };
  });
  state.calendar.on = stored.icalOn !== false;
  mergeCalendarDays();
}

// The cache used to hold one feed ({ url, text, fetchedAt }); it is a map keyed
// by address now, so every calendar keeps its own copy.
function cacheMap(raw) {
  if (!raw || typeof raw !== 'object') return {};
  if (typeof raw.url === 'string' && typeof raw.text === 'string') {
    return { [raw.url]: { text: raw.text, fetchedAt: Number(raw.fetchedAt) || 0 } };
  }
  return raw;
}

// The text of one feed. Nothing is written here: the feeds are fetched in
// parallel, and a write per feed would have each of them save the cache as it
// looked before the others answered, dropping their entries. The caller
// collects the fresh copies and saves once (saveCalendarCache).
async function feedText(url, force, cache) {
  const cached = cache[url];
  if (!force && cached && Date.now() - cached.fetchedAt < CALENDAR_TTL) {
    return { text: cached.text, fetchedAt: cached.fetchedAt };
  }

  // The worker fetches, not this script: a feed on another host is a
  // cross-origin request from the page's origin and would hit CORS here.
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'tah-fetch-ical', url });
    if (!reply || !reply.ok) throw new Error(reply?.error || 'Kalender nicht erreichbar.');
    return { text: reply.text, fetchedAt: Date.now(), fresh: true };
  } catch (err) {
    // A dead feed keeps its last good text instead of dropping out of the week;
    // the bar names it and says how old the text is.
    if (cached) return { text: cached.text, fetchedAt: cached.fetchedAt, stale: err.message };
    throw err;
  }
}

async function loadFeed(feed, dayKeys, force, cache, fresh) {
  try {
    const { text, fetchedAt, stale, fresh: isFresh } = await feedText(feed.url, force, cache);
    feed.days = TAH_ICAL.eventsByDay(text, dayKeys);
    feed.fetchedAt = fetchedAt;
    feed.error = stale || '';
    if (isFresh) fresh[feed.url] = { text, fetchedAt };
  } catch (err) {
    // Whatever this feed had stays on screen: one dead calendar must not blank
    // the others.
    feed.error = err.message;
  }
}

// Every feed's text sits in local storage and the quota is shared, so a calendar
// that was removed must not keep its copy. Calendars that are switched off do
// keep theirs — switching them back on is then instant.
async function saveCalendarCache(cache, fresh) {
  const next = {};
  let changed = false;
  for (const feed of state.calendar.feeds) {
    const entry = fresh[feed.url] || cache[feed.url];
    if (entry) next[feed.url] = entry;
    if (fresh[feed.url]) changed = true;
  }
  if (!changed) changed = Object.keys(cache).some((url) => !next[url]);
  if (changed) await chrome.storage.local.set({ icalCache: next });
}

async function loadCalendar(force = false) {
  const calendar = state.calendar;
  const grid = readGrid();
  const feeds = calendar.feeds.filter((feed) => feed.on);
  if (!calendar.on || !feeds.length || !grid) {
    calendar.days = {};
    calendar.fetchedAt = 0;
    return;
  }
  if (typeof TAH_ICAL === 'undefined') {
    for (const feed of feeds) feed.error = 'Kalender-Parser fehlt.';
    return;
  }

  const { icalCache } = await chrome.storage.local.get({ icalCache: null });
  const cache = cacheMap(icalCache);
  const fresh = {};
  const dayKeys = [...new Set(columnKeys(grid).filter(Boolean))];
  await Promise.all(feeds.map((feed) => loadFeed(feed, dayKeys, force, cache, fresh)));
  mergeCalendarDays();
  await saveCalendarCache(cache, fresh);
}

// The chips above the grid are the per-calendar switch. Hiding one only drops it
// from the merged week — its text stays cached, so switching it back is instant.
// The choice is written back to the settings, so it survives a reload.
async function toggleFeed(id) {
  const feed = state.calendar.feeds.find((entry) => entry.id === id);
  if (!feed) return;
  feed.on = !feed.on;
  mergeCalendarDays();
  refreshBlockView();
  await chrome.storage.local.set({ icalFeeds: state.calendar.feeds.map(storedFeed) });
  if (feed.on && !feed.fetchedAt) loadCalendar().then(refreshBlockView);
}

function calendarBar() {
  const calendar = state.calendar;
  if (!calendar.on || !calendar.feeds.length) return null;

  const bar = el('div', { class: 'tah-cal-bar' });

  const chips = el('span', { class: 'tah-cal-chips' });
  for (const feed of calendar.feeds) {
    const chip = el('button', {
      class: `tah-cal-chip${feed.on ? '' : ' tah-cal-off'}${feed.on && feed.error ? ' tah-cal-broken' : ''}`,
      type: 'button',
      title: feed.error
        ? `${feedTitle(feed)}: ${feed.error}${feed.fetchedAt ? ` (Stand ${timeLabel(feed.fetchedAt)})` : ''}`
        : `${feedTitle(feed)} ${feed.on ? 'ausblenden' : 'anzeigen'}`,
    });
    chip.style.setProperty('--tah-feed', feed.color || FEED_COLORS[0]);
    chip.setAttribute('aria-pressed', feed.on ? 'true' : 'false');
    chip.append(el('i', { class: 'tah-cal-dot' }), el('span', { text: feedTitle(feed) }));
    chip.addEventListener('click', () => toggleFeed(feed.id));
    chips.append(chip);
  }
  bar.append(chips);

  const count = Object.values(calendar.days).reduce((sum, list) => sum + list.length, 0);
  const when = calendar.fetchedAt ? ` · ${timeLabel(calendar.fetchedAt)}` : '';
  bar.append(el('span', { text: `${count} ${count === 1 ? 'Eintrag' : 'Einträge'} diese Woche${when}` }));

  const broken = calendar.feeds.filter((feed) => feed.on && feed.error);
  if (broken.length) {
    bar.append(
      el('span', {
        class: 'tah-cal-broken-text',
        text: broken.length === 1 && calendar.feeds.length === 1 ? `Kalender: ${broken[0].error}` : `${broken.length} Kalender nicht erreichbar`,
        title: broken.map((feed) => `${feedTitle(feed)}: ${feed.error}`).join('\n'),
      })
    );
  }

  const refresh = el('button', { class: 'tah-link', type: 'button', text: broken.length ? 'Erneut' : 'Aktualisieren' });
  refresh.addEventListener('click', () => loadCalendar(true).then(refreshBlockView));
  bar.append(' ', refresh);
  return bar;
}

/* ---------- UI ---------- */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('data-')) node.setAttribute(k, v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) node.append(child);
  return node;
}

function buildPanel() {
  const panel = el('div', { id: 'tah-panel' });

  const head = el('div', { class: 'tah-head' });
  head.append(el('strong', { text: 'Tour-Blöcke' }));
  head.append(el('span', { class: 'tah-sub', id: 'tah-sub', text: `Blöcke à ${state.settings.duration} Min` }));
  panel.append(head);

  const viewRow = el('div', { class: 'tah-row' });
  viewRow.append(el('span', { class: 'tah-label', text: 'Ansicht' }));
  const segs = el('div', { class: 'tah-segs' });
  for (const [value, label] of [['blocks', 'Blöcke'], ['slots', '5 Min']]) {
    const seg = el('button', { class: `tah-seg${state.settings.view === value ? ' tah-seg-on' : ''}`, type: 'button', text: label, 'data-view': value });
    seg.addEventListener('click', async () => {
      state.settings.view = value;
      await chrome.storage.sync.set({ view: value });
      applyView();
    });
    segs.append(seg);
  }
  viewRow.append(segs);
  panel.append(viewRow);

  // Both switches narrow what a click touches, so they share a row of their own
  // instead of being pushed apart to the edges.
  const filterRow = el('div', { class: 'tah-row tah-filters' });
  filterRow.append(el('span', { class: 'tah-label', text: 'Filter' }));

  const weekdayLabel = el('label', {
    class: 'tah-field tah-check',
    title:
      'Gilt nur für die ✓ / ✗ links neben der Uhrzeit (Zeilen-Buttons): an = nur Montag–Freitag, aus = auch Samstag und Sonntag. Die ✓ / ✗ in den Tagesköpfen und einzelne Zellen sind nicht betroffen.',
  });
  const weekdayInput = el('input', { id: 'tah-weekdays', type: 'checkbox' });
  weekdayInput.checked = state.settings.weekdaysOnly;
  weekdayInput.addEventListener('change', async () => {
    state.settings.weekdaysOnly = weekdayInput.checked;
    await chrome.storage.sync.set({ weekdaysOnly: weekdayInput.checked });
    refreshBlockView();
  });
  weekdayLabel.append(weekdayInput, el('span', { text: 'nur Mo–Fr (Zeilen ✓/✗)' }));

  const hideLabel = el('label', { class: 'tah-field tah-check', title: 'Blendet die Zeiten außerhalb der Arbeitszeit aus' });
  const hideInput = el('input', { id: 'tah-hide', type: 'checkbox' });
  hideInput.checked = state.settings.hideOutside;
  hideInput.addEventListener('change', async () => {
    state.settings.hideOutside = hideInput.checked;
    await chrome.storage.sync.set({ hideOutside: hideInput.checked });
    applyRowVisibility();
    refreshBlockView();
  });
  hideLabel.append(hideInput, el('span', { id: 'tah-hide-label', text: `nur ${state.settings.dayFrom}–${state.settings.dayTo}` }));
  filterRow.append(weekdayLabel, hideLabel);
  panel.append(filterRow);

  // The week fill is one click away, but never without the dialog: what it
  // leaves out (busy blocks, calendar entries, the weekend) is a choice.
  const weekRow = el('div', { class: 'tah-row tah-actions' });
  weekRow.append(el('span', { class: 'tah-label', text: 'Woche' }));
  const weekButton = el('button', {
    id: 'tah-fill-week',
    class: 'tah-btn',
    type: 'button',
    text: 'Ganze Woche verfügbar …',
  });
  weekButton.title =
    'Setzt alle noch freien Blöcke der Woche auf verfügbar. Belegte Zeiten und Termine der gewählten Kalender bleiben stehen; Wochenende und Kalender werden im Dialog gewählt.';
  weekButton.addEventListener('click', openWeekFillDialog);
  weekRow.append(weekButton);
  panel.append(weekRow);

  panel.append(
    el('div', {
      class: 'tah-hint',
      text:
        'Die ✓ / ✗ links neben der Uhrzeit setzen den ganzen Block auf einmal; „nur Mo–Fr“ betrifft nur diese Zeilen-Buttons · Alt+Klick: Block ab Zelle · Shift+Klick: Bereich bis hierher (beides = verfügbar)',
    })
  );
  panel.append(el('div', { id: 'tah-status', class: 'tah-status' }));

  return panel;
}

function repairCells() {
  // Heals cells left with escaped markup by earlier versions of this extension.
  for (const cell of document.querySelectorAll('td.timestampbutton')) {
    if (/[<\\]/.test(cell.textContent)) cell.innerHTML = CELL_MARKUP[stateOfClass(cell.className)];
  }
}

function mountPanel() {
  if (document.querySelector('#tah-panel')) return;
  const grid = readGrid();
  if (!grid || !grid.t) return;

  repairCells();

  const panel = buildPanel();
  const row = grid.t.closest('.row');
  if (row && row.parentElement) row.parentElement.insertBefore(panel, row);
  else grid.t.parentElement.insertBefore(panel, grid.t);

  const host = el('div', { id: 'tah-block-view' });
  grid.t.parentElement.insertBefore(host, grid.t);

  applyRowVisibility();
  applyView();
  loadCalendar().then(refreshBlockView);
}

/* ---------- interaction on the grid ---------- */

function onGridClick(event) {
  const cell = event.target.closest('td.timestampbutton');
  if (!cell) return;

  if (event.shiftKey && state.anchor) {
    event.preventDefault();
    event.stopPropagation();
    const cells = cellsBetween(state.anchor, cell);
    state.anchor = null;
    applyToCells(cells, 'available', 'Bereich');
    return;
  }

  if (event.altKey && state.settings.altClickBlock) {
    event.preventDefault();
    event.stopPropagation();
    const cells = blockFromCell(cell);
    applyToCells(cells, 'available', `Block ab ${new Date(Number(cell.dataset.timestamp) * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`);
    return;
  }

  state.anchor = cell;
}

/* ---------- settings ---------- */

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  state.settings = {
    duration: Number(stored.duration) || DEFAULTS.duration,
    presets: Array.isArray(stored.presets) && stored.presets.length ? stored.presets : DEFAULTS.presets,
    altClickBlock: stored.altClickBlock !== false,
    hideOutside: stored.hideOutside !== false,
    weekdaysOnly: stored.weekdaysOnly !== false,
    navLabels: stored.navLabels !== false,
    dayFrom: /^\d{1,2}:\d{2}$/.test(stored.dayFrom) ? stored.dayFrom : DEFAULTS.dayFrom,
    dayTo: /^\d{1,2}:\d{2}$/.test(stored.dayTo) ? stored.dayTo : DEFAULTS.dayTo,
    view: stored.view === 'slots' ? 'slots' : 'blocks',
    invoiceStart: Math.max(1, Number(stored.invoiceStart) || DEFAULTS.invoiceStart),
    invoicePrefix: typeof stored.invoicePrefix === 'string' ? stored.invoicePrefix : DEFAULTS.invoicePrefix,
  };
}

// The site collapses the sidebar to an icon rail and hides the labels with it.
// The stylesheet prints them under the icons, but only while this class is set
// (the popup can switch it off).
function applyNavLabels() {
  document.body.classList.toggle('tah-nav-labels', state.settings.navLabels);
}

chrome.storage.onChanged.addListener((changes, area) => {
  // The feed addresses are secrets and live in local storage, next to their
  // cache. A change can come from the settings page or from a chip click here;
  // either way the cache answers for the feeds that did not change, so this is
  // not a forced reload.
  if (area === 'local' && (changes.icalFeeds || changes.icalUrl || changes.icalOn)) {
    loadCalendarSettings()
      .then(() => loadCalendar(false))
      .then(() => refreshBlockView());
    return;
  }
  if (area !== 'sync') return;
  loadSettings().then(() => {
    applyNavLabels();
    const sub = document.querySelector('#tah-sub');
    if (sub) sub.textContent = `Blöcke à ${state.settings.duration} Min`;
    const hide = document.querySelector('#tah-hide');
    if (hide) hide.checked = state.settings.hideOutside;
    const weekdays = document.querySelector('#tah-weekdays');
    if (weekdays) weekdays.checked = state.settings.weekdaysOnly;
    const hideLabel = document.querySelector('#tah-hide-label');
    if (hideLabel) hideLabel.textContent = `nur ${state.settings.dayFrom}–${state.settings.dayTo}`;
    applyRowVisibility();
    applyView();
  });
});

/* ---------- invoice ---------- */

const BOOKINGS_URL = '/guide/bookings';
const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function addMonths(month, delta) {
  const [y, m] = month.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function parseGermanDate(text) {
  const m = /(\d{1,2})\.\s*([A-Za-zÄÖÜäöüß]+)\.?\s*(\d{4})/.exec(text || '');
  const month = m ? MONTH_NAMES.indexOf(m[2]) : -1;
  return month < 0 ? null : { day: Number(m[1]), month, year: Number(m[3]) };
}

function parseMonthLabel(text) {
  const m = /([A-Za-zÄÖÜäöüß]+)\s+(\d{4})/.exec(text || '');
  const month = m ? MONTH_NAMES.indexOf(m[1]) : -1;
  return month < 0 ? null : `${m[2]}-${String(month + 1).padStart(2, '0')}`;
}

// The site prints German prices ("97,50 €"); a comma means the dot is a thousands separator.
function parseMoney(text) {
  const raw = String(text).replace(/[^\d.,-]/g, '');
  if (!raw) return 0;
  return Number(raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw) || 0;
}

function guideName() {
  const node = document.querySelector('.profile-element .font-bold, .profile-element strong');
  return node ? node.textContent.trim() : '';
}

function currencySymbol() {
  return document.body.dataset.currencysymbol || '€';
}

function calendarBox() {
  return [...document.querySelectorAll('.ibox')].find((box) => /Buchungskalender/.test(box.querySelector('.ibox-title')?.textContent || ''));
}

function calendarMonth() {
  const legend = calendarBox()?.querySelector('legend');
  const fromLegend = parseMonthLabel(legend?.textContent);
  if (fromLegend) return fromLegend;
  const startAt = new URLSearchParams(location.search).get('start_at');
  return startAt && /^\d{4}-\d{2}/.test(startAt) ? startAt.slice(0, 7) : monthKey(new Date());
}

function parseBookingRow(tr, group, month) {
  const cells = [...tr.children];
  const info = cells.find((td) => /Datum:/.test(td.textContent));
  if (!info) return null;
  const text = info.textContent.replace(/\s+/g, ' ');
  const when = /Datum:\s*(\d{1,2})\.\s*([A-Za-zÄÖÜäöüß]+),?\s*(\d{1,2}):(\d{2})\s*Uhr/.exec(text);
  if (!when) return null;
  const monthIndex = MONTH_NAMES.indexOf(when[2]);
  const id = (tr.id.match(/\d+/) || [])[0];
  if (!id || monthIndex < 0) return null;
  const duration = /Dauer:\s*(\d+)\s*Minuten/.exec(text);
  // Only group tours carry a head count; public tours leave it out.
  const participants = /angemeldete Teilnehmende:\s*(\d+)/.exec(text);
  const year = group ? group.year : Number(month.slice(0, 4));
  // The status badge sits in the second cell, next to the group label. The row's
  // own `canceled` class cannot be used: every row carries it, booked ones with
  // an extra `no-costs`.
  const status = (cells[1]?.textContent || '').trim();
  return {
    id,
    cancelled: /storniert/i.test(status),
    tour: (cells[2]?.querySelector('strong')?.textContent || '').trim(),
    date: `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(Number(when[1])).padStart(2, '0')}`,
    time: `${when[3].padStart(2, '0')}:${when[4]}`,
    duration: duration ? Number(duration[1]) : null,
    participants: participants ? Number(participants[1]) : 0,
    customer: '',
    price: 0,
  };
}

async function fetchMonthBookings(month) {
  const query = new URLSearchParams({
    start_at: `${month}-01`,
    end_at: `${addMonths(month, 1)}-01`,
    per_page: '200',
  });
  query.append('status[]', '20'); // Gebucht
  query.append('status[]', '25'); // Abgeschlossen
  query.append('status[]', '50'); // Storniert – Absagen der Gruppe bringen ein Ausfallhonorar
  // E-Mail wird versendet, Unbestätigt, Bestätigt, Guidewechsel/Storno,
  // E-Mail-Versand fehlgeschlagen: past shifts belong on the invoice even when
  // the guide never confirmed them. 30 is not optional: cancelled and completed
  // bookings lose their guide assignment, so without it they never show up.
  for (const status of ['11', '15', '20', '30', '500']) query.append('guide_status_types[]', status);

  const res = await fetch(`${BOOKINGS_URL}?${query}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Buchungsliste: HTTP ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  // A logged-out session redirects to the login form, which answers 200. Say so
  // instead of reporting an empty month.
  if (doc.querySelector('input[type=password]')) throw new Error('Nicht angemeldet – bitte zuerst auf hsh.gomus.de einloggen.');

  const rows = [];
  let group = null;
  for (const tr of doc.querySelectorAll('table tr')) {
    if (tr.classList.contains('sticky-top')) {
      group = parseGermanDate(tr.textContent);
      continue;
    }
    if (!tr.classList.contains('booking-list-item')) continue;
    const row = parseBookingRow(tr, group, month);
    // end_at is inclusive of that whole day, so the first day of the next month
    // comes along; those bookings belong to the next invoice.
    if (row && row.date.startsWith(month)) rows.push(row);
  }
  return rows;
}

async function enrichBooking(row) {
  const res = await fetch(`${BOOKINGS_URL}/${row.id}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Buchung ${row.id}: HTTP ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const box = (name) => [...doc.querySelectorAll('.ibox')].find((node) => new RegExp(name).test(node.querySelector('.ibox-title')?.textContent || ''));
  const kunde = box('Kundendaten');
  const abrechnung = box('Abrechnung');
  const hinweise = box('Hinweise');

  // The detail boxes are definition lists; the tour itself ("Angebot") is only
  // named here — the list row shows the group label instead.
  const term = (name) => {
    const dt = [...doc.querySelectorAll('dt')].find((node) => node.textContent.trim().replace(/:$/, '') === name);
    const dd = dt && dt.nextElementSibling;
    return dd && dd.tagName === 'DD' ? dd.textContent.replace(/\s+/g, ' ').trim() : '';
  };

  const customer = (kunde?.querySelector('dd')?.textContent || '').replace(/\s+/g, ' ').trim();
  // The comment block holds more than the group name ("Alternative language: …"),
  // so keep only the Gruppenbezeichnung line.
  const commentText = hinweise?.querySelector('.booking-comment')?.textContent || '';
  const comment = (/Gruppenbezeichnung:\s*([^\n]+)/.exec(commentText) || [])[1]?.trim() || '';

  row.price = abrechnung ? [...abrechnung.querySelectorAll('td.price')].reduce((sum, td) => sum + parseMoney(td.textContent), 0) : 0;
  // "Honorar" for a tour that happened, "Ausfallhonorar" for a group cancellation.
  row.fee = (abrechnung?.querySelector('td:not(.price)')?.textContent || '').trim();
  row.customer = customer || comment || row.tour || `Buchung ${row.id}`;
  row.offer = term('Angebot') || row.tour;
  row.category = term('Angebotskategorie') || row.offer;
  row.participants = Number(term('Teilnehmende')) || row.participants || 0;
  return row;
}

async function invoiceNumberState() {
  const stored = await chrome.storage.sync.get({ invoiceNumbers: {}, invoiceStart: DEFAULTS.invoiceStart, invoicePrefix: DEFAULTS.invoicePrefix });
  const numbers = stored.invoiceNumbers || {};
  // Only the trailing digits count: prefixes may contain digits of their own ("RE-2026-100").
  const trailing = (value) => Number((/(\d+)\s*$/.exec(String(value)) || [])[1]) || 0;
  const highest = Object.values(numbers).reduce((max, value) => Math.max(max, trailing(value)), 0);
  const next = `${stored.invoicePrefix || ''}${String(Math.max(Number(stored.invoiceStart) || 1, highest + 1)).padStart(3, '0')}`;
  return { numbers, next };
}

// The preview shows the number the month would get, so it must not claim one.
async function peekInvoiceNumber(month) {
  const { numbers, next } = await invoiceNumberState();
  return numbers[month] || next;
}

async function assignInvoiceNumber(month) {
  const { numbers, next } = await invoiceNumberState();
  if (numbers[month]) return numbers[month];
  await chrome.storage.sync.set({ invoiceNumbers: { ...numbers, [month]: next } });
  return next;
}

function formatMoney(value) {
  return `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currencySymbol()}`;
}

function openInvoicePage() {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: 'tah-open-invoice' }, (reply) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else if (!reply || !reply.ok) reject(new Error((reply && reply.error) || 'Tab konnte nicht geöffnet werden.'));
        else resolve(reply);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function loadInvoiceRows(month) {
  const rows = await fetchMonthBookings(month);
  await pool(rows, CONCURRENCY, enrichBooking);
  // No amount on the Abrechnung means there is nothing to bill: the guide
  // cancelled, or the guide was moved off the booking. A cancellation by the
  // group carries an Ausfallhonorar and stays in.
  const billable = rows.filter((row) => row.price > 0);
  billable.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  return { rows: billable, skipped: rows.length - billable.length };
}

function skippedNote(count) {
  if (!count) return '';
  return `${count} ${count === 1 ? 'Buchung' : 'Buchungen'} ohne Honorar nicht berechnet (Absage durch den Guide oder Guidewechsel).`;
}

function setGenerateEnabled(enabled) {
  const go = document.querySelector('#tah-invoice-go');
  if (go) go.disabled = !enabled;
}

async function previewInvoice(month) {
  const token = ++state.invoiceToken;
  state.invoicePreview = null;
  renderInvoicePreview();
  setGenerateEnabled(false);
  invoiceStatus('Lade Buchungen …');
  try {
    const { rows, skipped } = await loadInvoiceRows(month);
    const number = await peekInvoiceNumber(month);
    if (token !== state.invoiceToken) return;
    state.invoicePreview = rows.length
      ? { month, rows, skipped, total: rows.reduce((sum, row) => sum + row.price, 0), number }
      : null;
    renderInvoicePreview();
    setGenerateEnabled(rows.length > 0);
    invoiceStatus(
      rows.length
        ? skippedNote(skipped)
        : `${monthLabel(month)}: keine berechenbaren Buchungen – es gibt nichts zu berechnen. ${skippedNote(skipped)}`.trim()
    );
  } catch (err) {
    if (token !== state.invoiceToken) return;
    setGenerateEnabled(true);
    invoiceStatus(`Fehler: ${err.message}`, { error: true });
  }
}

function renderInvoicePreview() {
  const box = document.querySelector('#tah-invoice-preview');
  if (!box) return;
  const preview = state.invoicePreview;
  box.hidden = !preview;
  if (!preview) return;

  const stat = (value, label) => {
    const node = el('span', { class: 'tah-invoice-stat' });
    node.append(el('strong', { text: value }), el('small', { text: label }));
    return node;
  };
  box.replaceChildren(
    stat(String(preview.rows.length), preview.rows.length === 1 ? 'Einsatz' : 'Einsätze'),
    stat(formatMoney(preview.total), 'Summe'),
    stat(preview.number, 'Rechnungsnummer')
  );
}

async function createInvoice(month) {
  // Reuse what the preview just loaded, so the invoice matches what was on screen.
  const preview = state.invoicePreview?.month === month ? state.invoicePreview : null;
  const rows = preview ? preview.rows : (await loadInvoiceRows(month)).rows;
  if (!rows.length) throw new Error(`${monthLabel(month)}: keine berechenbaren Buchungen – es gibt nichts zu berechnen.`);

  const invoice = {
    month,
    monthLabel: monthLabel(month),
    number: await assignInvoiceNumber(month),
    guide: guideName(),
    currency: currencySymbol(),
    rows,
    total: rows.reduce((sum, row) => sum + row.price, 0),
    createdAt: Date.now(),
  };
  await chrome.storage.local.set({ invoice });
  await openInvoicePage();
  return invoice;
}

function invoiceStatus(text, { error = false } = {}) {
  const node = document.querySelector('#tah-invoice-status');
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('tah-error', error);
}

let invoiceTimer = null;

function scheduleInvoicePreview(delay = 350) {
  clearTimeout(invoiceTimer);
  const month = document.querySelector('#tah-invoice-month');
  if (!month) return;
  const value = month.value;
  if (!/^\d{4}-\d{2}$/.test(value)) {
    state.invoiceToken += 1;
    state.invoicePreview = null;
    renderInvoicePreview();
    setGenerateEnabled(false);
    invoiceStatus('');
    return;
  }
  invoiceTimer = setTimeout(() => previewInvoice(value), delay);
}

function toggleInvoicePanel(open) {
  const panel = document.querySelector('#tah-invoice-panel');
  if (!panel) return false;
  panel.classList.toggle('tah-open', open);
  if (!open) {
    clearTimeout(invoiceTimer);
    state.invoiceToken += 1;
    return false;
  }
  document.querySelector('#tah-invoice-month').value = calendarMonth();
  invoiceStatus('');
  scheduleInvoicePreview(0);
  return true;
}

function mountInvoice() {
  if (document.querySelector('#tah-invoice-panel')) return;
  const box = calendarBox();
  const title = box?.querySelector('.ibox-title');
  if (!title) return;

  const group = el('div', { class: 'btn-group nobr' });
  const trigger = el('button', { class: 'btn btn-default btn-xs tah-invoice-trigger', type: 'button', title: 'Monatsrechnung erstellen (Alt+R)' });
  trigger.append(el('i', { class: 'fa fa-fw fa-file-text-o' }), el('span', { class: 'hidden-xs', text: ' Rechnung' }));
  group.append(trigger);
  (title.querySelector('.pull-right') || title).append(group);

  const panel = el('div', { id: 'tah-invoice-panel' });
  const month = el('input', { id: 'tah-invoice-month', type: 'month', class: 'tah-input' });
  const go = el('button', { id: 'tah-invoice-go', class: 'tah-btn', type: 'button', text: 'Rechnung erstellen' });
  const label = el('label', {}, ['Monat', month]);
  const previewBox = el('div', { id: 'tah-invoice-preview', class: 'tah-invoice-preview' });
  previewBox.hidden = true;
  panel.append(label, go, el('span', { id: 'tah-invoice-status', class: 'tah-invoice-status' }));
  panel.append(previewBox);
  panel.append(el('div', { class: 'tah-hint', text: 'Alle Einsätze des Monats, auch vergangene, unbestätigte und stornierte mit Ausfallhonorar. Alt+R zeigt die Vorschau, nochmal Alt+R erstellt die Rechnung.' }));
  title.append(panel);

  month.addEventListener('input', () => scheduleInvoicePreview());
  month.addEventListener('change', () => scheduleInvoicePreview());
  trigger.addEventListener('click', () => toggleInvoicePanel(!panel.classList.contains('tah-open')));

  go.addEventListener('click', async () => {
    const value = month.value;
    if (!/^\d{4}-\d{2}$/.test(value)) {
      invoiceStatus('Bitte einen Monat wählen.', { error: true });
      return;
    }
    go.disabled = true;
    if (state.invoicePreview?.month !== value) invoiceStatus('Lade Buchungen …');
    try {
      const invoice = await createInvoice(value);
      invoiceStatus(`Rechnung ${invoice.number} geöffnet.`);
    } catch (err) {
      invoiceStatus(`Fehler: ${err.message}`, { error: true });
    }
    go.disabled = false;
  });
}

/* ---------- shortcuts ---------- */

function navLinks() {
  const nav = document.querySelector('nav[role=navigation]');
  return nav ? [...nav.querySelectorAll('ul.nav > li > a[href]')].slice(0, 9) : [];
}

function annotateNav() {
  navLinks().forEach((link, i) => {
    if (link.dataset.tahShortcut) return;
    link.dataset.tahShortcut = `Alt+${i + 1}`;
    link.title = link.title ? `${link.title} (${link.dataset.tahShortcut})` : link.dataset.tahShortcut;
  });
}

// The month arrows are plain links to ?start_at=<month>; the month they point at
// is the only reliable way to tell previous from next (their labels are tooltips).
// Match exactly ±1: the middle "aktueller Monat" link points at today's month,
// not the one on screen, so a < / > comparison can pick the wrong arrow.
function calendarNavLinks() {
  const box = calendarBox();
  if (!box) return {};
  const current = calendarMonth();
  const links = [...box.querySelectorAll('.ibox-title a[href]')]
    .map((link) => ({ link, month: (new URL(link.href).searchParams.get('start_at') || '').slice(0, 7) }))
    .filter((entry) => /^\d{4}-\d{2}$/.test(entry.month));
  return {
    previous: links.find((entry) => entry.month === addMonths(current, -1))?.link,
    next: links.find((entry) => entry.month === addMonths(current, 1))?.link,
  };
}

// First Alt+R opens the panel with the preview, a second one bills the month —
// the same two steps as looking at the numbers and pressing the button.
function invoiceShortcut() {
  const panel = document.querySelector('#tah-invoice-panel');
  if (!panel) return false;

  if (!panel.classList.contains('tah-open')) {
    toggleInvoicePanel(true);
    return true;
  }

  const go = document.querySelector('#tah-invoice-go');
  const month = document.querySelector('#tah-invoice-month')?.value;
  if (go && !go.disabled && state.invoicePreview?.month === month) go.click();
  else scheduleInvoicePreview(0);
  return true;
}

// Alt+1…9 follow the site's own sidebar order, Alt+R opens the invoice panel,
// Alt+P / Alt+N walk the calendar month by month.
function onShortcutKey(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;

  if (event.code === 'KeyR') {
    if (invoiceShortcut()) event.preventDefault();
    return;
  }

  if (event.code === 'KeyS') {
    if (window.TAH_STATS?.toggle()) event.preventDefault();
    return;
  }

  if (event.code === 'KeyP' || event.code === 'KeyN') {
    const { previous, next } = calendarNavLinks();
    const link = event.code === 'KeyP' ? previous : next;
    if (!link) return;
    event.preventDefault();
    link.click();
    return;
  }

  const digit = /^Digit([1-9])$/.exec(event.code);
  if (!digit) return;
  const link = navLinks()[Number(digit[1]) - 1];
  if (!link) return;
  event.preventDefault();
  link.click();
}

function installShortcuts() {
  // The stats tab goes into the sidebar before the keys are handed out, so it
  // takes part in the Alt+1…9 order like every other entry.
  window.TAH_STATS?.installNav();
  annotateNav();
  document.addEventListener('keydown', onShortcutKey, true);
}

/* ---------- api for stats.js ---------- */

// stats.js is a separate content script in the same isolated world. It gets the
// page helpers through this object instead of reaching into this file's globals.
window.TAH_PAGE = {
  el,
  pool,
  MONTH_NAMES,
  monthKey,
  monthLabel,
  formatMoney,
  fetchMonthBookings,
  enrichBooking,
};

/* ---------- boot ---------- */

(async function boot() {
  await loadSettings();
  await loadCalendarSettings();
  applyNavLabels();
  installShortcuts();
  if (gridTable()) {
    mountPanel();
    document.addEventListener('click', onGridClick, true);
  }
  mountInvoice();
})();

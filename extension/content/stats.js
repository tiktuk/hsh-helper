'use strict';

// Statistics tab in the site's own sidebar. Everything is computed from the
// guide's booking list plus the Abrechnung box of each booking, the same two
// sources the invoice uses — the site has no statistics endpoint worth having.
//
// Loaded after content.js, in the same isolated world; the page helpers come
// from window.TAH_PAGE so this file never reaches into content.js' globals.
// Chart.js is vendored (vendor/chart.umd.min.js) because an MV3 extension may
// not load scripts from a CDN.
var TAH_STATS = (function () {
  const T = window.TAH_PAGE;
  if (!T) return undefined;

  const el = T.el;

  const PERIODS = [
    ['week', 'Woche'],
    ['month', 'Monat'],
    ['year', 'Jahr'],
  ];
  const WEEKDAY_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const MONTH_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  const PALETTE = ['#1e4b8c', '#4caf50', '#a1887f', '#f0a30a', '#7e57c2', '#26a69a', '#90a4ae'];

  // A month of list rows is cheap to refetch, a detail page is not: the price of
  // a booking does not change, only its status can.
  const LIST_TTL = 2 * 60 * 60 * 1000;
  const DETAIL_TTL = 7 * 24 * 60 * 60 * 1000;
  const DETAIL_MAX_AGE = 400 * 24 * 60 * 60 * 1000;
  const DETAIL_CONCURRENCY = 8;

  // Assumptions for the "what does an hour really pay" figures. The distance is
  // one way and is ridden twice on every workday; a pause between two tours is
  // time at the museum, not time off. Sync, not local: these describe the
  // person, like the invoice letterhead.
  const COMMUTE_DEFAULTS = {
    commuteKm: 10,
    commuteSpeed: 15,
    prepMinutes: 0,
    gapLimit: 45,
  };

  const view = {
    period: 'month',
    anchor: iso(new Date()),
    open: false,
    loading: false,
    token: 0,
    error: '',
    data: null,
    commute: { ...COMMUTE_DEFAULTS },
    charts: {},
    hiddenActive: [],
    observer: null,
  };

  /* ---------- dates ---------- */

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function iso(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function fromIso(value) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(date, days) {
    const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    copy.setDate(copy.getDate() + days);
    return copy;
  }

  function startOfWeek(date) {
    const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7));
    return copy;
  }

  const daysBetween = (a, b) => Math.round((b - a) / 86400000);

  // Minutes since local midnight. The booking list prints wall-clock times, so
  // no timezone conversion is involved here.
  function minutesOfTime(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
  }

  function clock(minutes) {
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  }

  function dayLabel(key) {
    const date = fromIso(key);
    return `${WEEKDAY_SHORT[(date.getDay() + 6) % 7]} ${key.split('-').reverse().join('.')}`;
  }

  // ISO 8601 week number: the week of the year's first Thursday.
  function isoWeek(date) {
    const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
    return Math.ceil(((utc - yearStart) / 86400000 + 1) / 7);
  }

  function rangeFor(period, anchor) {
    const date = fromIso(anchor);
    if (period === 'week') {
      const monday = startOfWeek(date);
      const sunday = addDays(monday, 6);
      const span =
        monday.getMonth() === sunday.getMonth()
          ? `${monday.getDate()}.–${sunday.getDate()}. ${MONTH_SHORT[sunday.getMonth()]}`
          : `${monday.getDate()}. ${MONTH_SHORT[monday.getMonth()]} – ${sunday.getDate()}. ${MONTH_SHORT[sunday.getMonth()]}`;
      return { from: iso(monday), to: iso(sunday), label: `KW ${isoWeek(monday)} · ${span} ${sunday.getFullYear()}` };
    }
    if (period === 'year') {
      return { from: `${date.getFullYear()}-01-01`, to: `${date.getFullYear()}-12-31`, label: String(date.getFullYear()) };
    }
    const first = new Date(date.getFullYear(), date.getMonth(), 1);
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return { from: iso(first), to: iso(last), label: T.monthLabel(T.monthKey(first)) };
  }

  function shiftPeriod(period, anchor, delta) {
    const date = fromIso(anchor);
    if (period === 'week') return iso(addDays(date, 7 * delta));
    if (period === 'year') return iso(new Date(date.getFullYear() + delta, 0, 1));
    return iso(new Date(date.getFullYear(), date.getMonth() + delta, 1));
  }

  function monthsInRange(from, to) {
    const months = [];
    const cursor = new Date(fromIso(from).getFullYear(), fromIso(from).getMonth(), 1);
    const end = new Date(fromIso(to).getFullYear(), fromIso(to).getMonth(), 1);
    while (cursor <= end) {
      months.push(T.monthKey(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return months;
  }

  /* ---------- data ---------- */

  function sum(rows, key) {
    return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  }

  function listRow(row) {
    return {
      id: row.id,
      date: row.date,
      time: row.time,
      duration: row.duration,
      cancelled: row.cancelled,
      tour: row.tour,
      participants: row.participants || 0,
    };
  }

  function setProgress(text) {
    const node = document.querySelector('#tah-stats-progress');
    if (node) node.textContent = text;
  }

  async function loadBookings(range, { force = false, token = 0 } = {}) {
    const months = monthsInRange(range.from, range.to);
    const stored = await chrome.storage.local.get({ statsMonths: {}, bookingDetails: {} });
    const monthCache = stored.statsMonths || {};
    const detailCache = stored.bookingDetails || {};
    let listDirty = false;
    let detailDirty = false;

    const rows = [];
    for (const [index, month] of months.entries()) {
      if (token && token !== view.token) return null;
      const hit = monthCache[month];
      let list;
      if (!force && hit && Date.now() - hit.fetchedAt < LIST_TTL) {
        list = hit.rows;
      } else {
        setProgress(`Lade Buchungen ${index + 1}/${months.length} …`);
        list = (await T.fetchMonthBookings(month)).map(listRow);
        monthCache[month] = { rows: list, fetchedAt: Date.now() };
        listDirty = true;
      }
      rows.push(...list.filter((row) => row.date >= range.from && row.date <= range.to));
    }

    // The price lives on the detail page. Fetch it once per booking and keep it:
    // a later period shows the same bookings without touching the server.
    const stale = rows.filter((row) => {
      const hit = detailCache[row.id];
      return force || !hit || hit.cancelled !== row.cancelled || Date.now() - hit.fetchedAt > DETAIL_TTL;
    });
    let failed = 0;
    let done = 0;
    if (stale.length) {
      await T.pool(stale, DETAIL_CONCURRENCY, async (row) => {
        try {
          const full = await T.enrichBooking({ ...row });
          detailCache[row.id] = {
            price: full.price,
            fee: full.fee || '',
            offer: full.offer || row.tour,
            category: full.category || full.offer || row.tour,
            participants: full.participants || 0,
            cancelled: row.cancelled,
            fetchedAt: Date.now(),
          };
          detailDirty = true;
        } catch {
          failed += 1;
        }
        done += 1;
        setProgress(`Lade Honorare … ${done}/${stale.length}`);
      });
    }

    if (listDirty || detailDirty) {
      for (const [id, detail] of Object.entries(detailCache)) {
        if (Date.now() - detail.fetchedAt > DETAIL_MAX_AGE) delete detailCache[id];
      }
      await chrome.storage.local.set({ statsMonths: monthCache, bookingDetails: detailCache });
    }

    const bookings = rows.map((row) => {
      const detail = detailCache[row.id];
      return {
        ...row,
        price: detail ? detail.price : 0,
        fee: detail ? detail.fee : '',
        offer: detail ? detail.offer : row.tour,
        category: detail ? detail.category : row.tour,
        participants: detail ? detail.participants : row.participants,
      };
    });
    return { bookings, failed };
  }

  /* ---------- aggregation ---------- */

  function aggregate(bookings) {
    // Only rows with an amount are the guide's work: no amount means the guide
    // cancelled or was moved off the booking (see the invoice notes).
    const billable = bookings.filter((row) => row.price > 0);
    const tours = billable.filter((row) => !row.cancelled);
    const cancellations = billable.filter((row) => row.cancelled);
    const minutes = sum(tours, 'duration');
    const days = new Set(tours.map((row) => row.date));
    // Weeks that actually have a tour: a year has many empty weeks, so counting
    // all 52 would make every guide look idle.
    const weeks = new Set(tours.map((row) => iso(startOfWeek(fromIso(row.date)))));
    return {
      billable,
      tours,
      cancellations,
      income: sum(billable, 'price'),
      tourIncome: sum(tours, 'price'),
      feeIncome: sum(cancellations, 'price'),
      minutes,
      participants: sum(tours, 'participants'),
      days: days.size,
      weeks: weeks.size,
      skipped: bookings.length - billable.length,
    };
  }

  // A workday is one calendar date with at least one billable tour. It starts
  // with the first tour and ends with the last, so a split shift is paid by the
  // tour but spent by the day: the pause in between is neither work nor free.
  // The commute is ridden twice per workday, because the guide stays on site.
  function workload(tours, settings, period, range) {
    const km = Math.max(0, Number(settings.commuteKm) || 0);
    const speed = Math.max(1, Number(settings.commuteSpeed) || 1);
    const prep = Math.max(0, Math.round(Number(settings.prepMinutes) || 0));
    const limit = Math.max(1, Math.round(Number(settings.gapLimit) || 1));
    const commute = km > 0 ? Math.round(((2 * km) / speed) * 60) : 0;

    const byDate = new Map();
    for (const row of tours) {
      if (!byDate.has(row.date)) byDate.set(row.date, []);
      byDate.get(row.date).push(row);
    }

    const days = [...byDate.keys()].sort().map((date) => {
      const rows = byDate.get(date);
      const items = rows.map((row) => {
        const start = minutesOfTime(row.time);
        const duration = Number(row.duration) || 0;
        return { start, end: start + duration, duration };
      });
      const timed = items.filter((item) => Number.isFinite(item.start));
      const work = items.reduce((total, item) => total + item.duration, 0);
      const first = timed.length ? Math.min(...timed.map((item) => item.start)) : 0;
      const last = timed.length ? Math.max(...timed.map((item) => item.end)) : work;
      // Overlapping rows (a 105-minute tour listed at 09:55 and 11:15) would
      // otherwise give a negative pause; the tours themselves are the floor.
      const span = Math.max(work, last - first);
      const gap = span - work;
      const away = span + commute + prep;
      const income = rows.reduce((total, row) => total + (Number(row.price) || 0), 0);
      return {
        date,
        rows,
        first,
        last,
        work,
        span,
        gap,
        commute,
        prep,
        away,
        income,
        band: gap <= limit ? 'efficient' : gap <= limit * 2 ? 'medium' : 'long',
      };
    });

    const total = (key) => days.reduce((sum, day) => sum + day[key], 0);
    const work = total('work');
    const gap = total('gap');
    const away = total('away');
    const income = total('income');
    const longest = days.reduce((best, day) => (!best || day.gap > best.gap ? day : best), null);
    const multi = days.filter((day) => day.rows.length > 1);
    const count = (band) => days.filter((day) => day.band === band).length;
    const paidRate = work ? income / (work / 60) : 0;

    return {
      days,
      limit,
      km,
      work,
      gap,
      away,
      income,
      commuteTotal: days.length * commute,
      kmTotal: days.length * 2 * km,
      paidRate,
      effectiveRate: away ? income / (away / 60) : 0,
      efficiency: away ? Math.min(1, work / away) : 0,
      lost: paidRate ? (gap / 60) * paidRate : 0,
      efficient: count('efficient'),
      medium: count('medium'),
      long: count('long'),
      longest: longest && longest.gap > 0 ? longest : null,
      multi,
      chart: workloadTimeline(period, range, days),
    };
  }

  // Same buckets as the income timeline, so the two charts line up; the bars are
  // hours instead of euros.
  function workloadTimeline(period, range, days) {
    const buckets =
      period === 'year'
        ? MONTH_SHORT.map((label, index) => ({ key: `${range.from.slice(0, 4)}-${pad(index + 1)}`, label }))
        : bucketDays(range.from, range.to).map((bucket) => ({
            ...bucket,
            label: period === 'week' ? `${WEEKDAY_SHORT[(bucket.date.getDay() + 6) % 7]} ${bucket.label}` : bucket.label,
          }));
    const indexOf = new Map(buckets.map((bucket, index) => [bucket.key, index]));
    const work = buckets.map(() => 0);
    const gap = buckets.map(() => 0);
    const commute = buckets.map(() => 0);
    for (const day of days) {
      const key = period === 'year' ? day.date.slice(0, 7) : day.date;
      const index = indexOf.get(key);
      if (index === undefined) continue;
      work[index] += day.work / 60;
      gap[index] += day.gap / 60;
      commute[index] += (day.commute + day.prep) / 60;
    }
    return { labels: buckets.map((bucket) => bucket.label), work, gap, commute };
  }

  function bucketDays(from, to) {
    const buckets = [];
    for (let day = fromIso(from); iso(day) <= to; day = addDays(day, 1)) {
      buckets.push({ key: iso(day), label: String(day.getDate()), date: day });
    }
    return buckets;
  }

  function timeline(period, range, bookings) {
    const buckets =
      period === 'year'
        ? MONTH_SHORT.map((label, index) => ({ key: `${range.from.slice(0, 4)}-${pad(index + 1)}`, label }))
        : bucketDays(range.from, range.to).map((bucket) => ({
            ...bucket,
            label: period === 'week' ? `${WEEKDAY_SHORT[(bucket.date.getDay() + 6) % 7]} ${bucket.label}` : bucket.label,
          }));

    const honorar = buckets.map(() => 0);
    const ausfall = buckets.map(() => 0);
    const count = buckets.map(() => 0);
    const indexOf = new Map(buckets.map((bucket, index) => [bucket.key, index]));

    for (const row of bookings) {
      const key = period === 'year' ? row.date.slice(0, 7) : row.date;
      const index = indexOf.get(key);
      if (index === undefined || row.price <= 0) continue;
      if (row.cancelled) ausfall[index] += row.price;
      else {
        honorar[index] += row.price;
        count[index] += 1;
      }
    }
    return { labels: buckets.map((bucket) => bucket.label), honorar, ausfall, count };
  }

  function byWeekday(bookings) {
    const counts = new Array(7).fill(0);
    const income = new Array(7).fill(0);
    for (const row of bookings) {
      if (row.cancelled || row.price <= 0) continue;
      const day = (fromIso(row.date).getDay() + 6) % 7;
      counts[day] += 1;
      income[day] += row.price;
    }
    return { counts, income };
  }

  function byTime(bookings) {
    const map = new Map();
    for (const row of bookings) {
      if (row.cancelled || row.price <= 0) continue;
      map.set(row.time, (map.get(row.time) || 0) + 1);
    }
    const times = [...map.keys()].sort();
    return { labels: times, counts: times.map((time) => map.get(time)) };
  }

  function byOffer(bookings, limit = 6) {
    const map = new Map();
    for (const row of bookings) {
      if (row.cancelled || row.price <= 0) continue;
      const key = row.offer || row.category || row.tour || 'Ohne Angebot';
      map.set(key, (map.get(key) || 0) + 1);
    }
    const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
    const head = entries.slice(0, limit);
    const rest = entries.slice(limit);
    if (rest.length) head.push([`Weitere (${rest.length})`, rest.reduce((total, [, value]) => total + value, 0)]);
    return { labels: head.map(([label]) => label), counts: head.map(([, value]) => value) };
  }

  function quantile(values, q) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const position = (sorted.length - 1) * q;
    const base = Math.floor(position);
    const rest = position - base;
    return sorted[base] + (sorted[base + 1] === undefined ? 0 : rest * (sorted[base + 1] - sorted[base]));
  }

  // Year-end forecast. Bookings are made weeks ahead, so a week that is still
  // empty is not going to stay empty: every remaining week is estimated at the
  // median of the completed weeks, or at what is already booked if that is
  // more. The band uses the same weeks' quartiles. It is a run rate with a
  // memory, not a promise — the chart says so.
  function forecastYear(bookings, year) {
    const today = iso(new Date());
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    if (yearEnd < today) {
      const done = bookings.filter((row) => row.price > 0);
      return { kind: 'past', total: sum(done, 'price'), tours: done.filter((row) => !row.cancelled).length };
    }
    if (yearStart > today) {
      const planned = bookings.filter((row) => row.price > 0);
      return { kind: 'future', total: sum(planned, 'price'), tours: planned.filter((row) => !row.cancelled).length };
    }

    const todayDate = fromIso(today);
    const startDate = fromIso(yearStart);
    const endDate = fromIso(yearEnd);
    const actualRows = bookings.filter((row) => row.price > 0 && row.date <= today);
    const futureRows = bookings.filter((row) => row.price > 0 && row.date > today);
    const actual = sum(actualRows, 'price');
    const booked = sum(futureRows, 'price');

    // Completed, whole weeks inside the year.
    const weekly = [];
    for (let monday = startOfWeek(startDate); monday <= endDate; monday = addDays(monday, 7)) {
      const sunday = addDays(monday, 6);
      if (iso(monday) < yearStart || iso(sunday) > yearEnd || sunday >= todayDate) continue;
      weekly.push(sum(bookings.filter((row) => row.date >= iso(monday) && row.date <= iso(sunday)), 'price'));
    }

    const months = new Array(12).fill(0);
    const add = new Array(12).fill(0);
    const lowAdd = new Array(12).fill(0);
    const highAdd = new Array(12).fill(0);

    let typical;
    let lowWeek;
    let highWeek;
    let method;
    if (weekly.length >= 3) {
      typical = quantile(weekly, 0.5);
      lowWeek = quantile(weekly, 0.25);
      highWeek = quantile(weekly, 0.75);
      method = `${weekly.length} abgeschlossene Wochen, Median ${T.formatMoney(typical)} pro Woche`;
    } else {
      // Too little history for a median: spread the actual income over the days
      // of the year that are gone and use that as the weekly rate.
      const elapsed = Math.max(1, daysBetween(startDate, todayDate) + 1);
      const perDay = actual / elapsed;
      typical = perDay * 7;
      lowWeek = typical * 0.75;
      highWeek = typical * 1.25;
      method = 'Tagesdurchschnitt des bisherigen Jahres (noch wenige Wochen Daten)';
    }

    for (let monday = startOfWeek(todayDate); monday <= endDate; monday = addDays(monday, 7)) {
      const days = [];
      for (let offset = 0; offset < 7; offset += 1) {
        const day = addDays(monday, offset);
        if (day > todayDate && iso(day) <= yearEnd) days.push(iso(day));
      }
      if (!days.length) continue;
      const inWeek = days.filter((day) => day <= yearEnd);
      const bookedInWeek = sum(futureRows.filter((row) => inWeek.includes(row.date)), 'price');
      const fraction = inWeek.length / 7;
      const expected = Math.max(bookedInWeek, typical * fraction);
      const low = Math.max(bookedInWeek, lowWeek * fraction);
      const high = Math.max(bookedInWeek, highWeek * fraction);
      const thursday = addDays(monday, 3);
      const month = thursday > endDate ? 11 : thursday.getMonth();
      add[month] += expected;
      lowAdd[month] += low;
      highAdd[month] += high;
    }

    for (const row of actualRows) months[Number(row.date.slice(5, 7)) - 1] += row.price;

    const currentMonth = todayDate.getMonth();
    const cumulative = [];
    let running = 0;
    for (const value of months) {
      running += value;
      cumulative.push(running);
    }
    const forecast = [];
    const lowSeries = [];
    const highSeries = [];
    let projection = actual;
    let lowProjection = actual;
    let highProjection = actual;
    for (let month = 0; month < 12; month += 1) {
      if (month < currentMonth) {
        forecast.push(null);
        lowSeries.push(null);
        highSeries.push(null);
        continue;
      }
      if (month > currentMonth) {
        projection += add[month];
        lowProjection += lowAdd[month];
        highProjection += highAdd[month];
      }
      forecast.push(projection);
      lowSeries.push(lowProjection);
      highSeries.push(highProjection);
    }

    return {
      kind: 'current',
      actual,
      booked,
      total: actual + add.reduce((total, value) => total + value, 0),
      low: actual + lowAdd.reduce((total, value) => total + value, 0),
      high: actual + highAdd.reduce((total, value) => total + value, 0),
      planned: futureRows.filter((row) => !row.cancelled).length,
      method,
      chart: {
        labels: MONTH_SHORT,
        actual: cumulative.map((value, month) => (month <= currentMonth ? value : null)),
        forecast,
        low: lowSeries,
        high: highSeries,
      },
    };
  }

  function buildStats(bookings, range, extra = {}) {
    const agg = aggregate(bookings);
    const period = view.period;
    const year = Number(range.from.slice(0, 4));
    return {
      range,
      period,
      agg,
      bookings,
      failed: extra.failed || 0,
      timeline: timeline(period, range, agg.billable),
      workload: workload(agg.tours, view.commute, period, range),
      weekdays: byWeekday(agg.tours),
      times: byTime(agg.tours),
      offers: byOffer(agg.tours),
      forecast: period === 'year' ? forecastYear(bookings, year) : null,
    };
  }

  /* ---------- formatting ---------- */

  function moneyShort(value) {
    return `${Math.round(value).toLocaleString('de-DE')} €`;
  }

  function hours(minutes) {
    const value = minutes / 60;
    return `${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })} h`;
  }

  /* ---------- view ---------- */

  function installNav() {
    const nav = document.querySelector('nav[role=navigation] ul.nav');
    if (!nav) return false;
    if (nav.querySelector('#tah-nav-stats')) return true;

    const li = el('li', { class: 'menu' });
    const link = el('a', { id: 'tah-nav-stats', href: '#statistik', title: 'Statistik' });
    link.append(el('i', { class: 'fa fa-bar-chart' }), el('span', { class: 'nav-label', text: 'Statistik' }));
    link.addEventListener('click', (event) => {
      event.preventDefault();
      // Resolved at click time, not captured: the dev harness can re-inject this
      // file, and the sidebar item outlives the instance that created it.
      window.TAH_STATS?.open();
    });
    li.append(link);

    // After the last guide entry, before the help link: the site's own order
    // stays untouched and Alt+1…9 keeps its numbering for those entries.
    const entries = [...nav.children];
    const last = [...entries].reverse().find((node) => node.querySelector('a[href^="/guide/"]'));
    if (last) last.after(li);
    else nav.append(li);
    return true;
  }

  function markNav(on) {
    const li = document.querySelector('#tah-nav-stats')?.closest('li');
    if (!li) return;
    li.classList.toggle('tah-nav-active', on);
    if (on) {
      // The page underneath keeps its own active entry; hide it while the
      // stats tab is the one on screen, and give it back on close.
      view.hiddenActive = [...document.querySelectorAll('nav[role=navigation] ul.nav > li.active')].filter((node) => node !== li);
      for (const node of view.hiddenActive) node.classList.remove('active');
    } else {
      for (const node of view.hiddenActive) node.classList.add('active');
      view.hiddenActive = [];
    }
  }

  // The view covers the content area only: the sidebar and the top bar stay
  // usable, so the stats tab still looks like a tab of the site. Both are
  // `position: relative/absolute` on this site, so they scroll away — measure
  // where they actually are, not where the theme says they should be.
  function position(root) {
    const nav = document.querySelector('nav[role=navigation].navbar-static-side') || document.querySelector('nav[role=navigation]');
    const top = document.querySelector('.navbar-static-top') || document.querySelector('.navbar-fixed-top');
    const navRect = nav ? nav.getBoundingClientRect() : null;
    const topRect = top ? top.getBoundingClientRect() : null;
    const left = navRect && navRect.bottom > 0 ? Math.max(0, Math.round(navRect.right)) : 0;
    const topPx = topRect ? Math.max(0, Math.round(topRect.bottom)) : 0;
    root.style.left = `${left}px`;
    root.style.top = `${topPx}px`;
  }

  function onResize() {
    const root = document.querySelector('#tah-stats');
    if (root) position(root);
  }

  function onKey(event) {
    if (event.key === 'Escape' && view.open) {
      event.preventDefault();
      close();
    }
  }

  function buildRoot() {
    const root = el('div', { id: 'tah-stats' });
    const head = el('div', { class: 'tah-stats-head' });

    const title = el('div', { class: 'tah-stats-title' });
    title.append(el('h2', { text: 'Statistik' }));
    title.append(el('span', { class: 'tah-stats-sub', text: 'Einnahmen, Einsätze und Prognose aus deinen Buchungen' }));
    head.append(title);

    const tools = el('div', { class: 'tah-stats-tools' });
    const segs = el('div', { class: 'tah-segs' });
    for (const [value, label] of PERIODS) {
      const seg = el('button', { class: `tah-seg${view.period === value ? ' tah-seg-on' : ''}`, type: 'button', text: label, 'data-period': value });
      seg.addEventListener('click', () => setPeriod(value));
      segs.append(seg);
    }
    tools.append(segs);

    const nav = el('div', { class: 'tah-stats-nav' });
    const previous = el('button', { class: 'tah-stats-arrow', type: 'button', title: 'Vorheriger Zeitraum', text: '‹' });
    previous.addEventListener('click', () => step(-1));
    const next = el('button', { class: 'tah-stats-arrow', type: 'button', title: 'Nächster Zeitraum', text: '›' });
    next.addEventListener('click', () => step(1));
    nav.append(previous, el('strong', { id: 'tah-stats-period', text: '' }), next);
    tools.append(nav);

    const refresh = el('button', { class: 'tah-stats-btn', type: 'button', title: 'Neu laden', text: '↻' });
    refresh.addEventListener('click', () => load({ force: true }));
    tools.append(refresh);

    const closeBtn = el('button', { class: 'tah-stats-close', type: 'button', title: 'Schließen (Esc)', text: '✕' });
    closeBtn.addEventListener('click', () => close());
    tools.append(closeBtn);

    head.append(tools);
    head.append(el('span', { id: 'tah-stats-progress', class: 'tah-stats-progress' }));

    root.append(head, el('div', { id: 'tah-stats-body', class: 'tah-stats-body' }));
    return root;
  }

  function open() {
    if (document.querySelector('#tah-stats')) return true;
    const root = buildRoot();
    document.body.append(root);
    view.open = true;
    document.body.classList.add('tah-stats-open');
    markNav(true);
    position(root);
    window.addEventListener('resize', onResize);
    // The rail can be collapsed or expanded from the site's own button; the
    // view has to follow the width.
    view.observer = new MutationObserver(onResize);
    view.observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('keydown', onKey, true);
    document.querySelector('#tah-stats-period').textContent = rangeFor(view.period, view.anchor).label;
    load();
    return true;
  }

  function close() {
    const root = document.querySelector('#tah-stats');
    if (!root) return false;
    destroyCharts();
    root.remove();
    view.open = false;
    view.token += 1;
    document.body.classList.remove('tah-stats-open');
    markNav(false);
    window.removeEventListener('resize', onResize);
    view.observer?.disconnect();
    view.observer = null;
    document.removeEventListener('keydown', onKey, true);
    return true;
  }

  function toggle() {
    return view.open ? close() : open();
  }

  function setPeriod(period) {
    if (!PERIODS.some(([value]) => value === period)) return;
    view.period = period;
    view.anchor = iso(new Date());
    document.querySelectorAll('#tah-stats .tah-seg').forEach((seg) => {
      seg.classList.toggle('tah-seg-on', seg.dataset.period === period);
    });
    const label = document.querySelector('#tah-stats-period');
    if (label) label.textContent = rangeFor(period, view.anchor).label;
    chrome.storage.local.set({ statsPeriod: period });
    load();
  }

  function step(delta) {
    view.anchor = shiftPeriod(view.period, view.anchor, delta);
    const label = document.querySelector('#tah-stats-period');
    if (label) label.textContent = rangeFor(view.period, view.anchor).label;
    load();
  }

  function destroyCharts() {
    for (const chart of Object.values(view.charts)) {
      try {
        chart.destroy();
      } catch {
        /* already gone with the node */
      }
    }
    view.charts = {};
  }

  function chart(id, config) {
    const node = document.getElementById(id);
    if (!node || typeof Chart === 'undefined') return null;
    const instance = new Chart(node, config);
    view.charts[id] = instance;
    return instance;
  }

  function kpi(value, label, note, { main = false } = {}) {
    const box = el('div', { class: `tah-kpi${main ? ' tah-kpi-main' : ''}` });
    box.append(el('strong', { text: value }), el('span', { class: 'tah-kpi-label', text: label }));
    if (note) box.append(el('small', { text: note }));
    return box;
  }

  function figure(id, caption, { wide = false } = {}) {
    const box = el('figure', { class: `tah-chart${wide ? ' tah-chart-wide' : ''}` });
    box.append(el('figcaption', { text: caption }));
    const holder = el('div', { class: 'tah-canvas' });
    holder.append(el('canvas', { id }));
    box.append(holder);
    return box;
  }

  function empty(text) {
    return el('p', { class: 'tah-stats-empty', text });
  }

  /* ---------- commute & pauses ---------- */

  // The four assumptions are editable right where their effect is visible: the
  // view is the only consumer, so this is their one place. They are written to
  // sync storage, like the invoice's person data.
  function numberField(key, label, { min = 0, step = 1 } = {}) {
    const wrap = el('label', { class: 'tah-assume-field' });
    wrap.append(el('span', { text: label }));
    const input = el('input', {
      type: 'number',
      min: String(min),
      step: String(step),
      value: String(view.commute[key]),
    });
    input.addEventListener('change', () => {
      const value = Math.max(min, Number(input.value) || 0);
      input.value = String(value);
      view.commute[key] = value;
      try {
        chrome.storage.sync.set({ [key]: value }).catch(() => {});
      } catch {
        /* no sync storage (the harness stubs it) */
      }
      recompute();
    });
    wrap.append(input);
    return wrap;
  }

  function assumptionsCard() {
    const box = el('div', { class: 'tah-assume' });
    const head = el('div', { class: 'tah-assume-head' });
    head.append(el('h3', { text: 'Arbeitsweg & Pausen' }));
    head.append(
      el('span', {
        class: 'tah-assume-hint',
        text: 'Hin- und Rückfahrt je Arbeitstag; die Pause zwischen zwei Einsätzen ist Anwesenheit, keine Freizeit.',
      })
    );
    box.append(head);

    const fields = el('div', { class: 'tah-assume-fields' });
    fields.append(
      numberField('commuteKm', 'Anfahrt (km, einfach)', { step: 0.5 }),
      numberField('commuteSpeed', 'Radtempo (km/h)', { min: 1 }),
      numberField('prepMinutes', 'Rüstzeit je Tag (min)', { step: 5 }),
      numberField('gapLimit', 'Pause bis (min) gilt als effizient', { min: 1, step: 5 })
    );
    box.append(fields);
    return box;
  }

  function workloadCard(wl) {
    const box = el('section', { class: 'tah-workload' });
    box.append(assumptionsCard());

    const kpis = el('div', { class: 'tah-kpis' });
    kpis.append(
      kpi(
        wl.effectiveRate ? `${T.formatMoney(wl.effectiveRate)}/h` : '–',
        'Effektiver Stundensatz',
        wl.paidRate ? `statt ${T.formatMoney(wl.paidRate)}/h pro Tourstunde` : ''
      ),
      kpi(hours(wl.gap), 'Wartezeit', wl.gap ? `entspricht ${T.formatMoney(wl.lost)} Honorar` : 'keine Pausen'),
      kpi(
        wl.km ? `${wl.kmTotal.toLocaleString('de-DE', { maximumFractionDigits: 0 })} km` : '–',
        'Radkilometer',
        wl.km ? `${hours(wl.commuteTotal)} Fahrzeit · ${wl.days.length * 2} Fahrten` : 'keine Anfahrt eingetragen'
      ),
      kpi(`${Math.round(wl.efficiency * 100)} %`, 'Effizienz', 'bezahlte Zeit von Tür zu Tür')
    );

    const small = el('div', { class: 'tah-kpis tah-kpis-small' });
    small.append(
      kpi(String(wl.efficient), 'Effiziente Tage', `von ${wl.days.length} · Pause ≤ ${wl.limit} min`),
      kpi(
        String(wl.medium + wl.long),
        'Tage mit Pause',
        wl.medium + wl.long === 0
          ? 'keine über dem Limit'
          : wl.long
            ? `davon ${wl.long} über ${wl.limit * 2} min`
            : `über ${wl.limit} min`
      ),
      kpi(wl.longest ? hours(wl.longest.gap) : '–', 'Längste Pause', wl.longest ? dayLabel(wl.longest.date) : 'keine'),
      kpi(
        String(wl.multi.length),
        'Tage mit 2+ Einsätzen',
        wl.days.length ? `${Math.round((wl.multi.length / wl.days.length) * 100)} % der Arbeitstage` : 'keine geteilten Tage'
      )
    );

    // The distribution sits next to its key figures instead of in the chart
    // grid: the grid is laid out for three small charts and a fourth would be
    // left alone in a row.
    const body = el('div', { class: 'tah-workload-body' });
    const figures = el('div', { class: 'tah-workload-kpis' });
    figures.append(kpis, small);
    body.append(figures, figure('tah-chart-efficiency', 'Arbeitstage nach Pausenlänge'));
    box.append(body);
    return box;
  }

  // Recompute from the bookings already in memory: changing an assumption must
  // not refetch a year of detail pages.
  function recompute() {
    if (!view.data) return;
    const { bookings, range, failed } = view.data;
    view.data = buildStats(bookings, range, { failed });
    render();
  }

  function render() {
    const body = document.querySelector('#tah-stats-body');
    if (!body) return;
    destroyCharts();
    body.replaceChildren();

    if (view.error) {
      const box = el('div', { class: 'tah-stats-error' });
      box.append(el('strong', { text: 'Statistik nicht verfügbar' }), el('span', { text: view.error }));
      const retry = el('button', { class: 'tah-stats-btn', type: 'button', text: 'Erneut versuchen' });
      retry.addEventListener('click', () => load({ force: true }));
      box.append(retry);
      body.append(box);
      setProgress('');
      return;
    }

    if (!view.data) {
      body.append(el('p', { class: 'tah-stats-empty', text: 'Lade Statistik …' }));
      return;
    }

    const { agg, range, period, forecast } = view.data;
    setProgress('');

    const kpis = el('div', { class: 'tah-kpis' });
    const perTour = agg.tours.length ? agg.tourIncome / agg.tours.length : 0;
    const perHour = agg.minutes ? agg.tourIncome / (agg.minutes / 60) : 0;
    kpis.append(
      kpi(T.formatMoney(agg.income), 'Einnahmen', agg.feeIncome ? `davon ${T.formatMoney(agg.feeIncome)} Ausfallhonorar` : '', { main: true }),
      kpi(String(agg.tours.length), 'Einsätze', `${agg.days} ${agg.days === 1 ? 'Arbeitstag' : 'Arbeitstage'}`),
      kpi(T.formatMoney(perTour), 'Ø pro Einsatz', perTour ? `Median ${T.formatMoney(median(agg.tours.map((row) => row.price)))}` : ''),
      kpi(hours(agg.minutes), 'Arbeitszeit', perHour ? `Ø ${T.formatMoney(perHour)}/h` : '')
    );
    body.append(kpis);

    const small = el('div', { class: 'tah-kpis tah-kpis-small' });
    small.append(
      kpi(String(agg.participants.toLocaleString('de-DE')), 'Teilnehmende', agg.tours.length ? `Ø ${Math.round(agg.participants / agg.tours.length)} pro Einsatz` : ''),
      kpi(agg.cancellations.length ? String(agg.cancellations.length) : '0', 'Absagen', agg.cancellations.length ? T.formatMoney(agg.feeIncome) : 'keine'),
      kpi(agg.weeks ? (agg.tours.length / agg.weeks).toLocaleString('de-DE', { maximumFractionDigits: 1 }) : '0', 'Einsätze / Woche', agg.weeks ? `über ${agg.weeks} ${agg.weeks === 1 ? 'Woche' : 'Wochen'}` : ''),
      kpi(agg.billable.length ? `${Math.round((agg.cancellations.length / agg.billable.length) * 100)} %` : '–', 'Absagequote', 'der berechenbaren Buchungen')
    );
    body.append(small);

    if (forecast) body.append(forecastCard(forecast, range));
    if (agg.tours.length) body.append(workloadCard(view.data.workload));

    if (!agg.billable.length) {
      body.append(empty('Keine berechenbaren Buchungen in diesem Zeitraum.'));
    } else {
      const charts = el('div', { class: 'tah-charts' });
      charts.append(figure('tah-chart-income', period === 'year' ? 'Einnahmen je Monat' : 'Einnahmen je Tag', { wide: true }));
      charts.append(
        figure(
          'tah-chart-workload',
          period === 'year' ? 'Zeitaufwand je Monat: Arbeit, Wartezeit, Anfahrt' : 'Zeitaufwand je Tag: Arbeit, Wartezeit, Anfahrt',
          { wide: true }
        )
      );
      if (forecast && forecast.kind === 'current') charts.append(figure('tah-chart-forecast', 'Prognose bis Jahresende (kumuliert)', { wide: true }));
      charts.append(figure('tah-chart-weekday', 'Einsätze nach Wochentag'));
      charts.append(figure('tah-chart-offer', 'Angebote nach Einsätzen'));
      charts.append(figure('tah-chart-time', 'Startzeiten'));
      body.append(charts);
    }

    const insights = insightList(view.data);
    if (insights.length) {
      const box = el('div', { class: 'tah-insights' });
      box.append(el('h3', { text: 'Auffälligkeiten' }));
      const list = el('ul');
      for (const text of insights) list.append(el('li', { text }));
      box.append(list);
      body.append(box);
    }

    const notes = [];
    if (agg.skipped) {
      notes.push(
        `${agg.skipped} ${agg.skipped === 1 ? 'Buchung' : 'Buchungen'} ohne Honorar nicht gezählt (Absage durch dich oder Guidewechsel).`
      );
    }
    if (view.data.failed) notes.push(`${view.data.failed} ${view.data.failed === 1 ? 'Buchung' : 'Buchungen'} konnten nicht geladen werden.`);
    notes.push('Daten aus der Buchungsliste und den Abrechnungsbeträgen der Buchungsdetails. Zwischengespeichert, „↻“ lädt neu.');
    body.append(el('p', { class: 'tah-stats-note', text: notes.join(' ') }));

    drawCharts(view.data);
  }

  function median(values) {
    return quantile(values, 0.5);
  }

  function forecastCard(forecast, range) {
    const box = el('section', { class: `tah-forecast tah-forecast-${forecast.kind}` });

    if (forecast.kind === 'past') {
      box.append(el('span', { class: 'tah-forecast-label', text: `${range.from.slice(0, 4)} abgeschlossen` }));
      box.append(el('strong', { text: T.formatMoney(forecast.total) }));
      box.append(el('span', { class: 'tah-forecast-range', text: `${forecast.tours} Einsätze im Jahr` }));
      return box;
    }
    if (forecast.kind === 'future') {
      box.append(el('span', { class: 'tah-forecast-label', text: `${range.from.slice(0, 4)} liegt noch vor uns` }));
      box.append(el('strong', { text: T.formatMoney(forecast.total) }));
      box.append(el('span', { class: 'tah-forecast-range', text: `bereits gebucht: ${forecast.tours} Einsätze` }));
      return box;
    }

    box.append(el('span', { class: 'tah-forecast-label', text: `Prognose zum 31.12.${range.from.slice(0, 4)}` }));
    box.append(el('strong', { text: T.formatMoney(forecast.total) }));
    box.append(el('span', { class: 'tah-forecast-range', text: `Spanne ${moneyShort(forecast.low)} – ${moneyShort(forecast.high)}` }));

    const meta = el('div', { class: 'tah-forecast-meta' });
    meta.append(
      el('span', { text: `Bisher ${T.formatMoney(forecast.actual)}` }),
      el('span', { text: `Bereits gebucht ${T.formatMoney(forecast.booked)} (${forecast.planned} ${forecast.planned === 1 ? 'Einsatz' : 'Einsätze'})` }),
      el('span', { text: `Grundlage: ${forecast.method}` })
    );
    box.append(meta);
    return box;
  }

  function insightList(data) {
    const { agg, weekdays, times, offers, range } = data;
    const out = [];
    if (!agg.tours.length) return out;

    const bestDay = weekdays.counts.indexOf(Math.max(...weekdays.counts));
    if (weekdays.counts[bestDay] > 0) {
      out.push(`Stärkster Wochentag: ${['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'][bestDay]} (${weekdays.counts[bestDay]} Einsätze)`);
    }
    const bestTime = times.counts.indexOf(Math.max(...times.counts));
    if (times.counts[bestTime] > 0) out.push(`Häufigste Startzeit: ${times.labels[bestTime]} Uhr (${times.counts[bestTime]}×)`);

    if (data.period === 'year') {
      const monthly = data.timeline.honorar.map((value, index) => value + data.timeline.ausfall[index]);
      const best = monthly.indexOf(Math.max(...monthly));
      if (monthly[best] > 0) out.push(`Bester Monat: ${T.MONTH_NAMES[best]} (${T.formatMoney(monthly[best])})`);
    }
    if (offers.labels.length) out.push(`Häufigstes Angebot: ${offers.labels[0]} (${offers.counts[0]}×)`);

    const groupTours = agg.tours.filter((row) => row.participants > 0);
    if (groupTours.length) {
      const average = Math.round(groupTours.reduce((total, row) => total + row.participants, 0) / groupTours.length);
      out.push(`Ø ${average} Teilnehmende pro Gruppenführung (${groupTours.length} mit Angabe)`);
    }
    const longest = [...agg.tours].sort((a, b) => b.price - a.price)[0];
    if (longest) out.push(`Höchster Einzelbetrag: ${T.formatMoney(longest.price)} am ${longest.date.split('-').reverse().join('.')}`);

    const wl = data.workload;
    if (wl.days.length) {
      out.push(
        `${wl.efficient} von ${wl.days.length} Arbeitstagen ohne Pause über ${wl.limit} min (${Math.round((wl.efficient / wl.days.length) * 100)} %)`
      );
      if (wl.multi.length) {
        out.push(
          `${wl.multi.length} Tage mit mehreren Einsätzen — ${Math.round((wl.multi.length / wl.days.length) * 100)} % der Arbeitstage`
        );
      }
      if (wl.gap) out.push(`Wartezeit zwischen Einsätzen: ${hours(wl.gap)} — das entspricht ${T.formatMoney(wl.lost)} Honorar`);
      if (wl.longest) {
        out.push(
          `Längste Pause: ${hours(wl.longest.gap)} am ${dayLabel(wl.longest.date)} (${clock(wl.longest.first)}–${clock(wl.longest.last)})`
        );
      }
      if (wl.km) out.push(`Arbeitsweg: ${Math.round(wl.kmTotal)} km und ${hours(wl.commuteTotal)} Fahrzeit bei ${wl.km} km einfacher Strecke`);
      if (wl.effectiveRate) {
        out.push(
          `Effektiver Stundensatz ${T.formatMoney(wl.effectiveRate)}/h — ${T.formatMoney(wl.paidRate - wl.effectiveRate)}/h weniger als pro Tourstunde`
        );
      }
    }

    if (data.period !== 'year') {
      out.push(`Zeitraum: ${range.from.split('-').reverse().join('.')} – ${range.to.split('-').reverse().join('.')}`);
    }
    return out;
  }

  /* ---------- charts ---------- */

  function drawCharts(data) {
    if (typeof Chart === 'undefined') {
      const body = document.querySelector('#tah-stats-body');
      if (body) body.append(el('p', { class: 'tah-stats-note', text: 'Diagramm-Bibliothek fehlt (vendor/chart.umd.min.js).' }));
      return;
    }

    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily || 'sans-serif';
    Chart.defaults.font.size = 11;
    Chart.defaults.color = '#666';

    const grid = { color: 'rgba(0, 0, 0, 0.06)' };
    const moneyAxis = {
      beginAtZero: true,
      grid,
      ticks: { callback: (value) => moneyShort(value) },
    };
    const base = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } } },
    };

    const timeline = data.timeline;
    chart('tah-chart-income', {
      type: 'bar',
      data: {
        labels: timeline.labels,
        datasets: [
          {
            label: 'Honorar',
            data: timeline.honorar,
            backgroundColor: '#1e4b8c',
            borderRadius: 2,
            stack: 'income',
            // A day without a tour should still show the bar's zero, not a gap.
            barPercentage: data.period === 'year' ? 0.7 : 0.85,
            categoryPercentage: 0.9,
          },
          {
            label: 'Ausfallhonorar',
            data: timeline.ausfall,
            backgroundColor: '#a1887f',
            borderRadius: 2,
            stack: 'income',
            barPercentage: data.period === 'year' ? 0.7 : 0.85,
            categoryPercentage: 0.9,
          },
        ],
      },
      options: {
        ...base,
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: data.period === 'month' } },
          y: moneyAxis,
        },
        plugins: {
          ...base.plugins,
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${T.formatMoney(ctx.parsed.y)}`,
              afterBody: (items) => {
                const count = timeline.count[items[0].dataIndex];
                return count ? `${count} ${count === 1 ? 'Einsatz' : 'Einsätze'}` : '';
              },
            },
          },
        },
      },
    });

    const workload = data.workload;
    chart('tah-chart-workload', {
      type: 'bar',
      data: {
        labels: workload.chart.labels,
        datasets: [
          {
            label: 'Arbeit',
            data: workload.chart.work,
            backgroundColor: '#1e4b8c',
            borderRadius: 2,
            stack: 'time',
            barPercentage: data.period === 'year' ? 0.7 : 0.85,
            categoryPercentage: 0.9,
          },
          {
            label: 'Wartezeit',
            data: workload.chart.gap,
            backgroundColor: '#f0a30a',
            borderRadius: 2,
            stack: 'time',
            barPercentage: data.period === 'year' ? 0.7 : 0.85,
            categoryPercentage: 0.9,
          },
          {
            label: 'Anfahrt',
            data: workload.chart.commute,
            backgroundColor: '#90a4ae',
            borderRadius: 2,
            stack: 'time',
            barPercentage: data.period === 'year' ? 0.7 : 0.85,
            categoryPercentage: 0.9,
          },
        ],
      },
      options: {
        ...base,
        scales: {
          x: {
            grid: { display: false },
            stacked: true,
            ticks: { maxRotation: 0, autoSkip: data.period === 'month' },
          },
          y: {
            beginAtZero: true,
            stacked: true,
            grid,
            ticks: { callback: (value) => `${value} h` },
          },
        },
        plugins: {
          ...base.plugins,
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString('de-DE', { maximumFractionDigits: 1 })} h`,
              footer: (items) => {
                const total = items.reduce((sum, item) => sum + item.parsed.y, 0);
                return `Tür zu Tür: ${total.toLocaleString('de-DE', { maximumFractionDigits: 1 })} h`;
              },
            },
          },
        },
      },
    });

    const forecast = data.forecast;
    if (forecast && forecast.kind === 'current' && forecast.chart) {
      const series = forecast.chart;
      chart('tah-chart-forecast', {
        type: 'line',
        data: {
          labels: series.labels,
          datasets: [
            {
              label: 'Spanne oben',
              data: series.high,
              borderColor: 'rgba(76, 175, 80, 0.35)',
              backgroundColor: 'rgba(76, 175, 80, 0.12)',
              borderWidth: 1,
              pointRadius: 0,
              fill: '+1',
              tension: 0.25,
            },
            {
              label: 'Spanne unten',
              data: series.low,
              borderColor: 'rgba(76, 175, 80, 0.35)',
              borderWidth: 1,
              pointRadius: 0,
              fill: false,
              tension: 0.25,
            },
            {
              label: 'Ist',
              data: series.actual,
              borderColor: '#1e4b8c',
              backgroundColor: 'rgba(30, 75, 140, 0.08)',
              borderWidth: 2,
              pointRadius: 2,
              fill: 'origin',
              tension: 0.25,
            },
            {
              label: 'Prognose',
              data: series.forecast,
              borderColor: '#4caf50',
              borderDash: [5, 4],
              borderWidth: 2,
              pointRadius: 2,
              fill: false,
              tension: 0.25,
            },
          ],
        },
        options: {
          ...base,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: { grid: { display: false } },
            y: moneyAxis,
          },
          plugins: {
            ...base.plugins,
            legend: { ...base.plugins.legend, labels: { ...base.plugins.legend.labels, filter: (item) => !item.text.startsWith('Spanne') } },
            tooltip: {
              callbacks: {
                label: (ctx) => (ctx.parsed.y === null ? null : `${ctx.dataset.label}: ${T.formatMoney(ctx.parsed.y)}`),
              },
              filter: (item) => item.dataset.label === 'Ist' || item.dataset.label === 'Prognose',
            },
          },
        },
      });
    }

    const weekdays = data.weekdays;
    chart('tah-chart-weekday', {
      type: 'bar',
      data: {
        labels: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'],
        datasets: [
          {
            label: 'Einsätze',
            data: weekdays.counts,
            backgroundColor: weekdays.counts.map((_, index) => (index < 5 ? '#1e4b8c' : '#90a4ae')),
            borderRadius: 2,
          },
        ],
      },
      options: {
        ...base,
        plugins: {
          ...base.plugins,
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.parsed.y} ${ctx.parsed.y === 1 ? 'Einsatz' : 'Einsätze'}`,
              afterLabel: (ctx) => T.formatMoney(weekdays.income[ctx.dataIndex]),
            },
          },
        },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, grid, ticks: { precision: 0 } },
        },
      },
    });

    const offers = data.offers;
    // Horizontal bars, not a doughnut: the offer names are long and the ranking
    // is what the reader wants, so the labels belong on the left axis.
    chart('tah-chart-offer', {
      type: 'bar',
      data: {
        labels: offers.labels.map((label) => (label.length > 26 ? `${label.slice(0, 24)}…` : label)),
        datasets: [
          {
            label: 'Einsätze',
            data: offers.counts,
            backgroundColor: offers.labels.map((_, index) => PALETTE[index % PALETTE.length]),
            borderRadius: 2,
            barPercentage: 0.8,
          },
        ],
      },
      options: {
        ...base,
        indexAxis: 'y',
        plugins: {
          ...base.plugins,
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => offers.labels[items[0].dataIndex],
              label: (ctx) => `${ctx.parsed.x} ${ctx.parsed.x === 1 ? 'Einsatz' : 'Einsätze'}`,
            },
          },
        },
        scales: {
          x: { beginAtZero: true, grid, ticks: { precision: 0 } },
          y: { grid: { display: false }, ticks: { autoSkip: false, padding: 4, font: { size: 9.5 } } },
        },
      },
    });

    const times = data.times;
    chart('tah-chart-time', {
      type: 'bar',
      data: {
        labels: times.labels,
        datasets: [{ label: 'Einsätze', data: times.counts, backgroundColor: '#4caf50', borderRadius: 2 }],
      },
      options: {
        ...base,
        plugins: { ...base.plugins, legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, grid, ticks: { precision: 0 } },
        },
      },
    });

    chart('tah-chart-efficiency', {
      type: 'doughnut',
      data: {
        labels: [
          `Effizient (≤ ${workload.limit} min)`,
          `Mittlere Pause (≤ ${workload.limit * 2} min)`,
          `Lange Pause (> ${workload.limit * 2} min)`,
        ],
        datasets: [
          {
            data: [workload.efficient, workload.medium, workload.long],
            backgroundColor: ['#4caf50', '#f0a30a', '#b3261e'],
            borderColor: '#fff',
            borderWidth: 2,
          },
        ],
      },
      options: {
        ...base,
        cutout: '55%',
        plugins: {
          ...base.plugins,
          legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.label}: ${ctx.parsed} ${ctx.parsed === 1 ? 'Tag' : 'Tage'}`,
            },
          },
        },
      },
    });
  }

  /* ---------- loading ---------- */

  async function loadCommute() {
    try {
      const stored = await chrome.storage.sync.get(COMMUTE_DEFAULTS);
      view.commute = { ...COMMUTE_DEFAULTS, ...stored };
    } catch {
      view.commute = { ...COMMUTE_DEFAULTS };
    }
  }

  async function load({ force = false } = {}) {
    if (!document.querySelector('#tah-stats')) return;
    const token = ++view.token;
    view.loading = true;
    view.error = '';
    view.data = null;
    const body = document.querySelector('#tah-stats-body');
    if (body) body.replaceChildren(el('p', { class: 'tah-stats-empty', text: 'Lade Buchungen …' }));
    destroyCharts();
    setProgress('Lade Buchungen …');

    const range = rangeFor(view.period, view.anchor);
    try {
      await loadCommute();
      const result = await loadBookings(range, { force, token });
      if (token !== view.token || !result) return;
      view.loading = false;
      view.data = buildStats(result.bookings, range, result);
      render();
    } catch (err) {
      if (token !== view.token) return;
      view.loading = false;
      view.error = err.message;
      render();
    }
  }

  /* ---------- boot ---------- */

  async function boot() {
    const stored = await chrome.storage.local.get({ statsPeriod: 'month' });
    if (PERIODS.some(([value]) => value === stored.statsPeriod)) view.period = stored.statsPeriod;
    await loadCommute();
    installNav();
  }

  boot();

  return { installNav, open, close, toggle };
})();

'use strict';

const DEFAULTS = {
  senderName: '',
  senderStreet: '',
  senderCity: '',
  taxNumber: '',
  recipientName: '',
  recipientStreet: '',
  recipientCity: '',
  bankName: '',
  iban: '',
  bic: '',
  salutation: 'Sehr geehrte Damen und Herren,',
  intro: 'vielen Dank für Ihren Auftrag. Wie vereinbart stelle ich Ihnen folgende Leistung in Rechnung:',
  assurance:
    'dass für diese Leistungen ein weiteres Honorar von einer anderen Stelle weder erbeten noch gezahlt wurde\n' +
    'alle Steuern und Sozialabgaben, die sich aus den Gesamteinkünften dieser Abrechnung ergeben, von mir selbst getragen und abgeführt werden.',
  closing: 'Diese Rechnung ist auch ohne Unterschrift gültig.\nMit freundlichen Grüßen',
  invoiceStart: 1,
  invoicePrefix: '',
  commuteKm: 10,
  commuteSpeed: 15,
  prepMinutes: 0,
  gapLimit: 45,
  bikeWhPerKm: 15,
  electricityPrice: 0.35,
};

// Numeric fields need a floor; everything else is free text.
const MINIMUM = { invoiceStart: 1, commuteSpeed: 1, gapLimit: 1 };

const FIELDS = [
  'senderName',
  'senderStreet',
  'senderCity',
  'taxNumber',
  'recipientName',
  'recipientStreet',
  'recipientCity',
  'bankName',
  'iban',
  'bic',
  'salutation',
  'intro',
  'assurance',
  'closing',
  'invoiceStart',
  'invoicePrefix',
  'commuteKm',
  'commuteSpeed',
  'prepMinutes',
  'gapLimit',
  'bikeWhPerKm',
  'electricityPrice',
];

const inputs = Object.fromEntries(FIELDS.map((id) => [id, document.querySelector(`#${id}`)]));
const signatureInput = document.querySelector('#signatureFile');
const signaturePreview = document.querySelector('#signaturePreview');
const signatureRemove = document.querySelector('#signatureRemove');
const bikePreview = document.querySelector('#bikePhotoPreview');
const bikeInput = document.querySelector('#bikePhotoFile');
const bikeReset = document.querySelector('#bikePhotoReset');
const BIKE_DEFAULT = '../assets/bike.jpg';
const saved = document.querySelector('#saved');
const icalList = document.querySelector('#icalFeeds');
const icalAdd = document.querySelector('#icalAdd');
const icalOnInput = document.querySelector('#icalOn');
const icalStatus = document.querySelector('#icalStatus');

function flash(text) {
  saved.textContent = text;
  setTimeout(() => {
    saved.textContent = '';
  }, 1500);
}

function showSignature(src) {
  signaturePreview.hidden = !src;
  signatureRemove.hidden = !src;
  if (src) signaturePreview.src = src;
  else signaturePreview.removeAttribute('src');
}

function showBikePhoto(src) {
  bikePreview.src = src || BIKE_DEFAULT;
  bikeReset.hidden = !src;
}

// A signature scan (and a phone photo of the bike) is far bigger than it needs
// to be on screen; 800 px wide is plenty and keeps it out of the storage
// quota's way.
function shrinkToDataUrl(file, { type = 'image/png', quality } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Bild konnte nicht gelesen werden.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Das ist kein Bild.'));
      img.onload = () => {
        const scale = Math.min(1, 800 / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL(type, quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  for (const id of FIELDS) {
    const value = stored[id] ?? DEFAULTS[id];
    inputs[id].value = String(value);
  }
  const { signature = '', bikePhoto = '', icalFeeds = null, icalUrl = '', icalOn = true } = await chrome.storage.local.get({
    signature: '',
    bikePhoto: '',
    icalFeeds: null,
    icalUrl: '',
    icalOn: true,
  });
  showSignature(signature);
  showBikePhoto(bikePhoto);

  feedDraft = readFeeds({ icalFeeds, icalUrl });
  grantedUrls = feedDraft.map((feed) => feed.url);
  icalOnInput.checked = icalOn !== false;
  renderFeeds();
}

/* ---------- calendar feeds ---------- */

// One colour per calendar; the same palette is in content.js, where a feed
// without a colour falls back by its position.
const FEED_COLORS = ['#b3261e', '#1e4b8c', '#2e7d32', '#6a1b9a', '#ef6c00', '#00695c'];
const REQUIRED_ORIGIN = 'https://hsh.gomus.de/*';

// The rows are the source of truth while the page is open; saving writes them
// out and re-renders, which is also where duplicate addresses disappear.
let feedDraft = [];
let feedStatus = new Map();
// Addresses present when the page loaded, for dropping permissions of a
// calendar that was removed.
let grantedUrls = [];

// `icalFeeds` is the current shape; `icalUrl` is the single feed the extension
// had before it could hold several (see content.js readFeedList).
function readFeeds({ icalFeeds, icalUrl }) {
  const list = Array.isArray(icalFeeds) ? icalFeeds : [];
  const feeds = list
    .filter((feed) => feed && typeof feed.url === 'string' && feed.url.trim())
    .map((feed, index) => ({
      id: typeof feed.id === 'string' && feed.id ? feed.id : `feed-${index + 1}`,
      url: feed.url.trim(),
      label: typeof feed.label === 'string' ? feed.label.trim() : '',
      color: typeof feed.color === 'string' ? feed.color : '',
      on: feed.on !== false,
    }));
  if (feeds.length || !icalUrl) return feeds;
  const legacy = String(icalUrl).trim();
  return legacy ? [{ id: 'feed-1', url: legacy, label: '', color: '', on: true }] : [];
}

function uid() {
  return `feed-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function feedRow(feed, index) {
  const row = document.createElement('div');
  row.className = 'feed-row';
  row.dataset.id = feed.id;

  const url = document.createElement('input');
  url.type = 'url';
  url.className = 'feed-url';
  url.spellcheck = false;
  url.placeholder = 'https://… , webcal://… oder webdav://…';
  url.value = feed.url;
  url.addEventListener('input', () => {
    feed.url = url.value.trim();
  });

  const label = document.createElement('input');
  label.type = 'text';
  label.className = 'feed-label';
  label.placeholder = 'Name';
  label.title = 'Name im Raster; leer heißt: der Server-Name';
  label.value = feed.label;
  label.addEventListener('input', () => {
    feed.label = label.value.trim();
  });

  const color = document.createElement('input');
  color.type = 'color';
  color.className = 'feed-color';
  color.title = 'Farbe von Chip und Terminstreifen';
  color.value = feed.color || FEED_COLORS[index % FEED_COLORS.length];
  feed.color = color.value;
  color.addEventListener('input', () => {
    feed.color = color.value;
  });

  const toggle = document.createElement('label');
  toggle.className = 'feed-on';
  const on = document.createElement('input');
  on.type = 'checkbox';
  on.checked = feed.on !== false;
  on.addEventListener('change', () => {
    feed.on = on.checked;
  });
  toggle.append(on, document.createTextNode('zeigen'));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'secondary feed-remove';
  remove.textContent = '×';
  remove.title = 'Kalender entfernen';
  remove.setAttribute('aria-label', 'Kalender entfernen');
  remove.addEventListener('click', () => {
    feedDraft = feedDraft.filter((entry) => entry.id !== feed.id);
    renderFeeds();
  });

  const status = document.createElement('p');
  status.className = 'hint feed-status';

  row.append(url, label, color, toggle, remove, status);
  return { row, status };
}

function renderFeeds() {
  icalList.replaceChildren();
  feedStatus = new Map();
  if (!feedDraft.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Noch kein Kalender hinterlegt.';
    icalList.append(empty);
    return;
  }
  feedDraft.forEach((feed, index) => {
    const { row, status } = feedRow(feed, index);
    icalList.append(row);
    feedStatus.set(feed.id, status);
  });
}

function addFeed() {
  const feed = { id: uid(), url: '', label: '', color: FEED_COLORS[feedDraft.length % FEED_COLORS.length], on: true };
  feedDraft = [...feedDraft, feed];
  renderFeeds();
  icalList.querySelector(`.feed-row[data-id="${feed.id}"] .feed-url`)?.focus();
}

// The feed URL is user-supplied, so the host permission is requested at runtime
// for exactly that origin (manifest: optional_host_permissions).
// The scheme mapping mirrors feedCandidates() in background.js: the permission
// has to cover the address the worker will really request, not the one typed.
// webdav:// may be served over either scheme, so both are requested.
function originPatterns(url) {
  const text = String(url || '').trim();
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  const scheme = match ? match[1].toLowerCase() : '';
  const rest = match ? text.slice(match[0].length) : '';
  let candidates;
  if (scheme === 'http' || scheme === 'https') candidates = [text];
  else if (scheme === 'webcal' || scheme === 'webdavs') candidates = [`https:${rest}`];
  else if (scheme === 'webdav') candidates = [`https:${rest}`, `http:${rest}`];
  else return [];

  const patterns = [];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      const pattern = `${parsed.protocol}//${parsed.hostname}/*`;
      if (!patterns.includes(pattern)) patterns.push(pattern);
    } catch {
      // not a usable address; the caller reports that
    }
  }
  return patterns;
}

function feedOrigins(feeds) {
  const patterns = [];
  for (const feed of feeds) {
    for (const pattern of originPatterns(feed.url)) {
      if (!patterns.includes(pattern)) patterns.push(pattern);
    }
  }
  return patterns;
}

// Must be called synchronously from a click handler: chrome.permissions.request
// only works inside a user gesture, and an await before it can consume that.
// All calendars go into one prompt, so adding a second one asks once.
async function ensureOrigins(feeds) {
  const origins = feedOrigins(feeds);
  if (!origins.length) {
    throw new Error('Bitte mindestens eine vollständige Adresse eintragen (https://, webcal:// oder webdav://).');
  }
  if (!chrome.permissions?.request) return origins;
  const granted = await chrome.permissions.request({ origins });
  if (!granted) throw new Error(`Ohne Erlaubnis für ${origins.join(' / ')} lassen sich die Kalender nicht laden.`);
  return origins;
}

// Chrome keeps a host permission until the extension asks for it back, so a
// removed calendar would still be readable. hsh.gomus.de is a required
// permission and cannot be dropped.
async function dropUnusedOrigins(feeds) {
  if (!chrome.permissions?.remove) return;
  const keep = new Set(feedOrigins(feeds));
  keep.add(REQUIRED_ORIGIN);
  const stale = [...new Set(grantedUrls.flatMap((url) => originPatterns(url)))].filter((pattern) => !keep.has(pattern));
  if (!stale.length) return;
  try {
    await chrome.permissions.remove({ origins: stale });
  } catch {
    // the permission simply stays; nothing to undo
  }
}

function nextSevenDays() {
  const days = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  for (let i = 0; i < 7; i += 1) {
    const date = new Date(cursor);
    date.setDate(date.getDate() + i);
    days.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
  }
  return days;
}

async function checkFeeds() {
  const feeds = feedDraft.filter((feed) => feed.url);
  if (!feeds.length) {
    icalStatus.textContent = 'Noch keine Adresse eingetragen.';
    return;
  }
  for (const status of feedStatus.values()) status.textContent = '';
  icalStatus.textContent = 'Lade …';

  const result = await ensureOrigins(feeds).catch((err) => err);
  if (result instanceof Error) {
    icalStatus.textContent = `Fehler: ${result.message}`;
    return;
  }

  let total = 0;
  let failed = 0;
  for (const feed of feeds) {
    const status = feedStatus.get(feed.id);
    if (status) status.textContent = 'Lade …';
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'tah-fetch-ical', url: feed.url });
      if (!reply || !reply.ok) throw new Error(reply?.error || 'Kalender nicht erreichbar.');
      const events = TAH_ICAL.eventsByDay(reply.text, nextSevenDays());
      const count = Object.values(events).reduce((sum, list) => sum + list.length, 0);
      total += count;
      if (status) status.textContent = `Verbunden: ${count} ${count === 1 ? 'Eintrag' : 'Einträge'} in den nächsten 7 Tagen.`;
    } catch (err) {
      failed += 1;
      if (status) status.textContent = `Fehler: ${err.message}`;
    }
  }
  const calendars = feeds.length === 1 ? 'Ein Kalender' : `${feeds.length} Kalender`;
  icalStatus.textContent = failed
    ? `${calendars}, ${failed} davon nicht erreichbar.`
    : `${calendars}: ${total} ${total === 1 ? 'Eintrag' : 'Einträge'} in den nächsten 7 Tagen.`;
}

async function save() {
  // Duplicate addresses would fetch the same feed twice and draw it twice.
  const feeds = [];
  for (const feed of feedDraft) {
    const url = feed.url.trim();
    if (!url || feeds.some((entry) => entry.url === url)) continue;
    feeds.push({
      id: feed.id || uid(),
      url,
      label: (feed.label || '').trim(),
      color: feed.color || FEED_COLORS[feeds.length % FEED_COLORS.length],
      on: feed.on !== false,
    });
  }
  const icalOn = icalOnInput.checked;
  const permission = feeds.length ? ensureOrigins(feeds).catch((err) => err) : Promise.resolve(null);

  const values = {};
  for (const id of FIELDS) {
    const input = inputs[id];
    if (typeof DEFAULTS[id] === 'number') {
      values[id] = Math.max(MINIMUM[id] ?? 0, Number(input.value) || 0);
    } else {
      values[id] = input.value.trim();
    }
  }
  await chrome.storage.sync.set(values);

  const result = await permission;
  if (result instanceof Error) {
    flash(`Nicht gespeichert: ${result.message}`);
    return;
  }
  await chrome.storage.local.set({ icalFeeds: feeds, icalOn });
  // The single-feed key is superseded by the list; the value lives on inside it.
  await chrome.storage.local.remove('icalUrl');
  await dropUnusedOrigins(feeds);
  feedDraft = feeds;
  grantedUrls = feeds.map((feed) => feed.url);
  renderFeeds();
  flash('Gespeichert.');
}

document.querySelector('#save').addEventListener('click', save);
document.querySelector('#icalCheck').addEventListener('click', checkFeeds);
icalAdd.addEventListener('click', addFeed);
document.querySelector('#reset').addEventListener('click', async () => {
  await chrome.storage.sync.set(DEFAULTS);
  await chrome.storage.local.remove('signature');
  await load();
  flash('Zurückgesetzt.');
});

signatureInput.addEventListener('change', async () => {
  const file = signatureInput.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await shrinkToDataUrl(file);
    await chrome.storage.local.set({ signature: dataUrl });
    showSignature(dataUrl);
    flash('Unterschrift gespeichert.');
  } catch (err) {
    flash(`Fehler: ${err.message}`);
  } finally {
    signatureInput.value = '';
  }
});

signatureRemove.addEventListener('click', async () => {
  await chrome.storage.local.remove('signature');
  showSignature('');
  flash('Unterschrift entfernt.');
});

bikeInput.addEventListener('change', async () => {
  const file = bikeInput.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await shrinkToDataUrl(file, { type: 'image/jpeg', quality: 0.82 });
    await chrome.storage.local.set({ bikePhoto: dataUrl });
    showBikePhoto(dataUrl);
    flash('Foto gespeichert.');
  } catch (err) {
    flash(`Fehler: ${err.message}`);
  } finally {
    bikeInput.value = '';
  }
});

bikeReset.addEventListener('click', async () => {
  await chrome.storage.local.remove('bikePhoto');
  showBikePhoto('');
  flash('Standardbild wiederhergestellt.');
});

load();

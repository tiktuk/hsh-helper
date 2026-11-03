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
const icalUrlInput = document.querySelector('#icalUrl');
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
  const { signature = '', bikePhoto = '' } = await chrome.storage.local.get({ signature: '', bikePhoto: '' });
  showSignature(signature);
  showBikePhoto(bikePhoto);

  const { icalUrl = '', icalOn = true } = await chrome.storage.local.get({ icalUrl: '', icalOn: true });
  icalUrlInput.value = icalUrl;
  icalOnInput.checked = icalOn !== false;
}

/* ---------- calendar feed ---------- */

// The feed URL is user-supplied, so the host permission is requested at runtime
// for exactly that origin (manifest: optional_host_permissions).
function originPattern(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

// Must be called synchronously from a click handler: chrome.permissions.request
// only works inside a user gesture, and an await before it can consume that.
async function ensureOrigin(url) {
  const origin = originPattern(url);
  if (!origin) throw new Error('Bitte eine vollständige http(s)-Adresse eintragen.');
  if (!chrome.permissions?.request) return origin;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`Ohne Erlaubnis für ${origin} lässt sich der Kalender nicht laden.`);
  return origin;
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

async function checkFeed() {
  const url = icalUrlInput.value.trim();
  if (!url) {
    icalStatus.textContent = 'Noch keine Adresse eingetragen.';
    return;
  }
  icalStatus.textContent = 'Lade …';
  const permission = ensureOrigin(url).catch((err) => err);
  try {
    const result = await permission;
    if (result instanceof Error) throw result;
    const reply = await chrome.runtime.sendMessage({ type: 'tah-fetch-ical', url });
    if (!reply || !reply.ok) throw new Error(reply?.error || 'Kalender nicht erreichbar.');
    const events = TAH_ICAL.eventsByDay(reply.text, nextSevenDays());
    const count = Object.values(events).reduce((sum, list) => sum + list.length, 0);
    icalStatus.textContent = `Verbunden: ${count} ${count === 1 ? 'Eintrag' : 'Einträge'} in den nächsten 7 Tagen.`;
  } catch (err) {
    icalStatus.textContent = `Fehler: ${err.message}`;
  }
}

async function save() {
  const icalUrl = icalUrlInput.value.trim();
  const icalOn = icalOnInput.checked;
  const permission = icalUrl ? ensureOrigin(icalUrl).catch((err) => err) : Promise.resolve(null);

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
  await chrome.storage.local.set({ icalUrl, icalOn });
  flash('Gespeichert.');
}

document.querySelector('#save').addEventListener('click', save);
document.querySelector('#icalCheck').addEventListener('click', checkFeed);
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

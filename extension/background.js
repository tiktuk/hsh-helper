'use strict';

// The content script runs in the page's origin, so a calendar feed on another
// host would be a cross-origin request from hsh.gomus.de and die on CORS. A
// service-worker fetch is not subject to CORS once the host permission is
// granted, which is the whole reason this round trip exists.
const FEED_HINT = 'Kein Zugriff auf den Kalender. Bitte die iCal-Adresse in den Einstellungen erneut speichern.';
const FEED_SCHEME_HINT = 'Ungültige Kalender-Adresse. Erlaubt sind http(s)://, webcal:// und webdav://.';

// The same feed is handed out under different schemes: Google and most others
// use https://, Apple a webcal://, WebDAV servers a webdav:// or webdavs://.
// The bytes are served over HTTP either way, so rewrite the scheme and keep the
// rest of the address — path, query, credentials — exactly as typed.
// webdav:// is the ambiguous one (davfs2 means plain HTTP, most calendar apps
// mean TLS), so both are tried; see originPatterns() in options.js, which
// requests the matching host permissions.
function feedCandidates(raw) {
  const url = String(raw || '').trim();
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  const scheme = match ? match[1].toLowerCase() : '';
  const rest = match ? url.slice(match[0].length) : '';
  let candidates;
  if (scheme === 'http' || scheme === 'https') candidates = [url];
  else if (scheme === 'webcal' || scheme === 'webdavs') candidates = [`https:${rest}`];
  else if (scheme === 'webdav') candidates = [`https:${rest}`, `http:${rest}`];
  else return [];

  return candidates.filter((candidate) => {
    try {
      new URL(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

async function fetchFeed(url) {
  const candidates = feedCandidates(url);
  if (!candidates.length) return { ok: false, error: FEED_SCHEME_HINT };

  let failure = null;
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { credentials: 'omit', cache: 'no-store', redirect: 'follow' });
      if (!res.ok) {
        failure = `Der Kalender antwortet mit HTTP ${res.status}.`;
        continue;
      }
      return { ok: true, text: await res.text() };
    } catch {
      failure = FEED_HINT;
    }
  }
  return { ok: false, error: failure };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'tah-fetch-ical') {
    fetchFeed(String(message.url || '')).then(sendResponse);
    return true;
  }

  if (message?.type !== 'tah-open-invoice') return;

  // The content script cannot open a chrome-extension:// page itself, so it asks
  // the worker to put the invoice in a new tab. Opening it in the sender's window
  // and in front matters: without a windowId Chrome uses whichever window is
  // focused, and the tab then appears somewhere the user is not looking.
  const options = { url: chrome.runtime.getURL('invoice/invoice.html'), active: true };
  if (sender.tab && sender.tab.windowId !== undefined) options.windowId = sender.tab.windowId;

  chrome.tabs.create(options).then(
    (tab) => sendResponse({ ok: true, tabId: tab.id }),
    (err) => sendResponse({ ok: false, error: err.message })
  );
  return true;
});

// Loads popup.html into jsdom and `require`s popup.js against it, so the
// Manual Post search/random/dropdown logic can be exercised the same way it
// runs in the real extension popup.
//
// popup.js runs a lot of top-level init code (chrome.storage reads, DOM
// wiring, a `fetch('version.json')` call) the moment it's required, so the
// DOM, `chrome.storage`, `fetch` and `CONFIG` globals must all be in place
// *before* `require('../../popup.js')` is called.

const fs = require('fs');
const path = require('path');

const POPUP_HTML = fs.readFileSync(path.join(__dirname, '../../popup.html'), 'utf8');
const POPUP_BODY = POPUP_HTML
  .replace(/[\s\S]*<body[^>]*>/i, '')
  .replace(/<\/body>[\s\S]*/i, '')
  // Strip <script src="..."> tags — popup.js itself is loaded via require()
  .replace(/<script[^>]*src="[^"]*"[^>]*>\s*<\/script>/gi, '');

// Loads a fresh popup.js module against a fresh DOM.
//
// `storageOverrides` seeds the in-memory chrome.storage.local backing store
// (e.g. `{ manualPostConfig: {...}, autoBotConfig: {...} }`) so tests can
// verify the independent Manual Post and Auto Bot configurations.
async function loadPopupDom(storageOverrides = {}) {
  document.body.innerHTML = POPUP_BODY;

  global.CONFIG = { REGION: 'be', MAX_PHOTOS: 5 };

  // popup.js consumes the SHARED_* reference data (normally provided by config.js
  // loaded via its <script> tag, which we strip here) at module load. Expose
  // every SHARED_* export from the real config.js so the test uses the same
  // single source of truth — new shared symbols are picked up automatically.
  const shared = require('../../config.js');
  for (const k of Object.keys(shared)) {
    if (k.startsWith('SHARED_')) global[k] = shared[k];
  }

  const storageData = {
    hasSeenOnboarding: true,
    googleApiKey: 'test-google-key',
    lastState: null,
    autoBotActive: false,
    lastMode: 'selector',
    ...storageOverrides,
  };

  // chrome.storage callbacks are always asynchronous in the real extension —
  // popup.js relies on this (e.g. top-level `const`s like AB_CONFIG_DEFAULTS
  // are only referenced from storage callbacks, after the whole script has
  // finished its first pass). A synchronous callback would hit the temporal
  // dead zone, so defer via a microtask.
  chrome.storage.local.get.mockImplementation((keys, cb) => {
    const result = {};
    Object.keys(keys).forEach(k => {
      result[k] = storageData[k] !== undefined ? storageData[k] : keys[k];
    });
    queueMicrotask(() => cb(result));
  });
  chrome.storage.local.set.mockImplementation((items, cb) => {
    Object.assign(storageData, items);
    queueMicrotask(() => cb && cb());
  });
  chrome.storage.local.remove.mockImplementation((_keys, cb) => queueMicrotask(() => cb && cb()));

  // Default fetch: only `version.json` is hit during init; everything else
  // must be mocked explicitly per-test (the Places API calls).
  global.fetch = jest.fn((url) => {
    if (String(url).includes('version.json')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ branch: 'test', commit: '' }) });
    }
    return Promise.reject(new Error(`Unmocked fetch: ${url}`));
  });

  jest.resetModules();
  const popup = require('../../popup.js');

  // Let the deferred chrome.storage callbacks (init + loadAutoBotConfig, incl.
  // its 60ms region-chip restore timeout) settle before handing control back.
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 70));

  return { popup, storageData };
}

module.exports = { loadPopupDom };

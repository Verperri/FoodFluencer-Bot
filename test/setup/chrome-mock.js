// Minimal `chrome.*` stub so background.js can be `require`d under Jest/jsdom.
// background.js registers several top-level listeners (onInstalled, alarms,
// onMessage) — those just need to be callable; the injector functions we test
// don't exercise them.

// jest-environment-jsdom v29 / jsdom v20 does NOT expose TextEncoder or
// TextDecoder as globals (they were removed from the automatic Node→jsdom
// bridge). background.js's muxMP4() uses `new TextEncoder()` directly, so
// polyfill from Node's built-in `util` module before any test code runs.
if (typeof TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util');
  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;
}

// jsdom's `crypto` global doesn't implement randomUUID() — used by
// getInstallId() in background.js/popup.js to generate the anonymous
// per-install telemetry ID. Polyfill from Node's crypto module.
if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
  const nodeCrypto = require('crypto');
  if (typeof global.crypto === 'undefined') global.crypto = {};
  global.crypto.randomUUID = () => nodeCrypto.randomUUID();
}

function listenerSet() {
  return { addListener: jest.fn(), removeListener: jest.fn(), hasListener: jest.fn() };
}

// jsdom doesn't implement Element.prototype.innerText (it always returns undefined).
// Injector code uses `el.innerText || el.textContent` so undefined falls through,
// but TikTok's location trigger-verification path reads innerText to detect that
// the trigger's label changed after a location result was clicked.  Polyfill as a
// textContent alias — safe for tests because all fixture elements use plain text.
if (typeof Element !== 'undefined' && !('innerText' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'innerText', {
    get() { return this.textContent; },
    set(v) { this.textContent = v; },
    configurable: true,
    enumerable: false,
  });
}

// jsdom doesn't implement scrollIntoView / scrollTo / scrollBy — background.js
// calls captionEl.scrollIntoView(...) before filling the caption field.
// Stub them as no-ops so the injectors can proceed without throwing.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}
if (typeof window !== 'undefined') {
  if (!window.scrollTo) window.scrollTo = () => {};
  if (!window.scrollBy) window.scrollBy = () => {};
}

// jsdom doesn't implement `document.execCommand` at all, but the Facebook
// injector calls it (legacy contenteditable insertion fallback) and the
// tests need to `jest.spyOn(document, 'execCommand')` — spyOn requires the
// property to already exist on the object. Stub it as a no-op returning
// `true` (the "command succeeded" signal) so both the injector and the spies
// work the same way they do in a real browser.
if (typeof document !== 'undefined' && typeof document.execCommand !== 'function') {
  document.execCommand = () => true;
}

// DataTransfer — jsdom's implementation is incomplete: items.add() with a
// File object silently fails and dt.files stays empty, which means all the
// injectors' file-injection paths produce empty FileLists in tests.
// Override with a minimal but functional implementation that:
//   • accepts File / Blob / string via items.add()
//   • returns an array-like `files` property that the injector code can read
//   • supports the Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,
//     'files')?.set path that the injectors prefer for setting input.files
{
  class MockDataTransfer {
    constructor() {
      this._files = [];
      this.items = {
        add: (item) => this._files.push(item),
        remove: (i) => this._files.splice(i, 1),
        clear: () => { this._files = []; },
        get length() { return this._files.length; },
      };
    }
    get files() {
      const arr = [...this._files];
      // Return an array-like that also exposes .item() and .length so it
      // behaves enough like a FileList for the tests' assertions to pass.
      const fl = arr.slice(); // real Array, so .toHaveLength / spread work
      fl.item = (i) => fl[i] ?? null;
      return fl;
    }
    clearData() { this._files = []; }
  }
  global.DataTransfer = MockDataTransfer;
}

// Patch HTMLInputElement.prototype.files to be writable in jsdom.
// jsdom marks `files` as a read-only DOMFileList property, so the injectors'
//   setter.call(input, dt.files)  or  input.files = dt.files
// both silently do nothing. Redefine the property to use a per-instance
// backing store that can be set, mirroring what a real browser's setter does.
if (typeof HTMLInputElement !== 'undefined') {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
  // Override jsdom's built-in setter: jsdom v20 HAS a setter but it validates
  // its argument as a FileList and rejects our plain-array mock, throwing
  //   "The provided value is not of type 'FileList'"
  // We need to replace it with one that accepts any array-like. Only do so
  // when the existing descriptor is configurable (so Object.defineProperty
  // won't throw).
  if (desc && desc.configurable) {
    Object.defineProperty(HTMLInputElement.prototype, 'files', {
      configurable: true,
      enumerable: true,
      get() { return this._mockFileList ?? (this._mockFileList = []); },
      set(fl) { this._mockFileList = fl; },
    });
  }
}

// background.js is a classic (non-module) service worker and loads config.js
// via importScripts(), which doesn't exist under Node/Jest. Stub it to set
// the same global CONFIG that config.js defines.
if (typeof global.importScripts === 'undefined') {
  global.importScripts = () => {
    if (typeof global.CONFIG === 'undefined') {
      global.CONFIG = { REGION: 'be', MAX_PHOTOS: 5, TELEMETRY_ENDPOINT: '' };
    }
  };
}

global.chrome = {
  runtime: {
    onInstalled: listenerSet(),
    onMessage: listenerSet(),
    sendMessage: jest.fn(() => Promise.resolve()),
    getURL: p => `chrome-extension://test-extension-id/${p}`,
  },
  alarms: {
    onAlarm: listenerSet(),
    create: jest.fn(),
    clear: jest.fn(),
  },
  storage: {
    local: {
      get: jest.fn((_keys, cb) => cb && cb({})),
      set: jest.fn((_items, cb) => cb && cb()),
      remove: jest.fn((_keys, cb) => cb && cb()),
    },
    onChanged: listenerSet(),
  },
  scripting: {
    executeScript: jest.fn(() => Promise.resolve([{ result: undefined }])),
  },
  windows: {
    create: jest.fn(() => Promise.resolve({ id: 1, tabs: [{ id: 1 }] })),
    update: jest.fn(() => Promise.resolve({ state: 'normal' })),
    remove: jest.fn(() => Promise.resolve()),
  },
  tabs: {
    onUpdated: listenerSet(),
  },
};

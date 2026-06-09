// Minimal `chrome.*` stub so background.js can be `require`d under Jest/jsdom.
// background.js registers several top-level listeners (onInstalled, alarms,
// onMessage) — those just need to be callable; the injector functions we test
// don't exercise them.

function listenerSet() {
  return { addListener: jest.fn(), removeListener: jest.fn(), hasListener: jest.fn() };
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
  // Only patch if already defined (jsdom sets it up as a getter-only accessor)
  if (desc && typeof desc.set !== 'function') {
    Object.defineProperty(HTMLInputElement.prototype, 'files', {
      configurable: true,
      enumerable: true,
      get() { return this._mockFileList ?? (this._mockFileList = []); },
      set(fl) { this._mockFileList = fl; },
    });
  }
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
    },
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

// Minimal `chrome.*` stub so background.js can be `require`d under Jest/jsdom.
// background.js registers several top-level listeners (onInstalled, alarms,
// onMessage) — those just need to be callable; the injector functions we test
// don't exercise them.

function listenerSet() {
  return { addListener: jest.fn(), removeListener: jest.fn(), hasListener: jest.fn() };
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

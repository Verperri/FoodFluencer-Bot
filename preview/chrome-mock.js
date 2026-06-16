// Browser-side `chrome.*` shim so popup.html/popup.js can run in a plain
// browser tab for visual/UI verification (not a real extension context).
// Backed by localStorage so state survives reloads during a preview session.
(function () {
  const STORAGE_PREFIX = "ffbot_preview::";

  function readAll() {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORAGE_PREFIX)) {
        try { out[k.slice(STORAGE_PREFIX.length)] = JSON.parse(localStorage.getItem(k)); }
        catch (e) { /* ignore corrupt entries */ }
      }
    }
    return out;
  }

  function get(keys, cb) {
    const all = readAll();
    let result = {};
    if (keys == null) {
      result = all;
    } else if (Array.isArray(keys)) {
      keys.forEach(k => { if (k in all) result[k] = all[k]; });
    } else if (typeof keys === "string") {
      if (keys in all) result[keys] = all[keys];
    } else {
      // object form: keys are defaults
      Object.keys(keys).forEach(k => {
        result[k] = (k in all) ? all[k] : keys[k];
      });
    }
    if (cb) { setTimeout(() => cb(result), 0); return; }
    return Promise.resolve(result);
  }

  function set(items, cb) {
    Object.keys(items).forEach(k => {
      localStorage.setItem(STORAGE_PREFIX + k, JSON.stringify(items[k]));
    });
    if (cb) { setTimeout(cb, 0); return; }
    return Promise.resolve();
  }

  function remove(keys, cb) {
    (Array.isArray(keys) ? keys : [keys]).forEach(k => {
      localStorage.removeItem(STORAGE_PREFIX + k);
    });
    if (cb) { setTimeout(cb, 0); return; }
    return Promise.resolve();
  }

  function listenerSet() {
    return { addListener: () => {}, removeListener: () => {}, hasListener: () => false };
  }

  window.chrome = {
    runtime: {
      onInstalled: listenerSet(),
      onMessage: listenerSet(),
      sendMessage: (msg, cb) => {
        console.log("[chrome-mock] runtime.sendMessage", msg);
        if (cb) { setTimeout(() => cb({}), 0); return; }
        return Promise.resolve({});
      },
      getURL: (p) => p,
    },
    alarms: {
      onAlarm: listenerSet(),
      create: (...args) => console.log("[chrome-mock] alarms.create", ...args),
      clear: (...args) => console.log("[chrome-mock] alarms.clear", ...args),
      clearAll: (...args) => console.log("[chrome-mock] alarms.clearAll", ...args),
      getAll: (cb) => { if (cb) cb([]); return Promise.resolve([]); },
    },
    storage: {
      local: { get, set, remove },
      onChanged: listenerSet(),
    },
    scripting: {
      executeScript: () => Promise.resolve([{ result: undefined }]),
    },
    windows: {
      create: () => Promise.resolve({ id: 1, tabs: [{ id: 1 }] }),
      update: () => Promise.resolve({ state: "normal" }),
      remove: () => Promise.resolve(),
    },
    tabs: {
      create: (...args) => console.log("[chrome-mock] tabs.create", ...args),
      onUpdated: listenerSet(),
    },
  };

  // Avoid noisy network errors for the optional telemetry endpoint and
  // version.json (popup.js fetches both at startup).
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, ...rest) => {
    const u = String(url);
    if (u.includes("version.json")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ branch: "preview", commit: "" }) });
    }
    if (u.includes("/v1/") || u.includes("telemetry")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    return realFetch(url, ...rest);
  };
})();

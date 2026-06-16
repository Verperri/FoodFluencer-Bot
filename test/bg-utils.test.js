// Tests for two background.js infrastructure helpers:
//  - mapLimit: order-preserving, concurrency-capped, error-isolating async map
//    (used to parallelize per-entity roundup photo fetches).
//  - appendAppLog: the single serialized writer for the shared `appLog` array,
//    which fixes the popup↔service-worker lost-update race.

let bg;

beforeEach(() => {
  jest.resetModules();
  global.CONFIG = { REGION: 'be', MAX_PHOTOS: 5, TELEMETRY_ENDPOINT: '' };
  bg = require('../background.js');
});

describe('mapLimit', () => {
  test('preserves input order regardless of completion order', async () => {
    // Later items resolve sooner — output must still match input order.
    const out = await bg.mapLimit([100, 40, 10], 3, (ms, i) =>
      new Promise(res => setTimeout(() => res(i), ms)));
    expect(out.map(r => r.value)).toEqual([0, 1, 2]);
  });

  test('never runs more than `limit` tasks at once', async () => {
    let active = 0, peak = 0;
    await bg.mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(res => setTimeout(res, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually ran concurrently
  });

  test('isolates per-item failures instead of aborting the batch', async () => {
    const out = await bg.mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n * 10;
    });
    expect(out[0]).toEqual({ ok: true, value: 10 });
    expect(out[1].ok).toBe(false);
    expect(out[1].error.message).toBe('boom');
    expect(out[2]).toEqual({ ok: true, value: 30 });
  });

  test('handles an empty list', async () => {
    expect(await bg.mapLimit([], 3, async x => x)).toEqual([]);
  });
});

describe('appendAppLog (serialized appLog writer)', () => {
  // A deliberately ASYNC storage mock: get and set resolve on a later tick, so
  // an unserialized get→push→set would lose concurrent updates. The serialized
  // appender must still land every entry.
  function makeAsyncStore() {
    const store = { appLog: [] };
    chrome.storage.local.get.mockImplementation((keys) =>
      new Promise(res => setTimeout(() => {
        const out = {};
        Object.keys(keys).forEach(k => { out[k] = store[k] !== undefined ? store[k] : keys[k]; });
        res(out);
      }, 1)));
    chrome.storage.local.set.mockImplementation((items) =>
      new Promise(res => setTimeout(() => { Object.assign(store, items); res(); }, 1)));
    return store;
  }

  test('does not drop entries when many appends race', async () => {
    const store = makeAsyncStore();
    const proms = [];
    for (let i = 0; i < 25; i++) proms.push(bg.appendAppLog({ level: 'info', message: `m${i}` }));
    await Promise.all(proms);
    expect(store.appLog).toHaveLength(25);
    // Order is preserved by the chain.
    expect(store.appLog.map(e => e.message)).toEqual(
      Array.from({ length: 25 }, (_, i) => `m${i}`));
  });

  test('never rejects into the caller even if storage throws', async () => {
    chrome.storage.local.get.mockImplementation(() => Promise.reject(new Error('storage down')));
    await expect(bg.appendAppLog({ level: 'error', message: 'x' })).resolves.toBeUndefined();
  });
});

// Tests for the opt-in centralized telemetry pipeline (cloud/worker.js client
// side): sendTelemetry()/getInstallId() are the shared transport used both by
// the photo waterfall (scraping/appeal feedback, "feedback" kind) and by
// TechLog._flush (technical logging, "logs" kind). These tests verify the
// connection is gated correctly and posts the expected payload shape to the
// configured endpoint — without requiring a live Worker deployment.

// background.js calls chrome.storage.local.get/set both with a callback and
// (in sendTelemetry/getInstallId) MV3-style with no callback, relying on the
// returned Promise — this mock supports both forms.
function setupStorage(initial = {}) {
  const store = { ...initial };
  chrome.storage.local.get.mockImplementation((keys, cb) => {
    const result = {};
    Object.keys(keys).forEach(k => {
      result[k] = store[k] !== undefined ? store[k] : keys[k];
    });
    if (cb) { queueMicrotask(() => cb(result)); return undefined; }
    return Promise.resolve(result);
  });
  chrome.storage.local.set.mockImplementation((items, cb) => {
    Object.assign(store, items);
    if (cb) { queueMicrotask(() => cb()); return undefined; }
    return Promise.resolve();
  });
  return store;
}

describe('centralized telemetry', () => {
  let bg;

  beforeEach(() => {
    jest.resetModules();
    global.CONFIG = { REGION: 'be', MAX_PHOTOS: 5, TELEMETRY_ENDPOINT: '' };
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }));
    bg = require('../background.js');
  });

  test('sendTelemetry is a no-op when TELEMETRY_ENDPOINT is not configured', async () => {
    setupStorage({ telemetryOptIn: true, installId: 'install-1' });
    await bg.sendTelemetry('logs', { entries: [{ id: '1' }] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sendTelemetry is a no-op when the user has not opted in', async () => {
    global.CONFIG.TELEMETRY_ENDPOINT = 'https://telemetry.example.com';
    setupStorage({ telemetryOptIn: false, installId: 'install-1' });
    await bg.sendTelemetry('logs', { entries: [{ id: '1' }] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sendTelemetry posts technical-log batches with the install id', async () => {
    global.CONFIG.TELEMETRY_ENDPOINT = 'https://telemetry.example.com';
    setupStorage({ telemetryOptIn: true, installId: 'install-1' });

    const entries = [{ id: 'e1', level: 'info', category: 'PHOTO', action: 'waterfall_start' }];
    await bg.sendTelemetry('logs', { entries });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://telemetry.example.com/v1/logs');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.installId).toBe('install-1');
    expect(typeof body.ts).toBe('string');
    expect(body.entries).toEqual(entries);
  });

  test('sendTelemetry posts photo-feedback batches (scraping/appeal data)', async () => {
    global.CONFIG.TELEMETRY_ENDPOINT = 'https://telemetry.example.com';
    setupStorage({ telemetryOptIn: true, installId: 'install-1' });

    const photos = [
      { source: 'google_maps', width: 2048, height: 1536, appeal: 72.5, rankScore: 80.1, kept: true },
      { source: 'duckduckgo', width: 1080, height: 1080, appeal: 40.2, rankScore: 55.0, kept: false },
    ];
    await bg.sendTelemetry('feedback', { photos });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://telemetry.example.com/v1/feedback');
    const body = JSON.parse(opts.body);
    expect(body.installId).toBe('install-1');
    expect(body.photos).toEqual(photos);
  });

  test('getInstallId generates and persists a UUID when none exists', async () => {
    const store = setupStorage({});
    const id = await bg.getInstallId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(store.installId).toBe(id);

    // A second call reuses the persisted id rather than generating a new one.
    const id2 = await bg.getInstallId();
    expect(id2).toBe(id);
  });

  test('TechLog._flush forwards the flushed batch to sendTelemetry as "logs"', async () => {
    global.CONFIG.TELEMETRY_ENDPOINT = 'https://telemetry.example.com';
    setupStorage({ telemetryOptIn: true, installId: 'install-1' });

    bg.TechLog.info('PHOTO', 'waterfall_start', { businessName: 'x' });
    bg.TechLog._flush();

    // sendTelemetry is fire-and-forget inside _flush; let its microtasks run.
    await new Promise(r => setTimeout(r, 0));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://telemetry.example.com/v1/logs');
    const body = JSON.parse(opts.body);
    expect(body.installId).toBe('install-1');
    expect(body.entries[0]).toMatchObject({ category: 'PHOTO', action: 'waterfall_start' });
  });

  test('TechLog._flush does not call fetch when telemetry is disabled', async () => {
    setupStorage({ telemetryOptIn: false });
    bg.TechLog.warn('SEARCH', 'auto_search_error', { error: 'boom' });
    bg.TechLog._flush();
    await new Promise(r => setTimeout(r, 0));
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

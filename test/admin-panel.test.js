// Tests for the popup Settings → Admin panel: a maintainer-only section
// gated behind a token typed in locally and validated live against the
// telemetry Worker's /admin/installs route. Until a valid token is entered,
// only the token input + Unlock button are shown; once unlocked, the lookup
// tools (install list, per-install logs/feedback) are revealed and the token
// row is hidden. "Lock" reverses this and forgets the stored token.

const { loadPopupDom } = require('./helpers/popup-dom');

// chrome.storage.local.get/set/remove support both the callback form (used
// by loadAdminSettings) and the no-callback Promise/MV3 form (used by
// adminFetch and the unlock/lock handlers) — back both by `storageData` so
// state set via one form is visible to the other.
function supportPromiseForm(storageData) {
  chrome.storage.local.get.mockImplementation((keys, cb) => {
    const result = {};
    Object.keys(keys).forEach(k => {
      result[k] = storageData[k] !== undefined ? storageData[k] : keys[k];
    });
    if (cb) { queueMicrotask(() => cb(result)); return undefined; }
    return Promise.resolve(result);
  });
  chrome.storage.local.set.mockImplementation((items, cb) => {
    Object.assign(storageData, items);
    if (cb) { queueMicrotask(() => cb()); return undefined; }
    return Promise.resolve();
  });
  chrome.storage.local.remove.mockImplementation((keys, cb) => {
    (Array.isArray(keys) ? keys : [keys]).forEach(k => delete storageData[k]);
    if (cb) { queueMicrotask(() => cb()); return undefined; }
    return Promise.resolve();
  });
}

// Settings only populates once opened — clicking any of the settings buttons
// calls openSettings(), which in turn calls loadAdminSettings().
function openSettings() {
  document.getElementById('settingsBtnSelector').click();
}

async function flush() {
  await new Promise(r => setTimeout(r, 0));
}

describe('Settings → Admin panel', () => {
  let storageData;

  beforeEach(async () => {
    const loaded = await loadPopupDom();
    storageData = loaded.storageData;
    supportPromiseForm(storageData);
    global.CONFIG.TELEMETRY_ENDPOINT = 'https://telemetry.example.com';
  });

  test('is locked by default: token row visible, lookup panel hidden', async () => {
    openSettings();
    await flush();

    expect(document.getElementById('settingsAdminTokenRow').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('settingsAdminPanel').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('settingsAdminStatus').textContent).toBe('');
  });

  test('an invalid token is rejected and the lookup panel stays hidden', async () => {
    openSettings();
    await flush();

    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'unauthorized' }) }));

    document.getElementById('settingsAdminToken').value = 'wrong-token';
    document.getElementById('settingsAdminSaveToken').click();
    await flush();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://telemetry.example.com/admin/installs',
      expect.objectContaining({ headers: { Authorization: 'Bearer wrong-token' } })
    );
    expect(document.getElementById('settingsAdminStatus').textContent).toBe('✗ Invalid token');
    expect(document.getElementById('settingsAdminPanel').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('settingsAdminTokenRow').classList.contains('hidden')).toBe(false);
    expect(storageData.adminToken).toBeUndefined();
  });

  test('a valid token unlocks the lookup panel and hides the token row', async () => {
    openSettings();
    await flush();

    global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ installs: [] }) }));

    document.getElementById('settingsAdminToken').value = 'correct-token';
    document.getElementById('settingsAdminSaveToken').click();
    await flush();

    expect(document.getElementById('settingsAdminStatus').textContent).toBe('✓ Unlocked');
    expect(document.getElementById('settingsAdminPanel').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('settingsAdminTokenRow').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('settingsAdminToken').value).toBe('');
    expect(storageData.adminToken).toBe('correct-token');
  });

  test('reopening settings with a stored token starts unlocked', async () => {
    storageData.adminToken = 'stored-token';

    openSettings();
    await flush();

    expect(document.getElementById('settingsAdminStatus').textContent).toBe('✓ Unlocked');
    expect(document.getElementById('settingsAdminPanel').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('settingsAdminTokenRow').classList.contains('hidden')).toBe(true);
  });

  test('Lock forgets the token and reverts to the locked state', async () => {
    storageData.adminToken = 'stored-token';
    openSettings();
    await flush();

    document.getElementById('settingsAdminLock').click();
    await flush();

    expect(storageData.adminToken).toBeUndefined();
    expect(document.getElementById('settingsAdminPanel').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('settingsAdminTokenRow').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('settingsAdminStatus').textContent).toBe('');
  });

  test('List recent installs fetches /admin/installs with the stored token and renders the result', async () => {
    storageData.adminToken = 'stored-token';
    openSettings();
    await flush();

    const installs = [{ install_id: 'abc-123', last_seen: '2026-06-10T00:00:00Z', log_count: 5 }];
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ installs }) }));

    document.getElementById('settingsAdminFetchInstalls').click();
    await flush();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://telemetry.example.com/admin/installs',
      expect.objectContaining({ headers: { Authorization: 'Bearer stored-token' } })
    );
    expect(document.getElementById('settingsAdminResults').textContent).toContain('abc-123');
    expect(document.getElementById('settingsAdminStatus').textContent).toBe('✓ Loaded');
  });

  test('View Logs/Feedback look up the entered Install ID', async () => {
    storageData.adminToken = 'stored-token';
    openSettings();
    await flush();

    global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ logs: [] }) }));
    document.getElementById('settingsAdminInstallId').value = 'install-xyz-789';
    document.getElementById('settingsAdminFetchLogs').click();
    await flush();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://telemetry.example.com/admin/logs?installId=install-xyz-789',
      expect.objectContaining({ headers: { Authorization: 'Bearer stored-token' } })
    );

    global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ feedback: [] }) }));
    document.getElementById('settingsAdminFetchFeedback').click();
    await flush();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://telemetry.example.com/admin/feedback?installId=install-xyz-789',
      expect.objectContaining({ headers: { Authorization: 'Bearer stored-token' } })
    );
  });

  test('without a configured TELEMETRY_ENDPOINT, Unlock reports the missing endpoint', async () => {
    global.CONFIG.TELEMETRY_ENDPOINT = '';
    openSettings();
    await flush();

    document.getElementById('settingsAdminToken').value = 'any-token';
    document.getElementById('settingsAdminSaveToken').click();
    await flush();

    expect(document.getElementById('settingsAdminStatus').textContent).toBe('No telemetry endpoint configured.');
    expect(document.getElementById('settingsAdminPanel').classList.contains('hidden')).toBe(true);
  });
});

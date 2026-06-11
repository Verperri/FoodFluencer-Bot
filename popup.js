// ── HTML escaping helper (prevents XSS when inserting external data into innerHTML) ──
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

// ── Version footer ────────────────────────────────────────────────────────────
let CURRENT_VERSION = '';
fetch('version.json').then(r => r.json()).then(v => {
  CURRENT_VERSION = `${v.branch} · ${v.commit}`;
  const el = document.getElementById('versionFooter');
  if (el) el.textContent = CURRENT_VERSION;
  const sv = document.getElementById('settingsVersion');
  if (sv) sv.textContent = CURRENT_VERSION;
}).catch(() => {});

// ════════════════════════════════════════════════════════════════════════════
// SETTINGS PANEL
// ════════════════════════════════════════════════════════════════════════════

function buildFeatureStatus(hasKey, hasFsqKey = false) {
  return [
    // Photo sources
    { label: 'Photo source 1 — Google Maps scraping',     on: true },
    { label: 'Photo source 2 — DuckDuckGo image search',  on: true },
    { label: 'Photo source 3 — Yelp scraping',            on: true },
    { label: 'Photo source 4 — TripAdvisor scraping',     on: true },
    { label: 'Photo source 5 — Foursquare API',           on: hasFsqKey, note: hasFsqKey ? '' : ' — add Foursquare key to enable' },
    { label: 'Photo source 6 — Google Places API',        on: hasKey,    note: hasKey    ? '' : ' — add Google key to enable' },
    // Posting
    { label: 'Automatic business discovery',  on: hasKey, note: hasKey ? '' : ' — requires Google key' },
    { label: 'Scheduled auto-posting',        on: true },
    { label: 'Auto-retry on post failure',    on: true },
    // Captions
    { label: 'Multilingual caption templates (50–100 per language)', on: true },
    { label: 'Type-aware captions (restaurant / hotel / bar)',        on: true },
    { label: 'Location-aware captions (city / province)',             on: true },
  ];
}

function renderFeatureStatus(containerId, hasKey, hasFsqKey = false) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = buildFeatureStatus(hasKey, hasFsqKey).map(f => `
    <div class="settings-feature ${f.on ? '' : 'disabled'}">
      <span class="feat-icon">${f.on ? '✅' : '⚠️'}</span>
      <span>${f.label}${f.note ? `<em style="font-size:.68rem;color:var(--muted)">${f.note}</em>` : ''}</span>
    </div>`).join('');
}

function openSettings() {
  const panel = document.getElementById('settingsPanel');
  const backdrop = document.getElementById('settingsBackdrop');
  if (!panel) return;

  // Populate current API keys (masked) and update sub-drawer badges
  chrome.storage.local.get({ googleApiKey: '', foursquareApiKey: '' }, ({ googleApiKey, foursquareApiKey }) => {
    const input = document.getElementById('settingsApiKey');
    if (input) input.value = googleApiKey ? '••••••••••••••••' : '';
    const status = document.getElementById('settingsKeyStatus');
    if (status) {
      status.className = 'settings-key-status ' + (googleApiKey ? 'ok' : 'warn');
      status.textContent = googleApiKey ? '✓ Google key saved' : 'ℹ No key — business discovery & Google photos disabled';
    }
    const fsqInput = document.getElementById('settingsFsqKey');
    if (fsqInput) fsqInput.value = foursquareApiKey ? '••••••••••••••••' : '';
    const fsqStatus = document.getElementById('settingsFsqKeyStatus');
    if (fsqStatus) {
      fsqStatus.className = 'settings-key-status ' + (foursquareApiKey ? 'ok' : '');
      fsqStatus.textContent = foursquareApiKey ? '✓ Foursquare key saved' : '';
    }
    setSubBadge('stGoogleBadge', googleApiKey);
    setSubBadge('stFsqBadge', foursquareApiKey);
    renderFeatureStatus('settingsFeatures', !!googleApiKey, !!foursquareApiKey);
  });

  const sv = document.getElementById('settingsVersion');
  if (sv && CURRENT_VERSION) sv.textContent = CURRENT_VERSION;

  loadDiagResults();
  refreshLogsBadges();
  loadDiagnosticsSettings();
  loadAdminSettings();

  panel.classList.remove('hidden');
  backdrop.classList.remove('hidden');
}

// Eagerly updates all Logs & Statistics sub-drawer badges from storage.
// Called every time settings opens so values survive popup close/reopen.
function refreshLogsBadges() {
  chrome.storage.local.get(
    { techLog: [], activityLog: [], apiLog: [], totalCost: 0, foursquareQuota: { count: 0, date: '' } },
    ({ techLog, activityLog, apiLog, totalCost, foursquareQuota }) => {

      // ── Technical Log: errors in last run ──────────────────────────────
      const lastRunId = [...techLog].reverse().find(e => e.run_id)?.run_id;
      const lastRunErrors = lastRunId
        ? techLog.filter(e => e.run_id === lastRunId && e.level === 'error').length
        : techLog.filter(e => e.level === 'error').length;
      const techBadge = document.getElementById('stTechLogBadge');
      if (techBadge) {
        if (techLog.length === 0) {
          techBadge.textContent = 'No entries';
          techBadge.className   = 'st-sub-badge st-sub-badge--none';
        } else if (lastRunErrors === 0) {
          techBadge.textContent = '✓ Last run clean';
          techBadge.className   = 'st-sub-badge st-sub-badge--ok';
        } else {
          techBadge.textContent = `${lastRunErrors} error${lastRunErrors > 1 ? 's' : ''} in last run`;
          techBadge.className   = 'st-sub-badge st-sub-badge--warn';
        }
      }

      // ── Activity: total posts ──────────────────────────────────────────
      const totalPosts = activityLog.length;
      const actBadge = document.getElementById('stActivityBadge');
      if (actBadge) {
        actBadge.textContent = `${totalPosts} post${totalPosts !== 1 ? 's' : ''}`;
        actBadge.className   = 'st-sub-badge ' + (totalPosts ? 'st-sub-badge--ok' : 'st-sub-badge--none');
      }

      // ── API Usage: est. calls / cost summary ──────────────────────────
      const today    = new Date().toISOString().slice(0, 10);
      const fsqToday = foursquareQuota.date === today ? foursquareQuota.count : 0;
      const usageBadge = document.getElementById('stApiUsageBadge');
      if (usageBadge) {
        const parts = [];
        if (apiLog.length)  parts.push(`Google: ${apiLog.length} calls · $${totalCost.toFixed(2)}`);
        if (fsqToday > 0)   parts.push(`FSQ: ${fsqToday}/950`);
        usageBadge.textContent = parts.length ? parts.join(' · ') : 'No usage yet';
        usageBadge.className   = 'st-sub-badge ' + (parts.length ? 'st-sub-badge--ok' : 'st-sub-badge--none');
      }
    }
  );
}

function closeSettings() {
  document.getElementById('settingsPanel')?.classList.add('hidden');
  document.getElementById('settingsBackdrop')?.classList.add('hidden');
}

// ── Settings drawer helpers ───────────────────────────────────────────────────

function toggleDrawer(hdrId, bodyId) {
  const hdr  = document.getElementById(hdrId);
  const body = document.getElementById(bodyId);
  if (!hdr || !body) return;
  const open = hdr.classList.contains('collapsed');
  hdr.classList.toggle('collapsed', !open);
  body.classList.toggle('collapsed', !open);
}

function setSubBadge(badgeId, hasKey) {
  const badge = document.getElementById(badgeId);
  if (!badge) return;
  badge.textContent  = hasKey ? 'Configured' : 'Not set';
  badge.className    = 'st-sub-badge ' + (hasKey ? 'st-sub-badge--ok' : 'st-sub-badge--none');
}

// Top-level drawers
document.getElementById('stApiKeysHdr')  ?.addEventListener('click', () => toggleDrawer('stApiKeysHdr',  'stApiKeysBody'));
document.getElementById('stFeaturesHdr') ?.addEventListener('click', () => toggleDrawer('stFeaturesHdr', 'stFeaturesBody'));
document.getElementById('stLogsHdr')     ?.addEventListener('click', () => { toggleDrawer('stLogsHdr', 'stLogsBody'); });
document.getElementById('stDiagHdr')     ?.addEventListener('click', () => toggleDrawer('stDiagHdr',     'stDiagBody'));
document.getElementById('stTelemetryHdr')?.addEventListener('click', () => toggleDrawer('stTelemetryHdr', 'stTelemetryBody'));
document.getElementById('stAdminHdr')    ?.addEventListener('click', () => toggleDrawer('stAdminHdr',     'stAdminBody'));

// API key sub-drawers
document.getElementById('stGoogleHdr')?.addEventListener('click', e => { e.stopPropagation(); toggleDrawer('stGoogleHdr', 'stGoogleBody'); });
document.getElementById('stFsqHdr')   ?.addEventListener('click', e => { e.stopPropagation(); toggleDrawer('stFsqHdr',    'stFsqBody'); });

// Settings open buttons (selector + both modes)
['settingsBtnSelector','settingsBtnManual','settingsBtnAuto'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', openSettings);
});
document.getElementById('settingsCloseBtn')?.addEventListener('click', closeSettings);
document.getElementById('settingsBackdrop')?.addEventListener('click', closeSettings);

// Save Google API key from settings panel
document.getElementById('settingsSaveKey')?.addEventListener('click', () => {
  const input  = document.getElementById('settingsApiKey');
  const status = document.getElementById('settingsKeyStatus');
  const val = (input?.value || '').trim();
  if (!val || val.startsWith('•')) { if (status) { status.className='settings-key-status warn'; status.textContent='Enter a new key to update.'; } return; }
  chrome.storage.local.set({ googleApiKey: val }, () => {
    API_KEY = val;
    if (input)  input.value = '••••••••••••••••';
    if (status) { status.className='settings-key-status ok'; status.textContent='✓ Google key saved'; }
    setSubBadge('stGoogleBadge', true);
    chrome.storage.local.get({ foursquareApiKey: '' }, ({ foursquareApiKey }) =>
      renderFeatureStatus('settingsFeatures', true, !!foursquareApiKey));
    checkUsageWarning();
    initAfterKey();
  });
});

// Save Foursquare API key from settings panel
document.getElementById('settingsSaveFsqKey')?.addEventListener('click', () => {
  const input  = document.getElementById('settingsFsqKey');
  const status = document.getElementById('settingsFsqKeyStatus');
  const val = (input?.value || '').trim();
  if (!val || val.startsWith('•')) { if (status) { status.className='settings-key-status warn'; status.textContent='Enter a new key to update.'; } return; }
  chrome.storage.local.set({ foursquareApiKey: val }, () => {
    if (input)  input.value = '••••••••••••••••';
    if (status) { status.className='settings-key-status ok'; status.textContent='✓ Foursquare key saved'; }
    setSubBadge('stFsqBadge', true);
    chrome.storage.local.get({ googleApiKey: '' }, ({ googleApiKey }) =>
      renderFeatureStatus('settingsFeatures', !!googleApiKey, true));
  });
});

// ── Diagnostics & Sharing — opt-in toggle + Install ID ───────────────────────
document.getElementById('settingsTelemetryOptIn')?.addEventListener('change', e => {
  chrome.storage.local.set({ telemetryOptIn: e.target.checked });
});

document.getElementById('settingsCopyInstallId')?.addEventListener('click', async () => {
  const input  = document.getElementById('settingsInstallId');
  const status = document.getElementById('settingsInstallIdStatus');
  if (!input?.value) return;
  try {
    await navigator.clipboard.writeText(input.value);
    if (status) { status.className = 'settings-key-status ok'; status.textContent = '✓ Copied to clipboard'; }
  } catch (_) {
    input.select();
    if (status) { status.className = 'settings-key-status warn'; status.textContent = 'Select and copy manually.'; }
  }
});

function loadDiagnosticsSettings() {
  chrome.storage.local.get({ telemetryOptIn: false, installId: null }, async ({ telemetryOptIn, installId }) => {
    const toggle = document.getElementById('settingsTelemetryOptIn');
    if (toggle) toggle.checked = telemetryOptIn;

    if (!installId) installId = await getInstallId();
    const idInput = document.getElementById('settingsInstallId');
    if (idInput) idInput.value = installId;
  });
}

// ── Admin panel — maintainer-only access to the centralized telemetry store ──
// The admin token is entered manually and stored only in this browser's
// chrome.storage.local; it is never bundled with the extension, so other
// users have no way to obtain it. Without a valid token the Worker's
// /admin/* routes reject requests with 401. The "Unlock" step verifies the
// token against the Worker before revealing the lookup tools.
function loadAdminSettings() {
  chrome.storage.local.get({ adminToken: '' }, ({ adminToken }) => {
    document.getElementById('settingsAdminPanel')?.classList.toggle('hidden', !adminToken);
    document.getElementById('settingsAdminTokenRow')?.classList.toggle('hidden', !!adminToken);
    const status = document.getElementById('settingsAdminStatus');
    if (status) {
      status.className = 'settings-key-status ' + (adminToken ? 'ok' : '');
      status.textContent = adminToken ? '✓ Unlocked' : '';
    }
  });
}

async function adminFetch(path) {
  const endpoint = (typeof CONFIG !== 'undefined' && CONFIG.TELEMETRY_ENDPOINT) || '';
  const status = document.getElementById('settingsAdminStatus');
  const results = document.getElementById('settingsAdminResults');
  if (!endpoint) {
    if (status) { status.className = 'settings-key-status warn'; status.textContent = 'No telemetry endpoint configured.'; }
    return null;
  }
  const { adminToken = '' } = await chrome.storage.local.get({ adminToken: '' });
  if (!adminToken) return null;

  try {
    const res = await fetch(`${endpoint}${path}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const data = await res.json();
    if (!res.ok) {
      if (status) { status.className = 'settings-key-status warn'; status.textContent = `✗ ${data.error || res.status}`; }
      return null;
    }
    if (status) { status.className = 'settings-key-status ok'; status.textContent = '✓ Loaded'; }
    if (results) results.textContent = JSON.stringify(data, null, 2);
    return data;
  } catch (e) {
    if (status) { status.className = 'settings-key-status warn'; status.textContent = `✗ ${e.message}`; }
    return null;
  }
}

document.getElementById('settingsAdminSaveToken')?.addEventListener('click', async () => {
  const input  = document.getElementById('settingsAdminToken');
  const status = document.getElementById('settingsAdminStatus');
  const val = (input?.value || '').trim();
  if (!val) { if (status) { status.className = 'settings-key-status warn'; status.textContent = 'Enter the admin token.'; } return; }

  const endpoint = (typeof CONFIG !== 'undefined' && CONFIG.TELEMETRY_ENDPOINT) || '';
  if (!endpoint) { if (status) { status.className = 'settings-key-status warn'; status.textContent = 'No telemetry endpoint configured.'; } return; }

  if (status) { status.className = 'settings-key-status'; status.textContent = 'Checking…'; }
  try {
    const res = await fetch(`${endpoint}/admin/installs`, { headers: { Authorization: `Bearer ${val}` } });
    if (!res.ok) {
      if (status) { status.className = 'settings-key-status warn'; status.textContent = res.status === 401 ? '✗ Invalid token' : `✗ ${res.status}`; }
      return;
    }
    await chrome.storage.local.set({ adminToken: val });
    if (input) input.value = '';
    if (status) { status.className = 'settings-key-status ok'; status.textContent = '✓ Unlocked'; }
    document.getElementById('settingsAdminPanel')?.classList.remove('hidden');
    document.getElementById('settingsAdminTokenRow')?.classList.add('hidden');
  } catch (e) {
    if (status) { status.className = 'settings-key-status warn'; status.textContent = `✗ ${e.message}`; }
  }
});

document.getElementById('settingsAdminLock')?.addEventListener('click', async () => {
  await chrome.storage.local.remove('adminToken');
  document.getElementById('settingsAdminPanel')?.classList.add('hidden');
  document.getElementById('settingsAdminTokenRow')?.classList.remove('hidden');
  document.getElementById('settingsAdminToken').value = '';
  const results = document.getElementById('settingsAdminResults');
  if (results) results.textContent = '';
  const status = document.getElementById('settingsAdminStatus');
  if (status) { status.className = 'settings-key-status'; status.textContent = ''; }
});

document.getElementById('settingsAdminFetchInstalls')?.addEventListener('click', () => adminFetch('/admin/installs'));
document.getElementById('settingsAdminFetchLogs')?.addEventListener('click', () => {
  const id = document.getElementById('settingsAdminInstallId')?.value.trim();
  if (id) adminFetch(`/admin/logs?installId=${encodeURIComponent(id)}`);
});
document.getElementById('settingsAdminFetchFeedback')?.addEventListener('click', () => {
  const id = document.getElementById('settingsAdminInstallId')?.value.trim();
  if (id) adminFetch(`/admin/feedback?installId=${encodeURIComponent(id)}`);
});

// ── Logs & Statistics — sub-drawer wiring ────────────────────────────────────
document.getElementById('stTechLogHdr')  ?.addEventListener('click', e => { e.stopPropagation(); toggleDrawer('stTechLogHdr',  'stTechLogBody');  if (!document.getElementById('stTechLogBody').classList.contains('collapsed')) renderTechLog(); });
document.getElementById('stActivityHdr') ?.addEventListener('click', e => { e.stopPropagation(); toggleDrawer('stActivityHdr',  'stActivityBody'); if (!document.getElementById('stActivityBody').classList.contains('collapsed')) renderActivitySummary(); });
document.getElementById('stApiUsageHdr') ?.addEventListener('click', e => { e.stopPropagation(); toggleDrawer('stApiUsageHdr',  'stApiUsageBody'); if (!document.getElementById('stApiUsageBody').classList.contains('collapsed')) renderApiUsage(); });

// Technical log — level + category filters
let _tlLevel = 'all', _tlCat = 'all';
document.getElementById('stTechLogLevels')?.addEventListener('click', e => {
  const btn = e.target.closest('.stl-filter-btn');
  if (!btn) return;
  _tlLevel = btn.dataset.level;
  document.querySelectorAll('#stTechLogLevels .stl-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
  renderTechLog();
});
document.getElementById('stTechLogCat')?.addEventListener('change', e => {
  _tlCat = e.target.value;
  renderTechLog();
});

function renderTechLog() {
  chrome.storage.local.get({ techLog: [] }, ({ techLog }) => {
    // Badge: errors in last run (same logic as refreshLogsBadges)
    const lastRunId     = [...techLog].reverse().find(e => e.run_id)?.run_id;
    const lastRunErrors = lastRunId
      ? techLog.filter(e => e.run_id === lastRunId && e.level === 'error').length
      : techLog.filter(e => e.level === 'error').length;
    const badge = document.getElementById('stTechLogBadge');
    if (badge) {
      if (techLog.length === 0) {
        badge.textContent = 'No entries'; badge.className = 'st-sub-badge st-sub-badge--none';
      } else if (lastRunErrors === 0) {
        badge.textContent = '✓ Last run clean'; badge.className = 'st-sub-badge st-sub-badge--ok';
      } else {
        badge.textContent = `${lastRunErrors} error${lastRunErrors > 1 ? 's' : ''} in last run`;
        badge.className = 'st-sub-badge st-sub-badge--warn';
      }
    }
    const container = document.getElementById('stTechLogEntries');
    if (!container) return;
    const filtered = techLog
      .filter(e => (_tlLevel === 'all' || e.level === _tlLevel) && (_tlCat === 'all' || e.category === _tlCat))
      .slice(-100).reverse();
    container.innerHTML = filtered.map(e => {
      const time = (e.ts || '').slice(11, 19);
      const lvlCls = e.level === 'warn' ? 'stl-lvl-warn' : e.level === 'error' ? 'stl-lvl-error' : 'stl-lvl-info';
      const msg = e.action + (e.name ? ` · ${e.name}` : '') + (e.error ? ` · ${e.error}` : '');
      return `<div class="stl-row">
        <span class="stl-ts">${time}</span>
        <span class="stl-lvl ${lvlCls}">${e.level || 'info'}</span>
        <span class="stl-cat">${e.category || ''}</span>
        <span class="stl-msg" title="${msg.replace(/"/g,'&quot;')}">${msg}</span>
      </div>`;
    }).join('') || '';
  });
}

function renderActivitySummary() {
  chrome.storage.local.get({ activityLog: [] }, ({ activityLog }) => {
    // Per-platform counts (all time)
    const platforms = { instagram: 0, facebook: 0, tiktok: 0 };
    activityLog.forEach(e => { if (e.platform in platforms) platforms[e.platform]++; });
    const total = Object.values(platforms).reduce((a, b) => a + b, 0);

    const badge = document.getElementById('stActivityBadge');
    if (badge) {
      badge.textContent = `${total} post${total !== 1 ? 's' : ''}`;
      badge.className = 'st-sub-badge ' + (total ? 'st-sub-badge--ok' : 'st-sub-badge--none');
    }

    const pillsEl = document.getElementById('stActivityPlatforms');
    if (pillsEl) {
      const labels = { instagram: '📷 Instagram', facebook: '👤 Facebook', tiktok: '🎵 TikTok' };
      pillsEl.innerHTML = Object.entries(platforms).map(([p, n]) => `
        <div class="stl-platform-pill">
          <span class="pill-count">${n}</span>
          <span class="pill-label">${labels[p]}</span>
        </div>`).join('');
    }

    // Last 7 days sparkline
    const sparkEl  = document.getElementById('stActivitySparkline');
    const labelsEl = document.getElementById('stActivitySparklineLabels');
    if (sparkEl && labelsEl) {
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        days.push(d.toISOString().slice(0, 10));
      }
      const dayCounts = days.map(d => activityLog.filter(e => (e.ts || '').startsWith(d)).length);
      const maxCount  = Math.max(...dayCounts, 1);
      const dayNames  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      sparkEl.innerHTML  = dayCounts.map(c => `<div class="stl-spark-bar ${c === 0 ? 'empty' : ''}" style="height:${Math.round((c / maxCount) * 36) + 4}px" title="${c} post${c !== 1 ? 's' : ''}"></div>`).join('');
      labelsEl.innerHTML = days.map(d => `<div class="stl-spark-lbl">${dayNames[new Date(d + 'T12:00:00').getDay()]}</div>`).join('');
    }
  });
}

function renderApiUsage() {
  chrome.storage.local.get({ apiLog: [], totalCost: 0, foursquareQuota: { count: 0, date: '' } }, data => {
    const { apiLog, totalCost, foursquareQuota } = data;
    const today = new Date().toISOString().slice(0, 10);
    const todayCalls = apiLog.filter(e => (e.ts || '').startsWith(today)).length;
    const weekCalls  = apiLog.filter(e => {
      const d = new Date(); d.setDate(d.getDate() - 7);
      return new Date(e.ts) >= d;
    }).length;

    const fsqToday  = foursquareQuota.date === today ? foursquareQuota.count : 0;
    const fsqLimit  = 950;
    const fsqPct    = Math.min((fsqToday / fsqLimit) * 100, 100);
    const fsqBarCls = fsqPct >= 80 ? 'stl-quota-bar--high' : fsqPct >= 50 ? 'stl-quota-bar--mid' : 'stl-quota-bar--low';

    const costPct    = Math.min((totalCost / 10) * 100, 100);
    const costBarCls = costPct >= 80 ? 'stl-quota-bar--high' : costPct >= 40 ? 'stl-quota-bar--mid' : 'stl-quota-bar--low';

    const badge = document.getElementById('stApiUsageBadge');
    if (badge) {
      badge.textContent = `$${totalCost.toFixed(3)}`;
      badge.className = 'st-sub-badge ' + (totalCost >= 8 ? 'st-sub-badge--warn' : 'st-sub-badge--ok');
    }

    const container = document.getElementById('stApiUsageCards');
    if (!container) return;
    container.innerHTML = `
      <div class="stl-api-card">
        <div class="stl-api-card-title">🔵 Google Places API</div>
        <div class="stl-api-stat-row"><span>Total calls</span><strong>${apiLog.length}</strong></div>
        <div class="stl-api-stat-row"><span>Today</span><strong>${todayCalls}</strong></div>
        <div class="stl-api-stat-row"><span>Last 7 days</span><strong>${weekCalls}</strong></div>
        <div class="stl-api-stat-row"><span>Est. cost (all time)</span><strong>$${totalCost.toFixed(4)}</strong></div>
        <div class="stl-quota-bar-wrap"><div class="stl-quota-bar ${costBarCls}" style="width:${costPct}%"></div></div>
        <div class="stl-api-stat-row" style="margin-top:3px"><span style="font-size:.64rem;color:var(--muted)">Estimated against $10 threshold</span></div>
      </div>
      <div class="stl-api-card">
        <div class="stl-api-card-title">🟡 Foursquare API</div>
        <div class="stl-api-stat-row"><span>Calls today</span><strong>${fsqToday}</strong></div>
        <div class="stl-api-stat-row"><span>Remaining today</span><strong>${fsqLimit - fsqToday} / ${fsqLimit}</strong></div>
        <div class="stl-quota-bar-wrap"><div class="stl-quota-bar ${fsqBarCls}" style="width:${fsqPct}%"></div></div>
        <div class="stl-api-stat-row" style="margin-top:3px"><span style="font-size:.64rem;color:var(--muted)">Quota resets at midnight</span></div>
      </div>`;
  });
}

// Export + reset
document.getElementById('settingsExportLogs')?.addEventListener('click', () => { TechLog.exportCSV(); });
document.getElementById('settingsResetActivity')?.addEventListener('click', () => {
  if (confirm('Reset the activity log? This cannot be undone.')) {
    chrome.storage.local.set({ activityLog: [] }, () => { refreshActivityLog(); renderActivitySummary(); });
  }
});

// Console deep-links
document.getElementById('stGoogleConsoleBtn')?.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://console.cloud.google.com/apis/api/places.googleapis.com/metrics' });
});
document.getElementById('stFsqConsoleBtn')?.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://foursquare.com/developers/home' });
});

document.getElementById('settingsShowOnboarding')?.addEventListener('click', () => {
  closeSettings();
  showOnboarding();
});

// ── Diagnostics ───────────────────────────────────────────────────────────────
// Runs the silent feasibility probes (RUN_DIAGNOSTICS → testSilentInstagram /
// ── Inline diagnostic test results ───────────────────────────────────────────
// NOTE: chrome.windows.create() steals OS focus and will close the extension
// popup mid-run. The Run button still triggers the background test; results
// persist in chrome.storage.local.silentTestResults and are rendered here both
// on settings open and via storage.onChanged so they appear when the user
// reopens the popup after the test completes.

function _diagPlatformTests(result) {
  return (result?.steps || [])
    .filter(s => typeof s.ok === 'boolean')
    .map((s, i) => ({ name: `Test Case #${i + 1} — ${s.label}`, ok: s.ok, detail: s.detail }));
}

function _renderDiagResults(results) {
  const container = document.getElementById('stDiagResults');
  const btn       = document.getElementById('runDiagnosticBtn');
  const summary   = document.getElementById('stDiagSummary');
  if (!container) return;

  const ig = results?.instagram;
  const tt = results?.tiktok;

  if (!ig && !tt) {
    container.innerHTML = '';
    if (summary) { summary.textContent = ''; summary.className = 'st-drawer-summary'; }
    return;
  }

  container.innerHTML = '';

  let totalPassed = 0, totalTests = 0, anyRunning = false;

  [[ig, '📷 Instagram'], [tt, '🎵 TikTok']].forEach(([result, title]) => {
    if (!result) return;
    const tests  = _diagPlatformTests(result);
    const passed = tests.filter(t => t.ok).length;
    totalPassed += passed;
    totalTests  += tests.length;
    if (result.running) anyRunning = true;

    const section = document.createElement('div');
    section.className = 'st-test-platform';

    const hdr = document.createElement('div');
    hdr.className = 'st-test-platform-hdr';
    hdr.textContent = result.running
      ? `${title} — running… (${passed}/${tests.length} so far)`
      : `${title} — ${passed}/${tests.length} passed`;
    section.appendChild(hdr);

    tests.forEach(t => {
      const row     = document.createElement('details');
      row.className = 'st-test-case';
      const sum     = document.createElement('summary');
      sum.textContent = `${t.ok ? '✅' : '❌'} ${t.name}`;
      row.appendChild(sum);
      if (t.detail) {
        const body = document.createElement('div');
        body.className = 'st-test-detail';
        body.textContent = t.detail;
        row.appendChild(body);
      }
      section.appendChild(row);
    });

    if (result.running) {
      const hint = document.createElement('div');
      hint.className = 'st-test-running';
      hint.textContent = '⏳ Running — popup may close when a window opens; reopen to see results.';
      section.appendChild(hint);
    }
    if (result.error) {
      const err = document.createElement('div');
      err.className = 'st-test-error';
      err.textContent = `✖ ${result.error}`;
      section.appendChild(err);
    } else if (result.verdict) {
      const v = document.createElement('div');
      v.className = 'st-test-verdict';
      v.textContent = `⇒ ${result.verdict}`;
      section.appendChild(v);
    }

    container.appendChild(section);
  });

  // Update drawer header badge
  if (summary && totalTests > 0) {
    const allPass = totalPassed === totalTests && !anyRunning;
    const hasFail = totalPassed < totalTests && !anyRunning;
    summary.textContent = anyRunning
      ? `Running…`
      : `Last run: ${totalPassed}/${totalTests} passed`;
    summary.className = 'st-drawer-summary st-diag-summary-badge ' + (
      anyRunning ? 'st-diag-summary-badge--running'
      : allPass  ? 'st-diag-summary-badge--pass'
      :            'st-diag-summary-badge--fail'
    );
  }

  if (btn) {
    btn.disabled = anyRunning;
    btn.textContent = anyRunning ? '🧪 Running…' : '🧪 Run Tests';
  }
}

function loadDiagResults() {
  chrome.storage.local.get({ silentTestResults: {} }, ({ silentTestResults }) =>
    _renderDiagResults(silentTestResults));
}

// Live updates if the popup stays open during a run
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.silentTestResults)
    _renderDiagResults(changes.silentTestResults.newValue);
});

document.getElementById('runDiagnosticBtn')?.addEventListener('click', () => {
  const btn = document.getElementById('runDiagnosticBtn');
  const container = document.getElementById('stDiagResults');
  if (btn) { btn.disabled = true; btn.textContent = '🧪 Running…'; }
  if (container) container.innerHTML = '<div class="st-test-running">⏳ Starting — opening platforms in minimised windows…</div>';
  // Persist flag so settings auto-reopens to the Tests drawer if the popup closes
  chrome.storage.local.set({ settingsReopenToDiag: true }, () => {
    chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTICS' }, () => {
      chrome.storage.local.remove('settingsReopenToDiag');
      loadDiagResults();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ONBOARDING
// ════════════════════════════════════════════════════════════════════════════

function showOnboarding() {
  const ob = document.getElementById('onboarding');
  if (!ob) return;
  // Reset to step 1
  goObStep(1);
  ob.classList.remove('hidden');
}

function hideOnboarding() {
  document.getElementById('onboarding')?.classList.add('hidden');
  chrome.storage.local.set({ hasSeenOnboarding: true });
}

function goObStep(n) {
  [1,2,3,4].forEach(i => {
    document.getElementById(`ob-step-${i}`)?.classList.toggle('hidden', i !== n);
    document.querySelector(`.ob-dot[data-step="${i}"]`)?.classList.toggle('active', i === n);
  });
}

// "Next" buttons
document.querySelectorAll('.ob-btn-next').forEach(btn => {
  btn.addEventListener('click', () => goObStep(parseInt(btn.dataset.to)));
});

// Skip / Continue from API keys step — advance to completion screen
document.getElementById('obSkipKey')?.addEventListener('click', () => {
  showObComplete(!!API_KEY);
  goObStep(4);
});
document.getElementById('obKeyContinue')?.addEventListener('click', () => {
  showObComplete(!!API_KEY);
});

// Save Google API key in onboarding
document.getElementById('obSaveKey')?.addEventListener('click', () => {
  const input  = document.getElementById('obApiKeyInput');
  const status = document.getElementById('obKeyStatus');
  const val = (input?.value || '').trim();
  if (!val) { if (status) { status.className='ob-key-status err'; status.textContent='Please enter an API key.'; } return; }
  if (status) { status.className='ob-key-status'; status.textContent='Saving…'; }
  chrome.storage.local.set({ googleApiKey: val }, () => {
    API_KEY = val;
    if (status) { status.className='ob-key-status ok'; status.textContent='✓ Google key saved!'; }
  });
});

// Save Foursquare API key in onboarding
document.getElementById('obSaveFsqKey')?.addEventListener('click', () => {
  const input  = document.getElementById('obFsqKeyInput');
  const status = document.getElementById('obFsqKeyStatus');
  const val = (input?.value || '').trim();
  if (!val) { if (status) { status.className='ob-key-status err'; status.textContent='Please enter an API key.'; } return; }
  if (status) { status.className='ob-key-status'; status.textContent='Saving…'; }
  chrome.storage.local.set({ foursquareApiKey: val }, () => {
    if (status) { status.className='ob-key-status ok'; status.textContent='✓ Foursquare key saved!'; }
  });
});

function showObComplete(hasKey) {
  const el = document.getElementById('obFeatureStatus');
  if (!el) return;
  chrome.storage.local.get({ foursquareApiKey: '' }, ({ foursquareApiKey }) => {
    const features = buildFeatureStatus(hasKey, !!foursquareApiKey);
    el.innerHTML = features.map(f => `
      <div class="ob-feat ${f.on ? 'enabled' : 'disabled'}">
        ${f.on ? '✅' : '⚠️'} ${f.label}${f.note ? ` <em style="font-size:.67rem">${f.note}</em>` : ''}
      </div>`).join('');
  });
}

// Finish onboarding
document.getElementById('obFinishBtn')?.addEventListener('click', () => {
  hideOnboarding();
  // Re-init with potentially new API key
  chrome.storage.local.get({ googleApiKey: '' }, ({ googleApiKey }) => {
    if (googleApiKey) { API_KEY = googleApiKey; initAfterKey(); }
  });
});

// ── Check on popup open whether to show onboarding or reopen settings ────────
chrome.storage.local.get({ hasSeenOnboarding: false, googleApiKey: '', settingsReopenToDiag: false }, ({ hasSeenOnboarding, googleApiKey, settingsReopenToDiag }) => {
  if (!hasSeenOnboarding) {
    showOnboarding();
    if (googleApiKey) {
      const input = document.getElementById('obApiKeyInput');
      if (input) input.value = googleApiKey;
    }
    return;
  }
  // If the user ran a diagnostic test and the popup closed mid-run, reopen settings
  // to the Tests drawer so they can see the results without any extra clicks.
  if (settingsReopenToDiag) {
    chrome.storage.local.remove('settingsReopenToDiag');
    openSettings();
    // Open the Tests drawer
    const diagHdr  = document.getElementById('stDiagHdr');
    const diagBody = document.getElementById('stDiagBody');
    if (diagHdr && diagBody) {
      diagHdr.classList.remove('collapsed');
      diagBody.classList.remove('collapsed');
    }
  }
});

// ── Constants ─────────────────────────────────────────────────────────────────

const PLACES_SEARCH = "https://places.googleapis.com/v1/places:searchText";
const PLACES_PHOTO  = "https://places.googleapis.com/v1";
const ITUNES_SEARCH = "https://itunes.apple.com/search";

const COST_TEXT_SEARCH = 0.017;
const COST_PHOTO       = 0.007;
const WARN_SOFT        = 5;
const WARN_HARD        = 20;

// ── Centralized telemetry (opt-in) ────────────────────────────────────────────
// Mirrors the helper in background.js — see that file for the rationale.
// Sends technical-log batches to the developer-run Cloudflare Worker, tagged
// with an anonymous per-install UUID, only when the user has enabled
// "Diagnostics & Sharing" in Settings and CONFIG.TELEMETRY_ENDPOINT is set.
async function getInstallId() {
  const { installId } = await chrome.storage.local.get({ installId: null });
  if (installId) return installId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installId: id });
  return id;
}

async function sendTelemetry(kind, payload) {
  const endpoint = (typeof CONFIG !== 'undefined' && CONFIG.TELEMETRY_ENDPOINT) || '';
  if (!endpoint) return;
  try {
    const { telemetryOptIn = false } = await chrome.storage.local.get({ telemetryOptIn: false });
    if (!telemetryOptIn) return;
    const installId = await getInstallId();
    await fetch(`${endpoint}/v1/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId, ts: new Date().toISOString(), ...payload }),
    });
  } catch (_) { /* telemetry is best-effort only */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// TECHNICAL LOGGER — structured action log for debugging and audit
// ══════════════════════════════════════════════════════════════════════════════

const TechLog = {
  _sessionId: `s-${Date.now()}`,
  _buf: [],
  _MAX_BUF: 25,

  _entry(level, category, action, details = {}) {
    const e = {
      id:        `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ts:        new Date().toISOString(),
      session:   this._sessionId,
      level,
      source:    "popup",
      category,
      action,
      ...details,
    };
    this._buf.push(e);
    console.log(`[TechLog] ${level.toUpperCase()} ${category}/${action}`, details);
    if (this._buf.length >= this._MAX_BUF || level === "error") this._flush();
    return e;
  },

  info:  (cat, action, d) => TechLog._entry("info",  cat, action, d),
  warn:  (cat, action, d) => TechLog._entry("warn",  cat, action, d),
  error: (cat, action, d) => TechLog._entry("error", cat, action, d),

  _flush() {
    if (!this._buf.length) return;
    const toFlush = [...this._buf]; this._buf = [];
    chrome.storage.local.get({ techLog: [] }, ({ techLog }) => {
      const updated = [...techLog, ...toFlush].slice(-1000); // keep last 1000 entries
      chrome.storage.local.set({ techLog: updated });
    });
    sendTelemetry('logs', { entries: toFlush });
  },

  exportCSV() {
    chrome.storage.local.get({ techLog: [] }, ({ techLog }) => {
      // Comprehensive columns including all new fields added in V1.8 / V2.0.
      // V2.0 adds the TikTok step-tracker fields (step/detail) plus the
      // upload-error / "Something went wrong" diagnostic fields (matched,
      // context, lastStep, lastStepDetail, pageSnippet) so the exported CSV
      // actually shows *which* step the bot was on and what it found.
      const cols = [
        "ts","run_type","run_id","level","source","category","action",
        "duration_ms","name","platform","status","photo_source","photo_count",
        "source_breakdown","song","artist","language","error","session","id",
        "step","detail","matched","context","lastStep","lastStepDetail","pageSnippet"
      ];
      const rows = techLog.map(e => cols.map(c => {
        const v = e[c];
        if (v === undefined || v === null) return "";
        if (typeof v === "object") return `"${JSON.stringify(v).replace(/"/g,'""')}"`;
        return `"${String(v).replace(/"/g,'""')}"`;
      }).join(","));
      const csv  = [cols.join(","), ...rows].join("\n");
      const slug = new Date().toISOString().slice(0, 10);
      chrome.runtime.sendMessage({
        type:     "DOWNLOAD",
        url:      "data:text/csv;charset=utf-8," + encodeURIComponent(csv),
        filename: `FoodFluencer/tech_log_${slug}.csv`,
      });
    });
  },
};

// ── App logger ────────────────────────────────────────────────────────────────

const AppLog = {
  _write(level, message, data) {
    const entry = {
      ts:      new Date().toISOString(),
      source:  "popup",
      level,
      message,
      data:    data !== undefined ? (typeof data === "string" ? data : JSON.stringify(data)) : null,
    };
    chrome.storage.local.get({ appLog: [] }, ({ appLog }) => {
      appLog.push(entry);
      if (appLog.length > 800) appLog = appLog.slice(-600);
      chrome.storage.local.set({ appLog });
    });
  },
  info:  (msg, d) => AppLog._write("info",  msg, d),
  warn:  (msg, d) => AppLog._write("warn",  msg, d),
  error: (msg, d) => AppLog._write("error", msg, d),
};

// Reused regex for extracting city from a formatted address
// Matches "1234 CityName, Country" patterns across all supported countries.
const CITY_FROM_ADDRESS_RE = /\d{4}\s+([A-Za-zÀ-ÿ\s-]+),\s*(?:Belgium|France|Germany|Luxembourg|(?:The )?Netherlands)/i;

// ── State ─────────────────────────────────────────────────────────────────────

let API_KEY           = "";
let currentRestaurant = null;
const uriCache        = new Map(); // "photoName|maxWidth" → uri
let selectedSong      = null;
let activePlatforms   = new Set();
let coverPhotoIndex   = 0;         // index into currentRestaurant.photos[]
let captionOpenerOffset = 0;       // bumped each time the caption is regenerated
const coverOverlayCache = new Map(); // "photoName|restaurantName" → overlayDataUrl

const $ = id => document.getElementById(id);

// ── Manual Post: search mode helper ─────────────────────────────────────────────
function isBotSearchMode() {
  return !!document.getElementById("searchModeBot")?.classList.contains("active");
}

// ── Cover photo overlay ───────────────────────────────────────────────────────

// Wait for Cormorant Garamond (loaded via Google Fonts <link> in popup.html)
async function ensureCoverFont() {
  try { await document.fonts.ready; } catch(_) {}
}
ensureCoverFont();

// Short tagline for cover — varies per venue (consistent per name)
function getCoverTagline(restaurantName, city) {
  const seed = restaurantName.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const c = city || 'Belgium';
  const lines = [
    `Must visit in ${c} 📍`,
    `Hidden gem in ${c} ✨`,
    `Have you been here? 🔥`,
    `${c}'s finest spot`,
    `Worth every visit 😍`,
    `Don't miss this place! ✨`,
    `A must in ${c}!`,
    `Next stop: ${c} 📍`,
    `Taste the best of ${c} 🔥`,
    `Discover ${c} 🌟`,
  ];
  return lines[seed % lines.length];
}

// ── Photo quality scoring ─────────────────────────────────────────────────────

const MIN_PHOTO_DIM   = 720;  // minimum short-side pixels for a post-worthy photo
const IG_MIN_RATIO    = 0.8;  // Instagram minimum aspect ratio (4:5 portrait)
const IG_MAX_RATIO    = 1.91; // Instagram maximum aspect ratio (~landscape)

// Resolution used to fetch photos for the quality/resolution gate — matches
// the Auto Bot's resolvePhotoUriBG(name, 2048, ...) so "Low res" reflects the
// true source photo, not the small grid thumbnail.
const QUALITY_SCAN_DIM = 2048;

// ── Content appeal heuristics ─────────────────────────────────────────────────
// Mirrors computeAppealMetrics() in background.js — see that file for the
// rationale behind each metric. Kept as a duplicate here since popup.js and
// the service worker run in separate execution contexts with no shared module.
function computeAppealMetrics(data, gray, W, H) {
  const total = W * H;

  let rgSum = 0, ybSum = 0, rgSumSq = 0, ybSumSq = 0, rbSum = 0;
  for (let i = 0; i < total; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const rg = r - g;
    const yb = 0.5 * (r + g) - b;
    rgSum += rg; ybSum += yb;
    rgSumSq += rg * rg; ybSumSq += yb * yb;
    rbSum += (r - b);
  }
  const rgMean = rgSum / total, ybMean = ybSum / total;
  const rgStd = Math.sqrt(Math.max(0, rgSumSq / total - rgMean * rgMean));
  const ybStd = Math.sqrt(Math.max(0, ybSumSq / total - ybMean * ybMean));
  const colorfulness = Math.sqrt(rgStd * rgStd + ybStd * ybStd) + 0.3 * Math.sqrt(rgMean * rgMean + ybMean * ybMean);
  const warmth = rbSum / total;

  const x0 = Math.floor(W * 0.25), x1 = Math.floor(W * 0.75);
  const y0 = Math.floor(H * 0.25), y1 = Math.floor(H * 0.75);
  let centerE = 0, centerN = 0, outerE = 0, outerN = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const idx = y * W + x;
      const lap = gray[idx - W] + gray[idx + W] + gray[idx - 1] + gray[idx + 1] - 4 * gray[idx];
      const e = lap * lap;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) { centerE += e; centerN++; }
      else { outerE += e; outerN++; }
    }
  }
  const centerDensity = centerN ? centerE / centerN : 0;
  const outerDensity  = outerN  ? outerE  / outerN  : 0;
  const centerFocus = outerDensity > 0 ? centerDensity / outerDensity : 1;

  const colorfulnessNorm = Math.max(0, Math.min(100, colorfulness * 1.2));
  const warmthNorm       = Math.max(0, Math.min(100, ((warmth + 60) / 120) * 100));
  const centerFocusNorm  = Math.max(0, Math.min(100, (centerFocus / 2) * 100));

  const appeal = colorfulnessNorm * 0.4 + warmthNorm * 0.3 + centerFocusNorm * 0.3;
  return { colorfulness, warmth, centerFocus, appeal };
}

// Returns { score, blurScore, meetsResolution, width, height }
// score         — combined quality signal (higher = better)
// blurScore     — Laplacian variance; higher means sharper
// meetsResolution — false if the actual delivered image is below MIN_PHOTO_DIM
async function scorePhotoQuality(uri) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const SW = Math.min(img.naturalWidth,  200);
        const SH = Math.min(img.naturalHeight, 200);
        const c = document.createElement('canvas');
        c.width = SW; c.height = SH;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, SW, SH);
        const d = ctx.getImageData(0, 0, SW, SH).data;

        // Build grayscale array + luminance stats
        const gray = new Float32Array(SW * SH);
        let sum = 0, sumSq = 0;
        for (let i = 0; i < SW * SH; i++) {
          const lum = 0.299 * d[i*4] + 0.587 * d[i*4+1] + 0.114 * d[i*4+2];
          gray[i] = lum; sum += lum; sumSq += lum * lum;
        }
        const mean = sum / (SW * SH);
        const contrast = Math.sqrt(Math.max(0, sumSq / (SW * SH) - mean * mean));

        // Laplacian variance — measures edge energy; low = blurry
        let lapSum = 0, lapSumSq = 0, lapN = 0;
        for (let y = 1; y < SH - 1; y++) {
          for (let x = 1; x < SW - 1; x++) {
            const lap = 4 * gray[y*SW+x]
              - gray[(y-1)*SW+x] - gray[(y+1)*SW+x]
              - gray[y*SW+x-1]   - gray[y*SW+x+1];
            lapSum += lap; lapSumSq += lap * lap; lapN++;
          }
        }
        const lapMean  = lapSum / lapN;
        const blurScore = lapSumSq / lapN - lapMean * lapMean; // higher = sharper

        // Penalise very dark (<40) or blown-out (>215)
        const brightnessPenalty = Math.max(0, 40 - mean) + Math.max(0, mean - 215);
        // Combined score: contrast + capped blur contribution - brightness penalty
        const baseScore = contrast + Math.min(blurScore * 0.12, 25) - brightnessPenalty * 0.5;

        // Blend in content-appeal (colorfulness/warmth/center focus) so the
        // "Best" cover pick also favours engaging-looking shots, not just
        // technically clean ones.
        const { colorfulness, warmth, centerFocus, appeal } = computeAppealMetrics(d, gray, SW, SH);
        const score = baseScore * 0.5 + appeal * 0.5;

        const meetsResolution = Math.min(img.naturalWidth, img.naturalHeight) >= MIN_PHOTO_DIM;
        resolve({ score, blurScore, meetsResolution, appeal, colorfulness, warmth, centerFocus,
                  width: img.naturalWidth, height: img.naturalHeight });
      } catch(_) {
        resolve({ score: 50, blurScore: 100, meetsResolution: true, width: 0, height: 0 });
      }
    };
    img.onerror = () =>
      resolve({ score: 50, blurScore: 100, meetsResolution: true, width: 0, height: 0 });
    img.src = uri;
  });
}

function updateQualityBadges() {
  if (!currentRestaurant) return;
  const scored = currentRestaurant.photos
    .map((p, i) => ({ i, score: p.qualityScore ?? -Infinity, ok: p.meetsResolution !== false }))
    .filter(p => p.score > -Infinity);
  if (!scored.length) return;
  const eligibleForBest = scored.filter(p => p.ok);
  const bestIdx = eligibleForBest.length >= 2
    ? eligibleForBest.reduce((a, b) => a.score >= b.score ? a : b).i
    : -1;
  const grid = $('photoGrid');
  currentRestaurant.photos.forEach((p, i) => {
    const slot  = grid?.querySelector(`[data-slot="${i}"]`);
    const badge = slot?.querySelector('.quality-badge');
    if (!badge) return;
    if (p.meetsResolution === false) {
      badge.textContent = '⚠ Low res';
      badge.className   = 'quality-badge quality-lowres';
    } else if (i === bestIdx) {
      badge.textContent = '◆ Best';
      badge.className   = 'quality-badge quality-best';
    } else {
      badge.textContent = '';
      badge.className   = 'quality-badge';
    }
  });
}

async function createCoverOverlay(imgUri, restaurantName, address) {
  const key = `${imgUri.slice(-40)}|${restaurantName}`;
  if (coverOverlayCache.has(key)) return coverOverlayCache.get(key);

  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { try {
      // NOTE: this overlay is now used for the GRID PREVIEW only. The real
      // post overlay is applied inside each platform injector at native
      // resolution. Never upscale here — downscale-only keeps the preview sharp.
      const MAX_DIM = 1440;
      const srcW = img.naturalWidth  || 900;
      const srcH = img.naturalHeight || 900;

      // Crop to Instagram-valid aspect ratio (centre crop)
      const ratio = srcW / srcH;
      let cropW = srcW, cropH = srcH;
      if (ratio < IG_MIN_RATIO)      cropH = Math.round(srcW / IG_MIN_RATIO);
      else if (ratio > IG_MAX_RATIO) cropW = Math.round(srcH * IG_MAX_RATIO);
      const cropOffX = Math.round((srcW - cropW) / 2);
      const cropOffY = Math.round((srcH - cropH) / 2);

      // Downscale-only — clamp the long side to MAX_DIM, never enlarge
      const downScale = Math.min(1, MAX_DIM / Math.max(cropW, cropH));
      const W = Math.round(cropW * downScale);
      const H = Math.round(cropH * downScale);
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      // Draw base image — crop and (down)scale in one pass
      ctx.drawImage(img, cropOffX, cropOffY, cropW, cropH, 0, 0, W, H);

      // ── Find the darkest vertical zone for best text readability ──────────
      function sampleLuminance(x, y, w, h) {
        try {
          const d = ctx.getImageData(Math.round(x), Math.round(y),
                                     Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data;
          let sum = 0, n = 0;
          for (let i = 0; i < d.length; i += 16) { // every 4th pixel for speed
            sum += 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
            n++;
          }
          return n > 0 ? sum / n : 128;
        } catch(_) { return 128; }
      }

      // Three candidate zones (top / middle / bottom third)
      const zones = [
        { id: 'top',    lum: sampleLuminance(0, 0,       W, H*0.37), centerY: H*0.22 },
        { id: 'middle', lum: sampleLuminance(0, H*0.30,  W, H*0.40), centerY: H*0.50 },
        { id: 'bottom', lum: sampleLuminance(0, H*0.63,  W, H*0.37), centerY: H*0.80 },
      ];
      const best = zones.reduce((a, b) => a.lum <= b.lum ? a : b);

      // ── Vignette — strongest toward the chosen text zone ─────────────────
      // Linear gradient from the zone edges
      const vigStart = best.centerY - H * 0.22;
      const vigEnd   = best.centerY + H * 0.22;
      const vlin = ctx.createLinearGradient(0, vigStart, 0, vigEnd);
      vlin.addColorStop(0,   'rgba(0,0,0,0.00)');
      vlin.addColorStop(0.5, 'rgba(0,0,0,0.48)');
      vlin.addColorStop(1,   'rgba(0,0,0,0.00)');
      ctx.fillStyle = vlin; ctx.fillRect(0, 0, W, H);
      // Light overall edge vignette
      const vedge = ctx.createRadialGradient(W/2, H/2, H*0.18, W/2, H/2, H*0.82);
      vedge.addColorStop(0, 'rgba(0,0,0,0.00)');
      vedge.addColorStop(1, 'rgba(0,0,0,0.28)');
      ctx.fillStyle = vedge; ctx.fillRect(0, 0, W, H);

      // ── Sizes ─────────────────────────────────────────────────────────────
      const nameSize   = Math.max(32, Math.round(W * 0.072));
      const tagSize    = Math.max(16, Math.round(W * 0.028));
      const cornerSize = Math.max(10, Math.round(W * 0.016));
      const gap        = Math.round(nameSize * 0.42);

      // Extract city (for tagline + corner label only)
      const cityM = address.match(CITY_FROM_ADDRESS_RE);
      const city  = (cityM?.[1] || address.split(',')[0] || '').trim();
      const tagline = getCoverTagline(restaurantName, city);

      // Two-line block: tagline + restaurant name
      const blockH = tagSize + gap + nameSize;
      let y = best.centerY - blockH / 2;

      ctx.fillStyle    = '#FFFFFF';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.shadowColor  = 'rgba(0,0,0,0.72)';
      ctx.shadowOffsetX = 0;

      // ── Tagline (small, italic — already contains city) ───────────────────
      ctx.font       = `300 italic ${tagSize}px "Cormorant Garamond", Georgia, serif`;
      ctx.shadowBlur = Math.round(tagSize * 0.55);
      ctx.shadowOffsetY = 1;
      ctx.fillText(tagline, W / 2, y);
      y += tagSize + gap;

      // ── Restaurant name (larger) ──────────────────────────────────────────
      ctx.font       = `400 ${nameSize}px "Cormorant Garamond", Georgia, serif`;
      ctx.shadowBlur = Math.round(nameSize * 0.26);
      ctx.shadowOffsetY = 2;
      ctx.fillText(restaurantName, W / 2, y);

      // ── Bottom-right corner micro-label ───────────────────────────────────
      if (city) {
        ctx.font         = `300 ${cornerSize}px "Cormorant Garamond", Georgia, serif`;
        ctx.textAlign    = 'right';
        ctx.textBaseline = 'bottom';
        ctx.shadowBlur   = 3;
        ctx.shadowOffsetY = 0;
        const pad = Math.round(W * 0.032);
        ctx.fillText(`${city}, Belgium`, W - pad, H - pad);
      }

      const result = canvas.toDataURL('image/jpeg', 0.97);
      coverOverlayCache.set(key, result);
      resolve(result);
    } catch(e) { resolve(null); } }; // try/catch ensures promise always resolves
    img.onerror = () => resolve(null);
    img.src = imgUri;
  });
}

function setCoverPhoto(newIndex) {
  if (!currentRestaurant) return;
  // Clicking the current cover photo's badge again clears it (no cover photo)
  coverPhotoIndex = (newIndex === coverPhotoIndex) ? -1 : newIndex;
  coverOverlayCache.clear(); // invalidate cache (photo changed)
  renderPhotoGrid();
  saveState();
}

// Reorders currentRestaurant.photos via drag & drop, keeping the cover
// photo selection pinned to the same photo even after it moves.
function reorderPhotos(fromIndex, toIndex) {
  if (!currentRestaurant) return;
  const { photos } = currentRestaurant;
  if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= photos.length ||
      toIndex < 0 || toIndex >= photos.length) return;

  const coverPhoto = coverPhotoIndex >= 0 ? photos[coverPhotoIndex] : null;

  const [moved] = photos.splice(fromIndex, 1);
  photos.splice(toIndex, 0, moved);

  if (coverPhoto) coverPhotoIndex = photos.indexOf(coverPhoto);

  coverOverlayCache.clear();
  renderPhotoGrid();
  saveState();
  AppLog.info("Photo order changed", { fromIndex, toIndex });
}

// ── State persistence ─────────────────────────────────────────────────────────

function saveState() {
  if (!currentRestaurant) return;
  chrome.storage.local.set({
    lastState: {
      restaurant:      currentRestaurant,
      uriCacheEntries: [...uriCache.entries()],
      selectedSong,
      caption:         $("caption")?.value || "",
      activePlatforms: [...activePlatforms],
      coverPhotoIndex,
      resultsTarget,
    },
  });
}

// ── Place Preview: move the shared #results panel between the Manual Search
// and Bot Search ("Singular Horeca Post") sections, depending on which flow
// produced the result, so the preview always appears where the user is
// looking. ──────────────────────────────────────────────────────────────────
let resultsTarget = "bot";
function moveResultsTo(target) {
  resultsTarget = target;
  const results = $("results");
  const anchor  = document.getElementById(target === "manual" ? "resultsAnchorManual" : "resultsAnchorBot");
  if (!results || !anchor) return;
  anchor.insertAdjacentElement("afterend", results);
}

// Debounced save for caption edits
let _saveTimer = null;
function saveStateSoon() { clearTimeout(_saveTimer); _saveTimer = setTimeout(saveState, 600); }

// Tracks the most recent renderPhotoGrid call so stale in-flight photo resolves
// from a previous restaurant don't write into the new grid.
let _photoGridVersion = 0;

function restoreState(saved) {
  if (!saved?.restaurant) return;

  // Restore URI cache
  (saved.uriCacheEntries || []).forEach(([k, v]) => uriCache.set(k, v));

  // Restore restaurant
  currentRestaurant = saved.restaurant;
  coverPhotoIndex   = saved.coverPhotoIndex ?? 0;

  $("restaurantName").textContent    = currentRestaurant.name;
  $("restaurantAddress").textContent = currentRestaurant.address;
  $("restaurantMeta").textContent    = currentRestaurant.rating
    ? `⭐ ${currentRestaurant.rating} · ${(currentRestaurant.totalRatings || 0).toLocaleString()} ratings` : "";

  const link = $("restaurantMapsLink");
  link.href = currentRestaurant.mapsUrl || "#";
  link.style.display = currentRestaurant.mapsUrl ? "inline" : "none";

  $("query").value = currentRestaurant.name;

  renderPhotoGrid();

  // Restore song
  if (saved.selectedSong) {
    selectedSong = saved.selectedSong;
    $("selectedSongArt").src            = selectedSong.artwork;
    $("selectedSongName").textContent   = selectedSong.name;
    $("selectedSongArtist").textContent = selectedSong.artist;
    $("selectedSong").classList.remove("hidden");
  }

  // Restore caption — always guarantee an engagement opener is present
  if ($("caption")) {
    const raw = saved.caption || buildDefaultCaption();
    $("caption").value = ensureOpener(raw);
  }

  // Restore platforms
  (saved.activePlatforms || []).forEach(p => {
    activePlatforms.add(p);
    document.querySelector(`.social-btn[data-platform="${p}"]`)?.classList.add("active");
  });

  // Show the preview in whichever section the place was originally found from.
  const target = saved.resultsTarget === "manual" ? "manual" : "bot";
  moveResultsTo(target);
  if (target === "manual") {
    if (isBotSearchMode()) setSearchMode("manual");
  } else if (!isBotSearchMode()) {
    setSearchMode("bot");
  }
  $("results").classList.remove("hidden");
}

// ── Init ──────────────────────────────────────────────────────────────────────

chrome.storage.local.get(
  { googleApiKey: "", lastState: null, autoBotActive: false },
  ({ googleApiKey, lastState, autoBotActive: botActive }) => {
    API_KEY = googleApiKey;

    if (botActive) {
      // Bot is running — skip mode selector, go directly to Auto Bot panel
      TechLog.info("NAV", "auto_navigate", { reason: "bot_active" });
      showMode("auto");
      setTimeout(() => {
        loadAutoBotConfig();
        setTimeout(restoreBotActiveState, 80);
      }, 50);
    } else {
      showKeySetup(!API_KEY);
      checkUsageWarning();
      loadAutoBotConfig();   // populate Auto Bot filter settings
      loadManualConfig();    // populate independent Manual Post filter settings
      if (API_KEY && lastState) restoreState(lastState);
    }
  }
);

// ── API key setup ─────────────────────────────────────────────────────────────

function showKeySetup(show) {
  $("keySetup").classList.toggle("hidden", !show);
  document.querySelector(".search-mode-toggle")?.classList.toggle("hidden", show);
  document.querySelector(".search-section").classList.toggle("hidden", show);
  $("botSearchPanel")?.classList.toggle("hidden", show || !document.getElementById("searchModeBot")?.classList.contains("active"));
  if (show) $("results").classList.add("hidden");
}

$("saveKeyBtn").addEventListener("click", () => {
  const key = $("apiKeyInput").value.trim();
  if (!key) return;
  chrome.storage.local.set({ googleApiKey: key }, () => {
    API_KEY = key;
    showKeySetup(false);
  });
});

document.getElementById('saveFsqKeyBtn')?.addEventListener('click', () => {
  const key = document.getElementById('fsqKeyInput')?.value.trim();
  if (!key) return;
  chrome.storage.local.set({ foursquareApiKey: key });
});

// ── API usage tracking ────────────────────────────────────────────────────────

function trackApiCall(type, query = "") {
  const cost = type === "search" ? COST_TEXT_SEARCH : COST_PHOTO;
  chrome.storage.local.get({ apiLog: [], totalCost: 0 }, ({ apiLog, totalCost }) => {
    apiLog.push({ ts: new Date().toISOString(), type, query, cost });
    const newTotal = +(totalCost + cost).toFixed(4);
    chrome.storage.local.set({ apiLog, totalCost: newTotal }, checkUsageWarning);
  });
}

function checkUsageWarning() {
  chrome.storage.local.get({ totalCost: 0, apiLog: [] }, ({ totalCost, apiLog }) => {
    const warn = $("usageWarning");
    const txt  = $("usageWarningText");
    if (totalCost >= WARN_HARD) {
      warn.classList.remove("hidden");
      warn.style.cssText = "border-color:#dc2626;background:#fef2f2;color:#991b1b;";
      txt.textContent = `⛔ High API usage: ~$${totalCost.toFixed(2)} (${apiLog.length} calls). Consider pausing your key.`;
    } else if (totalCost >= WARN_SOFT) {
      warn.classList.remove("hidden");
      warn.style.cssText = "";
      txt.textContent = `⚠️ API usage: ~$${totalCost.toFixed(2)} across ${apiLog.length} calls.`;
    } else {
      warn.classList.add("hidden");
    }
  });
}

$("downloadLogBtn").addEventListener("click", () => {
  chrome.storage.local.get({ apiLog: [] }, ({ apiLog }) => {
    const csv = ["timestamp,type,query,cost_usd",
      ...apiLog.map(r => `${r.ts},${r.type},"${(r.query||"").replace(/"/g,'""')}",${r.cost}`)
    ].join("\n");
    chrome.runtime.sendMessage({
      type: "DOWNLOAD",
      url: "data:text/csv;charset=utf-8," + encodeURIComponent(csv),
      filename: `FoodFluencer/api_log_${new Date().toISOString().slice(0,10)}.csv`,
    });
  });
});

// ── Places API (New) ──────────────────────────────────────────────────────────

// Searches for places matching a free-text query, biased to the configured
// country, and returns up to several candidates so the user can disambiguate
// (e.g. "Hilton" -> several Hilton hotels in the area).
async function searchRestaurantMulti(query, country = "BE") {
  const countryName = AB_COUNTRY_NAMES[country] || "Belgium";
  const bounds      = AB_COUNTRY_BOUNDS[country] || AB_COUNTRY_BOUNDS.BE;
  const q = new RegExp(countryName, "i").test(query) ? query : `${query} ${countryName}`;
  trackApiCall("search", q);

  const res = await fetch(PLACES_SEARCH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri,places.photos",
    },
    body: JSON.stringify({
      textQuery: q,
      maxResultCount: 8,
      locationRestriction: { rectangle: bounds },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `API error ${res.status}`;
    if (/quota|billing|exceeded|disabled|SERVICE_DISABLED/i.test(msg))
      throw new Error(`⛔ Google API quota exceeded or billing issue — check your Google Cloud Console. (${msg})`);
    throw new Error(msg);
  }
  const data = await res.json();
  if (!data.places?.length)
    throw new Error(`No results found for "${query}" in ${countryName}.`);
  return data.places;
}

async function resolvePhotoUri(photoName, maxWidth = 400) {
  const key = `${photoName}|${maxWidth}`;
  if (uriCache.has(key)) return uriCache.get(key);
  trackApiCall("photo", "");
  const res  = await fetch(`${PLACES_PHOTO}/${photoName}/media?maxWidthPx=${maxWidth}&key=${API_KEY}&skipHttpRedirect=true`);
  const data = await res.json();
  const uri  = data.photoUri;
  uriCache.set(key, uri);
  return uri;
}

// ── Render restaurant ─────────────────────────────────────────────────────────

function renderResults(place, target = "bot") {
  const allPhotos = (place.photos || [])
    .sort((a, b) => (b.width || 0) - (a.width || 0))
    .map(p => ({ name: p.name }));

  currentRestaurant = {
    name:         place.displayName?.text || "",
    address:      place.formattedAddress  || "",
    rating:       place.rating,
    totalRatings: place.userRatingCount,
    mapsUrl:      place.googleMapsUri     || "",
    allPhotos,
    photos: allPhotos.slice(0, CONFIG.MAX_PHOTOS),
  };

  $("restaurantName").textContent    = currentRestaurant.name;
  $("restaurantAddress").textContent = currentRestaurant.address;
  $("restaurantMeta").textContent    = place.rating
    ? `⭐ ${place.rating} · ${(place.userRatingCount || 0).toLocaleString()} ratings` : "";

  const link = $("restaurantMapsLink");
  link.href = currentRestaurant.mapsUrl || "#";
  link.style.display = currentRestaurant.mapsUrl ? "inline" : "none";

  // Reset cover to first (best quality) photo on new search
  coverPhotoIndex = 0;
  coverOverlayCache.clear();

  renderPhotoGrid();

  // Auto-fill caption on fresh search (not restore)
  if ($("caption")) $("caption").value = buildDefaultCaption();

  // Show the preview in whichever section the place was found from.
  moveResultsTo(target);
  if (target === "manual") {
    if (isBotSearchMode()) setSearchMode("manual");
  } else if (!isBotSearchMode()) {
    setSearchMode("bot");
  }
  $("results").classList.remove("hidden");
  saveState();
}

function renderPhotoGrid() {
  const grid    = $("photoGrid");
  const photos  = currentRestaurant.photos;
  grid.innerHTML = "";

  // Stamp this render so any in-flight resolves from a previous restaurant
  // that complete late can detect they're stale and bail out.
  const myVersion = ++_photoGridVersion;

  photos.forEach((photo, i) => {
    const div = document.createElement("div");
    div.className = "photo-item";
    div.dataset.slot = i;
    div.draggable = true;

    div.addEventListener("dragstart", e => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i));
      div.classList.add("dragging");
    });
    div.addEventListener("dragend", () => {
      div.classList.remove("dragging");
      grid.querySelectorAll(".photo-item.drag-over").forEach(el => el.classList.remove("drag-over"));
    });
    div.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      div.classList.add("drag-over");
    });
    div.addEventListener("dragleave", () => div.classList.remove("drag-over"));
    div.addEventListener("drop", e => {
      e.preventDefault();
      div.classList.remove("drag-over");
      const fromIndex = parseInt(e.dataTransfer.getData("text/plain"), 10);
      reorderPhotos(fromIndex, i);
    });

    grid.appendChild(div);

    const cached = uriCache.get(`${photo.name}|400`);
    if (cached) {
      fillPhotoSlot(div, cached, i);
    } else {
      div.innerHTML = `<div class="loading-thumb">Loading…</div>`;
      resolvePhotoUri(photo.name, 400)
        .then(uri => {
          if (_photoGridVersion !== myVersion) return; // stale — new restaurant loaded
          fillPhotoSlot(div, uri, i);
        })
        .catch(() => {
          if (_photoGridVersion !== myVersion) return;
          div.innerHTML = `<div class="loading-thumb">Unavailable</div>`;
        });
    }
  });
}

function fillPhotoSlot(div, uri, index) {
  const isCover = index === coverPhotoIndex;
  if (isCover) div.classList.add('is-cover'); else div.classList.remove('is-cover');

  div.innerHTML = `
    <img src="${uri}" alt="Photo ${index + 1}" />
    ${isCover
      ? '<button class="cover-badge" title="Click to remove as cover photo">Cover ✕</button>'
      : `<button class="make-cover-btn" title="Set as cover photo">⭐ Cover</button>`}
    <span class="photo-label">${isCover ? '★' : index + 1}</span>
    <span class="quality-badge"></span>
    <button class="dismiss-btn" title="Replace with another photo">✕</button>`;

  // Score quality (contrast + blur + resolution) and update grid badges.
  // The resolution check needs the TRUE source dimensions, so score against a
  // high-res fetch (2048px) rather than the 400px grid thumbnail — a 400px
  // image can never satisfy MIN_PHOTO_DIM (720), which would flag every photo
  // as low-res regardless of its real size. This mirrors the Auto Bot's
  // photo-quality gate, which scores resolvePhotoUriBG(name, 2048, ...).
  const scoreName = currentRestaurant?.photos[index]?.name;
  (scoreName ? resolvePhotoUri(scoreName, QUALITY_SCAN_DIM) : Promise.resolve(uri))
    .then(scanUri => scorePhotoQuality(scanUri || uri))
    .then(({ score, meetsResolution }) => {
      if (currentRestaurant?.photos[index]) {
        currentRestaurant.photos[index].qualityScore    = score;
        currentRestaurant.photos[index].meetsResolution = meetsResolution;
        updateQualityBadges();
      }
    });

  // Show cover overlay preview on the cover photo — use 1600px source for quality
  if (isCover && currentRestaurant) {
    const photoName = currentRestaurant.photos[index]?.name;
    const hiResPromise = photoName
      ? resolvePhotoUri(photoName, 1600)
      : Promise.resolve(uri);
    hiResPromise
      .then(hiResUri => createCoverOverlay(hiResUri || uri, currentRestaurant.name, currentRestaurant.address))
      .then(overlayUri => {
        if (overlayUri) {
          const imgEl = div.querySelector('img');
          if (imgEl && div.dataset.slot === String(index)) imgEl.src = overlayUri;
        }
      });
  }

  div.querySelector(".dismiss-btn").addEventListener("click", e => {
    e.stopPropagation();
    dismissPhoto(index);
  });

  const coverBtn = div.querySelector(".make-cover-btn, .cover-badge");
  coverBtn?.addEventListener("click", e => {
    e.stopPropagation();
    setCoverPhoto(index);
  });
}

async function dismissPhoto(index) {
  const { photos, allPhotos } = currentRestaurant;
  const shownNames = new Set(photos.map(p => p.name));
  const next = allPhotos.find(p => !shownNames.has(p.name));

  const slot = $("photoGrid").querySelector(`[data-slot="${index}"]`);

  if (next) {
    photos[index] = next;
    slot.classList.add("replacing");
    slot.innerHTML = `<div class="loading-thumb">Loading…</div>`;
    try {
      const uri = await resolvePhotoUri(next.name, 400);
      slot.classList.remove("replacing");
      fillPhotoSlot(slot, uri, index);
    } catch {
      slot.classList.remove("replacing");
      slot.innerHTML = `<div class="loading-thumb">Unavailable</div>`;
    }
  } else {
    photos.splice(index, 1);
    // Adjust cover index when a photo before/at it is removed
    if (index < coverPhotoIndex) coverPhotoIndex = Math.max(0, coverPhotoIndex - 1);
    else if (index === coverPhotoIndex) coverPhotoIndex = 0;
    if (coverPhotoIndex >= photos.length) coverPhotoIndex = 0;
    coverOverlayCache.clear();
    renderPhotoGrid();
  }
  saveState();
}

// ── Caption ───────────────────────────────────────────────────────────────────

// Returns one engagement opener sentence (deterministic per restaurant, consistent across restores)
function getEngagementOpener() {
  if (!currentRestaurant) return "";
  const { name, address } = currentRestaurant;
  const cityMatch   = address.match(CITY_FROM_ADDRESS_RE);
  const cityDisplay = (cityMatch?.[1] || "Belgium").trim();
  const seed        = name.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const openers = [
    `Have you ever been to ${name} in ${cityDisplay}? 🍽️ Drop a 💬 below!`,
    `Best restaurant in ${cityDisplay}? ${name} is definitely worth a visit! 🔥`,
    `What do you think of ${name}? Let us know in the comments! 👇`,
    `Discover the hidden gem of ${cityDisplay}: ${name} ✨`,
    `Next time you're in ${cityDisplay}, make sure to visit ${name}! 📍`,
    `Have you tried ${name} yet? This is what food dreams are made of 😍`,
  ];
  return openers[(seed + captionOpenerOffset) % openers.length];
}

function buildDefaultCaption() {
  if (!currentRestaurant) return "";
  const { name, address, rating } = currentRestaurant;

  const cityMatch   = address.match(CITY_FROM_ADDRESS_RE);
  const cityDisplay = (cityMatch?.[1] || "Belgium").trim();
  const cityTag     = cityDisplay.replace(/\s+/g, "");

  let text = `${getEngagementOpener()}\n\n📍 ${name}\n📌 ${address}`;
  if (rating) text += `\n⭐ ${rating}/5`;
  if (selectedSong) text += `\n\n🎵 ${selectedSong.name} – ${selectedSong.artist}`;
  text += `\n\n#${cityTag} #BelgianFood #FoodFluencer #Foodie #FoodPhotography #Restaurant #Belgium`;
  return text;
}

// Ensures every caption starts with an engagement opener.
// Preserves user edits below the first line; replaces a stale/missing opener.
function ensureOpener(existingCaption) {
  if (!currentRestaurant) return existingCaption;
  const opener  = getEngagementOpener();
  const openerRe = /^(Have you ever been|Best restaurant|What do you think|Discover the hidden|Next time you're|Have you tried)/i;
  // Already has the correct opener — leave untouched
  if (existingCaption.startsWith(opener)) return existingCaption;
  // Has an old/different opener — replace just the first line
  if (openerRe.test(existingCaption)) {
    const rest = existingCaption.replace(/^[^\n]+(\n\n?)?/, "");
    return `${opener}\n\n${rest}`;
  }
  // No opener at all — prepend it
  return `${opener}\n\n${existingCaption}`;
}

// Update just the song line in the caption without overwriting the user's other edits
function updateCaptionSongLine() {
  const el = $("caption");
  if (!el) return;
  let text = el.value.replace(/\n🎵 .+/g, "").trimEnd();
  if (selectedSong) text += `\n🎵 ${selectedSong.name} – ${selectedSong.artist}`;
  // Also guarantee the opener is present after song changes
  el.value = ensureOpener(text);
  saveState();
}

// Regenerate button
$("refreshCaptionBtn")?.addEventListener("click", () => {
  captionOpenerOffset++;
  if ($("caption")) $("caption").value = buildDefaultCaption();
  saveState();
});

// Save caption on edit (debounced)
$("caption")?.addEventListener("input", saveStateSoon);

// ── Search ────────────────────────────────────────────────────────────────────

function setStatus(msg, type = "loading") {
  const el = $("status");
  el.textContent = msg;
  el.className = `status status--${type}`;
  el.classList.remove("hidden");
  if (type !== "loading") setTimeout(() => el.classList.add("hidden"), 6000);
}

// Hides and clears the entity-search results dropdown
function hideSearchResultsDropdown() {
  const el = $("searchResultsDropdown");
  if (!el) return;
  el.innerHTML = "";
  el.classList.add("hidden");
}

// Renders the candidate places returned by the search as a clickable dropdown
// so the user can pick the exact entity they meant (e.g. the right Hilton).
function renderSearchResultsDropdown(places) {
  const el = $("searchResultsDropdown");
  if (!el) return;
  el.innerHTML = "";
  places.forEach(place => {
    const name = place.displayName?.text || "Unknown";
    const meta = place.rating
      ? `⭐ ${place.rating} · ${(place.userRatingCount || 0).toLocaleString()} ratings` : "";

    const div = document.createElement("div");
    div.className = "search-result-item";
    div.innerHTML = `
      <div class="search-result-name">${name}</div>
      <div class="search-result-address">${place.formattedAddress || ""}</div>
      ${meta ? `<div class="search-result-meta">${meta}</div>` : ""}`;
    div.addEventListener("click", () => {
      $("query").value = name;
      hideSearchResultsDropdown();
      renderResults(place, "manual");
      AppLog.info("Restaurant selected from search results", { name });
    });
    el.appendChild(div);
  });
  el.classList.remove("hidden");
}

async function doSearch(query) {
  if (!query.trim()) return;
  if (!API_KEY) { setStatus("Please save your API key first.", "error"); return; }
  setStatus("Searching…");
  $("results").classList.add("hidden");
  hideSearchResultsDropdown();
  // Clear song for a fresh search
  selectedSong = null;
  $("selectedSong")?.classList.add("hidden");
  try {
    const { country } = getManualSettings();
    const places = await searchRestaurantMulti(query, country);
    renderSearchResultsDropdown(places);
    AppLog.info("Restaurant search results", { count: places.length, query });
    $("status").classList.add("hidden");
  } catch (err) {
    AppLog.error("Restaurant search failed", { query, error: err.message });
    setStatus(err.message, "error");
  }
}

$("searchBtn").addEventListener("click", () => doSearch($("query").value));
$("query").addEventListener("keydown", e => { if (e.key === "Enter") doSearch($("query").value); });
$("randomBtn").addEventListener("click", async () => {
  if (!API_KEY) { setStatus("Please save your API key first.", "error"); return; }
  setStatus("Picking a random place…");
  $("results").classList.add("hidden");
  hideSearchResultsDropdown();
  selectedSong = null;
  $("selectedSong")?.classList.add("hidden");
  try {
    const settings = getManualSettings();
    const place = await searchAutoPlace(settings.type, settings.country, settings.region,
      settings.minRatings, settings.minStars, settings.minPics);
    $("query").value = place.displayName?.text || "";
    renderResults(place);
    AppLog.info("Random place found", { name: place.displayName?.text, settings });
    $("status").classList.add("hidden");
  } catch (err) {
    AppLog.error("Random place search failed", { error: err.message, settings: getManualSettings() });
    setStatus(err.message, "error");
  }
});

document.getElementById("mmPreviewClose")?.addEventListener("click", () => {
  $("results").classList.add("hidden");
  currentRestaurant = null;
  chrome.storage.local.remove("lastState");
});

// ── Social platform toggles ───────────────────────────────────────────────────

document.querySelectorAll(".social-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const p = btn.dataset.platform;
    activePlatforms.has(p) ? activePlatforms.delete(p) : activePlatforms.add(p);
    btn.classList.toggle("active", activePlatforms.has(p));
    saveState();
  });
});

// ── Song search ───────────────────────────────────────────────────────────────

$("songSearchBtn").addEventListener("click", searchSong);
$("songQuery").addEventListener("keydown", e => { if (e.key === "Enter") searchSong(); });

async function searchSong() {
  const q = $("songQuery").value.trim();
  if (!q) return;
  const el = $("songResults");
  el.innerHTML = `<div style="padding:6px;color:#999;font-size:.75rem">Searching…</div>`;
  el.classList.remove("hidden");
  try {
    const res  = await fetch(`${ITUNES_SEARCH}?term=${encodeURIComponent(q)}&media=music&entity=song&limit=6`);
    const data = await res.json();
    renderSongResults(data.results || []);
  } catch {
    el.innerHTML = `<div style="padding:6px;color:var(--error);font-size:.75rem">Search failed.</div>`;
  }
}

function renderSongResults(songs) {
  const el = $("songResults");
  if (!songs.length) { el.innerHTML = `<div style="padding:6px;color:#999;font-size:.75rem">No results.</div>`; return; }
  el.innerHTML = "";
  songs.forEach(song => {
    const div = document.createElement("div");
    div.className = "song-result";
    div.innerHTML = `
      <img src="${song.artworkUrl100}" alt="" />
      <div class="song-result-info">
        <div class="song-result-name">${song.trackName}</div>
        <div class="song-result-artist">${song.artistName}</div>
      </div>`;
    div.addEventListener("click", () => selectSong({
      name: song.trackName, artist: song.artistName,
      artwork: song.artworkUrl100, previewUrl: song.previewUrl,
    }));
    el.appendChild(div);
  });
}

function selectSong(song) {
  selectedSong = song;
  $("songResults").classList.add("hidden");
  $("songQuery").value = "";
  $("selectedSongArt").src            = song.artwork;
  $("selectedSongName").textContent   = song.name;
  $("selectedSongArtist").textContent = song.artist;
  $("selectedSong").classList.remove("hidden");
  updateCaptionSongLine();
}

$("removeSongBtn").addEventListener("click", () => {
  selectedSong = null;
  $("selectedSong").classList.add("hidden");
  updateCaptionSongLine();
});

// ── Export & Post ─────────────────────────────────────────────────────────────

$("postBtn").addEventListener("click", postToSocial);
$("exportBtn").addEventListener("click", exportPhotos);

async function photoToDataUrl(uri, maxWidth = 1440) {
  const res    = await fetch(uri);
  const blob   = await res.blob();
  const bitmap = await createImageBitmap(blob);

  // Crop to Instagram-valid aspect ratio (centre crop)
  const ratio = bitmap.width / bitmap.height;
  let cropW = bitmap.width, cropH = bitmap.height;
  if (ratio < IG_MIN_RATIO)      cropH = Math.round(bitmap.width / IG_MIN_RATIO);
  else if (ratio > IG_MAX_RATIO) cropW = Math.round(bitmap.height * IG_MAX_RATIO);
  const cropOffX = Math.round((bitmap.width  - cropW) / 2);
  const cropOffY = Math.round((bitmap.height - cropH) / 2);

  const scale = Math.min(1, maxWidth / cropW);
  const canvas = document.createElement("canvas");
  canvas.width  = Math.round(cropW * scale);
  canvas.height = Math.round(cropH * scale);
  canvas.getContext("2d").drawImage(bitmap, cropOffX, cropOffY, cropW, cropH, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.95);
}

// Resolves full-res photo URIs from the Google Places CDN, gated to
// MIN_PHOTO_DIM short-side resolution. Shared by Post and Export.
async function resolveManualPhotoUris(runId, runType) {
  const { photos } = currentRestaurant;

  const t_photos = Date.now();
  TechLog.info("MEDIA", "photos_start", { run_id: runId, run_type: runType, name: currentRestaurant.name });

  // Build a pool of candidate photo names: selected photos first, then unused extras
  const selectedNames = new Set(photos.map(p => p.name));
  const extraPhotos   = (currentRestaurant.allPhotos || []).filter(p => !selectedNames.has(p.name));
  const candidates    = [...photos, ...extraPhotos];

  const photoUris = [];
  const usedNames = new Set();
  for (const photo of candidates) {
    if (photoUris.length >= photos.length) break; // collected enough
    if (usedNames.has(photo.name)) continue;
    try {
      const uri = await resolvePhotoUri(photo.name, 2048);
      // Resolution gate: load the image and verify delivered dimensions
      const dims = await new Promise(res => {
        const img = new Image();
        img.onload  = () => res({ w: img.naturalWidth,  h: img.naturalHeight });
        img.onerror = () => res({ w: 0, h: 0 });
        img.src = uri;
      });
      const shortSide = Math.min(dims.w, dims.h);
      if (shortSide > 0 && shortSide < MIN_PHOTO_DIM) {
        AppLog.warn(`Photo below ${MIN_PHOTO_DIM}px short side (${dims.w}×${dims.h}), trying next`, { photo: photo.name });
        usedNames.add(photo.name);
        continue; // skip — try next candidate
      }
      photoUris.push(uri);
      usedNames.add(photo.name);
    } catch (e) {
      AppLog.error("Photo resolve failed", { photo: photo.name, error: String(e) });
      console.warn("Photo resolve failed:", e);
    }
  }
  TechLog.info("MEDIA", "photos_done", { run_id: runId, run_type: runType,
    photo_source: "google_places_manual", photo_count: photoUris.length,
    source_breakdown: { google_places_manual: photoUris.length },
    duration_ms: Date.now()-t_photos });
  AppLog.info(`Resolved ${photoUris.length}/${photos.length} photo URIs`);

  return photoUris;
}

function logManualExport(timestamp, photoCount, platforms, caption) {
  const { name, address } = currentRestaurant;
  chrome.storage.local.get({ exportLog: [] }, ({ exportLog }) => {
    exportLog.push({
      timestamp, name, address, photos: photoCount,
      song:      selectedSong ? `${selectedSong.name} – ${selectedSong.artist}` : null,
      platforms,
      caption,
    });
    chrome.storage.local.set({ exportLog });
  });
}

async function postToSocial() {
  if (!currentRestaurant) return;

  const { name, address, photos } = currentRestaurant;
  const caption   = $("caption")?.value.trim() || buildDefaultCaption();
  const songName  = selectedSong?.name || "";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const platforms = [...activePlatforms];

  if (platforms.length === 0) {
    setStatus("⚠️ Select at least one social media platform to post.", "error");
    return;
  }

  const runId    = `manual-${Date.now()}`;
  const runStart = Date.now();
  TechLog.info("POST", "run_start", { run_id: runId, run_type: "manual",
    restaurant: name, address, platforms, song: songName });

  $("postBtn").disabled   = true;
  $("exportBtn").disabled = true;
  AppLog.info("Post started", { restaurant: name, photos: photos.length, platforms, song: songName });
  setStatus("Resolving photos…");

  const photoUris = await resolveManualPhotoUris(runId, "manual");
  logManualExport(timestamp, photoUris.length, platforms, caption);

  if (photoUris.length > 0) {
    setStatus(`Preparing photos… applying cover overlay…`);

    // Build photo data URLs with cover (+ text overlay) at position 0
    const covIdx   = Math.min(coverPhotoIndex, photoUris.length - 1);
    const photoDataUrls = [];

    // Cover photo at index 0 — sent PLAIN (no overlay baked here).
    // The text/vignette overlay is applied once, inside each platform injector,
    // at the photo's native resolution. Pre-baking here would force an
    // upscale + double JPEG re-encode + double overlay → blurry result.
    // If the user removed the cover photo (covIdx === -1), photos are simply
    // sent in their current order with no designated cover.
    if (covIdx >= 0) {
      try {
        const coverUri = photoUris[covIdx];
        photoDataUrls.push(await photoToDataUrl(coverUri));
        AppLog.info("Cover photo prepared (overlay applied in injector)", { index: covIdx });
      } catch(e) {
        AppLog.warn("Cover photo prep failed", String(e));
      }
    }

    // Remaining photos in original order (skip cover)
    for (let i = 0; i < photoUris.length; i++) {
      if (i === covIdx) continue;
      try {
        photoDataUrls.push(await photoToDataUrl(photoUris[i]));
      } catch (e) {
        AppLog.error("Photo resize failed", { uri: photoUris[i], error: String(e) });
      }
    }

    if (photoDataUrls.length > 0) {
      AppLog.info(`Sending ${photoDataUrls.length} photos to ${platforms.join(", ")}`);

      // TikTok: video is built INSIDE the injector from photoDataUrls.
      // Pre-fetch song audio here (popup has iTunes host-permission; injector doesn't).
      // 30s preview ≈ 480KB → ~640KB base64 — well within executeScript arg limits.
      let tiktokAudioDataUrl = null;
      if (platforms.includes("tiktok") && selectedSong?.previewUrl) {
        try {
          setStatus("Fetching song preview for TikTok…");
          const ar = await fetch(selectedSong.previewUrl);
          const ab = await ar.blob();
          tiktokAudioDataUrl = await new Promise((res, rej) => {
            const fr = new FileReader(); fr.onload = e => res(e.target.result); fr.onerror = rej;
            fr.readAsDataURL(ab);
          });
          AppLog.info(`Song audio fetched: ${(tiktokAudioDataUrl.length/1024).toFixed(0)}KB`);
        } catch(e) {
          AppLog.warn("Could not fetch song audio", String(e));
        }
      }

      for (const platform of platforms) {
        const t_plat = Date.now();
        TechLog.info("POST", "platform_start", { run_id: runId, run_type: "manual", platform });
        setStatus(`Opening ${platform}…`);
        chrome.runtime.sendMessage({
          type: "OPEN_SOCIAL", platform, photoDataUrls, caption, songName,
          location:         currentRestaurant.address || "",
          // Empty restaurantName tells the injectors to skip the cover
          // overlay when the user has explicitly removed the cover photo.
          restaurantName:   coverPhotoIndex >= 0 ? (currentRestaurant.name || "") : "",
          tiktokAudioDataUrl: platform === "tiktok" ? (tiktokAudioDataUrl || null) : null,
        });
        await new Promise(r => setTimeout(r, 900));
        TechLog.info("POST", "platform_opened", { run_id: runId, run_type: "manual",
          platform, duration_ms: Date.now()-t_plat });
      }
      TechLog.info("POST", "run_complete", { run_id: runId, run_type: "manual",
        name, platforms, photo_count: photoDataUrls.length, total_duration_ms: Date.now()-runStart });
      TechLog._flush();
      setStatus(`✅ Opening ${platforms.join(", ")} — ${photoDataUrls.length} photos & caption ready!`, "success");
    } else {
      AppLog.error("All photo resizes failed — cannot post to social media");
      setStatus("⚠️ Could not prepare photos for social media.", "error");
    }
  } else {
    AppLog.error("No photo URIs resolved");
    setStatus("⚠️ Could not resolve any photos.", "error");
  }

  $("postBtn").disabled   = false;
  $("exportBtn").disabled = false;
}

async function exportPhotos() {
  if (!currentRestaurant) return;

  const { name, address, photos } = currentRestaurant;
  const caption   = $("caption")?.value.trim() || buildDefaultCaption();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const runId = `manual-export-${Date.now()}`;
  TechLog.info("EXPORT", "run_start", { run_id: runId, run_type: "manual-export", restaurant: name, address });

  $("postBtn").disabled   = true;
  $("exportBtn").disabled = true;
  AppLog.info("Export started", { restaurant: name, photos: photos.length });
  setStatus("Resolving photos…");

  const photoUris = await resolveManualPhotoUris(runId, "manual-export");
  logManualExport(timestamp, photoUris.length, [], caption);

  if (photoUris.length === 0) {
    AppLog.error("No photo URIs resolved");
    setStatus("⚠️ Could not resolve any photos.", "error");
    $("postBtn").disabled   = false;
    $("exportBtn").disabled = false;
    return;
  }

  setStatus("Preparing photos for export…");

  const slug = (name || "restaurant").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "restaurant";
  const folder = `FoodFluencer/${slug}_${timestamp}`;

  let saved = 0;
  for (let i = 0; i < photoUris.length; i++) {
    setStatus(`Exporting photo ${i + 1}/${photoUris.length}…`);
    try {
      const dataUrl = await photoToDataUrl(photoUris[i]);
      await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type:     "DOWNLOAD",
          url:      dataUrl,
          filename: `${folder}/photo_${i + 1}.jpg`,
        }, resolve);
      });
      saved++;
    } catch (e) {
      AppLog.error("Photo export failed", { uri: photoUris[i], error: String(e) });
    }
  }

  TechLog.info("EXPORT", "run_complete", { run_id: runId, run_type: "manual-export",
    name, photo_count: saved });
  TechLog._flush();

  if (saved > 0) {
    AppLog.info(`Exported ${saved}/${photoUris.length} photos`, { restaurant: name });
    setStatus(`✅ Exported ${saved} photo${saved === 1 ? "" : "s"} to Downloads/${folder}/`, "success");
  } else {
    AppLog.error("All photo exports failed");
    setStatus("⚠️ Could not export any photos.", "error");
  }

  $("postBtn").disabled   = false;
  $("exportBtn").disabled = false;
}

// ── TikTok MP4 builder (runs in popup context — has WebCodecs + full Web APIs) ─

async function createTikTokMP4(photoDataUrls, onProgress) {
  const W = 720, H = 1280; // 9:16 portrait
  const FPS = 25, BITRATE = 2_000_000, SEC_PER_SLIDE = 1.2;

  // Load images
  const images = [];
  for (const src of photoDataUrls) {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => res(); img.src = src; });
    if (img.naturalWidth > 0) images.push(img);
  }
  if (!images.length) throw new Error('No images loaded');

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  function drawSlide(img) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
    ctx.drawImage(img, (W - img.naturalWidth * s) / 2, (H - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
  }

  // ── WebCodecs path ────────────────────────────────────────────────────────
  if (window.VideoEncoder) {
    // Try codecs from most to least capable, picking the first supported one
    const CODECS = [
      'avc1.4d0028', // H.264 Main Level 4.0
      'avc1.42001f', // H.264 Baseline Level 3.1
      'avc1.42001e', // H.264 Baseline Level 3.0
      'avc1.420014', // H.264 Baseline Level 2.0
    ];

    let chosenCodec = null;
    for (const codec of CODECS) {
      try {
        const support = await VideoEncoder.isConfigSupported({
          codec, width: W, height: H, bitrate: BITRATE, framerate: FPS,
        });
        if (support.supported) { chosenCodec = codec; break; }
      } catch (_) {}
    }

    if (!chosenCodec) {
      AppLog.warn('No H.264 codec supported by WebCodecs — falling back to WebM');
    } else {
      AppLog.info(`WebCodecs encoding with ${chosenCodec}`);
      const TIMESCALE = 90000;
      const SAMPLE_DUR = Math.round(TIMESCALE / FPS);
      const framesPerSlide = Math.ceil(SEC_PER_SLIDE * FPS);
      const totalFrames = images.length * framesPerSlide;

      const chunks = []; let decoderConfig = null; let encodeError = null;
      const encoder = new VideoEncoder({
        output: (chunk, meta) => {
          if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
          const buf = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(buf);
          chunks.push({ data: new Uint8Array(buf), isKey: chunk.type === 'key' });
        },
        error: e => { encodeError = e; },
      });

      encoder.configure({ codec: chosenCodec, width: W, height: H, bitrate: BITRATE, framerate: FPS, avc: { format: 'avc' } });

      let fi = 0;
      for (let i = 0; i < images.length; i++) {
        drawSlide(images[i]);
        for (let f = 0; f < framesPerSlide; f++) {
          if (encodeError) throw new Error(`Encoder error: ${encodeError.message}`);
          const ts = Math.round(fi * 1_000_000 / FPS);
          const frame = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1_000_000 / FPS) });
          encoder.encode(frame, { keyFrame: fi === 0 || f === 0 });
          frame.close(); fi++;
        }
        if (onProgress) onProgress(i + 1, images.length);
        await new Promise(r => setTimeout(r, 0)); // yield
      }
      await encoder.flush();
      encoder.close();
      if (encodeError) throw new Error(`Encoder error: ${encodeError.message}`);
      AppLog.info(`WebCodecs encoded ${chunks.length} chunks, ${(chunks.reduce((a,c)=>a+c.data.length,0)/1024).toFixed(0)}KB`);
      return buildMP4Blob(chunks, decoderConfig, W, H, FPS, TIMESCALE, SAMPLE_DUR, totalFrames);
    }
  } else {
    AppLog.warn('VideoEncoder (WebCodecs) not available — using MediaRecorder fallback');
  }

  // ── MediaRecorder fallback ────────────────────────────────────────────────
  // Note: produces WebM, not MP4 — TikTok might still reject it.
  // If WebCodecs was unavailable on this browser, WebM is the only option.
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
  AppLog.info(`MediaRecorder fallback using ${mimeType}`);
  const stream = canvas.captureStream(FPS);
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: BITRATE });
  const ch = [];
  rec.ondataavailable = e => { if (e.data.size > 0) ch.push(e.data); };
  rec.start(100);
  for (let i = 0; i < images.length; i++) {
    drawSlide(images[i]);
    if (onProgress) onProgress(i + 1, images.length);
    await new Promise(r => setTimeout(r, SEC_PER_SLIDE * 1000));
  }
  rec.stop();
  return new Promise(res => { rec.onstop = () => res(new Blob(ch, { type: mimeType })); });
}

function buildMP4Blob(chunks, dcfg, W, H, fps, ts, sampleDur, totalFrames) {
  const u8  = v => [v & 0xFF];
  const u16 = v => [(v >> 8) & 0xFF, v & 0xFF];
  const u32 = v => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
  const s4  = s => [...new TextEncoder().encode(s).slice(0, 4)];
  const z   = n => Array(n).fill(0);
  function box(t, ...c) { const d = c.flat(Infinity); return [...u32(8 + d.length), ...s4(t.padEnd(4,' ')), ...d]; }
  function fb(t, v, f, ...c) { return box(t, u8(v), [(f>>16)&0xFF,(f>>8)&0xFF,f&0xFF], ...c); }

  // SPS/PPS from encoder's decoderConfig
  let sps = new Uint8Array([0x67,0x4d,0x00,0x28,0xda,0x01,0xe0,0x08,0x9f,0x96,0x60,0x00,0x00,0x03,0x00,0x40,0x00,0x00,0x0c,0x83,0xc5,0x0a,0x44,0x80]);
  let pps = new Uint8Array([0x68,0xee,0x31,0xb2,0x8b]);
  if (dcfg?.description) {
    const d = new Uint8Array(dcfg.description); let i = 5;
    const ns = d[i++] & 0x1F;
    for (let j=0;j<ns;j++) { const l=(d[i]<<8)|d[i+1];i+=2; sps=d.slice(i,i+l);i+=l; }
    const np = d[i++];
    for (let j=0;j<np;j++) { const l=(d[i]<<8)|d[i+1];i+=2; pps=d.slice(i,i+l);i+=l; }
  }

  const avcC = box('avcC', u8(1),[sps[1],sps[2],sps[3]],[0xFF],[0xE1],u16(sps.length),[...sps],u8(1),u16(pps.length),[...pps]);
  const avc1 = box('avc1', z(6),u16(1),z(16),u16(W),u16(H),[0,72,0,0,0,72,0,0],u32(0),u16(1),z(32),u16(0x18),u16(0xFFFF),avcC);

  const dur  = totalFrames * sampleDur;
  const mat  = [0x00,0x01,0x00,0x00,0,0,0,0,0,0,0,0, 0,0,0,0,0x00,0x01,0x00,0x00,0,0,0,0,0,0,0,0, 0,0,0,0,0x40,0x00,0x00,0x00];

  const stsd = fb('stsd',0,0, u32(1), avc1);
  const stts = fb('stts',0,0, u32(1),u32(chunks.length),u32(sampleDur));
  const keys = chunks.map((c,i)=>c.isKey?i+1:null).filter(Boolean);
  const stss = fb('stss',0,0, u32(keys.length),...keys.flatMap(i=>u32(i)));
  const stsz = fb('stsz',0,0, u32(0),u32(chunks.length),...chunks.flatMap(c=>u32(c.data.length)));
  const stsc = fb('stsc',0,0, u32(1),u32(1),u32(1),u32(1));
  const stco_ph = fb('stco',0,0, u32(chunks.length),...chunks.flatMap(()=>u32(0)));
  const stbl_ph = box('stbl',stsd,stts,stss,stsc,stsz,stco_ph);
  const vmhd = fb('vmhd',0,1, u16(0),z(6));
  const dinf = box('dinf',fb('dref',0,0,u32(1),fb('url ',0,1)));
  const minf_ph = box('minf',vmhd,dinf,stbl_ph);
  const mdhd = fb('mdhd',0,0, u32(0),u32(0),u32(ts),u32(dur),u16(0x55C4),u16(0));
  const hdlr = fb('hdlr',0,0, u32(0),s4('vide'),z(12),[...s4('Vide'),0]);
  const mdia_ph = box('mdia',mdhd,hdlr,minf_ph);
  const tkhd = fb('tkhd',0,3, u32(0),u32(0),u32(1),u32(0),u32(dur),z(8),u16(0),u16(0),u16(0),u16(0),mat,u32(W<<16),u32(H<<16));
  const trak_ph = box('trak',tkhd,mdia_ph);
  const mvhd = fb('mvhd',0,0, u32(0),u32(0),u32(ts),u32(dur),u32(0x10000),u16(0x100),z(10),mat,z(24),u32(2));
  const moov_ph = box('moov',mvhd,trak_ph);
  const ftyp = box('ftyp',s4('isom'),u32(0x200),s4('isom'),s4('iso2'),s4('avc1'),s4('mp41'));

  // Compute real chunk offsets (moov first → fast-start)
  const mdatStart = ftyp.length + moov_ph.length + 8;
  let off = mdatStart;
  const realOff = chunks.map(c => { const o=off; off+=c.data.length; return o; });

  const stco_r  = fb('stco',0,0, u32(chunks.length),...realOff.flatMap(o=>u32(o)));
  const stbl_r  = box('stbl',stsd,stts,stss,stsc,stsz,stco_r);
  const minf_r  = box('minf',vmhd,dinf,stbl_r);
  const mdia_r  = box('mdia',mdhd,hdlr,minf_r);
  const trak_r  = box('trak',tkhd,mdia_r);
  const moov_r  = box('moov',mvhd,trak_r);

  const mdatSize = chunks.reduce((a,c)=>a+c.data.length,0);
  const mdatHdr  = new Uint8Array([...u32(mdatSize+8),...s4('mdat')]);
  const total    = ftyp.length + moov_r.length + mdatHdr.length + mdatSize;
  const out      = new Uint8Array(total);
  let p = 0;
  for (const part of [new Uint8Array(ftyp), new Uint8Array(moov_r), mdatHdr, ...chunks.map(c=>c.data)]) {
    out.set(part, p); p += part.length;
  }
  return new Blob([out], { type: 'video/mp4' });
}

// ── Auto Bot: language caption templates ─────────────────────────────────────

const CAPTION_LANG = {
  en: {
    opener: (name, type, city, seed) => {
      const t = type;
      return [
        `Have you visited ${name} yet? Drop a 💬 below!`,
        `Best ${t} in ${city}? ${name} is worth every visit! 🔥`,
        `What do you think of ${name}? Let us know 👇`,
        `Discover the hidden gem of ${city}: ${name} ✨`,
        `Don't miss ${name} next time you're in ${city}! 📍`,
        `Have you tried ${name}? This is what dreams are made of 😍`,
      ][seed % 6];
    },
  },
  nl: {
    opener: (name, type, city, seed) => {
      const t = { restaurant:"restaurant", hotel:"hotel", bar:"bar" }[type] || type;
      return [
        `Ben je al bij ${name} geweest? Laat het ons weten! 💬`,
        `Beste ${t} in ${city}? ${name} is zeker een bezoek waard! 🔥`,
        `Wat vind je van ${name}? Vertel het ons! 👇`,
        `Ontdek de verborgen parel van ${city}: ${name} ✨`,
        `Mis ${name} niet als je in ${city} bent! 📍`,
        `Heb je ${name} al geprobeerd? Dit is wat dromen zijn gemaakt van 😍`,
      ][seed % 6];
    },
  },
  fr: {
    opener: (name, type, city, seed) => {
      const t = { restaurant:"restaurant", hotel:"hôtel", bar:"bar" }[type] || type;
      return [
        `Avez-vous déjà visité ${name}? Laissez un commentaire! 💬`,
        `Meilleur ${t} à ${city}? ${name} vaut vraiment le détour! 🔥`,
        `Que pensez-vous de ${name}? Partagez votre avis! 👇`,
        `Découvrez la perle cachée de ${city}: ${name} ✨`,
        `Ne manquez pas ${name} lors de votre prochain séjour à ${city}! 📍`,
        `Avez-vous essayé ${name}? C'est ce dont on rêve 😍`,
      ][seed % 6];
    },
  },
  de: {
    opener: (name, type, city, seed) => {
      const t = { restaurant:"Restaurant", hotel:"Hotel", bar:"Bar" }[type] || type;
      return [
        `Habt ihr ${name} schon besucht? Schreibt uns! 💬`,
        `Bestes ${t} in ${city}? ${name} ist jeden Besuch wert! 🔥`,
        `Was denkt ihr über ${name}? Erzählt uns! 👇`,
        `Entdeckt das versteckte Juwel von ${city}: ${name} ✨`,
        `Verpasst ${name} nicht bei eurem nächsten Besuch in ${city}! 📍`,
        `Habt ihr ${name} schon ausprobiert? Davon träumt man 😍`,
      ][seed % 6];
    },
  },
};

// iTunes country codes for Top 100 RSS feed
const ITUNES_CC = { BE: "be", FR: "fr", DE: "de", LU: "be", NL: "nl" };

// Fetch a song based on the selected genre and country
async function getAutoSong(genre, country) {
  const cc = ITUNES_CC[country] || "be";

  if (genre === "top100") {
    try {
      // Use iTunes RSS Top Songs chart for the country (one API call)
      const feedUrl = `https://itunes.apple.com/${cc}/rss/topsongs/limit=100/json`;
      const feedRes = await fetch(feedUrl);
      if (feedRes.ok) {
        const feedData = await feedRes.json();
        const entries  = feedData.feed?.entry || [];
        if (entries.length) {
          const entry   = entries[Math.floor(Math.random() * entries.length)];
          const trackId = entry.id?.attributes?.["im:id"];
          if (trackId) {
            // Lookup full details (including previewUrl) — one extra call but cached by iTunes CDN
            const lookupRes = await fetch(`https://itunes.apple.com/lookup?id=${trackId}`);
            if (lookupRes.ok) {
              const lookupData = await lookupRes.json();
              const track = lookupData.results?.[0];
              if (track) return {
                name:       track.trackName,
                artist:     track.artistName,
                artwork:    track.artworkUrl100,
                previewUrl: track.previewUrl || null,
                genre:      "Top 100",
              };
            }
          }
          // Fallback: basic info from RSS
          return {
            name:       entry["im:name"]?.label || "Unknown",
            artist:     entry["im:artist"]?.label || "Unknown",
            artwork:    entry["im:image"]?.[2]?.label || "",
            previewUrl: null,
            genre:      "Top 100",
          };
        }
      }
    } catch(e) { /* fall through to search */ }
  }

  // Pop and Social Media — use iTunes Search API
  const searchQueries = {
    top100:      `top hits ${new Date().getFullYear()}`,
    pop:         "pop hit",
    socialmedia: `viral trending ${new Date().getFullYear()}`,
  };
  const genreLabels = { top100: "Top 100", pop: "Pop", socialmedia: "Social Media" };
  const term = searchQueries[genre] || "pop hit";
  const searchRes = await fetch(
    `${ITUNES_SEARCH}?term=${encodeURIComponent(term)}&media=music&entity=song&limit=50`
  );
  if (!searchRes.ok) throw new Error("Could not reach iTunes");
  const searchData = await searchRes.json();
  const songs = searchData.results || [];
  if (!songs.length) throw new Error(`No songs found for genre "${genre}"`);

  const song = songs[Math.floor(Math.random() * songs.length)];
  return {
    name:       song.trackName,
    artist:     song.artistName,
    artwork:    song.artworkUrl100,
    previewUrl: song.previewUrl || null,
    genre:      genreLabels[genre] || genre,
  };
}

// ── Auto Bot: type / country data ────────────────────────────────────────────

// Maps UI type value → plain-language search term for Places API
const AB_TYPE_QUERY = {
  restaurant: "restaurant",
  hotel:      "hotel",
  bar:        "bar",
};

const AB_COUNTRY_NAMES = {
  BE: "Belgium",
  FR: "France",
  DE: "Germany",
  LU: "Luxembourg",
  NL: "The Netherlands",
};

// City pools — used when "All regions" is selected so each search is anchored
// to a different city rather than the whole country (country-wide queries always
// return the same top-20 nationally popular places from the Places API).
const AB_CITY_POOL = {
  BE: ["Bruges","Ghent","Antwerp","Brussels","Liège","Namur","Mons","Leuven",
       "Mechelen","Hasselt","Kortrijk","Ostend","Aalst","Genk","Sint-Niklaas",
       "Tournai","Charleroi","Arlon","Dinant","Durbuy","Spa","Bastogne",
       "Tongeren","Diest","Dendermonde","Roeselare","Ieper","Veurne","Chimay"],
  FR: ["Paris","Lyon","Marseille","Bordeaux","Toulouse","Nice","Strasbourg",
       "Nantes","Montpellier","Lille","Rennes","Reims","Tours","Angers",
       "Metz","Nancy","Dijon","Grenoble","Brest","Perpignan"],
  DE: ["Berlin","Hamburg","Munich","Cologne","Frankfurt","Stuttgart","Düsseldorf",
       "Leipzig","Dortmund","Bremen","Hannover","Nuremberg","Dresden","Freiburg",
       "Heidelberg","Trier","Erfurt","Regensburg","Würzburg","Lübeck"],
  LU: ["Luxembourg City","Esch-sur-Alzette","Differdange","Dudelange","Ettelbruck",
       "Diekirch","Wiltz","Echternach","Remich","Vianden"],
  NL: ["Amsterdam","Rotterdam","The Hague","Utrecht","Eindhoven","Groningen",
       "Tilburg","Almere","Breda","Nijmegen","Leiden","Maastricht","Haarlem",
       "Arnhem","Delft","Deventer","Zwolle","Amersfoort","Middelburg"],
};

function pickRandomCity(cc) {
  const pool = AB_CITY_POOL[cc] || AB_CITY_POOL.BE;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Bounding boxes used as locationRestriction for each country
const AB_COUNTRY_BOUNDS = {
  BE: { low: { latitude: 49.5,  longitude:  2.5 }, high: { latitude: 51.5,  longitude:  6.4 } },
  FR: { low: { latitude: 41.3,  longitude: -5.1 }, high: { latitude: 51.1,  longitude:  9.6 } },
  DE: { low: { latitude: 47.2,  longitude:  5.9 }, high: { latitude: 55.1,  longitude: 15.0 } },
  LU: { low: { latitude: 49.4,  longitude:  5.7 }, high: { latitude: 50.2,  longitude:  6.5 } },
  NL: { low: { latitude: 50.7,  longitude:  3.3 }, high: { latitude: 53.6,  longitude:  7.2 } },
};

// Read current Auto Bot form values
function getAutoBotSettings() {
  const country = document.getElementById("abCountry")?.value || "BE";
  const type    = document.querySelector("#abType .ab-pill.active")?.dataset?.val || "restaurant";

  // Selected regions (empty string = All)
  const allChip     = document.querySelector("#abRegionWrap .all-chip");
  const activeChips = [...document.querySelectorAll("#abRegionWrap .ab-region-chip:not(.all-chip)")]
                        .filter(c => c.classList.contains("active"));
  let region = "";
  if (!allChip?.classList.contains("active") && activeChips.length > 0) {
    region = activeChips[Math.floor(Math.random() * activeChips.length)].textContent.trim();
  }

  const minRatings = parseInt(document.getElementById("abMinRatings")?.value || "100", 10);
  const minStars   = parseFloat(document.querySelector("#abStars .ab-pill.active")?.dataset?.val || "4");
  const minPics    = parseInt(document.querySelector("#abPics .ab-pill.active")?.dataset?.val || "5", 10);
  const language   = document.getElementById("abLanguage")?.value || "nl";
  const songGenre  = document.getElementById("abSongGenre")?.value || "top100";

  // Caption checkboxes
  const captionOpts = {
    catchy:   document.getElementById("abCapCatchy")?.checked ?? true,
    name:     document.getElementById("abCapName")?.checked   ?? true,
    address:  document.getElementById("abCapAddr")?.checked   ?? true,
    hashtags: document.getElementById("abCapHash")?.checked   ?? true,
    song:     document.getElementById("abCapSong")?.checked   ?? true,
  };

  const sched = getScheduleSettings();

  return {
    country, type, region, minRatings, minStars, minPics,
    language, songGenre, captionOpts,
    frequency: sched.frequency,
    window:    sched.window,
  };
}

// Read current Manual Post search-filter form values (independent of Auto Bot)
function getManualSettings() {
  const country = document.getElementById("mmCountry")?.value || "BE";
  const type    = document.querySelector("#mmType .ab-pill.active")?.dataset?.val || "restaurant";

  // Selected regions (empty string = All)
  const allChip     = document.querySelector("#mmRegionWrap .all-chip");
  const activeChips = [...document.querySelectorAll("#mmRegionWrap .ab-region-chip:not(.all-chip)")]
                        .filter(c => c.classList.contains("active"));
  let region = "";
  if (!allChip?.classList.contains("active") && activeChips.length > 0) {
    region = activeChips[Math.floor(Math.random() * activeChips.length)].textContent.trim();
  }

  const minRatings = parseInt(document.getElementById("mmMinRatings")?.value || "100", 10);
  const minStars   = parseFloat(document.querySelector("#mmStars .ab-pill.active")?.dataset?.val || "4");
  const minPics    = parseInt(document.querySelector("#mmPics .ab-pill.active")?.dataset?.val || "5", 10);

  return { country, type, region, minRatings, minStars, minPics };
}

// Search Places API with ALL filter parameters baked in (one call)
async function searchAutoPlace(type, country, region, minRatings = 0, minStars = 3, minPics = 3) {
  const typeQuery   = AB_TYPE_QUERY[type] || "restaurant";
  const countryName = AB_COUNTRY_NAMES[country] || "Belgium";
  const bounds      = AB_COUNTRY_BOUNDS[country] || AB_COUNTRY_BOUNDS.BE;

  // When no region is selected, anchor to a random city for genuine variety.
  const locationPart = region ? `${region}, ${countryName}` : `${pickRandomCity(country)}, ${countryName}`;
  const q = `${typeQuery} in ${locationPart}`;

  trackApiCall("search", q);
  AppLog.info("Auto Bot search", { type, country, region, query: q, minRatings, minStars, minPics });

  // Build request — push minRating into the API to let the server pre-filter by stars.
  // This reduces the client-side work we need to do.
  const body = {
    textQuery:           q,
    maxResultCount:      20,        // fetch up to 20 so client-side filters have options
    minRating:           minStars,  // API-level star filter (reduces wasted results)
    locationRestriction: { rectangle: bounds },
  };

  const res = await fetch(PLACES_SEARCH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri,places.photos",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `API error ${res.status}`;
    if (/quota|billing|exceeded|disabled|SERVICE_DISABLED/i.test(msg))
      throw new Error(`⛔ Google API quota exceeded or billing issue — check your Google Cloud Console. (${msg})`);
    throw new Error(msg);
  }
  const data = await res.json();
  if (!data.places?.length)
    throw new Error(`No ${type}s found in "${locationPart}" (try relaxing filters)`);

  // Client-side filters: ratings count and minimum photos
  // (minRating/stars already handled server-side above)
  const filtered = data.places.filter(p =>
    (p.userRatingCount || 0) >= minRatings &&
    (p.photos           || []).length >= minPics
  );

  if (!filtered.length) {
    // Fall back to star/count filtered only (ignore photo count) to avoid 0 results
    const partialFiltered = data.places.filter(p => (p.userRatingCount || 0) >= minRatings);
    if (!partialFiltered.length)
      throw new Error(`No ${type}s in "${locationPart}" have ${minRatings}+ ratings. Try lowering the threshold.`);
    AppLog.warn("No results met photo minimum — returning best available", { minPics });
    return partialFiltered[Math.floor(Math.random() * partialFiltered.length)];
  }

  // Pick a random result from the filtered set for variety
  return filtered[Math.floor(Math.random() * filtered.length)];
}

// ── Auto Bot caption generator ────────────────────────────────────────────────
// Builds a multilingual caption. Catchy opener + Name + Address use the selected
// language. Hashtags and Song name are always in English.
function getAutoCaption(name, address, type, language, captionOpts, songInfo = null) {
  const cityM   = address.match(CITY_FROM_ADDRESS_RE);
  const city    = (cityM?.[1] || address.split(",")[0] || "").trim();
  const seed    = name.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const tLabel  = type === "restaurant" ? "restaurant" : type === "hotel" ? "hotel" : "bar";
  const cityTag = city.replace(/\s+/g, "");
  const lang    = CAPTION_LANG[language] || CAPTION_LANG.en;

  const parts = [];

  // ── Catchy phrase (language-aware) ───────────────────────────────────────
  if (captionOpts.catchy) {
    parts.push(lang.opener(name, tLabel, city, seed));
    parts.push("");
  }

  // ── Name (language-aware label) ──────────────────────────────────────────
  if (captionOpts.name && name)       parts.push(`📍 ${name}`);

  // ── Address (same across languages — it's a proper address) ──────────────
  if (captionOpts.address && address) parts.push(`📌 ${address}`);

  if ((captionOpts.name || captionOpts.address) && (captionOpts.song || captionOpts.hashtags))
    parts.push("");

  // ── Song name (always English) ────────────────────────────────────────────
  if (captionOpts.song) {
    if (songInfo) {
      parts.push(`🎵 ${songInfo.name} – ${songInfo.artist}`);
    } else {
      parts.push(`🎵 [Song — selected based on genre]`);
    }
  }

  // ── Hashtags (always English, tag-based) ─────────────────────────────────
  if (captionOpts.hashtags) {
    const tCapit = tLabel.charAt(0).toUpperCase() + tLabel.slice(1);
    parts.push(`\n#${cityTag} #FoodFluencer #${tCapit}Photography #Foodie #Belgium`);
  }

  return parts.join("\n").trim();
}

// Preview Example Post — runs a real search and renders the result
async function previewExamplePost() {
  if (!API_KEY) { setStatus("Please save your API key first.", "error"); return; }

  const panel   = document.getElementById("autoPreview");
  const content = document.getElementById("autoPreviewContent");
  if (!panel || !content) return;

  const settings  = getAutoBotSettings();
  const runId     = `demo-${Date.now()}`;
  const runStart  = Date.now();
  TechLog.info("POST", "run_start", { run_id: runId, run_type: "demo",
    type: settings.type, country: settings.country, region: settings.region || "all",
    language: settings.language });

  panel.classList.remove("hidden");
  content.innerHTML = `<div class="auto-preview-loading">🔍 Searching for ${settings.type}s · 🎵 Finding song…</div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    // Run entity search and song search in parallel — one Places call + one iTunes call
    const t_search = Date.now();
    TechLog.info("SEARCH", "search_start", { run_id: runId, run_type: "demo",
      type: settings.type, country: settings.country, region: settings.region || "all" });

    const [place, songInfo] = await Promise.all([
      searchAutoPlace(settings.type, settings.country, settings.region,
                      settings.minRatings, settings.minStars, settings.minPics),
      getAutoSong(settings.songGenre, settings.country).catch(e => {
        AppLog.warn("Song fetch failed", e.message);
        return null;
      }),
    ]);

    const name        = place.displayName?.text || "Unknown";
    const address     = place.formattedAddress  || "";
    const rating      = place.rating;
    const ratingCount = place.userRatingCount || 0;
    TechLog.info("SEARCH", "search_done", { run_id: runId, run_type: "demo",
      name, address, duration_ms: Date.now()-t_search });
    TechLog.info("SONG", songInfo ? "song_found" : "song_skipped", { run_id: runId, run_type: "demo",
      song: songInfo?.name, artist: songInfo?.artist });

    // Photo count: random between minPics and min(available, 5)
    const allPhotos = (place.photos || []).sort((a, b) => (b.width || 0) - (a.width || 0));
    const available = Math.min(allPhotos.length, 5);
    const minP      = Math.min(settings.minPics, available);
    const numPhotos = minP >= available ? available
                    : minP + Math.floor(Math.random() * (available - minP + 1));
    const photos    = allPhotos.slice(0, numPhotos).map(p => ({ name: p.name }));

    // Multilingual caption with real song info
    const caption = getAutoCaption(name, address, settings.type, settings.language, settings.captionOpts, songInfo);

    const typeLabel   = settings.type.charAt(0).toUpperCase() + settings.type.slice(1);
    const regionLabel = settings.region || AB_COUNTRY_NAMES[settings.country] || "Belgium";
    const langLabels  = { nl:"Dutch", en:"English", fr:"French", de:"German" };

    content.innerHTML = `
      <div class="auto-preview-meta">
        <span class="auto-preview-type-badge ${settings.type}">${typeLabel}</span>
        <span class="auto-preview-region">📍 ${regionLabel}</span>
        <span class="auto-preview-lang">🌐 ${langLabels[settings.language] || settings.language}</span>
      </div>
      <div class="auto-preview-card">
        <span class="auto-preview-name">${escapeHtml(name)}</span>
        <span class="auto-preview-addr">${escapeHtml(address)}</span>
        ${rating ? `<span class="auto-preview-rating">⭐ ${escapeHtml(rating)} · ${ratingCount.toLocaleString()} ratings</span>` : ""}
      </div>
      <div class="auto-preview-photos" id="autoPreviewPhotos"></div>
      ${songInfo ? `
        <div class="auto-preview-song">
          <img src="${escapeHtml(songInfo.artwork)}" alt="" />
          <div class="auto-preview-song-info">
            <span class="auto-preview-song-name">${escapeHtml(songInfo.name)}</span>
            <span class="auto-preview-song-artist">${escapeHtml(songInfo.artist)}</span>
          </div>
          <span class="auto-preview-genre-badge">${escapeHtml(songInfo.genre)}</span>
        </div>` : ""}
      ${caption ? `<div class="auto-preview-caption">${escapeHtml(caption).replace(/\n/g, "<br>")}</div>` : ""}
      <p class="auto-preview-note">${photos.length} photo${photos.length !== 1 ? "s" : ""} · ≥${escapeHtml(settings.minRatings)} ratings · ≥${escapeHtml(settings.minStars)}⭐</p>
    `;

    // Load photos async
    const photoGrid = document.getElementById("autoPreviewPhotos");
    if (photoGrid && photos.length) {
      for (let i = 0; i < photos.length; i++) {
        const div = document.createElement("div");
        div.className = "auto-preview-photo";
        div.innerHTML = `<div class="loading-thumb">…</div>`;
        photoGrid.appendChild(div);
        resolvePhotoUri(photos[i].name, 400).then(uri => {
          if (i === 0) {
            createCoverOverlay(uri, name, address).then(overlay => {
              div.innerHTML = `<img src="${overlay || uri}" alt="Cover" />`;
            });
          } else {
            div.innerHTML = `<img src="${uri}" alt="Photo ${i + 1}" />`;
          }
        }).catch(() => { div.innerHTML = `<div class="loading-thumb">—</div>`; });
      }
    }

    TechLog.info("MEDIA", "photos_done", { run_id: runId, run_type: "demo",
      photo_source: "google_places_preview", photo_count: photos.length,
      source_breakdown: { google_places_preview: photos.length } });
    TechLog.info("POST", "run_complete", { run_id: runId, run_type: "demo",
      name, status: "rendered", total_duration_ms: Date.now()-runStart });
    TechLog._flush();
    AppLog.info("Auto Bot preview rendered", { name, type: settings.type, song: songInfo?.name, lang: settings.language });
  } catch(err) {
    TechLog.error("POST", "run_failed", { run_id: runId, run_type: "demo",
      error: err.message, total_duration_ms: Date.now()-runStart });
    TechLog._flush();
    content.innerHTML = `<div class="auto-preview-error">⚠️ ${err.message}</div>`;
    AppLog.error("Auto Bot preview failed", err.message);
  }
}

// ── Auto Bot config persistence ──────────────────────────────────────────────
// Saves the entire Auto Bot form state to chrome.storage so it survives
// extension closes and is restored each time the user opens Auto Bot mode.

function saveAutoBotConfig() {
  const config = {
    // Entity
    type:      document.querySelector("#abType .ab-pill.active")?.dataset?.val || "restaurant",
    country:   document.getElementById("abCountry")?.value   || "BE",
    // Regions: save which chips are active
    allRegions:  document.querySelector("#abRegionWrap .all-chip")?.classList.contains("active") ?? true,
    regions:     [...document.querySelectorAll("#abRegionWrap .ab-region-chip:not(.all-chip)")]
                   .filter(c => c.classList.contains("active")).map(c => c.textContent.trim()),
    // Thresholds
    minRatings:  document.getElementById("abMinRatings")?.value || "100",
    minStars:    document.querySelector("#abStars .ab-pill.active")?.dataset?.val || "4",
    minPics:     document.querySelector("#abPics .ab-pill.active")?.dataset?.val || "5",
    // Song
    songGenre:   document.getElementById("abSongGenre")?.value || "top100",
    // Caption
    language:    document.getElementById("abLanguage")?.value  || "nl",
    capCatchy:   document.getElementById("abCapCatchy")?.checked ?? true,
    capName:     document.getElementById("abCapName")?.checked   ?? true,
    capAddr:     document.getElementById("abCapAddr")?.checked   ?? true,
    capHash:     document.getElementById("abCapHash")?.checked   ?? true,
    capSong:     document.getElementById("abCapSong")?.checked   ?? true,
    // Schedule — frequency
    freqNum:     document.getElementById("abFreqNum")?.value    || "1",
    freqPeriod:  document.getElementById("abFreqPeriod")?.value || "day",
    freqRandom:  document.getElementById("abFreqRand")?.classList.contains("is-active") || false,
    // Schedule — posting window
    fromH:       document.getElementById("abFromH")?.value  || "05",
    fromM:       document.getElementById("abFromM")?.value  || "00",
    fromAP:      document.getElementById("abFromAP")?.value || "PM",
    toH:         document.getElementById("abToH")?.value    || "10",
    toM:         document.getElementById("abToM")?.value    || "00",
    toAP:        document.getElementById("abToAP")?.value   || "PM",
    windowRandom: document.getElementById("abWindowRand")?.classList.contains("is-active") || false,
    // Social platforms
    socialIG:  document.getElementById("abSocialIG")?.classList.contains("active") ?? true,
    socialFB:  document.getElementById("abSocialFB")?.classList.contains("active") ?? true,
    socialTT:  document.getElementById("abSocialTT")?.classList.contains("active") ?? true,
  };
  chrome.storage.local.set({ autoBotConfig: config });
}

const AB_CONFIG_DEFAULTS = {
  type: "restaurant", country: "BE", allRegions: true, regions: [],
  minRatings: "100", minStars: "4", minPics: "5",
  songGenre: "top100", language: "nl",
  capCatchy: true, capName: true, capAddr: true, capHash: true, capSong: true,
  freqNum: "1", freqPeriod: "day", freqRandom: false,
  fromH: "05", fromM: "00", fromAP: "PM", toH: "10", toM: "00", toAP: "PM",
  windowRandom: false, socialIG: true, socialFB: true, socialTT: false,
};

function loadAutoBotConfig() {
  chrome.storage.local.get({ autoBotConfig: null }, ({ autoBotConfig: raw }) => {
    if (!raw) return;
    // Merge stored config over defaults so missing/corrupted keys fall back safely
    const cfg = { ...AB_CONFIG_DEFAULTS, ...raw };

    const pill = (groupId, val) =>
      document.querySelectorAll(`#${groupId} .ab-pill`)
        .forEach(p => p.classList.toggle("active", p.dataset.val === val));
    const sel = (id, val) => { const e = document.getElementById(id); if (e && val != null) e.value = val; };

    pill("abType",  cfg.type);
    sel("abCountry", cfg.country);
    if (cfg.country) {
      buildRegionChips(cfg.country);
      setTimeout(() => {
        if (cfg.allRegions) {
          document.querySelector("#abRegionWrap .all-chip")?.classList.add("active");
        } else if (cfg.regions?.length) {
          document.querySelector("#abRegionWrap .all-chip")?.classList.remove("active");
          document.querySelectorAll("#abRegionWrap .ab-region-chip:not(.all-chip)")
            .forEach(c => c.classList.toggle("active", cfg.regions.includes(c.textContent.trim())));
        }
      }, 60);
    }
    sel("abMinRatings", cfg.minRatings);
    const sliderVal = document.getElementById("abMinRatingsVal");
    if (sliderVal && cfg.minRatings) sliderVal.textContent = cfg.minRatings;

    pill("abStars", cfg.minStars);
    pill("abPics",  cfg.minPics);
    sel("abSongGenre", cfg.songGenre);
    sel("abLanguage",  cfg.language);

    const capMap = { abCapCatchy:"capCatchy", abCapName:"capName", abCapAddr:"capAddr", abCapHash:"capHash", abCapSong:"capSong" };
    Object.entries(capMap).forEach(([id, key]) => {
      const e = document.getElementById(id);
      if (e && cfg[key] !== undefined) e.checked = cfg[key];
    });

    sel("abFreqNum",    cfg.freqNum);
    sel("abFreqPeriod", cfg.freqPeriod);
    if (cfg.freqRandom) {
      document.getElementById("abFreqRand")?.classList.add("is-active");
      document.getElementById("abFreqRow")?.classList.add("is-random");
      document.getElementById("abFreqRandHint")?.classList.remove("hidden");
    }

    sel("abFromH",  cfg.fromH);  sel("abFromM",  cfg.fromM);  sel("abFromAP", cfg.fromAP);
    sel("abToH",    cfg.toH);    sel("abToM",    cfg.toM);    sel("abToAP",   cfg.toAP);
    if (cfg.windowRandom) {
      document.getElementById("abWindowRand")?.classList.add("is-active");
      document.getElementById("abWindowRow")?.classList.add("is-random");
      document.getElementById("abWindowRandHint")?.classList.remove("hidden");
    }

    if (cfg.socialIG !== undefined) document.getElementById("abSocialIG")?.classList.toggle("active", cfg.socialIG);
    if (cfg.socialFB !== undefined) document.getElementById("abSocialFB")?.classList.toggle("active", cfg.socialFB);
    if (cfg.socialTT !== undefined) document.getElementById("abSocialTT")?.classList.toggle("active", cfg.socialTT);
  });
}

// Debounced save — fires 600ms after last change
let _abSaveTimer = null;
function autoBotChanged() {
  clearTimeout(_abSaveTimer);
  _abSaveTimer = setTimeout(saveAutoBotConfig, 600);
}

function initAutoBotPersistence() {
  const ids = ["abCountry","abLanguage","abSongGenre","abMinRatings","abFreqNum","abFreqPeriod",
               "abFromH","abFromM","abFromAP","abToH","abToM","abToAP",
               "abCapCatchy","abCapName","abCapAddr","abCapHash","abCapSong"];
  ids.forEach(id => {
    document.getElementById(id)?.addEventListener("change", autoBotChanged);
    document.getElementById(id)?.addEventListener("input",  autoBotChanged);
  });
  ["abType","abStars","abPics"].forEach(id =>
    document.getElementById(id)?.addEventListener("click", autoBotChanged));
  document.getElementById("abRegionWrap")?.addEventListener("click", autoBotChanged);
  ["abSocialIG","abSocialFB","abSocialTT","abFreqRand","abWindowRand"]
    .forEach(id => document.getElementById(id)?.addEventListener("click", autoBotChanged));
}
initAutoBotPersistence();

// ── Manual Post search-filter persistence (independent of Auto Bot) ─────────────

function saveManualConfig() {
  const config = {
    type:       document.querySelector("#mmType .ab-pill.active")?.dataset?.val || "restaurant",
    country:    document.getElementById("mmCountry")?.value   || "BE",
    allRegions: document.querySelector("#mmRegionWrap .all-chip")?.classList.contains("active") ?? true,
    regions:    [...document.querySelectorAll("#mmRegionWrap .ab-region-chip:not(.all-chip)")]
                  .filter(c => c.classList.contains("active")).map(c => c.textContent.trim()),
    minRatings: document.getElementById("mmMinRatings")?.value || "100",
    minStars:   document.querySelector("#mmStars .ab-pill.active")?.dataset?.val || "4",
    minPics:    document.querySelector("#mmPics .ab-pill.active")?.dataset?.val || "5",
  };
  chrome.storage.local.set({ manualPostConfig: config });
}

const MM_CONFIG_DEFAULTS = {
  type: "restaurant", country: "BE", allRegions: true, regions: [],
  minRatings: "100", minStars: "4", minPics: "5",
};

function loadManualConfig() {
  chrome.storage.local.get({ manualPostConfig: null }, ({ manualPostConfig: raw }) => {
    const cfg = { ...MM_CONFIG_DEFAULTS, ...(raw || {}) };

    const pill = (groupId, val) =>
      document.querySelectorAll(`#${groupId} .ab-pill`)
        .forEach(p => p.classList.toggle("active", p.dataset.val === val));
    const sel = (id, val) => { const e = document.getElementById(id); if (e && val != null) e.value = val; };

    pill("mmType", cfg.type);
    sel("mmCountry", cfg.country);
    buildRegionChips(cfg.country, "mmRegionWrap");
    setTimeout(() => {
      if (cfg.allRegions) {
        document.querySelector("#mmRegionWrap .all-chip")?.classList.add("active");
      } else if (cfg.regions?.length) {
        document.querySelector("#mmRegionWrap .all-chip")?.classList.remove("active");
        document.querySelectorAll("#mmRegionWrap .ab-region-chip:not(.all-chip)")
          .forEach(c => c.classList.toggle("active", cfg.regions.includes(c.textContent.trim())));
      }
    }, 60);

    sel("mmMinRatings", cfg.minRatings);
    const sliderVal = document.getElementById("mmMinRatingsVal");
    if (sliderVal && cfg.minRatings) sliderVal.textContent = cfg.minRatings;

    pill("mmStars", cfg.minStars);
    pill("mmPics",  cfg.minPics);

    updateManualConfigSummary();
  });
}

// Debounced save — fires 600ms after last change
let _mmSaveTimer = null;
function manualConfigChanged() {
  clearTimeout(_mmSaveTimer);
  _mmSaveTimer = setTimeout(() => { saveManualConfig(); updateManualConfigSummary(); }, 600);
}

function initManualPersistence() {
  document.getElementById("mmCountry")?.addEventListener("change", manualConfigChanged);
  document.getElementById("mmMinRatings")?.addEventListener("input", manualConfigChanged);
  ["mmType","mmStars","mmPics"].forEach(id =>
    document.getElementById(id)?.addEventListener("click", manualConfigChanged));
  document.getElementById("mmRegionWrap")?.addEventListener("click", manualConfigChanged);
}
initManualPersistence();

// ── Manual Post config summary (shown when filters are collapsed) ───────────────
function updateManualConfigSummary() {
  const el = document.getElementById("mmConfigSummary");
  if (!el) return;
  const type    = document.querySelector("#mmType .ab-pill.active")?.dataset?.val || "restaurant";
  const cc      = document.getElementById("mmCountry")?.value || "BE";
  const country = AB_COUNTRY_NAMES[cc] || cc;
  const allChip = document.querySelector("#mmRegionWrap .all-chip");
  const region  = allChip?.classList.contains("active") ? "All regions"
    : [...document.querySelectorAll("#mmRegionWrap .ab-region-chip:not(.all-chip)")]
        .filter(c => c.classList.contains("active")).map(c => c.textContent.trim()).join(", ") || "All regions";
  el.textContent = `${type.charAt(0).toUpperCase() + type.slice(1)} · ${country} · ${region}`;
}

// ── Manual Post collapsible filters toggle ───────────────────────────────────────
document.getElementById("mmConfigToggle")?.addEventListener("click", () => {
  const body  = document.getElementById("mmConfigBody");
  const arrow = document.getElementById("mmConfigArrow");
  if (!body) return;
  const collapsed = body.classList.toggle("collapsed");
  arrow?.classList.toggle("collapsed", collapsed);
});

// ── Bot Configuration collapsible wrapper toggle (Auto Bot) ─────────────────────
[
  ["abBotConfigToggle", "abBotConfigBody", "abBotConfigArrow"],
].forEach(([toggleId, bodyId, arrowId]) => {
  document.getElementById(toggleId)?.addEventListener("click", () => {
    const body  = document.getElementById(bodyId);
    const arrow = document.getElementById(arrowId);
    if (!body) return;
    const collapsed = body.classList.toggle("collapsed");
    arrow?.classList.toggle("collapsed", collapsed);
  });
});

// ── Manual Post: Manual Search vs Bot Search toggle ──────────────────────────────
const searchModeManualBtn = document.getElementById("searchModeManual");
const searchModeBotBtn    = document.getElementById("searchModeBot");
const manualSearchPanel   = document.getElementById("manualSearchPanel");
const botSearchPanel      = document.getElementById("botSearchPanel");
function setSearchMode(mode) {
  const isBot = mode === "bot";
  searchModeManualBtn?.classList.toggle("active", !isBot);
  searchModeBotBtn?.classList.toggle("active", isBot);
  manualSearchPanel?.classList.toggle("hidden", isBot);
  botSearchPanel?.classList.toggle("hidden", !isBot);
}
searchModeManualBtn?.addEventListener("click", () => setSearchMode("manual"));
searchModeBotBtn?.addEventListener("click", () => setSearchMode("bot"));

// ── Manual Post: single-select pill groups (Type / Stars / Pics) ────────────────
["mmType", "mmStars", "mmPics"].forEach(groupId => {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.addEventListener("click", e => {
    const pill = e.target.closest(".ab-pill");
    if (!pill) return;
    group.querySelectorAll(".ab-pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
  });
});

// ── Manual Post: ratings slider live value ───────────────────────────────────────
const mmSlider = document.getElementById("mmMinRatings");
const mmSliderVal = document.getElementById("mmMinRatingsVal");
if (mmSlider && mmSliderVal) {
  mmSlider.addEventListener("input", () => {
    mmSliderVal.textContent = Number(mmSlider.value).toLocaleString();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTO BOT SCHEDULE LOGIC
// ══════════════════════════════════════════════════════════════════════════════

// Convert 12-hour time components to total minutes since midnight (24h)
function abTimeTo24hMinutes(hour, minute, ampm) {
  let h = parseInt(hour, 10) || 12;
  const m = parseInt(minute, 10) || 0;
  if (ampm === "AM") { if (h === 12) h = 0; }
  else               { if (h !== 12) h += 12; }
  return h * 60 + m;
}

// Format minutes-since-midnight as "HH:MM"
function abMinutesToHHMM(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}

// Format a Date as "YYYY-MM-DD"
function abFormatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}

// Pick `count` random times within a window, returned sorted
function abRandomTimesInWindow(count, startMin, endMin) {
  if (count <= 0) return [];
  const range = Math.max(0, endMin - startMin);
  return Array.from({ length: count }, () => {
    const m = startMin + Math.floor(Math.random() * (range + 1));
    return abMinutesToHHMM(m);
  }).sort();
}

// Calculate window bounds from form or random
function abGetWindowMinutes(windowCfg) {
  if (windowCfg.isRandom) return { start: 0, end: 1439 }; // full day
  const start = abTimeTo24hMinutes(windowCfg.fromH, windowCfg.fromM, windowCfg.fromAP);
  const end   = abTimeTo24hMinutes(windowCfg.toH,   windowCfg.toM,   windowCfg.toAP);
  // Handle overnight windows (e.g. 10 PM → 2 AM)
  return { start, end: end >= start ? end : end + 1440 };
}

// Distribute `total` posts across `numDays` days respecting maxPerDay
// Returns array of per-day counts
function abDistributePostsAcrossDays(total, numDays, maxPerDay = 2) {
  const capped  = Math.min(total, maxPerDay * numDays);
  const base    = Math.floor(capped / numDays);   // every day gets at least this many
  const extra   = capped % numDays;               // first `extra` days get one more

  // Shuffle day indices so the extra posts land on random days rather than always
  // the first N days — preserves the feel of random distribution without O(10000) retries.
  const order = Array.from({ length: numDays }, (_, i) => i)
    .sort(() => Math.random() - 0.5);

  const perDay = new Array(numDays).fill(base);
  for (let i = 0; i < extra; i++) perDay[order[i]]++;
  return perDay;
}

/**
 * Generate the full posting schedule based on Auto Bot settings.
 *
 * Returns an object with:
 *   - posts[]:  { date (YYYY-MM-DD), time (HH:MM), platforms[], dayOfWeek }
 *   - summary:  human-readable description
 *   - totalPosts, period, generatedAt
 *
 * This is PURE LOGIC — no API calls, no actual posting.
 * Saved to chrome.storage as 'autoBotSchedule' for the scheduling engine to consume.
 */
function generateAutoBotSchedule(settings) {
  const { frequency: freq, window: win, country } = settings;
  const platforms = [];
  if (document.getElementById("abSocialIG")?.classList.contains("active")) platforms.push("instagram");
  if (document.getElementById("abSocialFB")?.classList.contains("active")) platforms.push("facebook");
  if (document.getElementById("abSocialTT")?.classList.contains("active")) platforms.push("tiktok");

  if (platforms.length === 0) {
    AppLog.warn("Auto Bot schedule: no platforms selected — schedule not generated");
    return { generatedAt: new Date().toISOString(), period: freq.period, totalPosts: 0, platforms: [], posts: [] };
  }

  const winBounds = abGetWindowMinutes(win);

  // Determine actual post count
  let totalPosts;
  if (freq.isRandom) {
    // Random caps: max 2/day, max 20/week
    const maxMap = { day: 2, week: 20, month: 40 };
    const maxForPeriod = maxMap[freq.period] || 20;
    totalPosts = Math.floor(Math.random() * maxForPeriod) + 1;
  } else {
    totalPosts = Math.max(1, freq.count);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const posts = [];

  if (freq.period === "day") {
    // Repeat `totalPosts` per day for the next 7 days
    for (let d = 0; d < 7; d++) {
      const date = new Date(today); date.setDate(today.getDate() + d);
      const times = abRandomTimesInWindow(totalPosts, winBounds.start, winBounds.end);
      times.forEach(time => posts.push({
        date: abFormatDate(date), time, platforms,
        dayOfWeek: date.toLocaleDateString("en-US", { weekday: "short" }),
      }));
    }
  } else if (freq.period === "week") {
    // Distribute across the NEXT 7 days starting from today (never past days)
    const perDay = abDistributePostsAcrossDays(totalPosts, 7, 2);
    for (let d = 0; d < 7; d++) {
      if (perDay[d] === 0) continue;
      const date = new Date(today); date.setDate(today.getDate() + d);
      const times = abRandomTimesInWindow(perDay[d], winBounds.start, winBounds.end);
      times.forEach(time => posts.push({
        date: abFormatDate(date), time, platforms,
        dayOfWeek: date.toLocaleDateString("en-US", { weekday: "short" }),
      }));
    }
  } else if (freq.period === "month") {
    // Distribute across next 30 days starting from today
    const perDay = abDistributePostsAcrossDays(totalPosts, 30, 2);
    for (let d = 0; d < 30; d++) {
      if (perDay[d] === 0) continue;
      const date = new Date(today); date.setDate(today.getDate() + d);
      const times = abRandomTimesInWindow(perDay[d], winBounds.start, winBounds.end);
      times.forEach(time => posts.push({
        date: abFormatDate(date), time, platforms,
        dayOfWeek: date.toLocaleDateString("en-US", { weekday: "short" }),
      }));
    }
  }

  // Always sort chronologically and strip any posts already in the past
  const now = new Date();
  posts.sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  const futurePosts = posts.filter(p => new Date(`${p.date}T${p.time}:00`) > now);

  if (futurePosts.length === 0 && posts.length > 0) {
    // All generated times ended up in the past (e.g. user activated late at night
    // with a narrow posting window that already closed today).
    const schedBtn = document.getElementById("abScheduleBtn");
    if (schedBtn) {
      const origText = schedBtn.textContent;
      schedBtn.textContent = "⚠️ All times already past — schedule a future window";
      setTimeout(() => { schedBtn.textContent = origText; }, 6000);
    }
    AppLog.warn("Auto Bot schedule: all generated posts were in the past — no alarms will fire");
  }

  const result = {
    generatedAt: new Date().toISOString(),
    period: freq.period,
    frequencyIsRandom: freq.isRandom,
    windowIsRandom: win.isRandom,
    totalPosts: futurePosts.length,
    platforms,
    posts: futurePosts, // always future-only
  };

  // Persist the schedule
  chrome.storage.local.set({ autoBotSchedule: result });
  AppLog.info("Auto Bot schedule generated", {
    totalPosts: futurePosts.length, period: freq.period,
    platforms, windowRandom: win.isRandom,
  });

  return result;
}

// Helper: get frequency + window settings from current form state
function getScheduleSettings() {
  return {
    frequency: {
      count:    parseInt(document.getElementById("abFreqNum")?.value    || "1",   10),
      period:   document.getElementById("abFreqPeriod")?.value          || "day",
      isRandom: document.getElementById("abFreqRand")?.classList.contains("is-active") || false,
    },
    window: {
      fromH:    document.getElementById("abFromH")?.value  || "05",
      fromM:    document.getElementById("abFromM")?.value  || "00",
      fromAP:   document.getElementById("abFromAP")?.value || "PM",
      toH:      document.getElementById("abToH")?.value    || "10",
      toM:      document.getElementById("abToM")?.value    || "00",
      toAP:     document.getElementById("abToAP")?.value   || "PM",
      isRandom: document.getElementById("abWindowRand")?.classList.contains("is-active") || false,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTO BOT ACTIVATION LOGIC
// ══════════════════════════════════════════════════════════════════════════════

let autoBotActive      = false;
let activityLogFilter  = "month"; // "day" | "week" | "month" | "year"

const FILTER_LABELS = { day:"Last 24 hours", week:"Last 7 days", month:"Last 30 days", year:"Last year" };
const FILTER_SHORT  = { day:"1d", week:"7d", month:"30d", year:"1y" };

// ── Collapsible config toggle ─────────────────────────────────────────────────
document.getElementById("abConfigToggle")?.addEventListener("click", () => {
  const body  = document.getElementById("abConfigBody");
  const arrow = document.getElementById("abConfigArrow");
  if (!body) return;
  const collapsed = body.classList.toggle("collapsed");
  arrow?.classList.toggle("collapsed", collapsed);
});

// ── Collapsible scheduled posts toggle ───────────────────────────────────────
document.getElementById("abSchedToggle")?.addEventListener("click", () => {
  const body  = document.getElementById("abSchedBody");
  const arrow = document.getElementById("abSchedArrow");
  if (!body) return;
  const collapsed = body.classList.toggle("collapsed");
  arrow?.classList.toggle("collapsed", collapsed);
});

// ── Collapsible per-bot-type schedule group toggle ────────────────────────────
function bindScheduleGroupToggle(prefix) {
  document.getElementById(`${prefix}ScheduleToggle`)?.addEventListener("click", () => {
    const body  = document.getElementById(`${prefix}ScheduleBody`);
    const arrow = document.getElementById(`${prefix}ScheduleArrow`);
    if (!body) return;
    const collapsed = body.classList.toggle("collapsed");
    arrow?.classList.toggle("collapsed", collapsed);
  });
}
bindScheduleGroupToggle("ab");
bindScheduleGroupToggle("rr");

// ── Collapsible Activity Log toggle ───────────────────────────────────────────
document.getElementById("abLogToggle")?.addEventListener("click", (e) => {
  if (e.target.closest(".ab-log-controls")) return;
  const items = document.getElementById("abLogItems");
  const arrow = document.getElementById("abLogArrow");
  if (!items) return;
  const collapsed = items.classList.toggle("collapsed");
  arrow?.classList.toggle("collapsed", collapsed);
});

// ── Activate / Deactivate ─────────────────────────────────────────────────────
document.getElementById("abScheduleBtn")?.addEventListener("click", () => {
  if (autoBotActive) deactivateBot();
  else               activateBot();
});

function activateBot() {
  if (!API_KEY) { alert("Please save your Google API key before activating the bot."); return; }
  const platforms = [];
  if (document.getElementById("abSocialIG")?.classList.contains("active")) platforms.push("instagram");
  if (document.getElementById("abSocialFB")?.classList.contains("active")) platforms.push("facebook");
  if (document.getElementById("abSocialTT")?.classList.contains("active")) platforms.push("tiktok");
  if (!platforms.length) { alert("Please select at least one social media platform."); return; }

  // Collapse config immediately so the user gets visual feedback right away
  const cfgBody  = document.getElementById("abConfigBody");
  const cfgArrow = document.getElementById("abConfigArrow");
  cfgBody?.classList.add("collapsed");
  cfgArrow?.classList.add("collapsed");

  const settings = getAutoBotSettings();
  const schedule = generateAutoBotSchedule(settings);

  autoBotActive = true;
  chrome.storage.local.set({ autoBotActive: true, autoBotSchedule: schedule, autoBotRunLog: [] });
  setupScheduleAlarms(schedule);

  updateBotUI(true);
  renderScheduledPosts(schedule);
  refreshActivityLog();
  updateProgress(0, schedule.totalPosts);
  updateNextPostLabel(schedule);
  updateConfigSummary();

  AppLog.info("Auto Bot activated", { totalPosts: schedule.totalPosts, platforms });
  TechLog.info("SCHEDULE", "bot_activated", { totalPosts: schedule.totalPosts, platforms, period: settings.frequency?.period });
}

function deactivateBot() {
  autoBotActive = false;
  // Archive last schedule before clearing so the user can re-enable from where they left off.
  // activityLog (persistent history) is always preserved.
  chrome.storage.local.get({ autoBotSchedule: null }, ({ autoBotSchedule: prev }) => {
    const updates = { autoBotActive: false, autoBotSchedule: null, autoBotRunLog: [] };
    if (prev) updates.autoBotLastSchedule = prev;
    chrome.storage.local.set(updates);
  });
  chrome.storage.local.remove("autoBotPaused");
  hidePausedBanner();
  clearAlarmsByPrefix("ffbot-auto-");
  updateBotUI(false);
  // Reset schedule-specific UI
  updateProgress(0, 0);
  const schedBody  = document.getElementById("abSchedBody");
  const schedBadge = document.getElementById("abSchedCount");
  const schedTitle = document.querySelector("#abScheduledSection .ab-collapse-hdr-title");
  if (schedBody)  schedBody.innerHTML = "";
  if (schedBadge) schedBadge.textContent = "0";
  if (schedTitle) schedTitle.textContent = "📅 Scheduled Posts";
  // Refresh activity log from persistent store (unchanged)
  refreshActivityLog();
  AppLog.info("Auto Bot deactivated — schedule cleared, activity log preserved");
  TechLog.info("SCHEDULE", "bot_deactivated", { scheduleCleared: true });
}

// ── Active Bots overview card: shown whenever any bot status/paused row is visible ──
function syncActiveBotsWrap() {
  const wrap = document.getElementById("abActiveBotsWrap");
  if (!wrap) return;
  const rows = ["abBotStatus", "abPausedBanner", "rrBotStatus", "rrPausedBanner"]
    .map(id => document.getElementById(id))
    .filter(Boolean);
  const anyVisible = rows.some(el => !el.classList.contains("hidden"));
  wrap.classList.toggle("hidden", !anyVisible);
}

// ── Schedule group summary (shown on the collapsed schedule header) ──────────
function formatFreqSummary(freq) {
  if (!freq) return "";
  if (freq.isRandom) return "🎲 Random frequency";
  return `${freq.count}× / ${freq.period}`;
}

function updateScheduleGroupSummary(prefix, active) {
  const el = document.getElementById(`${prefix}ScheduleSummary`);
  if (!el) return;
  const settings = prefix === "ab" ? getScheduleSettings() : getRoundupScheduleSettings();
  const freqTxt = formatFreqSummary(settings.frequency);
  el.textContent = active ? `🟢 Active · ${freqTxt}` : `⚪ Not scheduled · ${freqTxt}`;
}

function updateBotUI(active) {
  const btn      = document.getElementById("abScheduleBtn");
  const body     = document.getElementById("abConfigBody");
  const arrow    = document.getElementById("abConfigArrow");
  const status   = document.getElementById("abBotStatus");
  const progress = document.getElementById("abProgressWrap");
  const schedSec = document.getElementById("abScheduledSection");
  const actLog   = document.getElementById("abActivityLog");

  if (active) {
    if (btn) { btn.textContent = "⏹ Deactivate Bot"; btn.classList.add("is-active"); }
    body?.classList.add("collapsed");
    arrow?.classList.add("collapsed");
    status?.classList.remove("hidden");
    progress?.classList.remove("hidden");
    schedSec?.classList.remove("hidden");
    actLog?.classList.add("prominent");
  } else {
    if (btn) { btn.textContent = "⏰ Schedule Auto Bot"; btn.classList.remove("is-active"); }
    body?.classList.remove("collapsed");
    arrow?.classList.remove("collapsed");
    status?.classList.add("hidden");
    progress?.classList.add("hidden");
    schedSec?.classList.add("hidden");
    actLog?.classList.remove("prominent");
  }
  updateScheduleGroupSummary("ab", active);
  syncActiveBotsWrap();
}

// ── Chrome Alarms ─────────────────────────────────────────────────────────────
// Clear only alarms belonging to one campaign (by name prefix) so activating or
// deactivating one campaign (spotlight vs. roundup) never clobbers the other's.
async function clearAlarmsByPrefix(prefix) {
  const all = await chrome.alarms.getAll();
  await Promise.all(all.filter(a => a.name.startsWith(prefix)).map(a => chrome.alarms.clear(a.name)));
}

function setupScheduleAlarms(schedule) {
  clearAlarmsByPrefix("ffbot-auto-").then(() => {
    const now = Date.now();
    schedule.posts.forEach((post, idx) => {
      const base = new Date(`${post.date}T${post.time}:00`).getTime();
      // Add a random 0-15 min delay so posts don't fire at the exact same
      // second every day — a uniform schedule is an easy automation signal.
      // A little extra delay is harmless since this only runs a few times a day.
      const when = base + Math.floor(Math.random() * 15 * 60 * 1000);
      if (when > now) chrome.alarms.create(`ffbot-auto-${idx}`, { when });
    });
    AppLog.info(`Set ${schedule.posts.length} alarms`);
  });
}

// ── Render scheduled posts list ───────────────────────────────────────────────
const SCHED_STATUS_LABELS = {
  pending:     "⏳ Pending",
  triggered:   "🔄 Posting…",
  done:        "✓ Done",
  failed:      "✗ Failed",
  unconfirmed: "⚠ Unconfirmed",
};

function renderScheduledPosts(schedule, runLog = []) {
  const body  = document.getElementById("abSchedBody");
  const badge = document.getElementById("abSchedCount");
  const title = document.querySelector("#abScheduledSection .ab-collapse-hdr-title");
  if (!body) return;

  const postCount = schedule?.posts?.length || 0;
  if (badge) badge.textContent = postCount;

  // Show generation timestamp in the section header
  if (title && schedule?.generatedAt) {
    const genTime = new Date(schedule.generatedAt).toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit" });
    const genDate = new Date(schedule.generatedAt).toLocaleDateString("en-GB", { day:"numeric", month:"short" });
    title.textContent = `📅 Scheduled Posts — generated ${genDate} at ${genTime}`;
  }

  body.innerHTML = "";

  // Empty state
  if (!postCount) {
    body.innerHTML = `<div style="padding:12px;text-align:center;font-size:.75rem;color:var(--muted)">No upcoming posts scheduled</div>`;
    return;
  }

  // Group by date
  const grouped = {};
  schedule.posts.forEach((post, idx) => {
    if (!grouped[post.date]) grouped[post.date] = [];
    grouped[post.date].push({ ...post, idx });
  });

  Object.entries(grouped).sort(([a],[b]) => a.localeCompare(b)).forEach(([date, posts]) => {
    const dayEl  = document.createElement("div");
    dayEl.className = "ab-sched-day-group";
    const dayObj = new Date(`${date}T00:00:00`);
    const dayLbl = dayObj.toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"short" });
    dayEl.innerHTML = `<div class="ab-sched-day-label">${dayLbl}</div>`;

    posts.forEach(post => {
      const plat = post.platforms.map(p => ({ instagram:"📸 IG", facebook:"👥 FB", tiktok:"🎵 TT" }[p] || p)).join("  ");

      // Status comes from the ACTUAL run log — never from the clock.
      // "✓ Done" is only shown when the run confirmed success on every platform.
      const logStatus = runLog.find(e => e.postIndex === post.idx)?.status;
      const status    = SCHED_STATUS_LABELS[logStatus] ? logStatus : "pending";

      const item = document.createElement("div");
      item.className = "ab-sched-item";
      item.id = `abSchedItem-${post.idx}`;
      item.innerHTML = `
        <span class="ab-sched-time">${escapeHtml(post.time)}</span>
        <span class="ab-sched-platforms">${escapeHtml(plat)}</span>
        <span class="ab-sched-status ${status}" id="abSchedStatus-${post.idx}">
          ${SCHED_STATUS_LABELS[status]}
        </span>`;
      dayEl.appendChild(item);
    });
    body.appendChild(dayEl);
  });
}

function updateScheduledItemStatus(idx, status) {
  const el = document.getElementById(`abSchedStatus-${idx}`);
  if (!el) return;
  el.textContent = SCHED_STATUS_LABELS[status] || status;
  el.className   = `ab-sched-status ${status}`;
}

// ── Progress ──────────────────────────────────────────────────────────────────
function updateProgress(done, total) {
  const fill  = document.getElementById("abProgressFill");
  const label = document.getElementById("abProgressLabel");
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  if (fill)  fill.style.width = `${pct}%`;
  if (label) label.textContent = `${done} of ${total} posts published`;
  const txt = document.getElementById("abBotProgressText");
  if (txt)   txt.textContent = `${done} / ${total} posts`;
}

function updateNextPostLabel(schedule) {
  const el  = document.getElementById("abBotNextPost");
  if (!el) return;
  const now  = new Date();
  const next = schedule.posts.find(p => new Date(`${p.date}T${p.time}:00`) > now);
  if (next) {
    const d = new Date(`${next.date}T${next.time}:00`);
    el.textContent = `Next: ${d.toLocaleDateString("en-GB", { weekday:"short", day:"numeric", month:"short" })} at ${next.time}`;
  } else {
    el.textContent = "All posts complete";
  }
}

const ACTIVITY_LOG_MAX_ENTRIES = 2000; // prune floor for chrome.storage writes
const ACTIVITY_LOG_DISPLAY_CAP = 500;  // max entries rendered at once to avoid DOM freeze

// ── Activity log — reads from persistent activityLog, filtered by time ────────
function refreshActivityLog(filter) {
  if (filter) activityLogFilter = filter;
  const now    = new Date();
  const ms     = { day:864e5, week:6048e5, month:2592e6, year:31536e6 };
  const cutoff = new Date(now - (ms[activityLogFilter] || ms.month));

  chrome.storage.local.get({ activityLog:[] }, ({ activityLog }) => {
    // Auto-prune oversized logs before reading so storage stays lean
    if (activityLog.length > ACTIVITY_LOG_MAX_ENTRIES) {
      const pruned = activityLog.slice(-ACTIVITY_LOG_MAX_ENTRIES);
      chrome.storage.local.set({ activityLog: pruned });
      activityLog = pruned;
    }
    const counts = { instagram:0, facebook:0, tiktok:0 };
    activityLog
      .filter(e => e.status === "done" && new Date(e.ts) >= cutoff)
      .slice(-ACTIVITY_LOG_DISPLAY_CAP)
      .forEach(e => { if (e.platform in counts) counts[e.platform]++; });

    const total = Object.values(counts).reduce((a,b) => a+b, 0);
    const fmt   = n => `${n} post${n !== 1 ? "s" : ""}`;
    const set   = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };

    set("abLogIG",          fmt(counts.instagram));
    set("abLogFB",          fmt(counts.facebook));
    set("abLogTT",          fmt(counts.tiktok));
    set("abLogTotal",       fmt(total));
    set("abLogPeriodLabel", FILTER_SHORT[activityLogFilter]  || "30d");
    set("abLogPeriod",      FILTER_LABELS[activityLogFilter] || "Last 30 days");

    // Highlight active filter option
    document.querySelectorAll(".ab-filter-opt").forEach(btn =>
      btn.classList.toggle("ab-filter-opt--active", btn.dataset.filter === activityLogFilter)
    );
  });
}

function resetActivityLog() {
  if (!confirm("Reset the entire activity log? This cannot be undone.")) return;
  chrome.storage.local.set({ activityLog:[] }, () => {
    refreshActivityLog();
    AppLog.info("Activity log reset by user");
    TechLog.info("LOG", "activity_log_reset", {});
  });
}

// Filter dropdown toggle
document.getElementById("abLogFilterBtn")?.addEventListener("click", e => {
  e.stopPropagation();
  document.getElementById("abLogFilterDropdown")?.classList.toggle("hidden");
  document.getElementById("abLogFilterBtn")?.classList.toggle("active");
});

// Filter option selection
document.getElementById("abLogFilterDropdown")?.addEventListener("click", e => {
  const opt = e.target.closest(".ab-filter-opt");
  if (!opt) return;
  document.getElementById("abLogFilterDropdown")?.classList.add("hidden");
  document.getElementById("abLogFilterBtn")?.classList.remove("active");
  refreshActivityLog(opt.dataset.filter);
});

// Close dropdown when clicking outside
document.addEventListener("click", () => {
  document.getElementById("abLogFilterDropdown")?.classList.add("hidden");
  document.getElementById("abLogFilterBtn")?.classList.remove("active");
});

document.getElementById("abLogResetBtn")?.addEventListener("click", resetActivityLog);

// ── Config summary (shown when config is collapsed) ───────────────────────────
function updateConfigSummary() {
  const el = document.getElementById("abConfigSummary");
  if (!el) return;
  const type    = document.querySelector("#abType .ab-pill.active")?.dataset?.val || "restaurant";
  const cc      = document.getElementById("abCountry")?.value || "BE";
  const country = AB_COUNTRY_NAMES[cc] || cc;
  const allChip = document.querySelector("#abRegionWrap .all-chip");
  const region  = allChip?.classList.contains("active") ? "All regions"
    : [...document.querySelectorAll("#abRegionWrap .ab-region-chip:not(.all-chip)")]
        .filter(c => c.classList.contains("active")).map(c => c.textContent.trim()).join(", ") || "All regions";
  el.textContent = `${type.charAt(0).toUpperCase() + type.slice(1)} · ${country} · ${region}`;
}

// ── Paused banner ──────────────────────────────────────────────────────────────
function showPausedBanner(reason) {
  const banner = document.getElementById("abPausedBanner");
  const reasonEl = document.getElementById("abPausedReason");
  if (reasonEl) reasonEl.textContent = reason || "The bot needs your attention.";
  banner?.classList.remove("hidden");
  syncActiveBotsWrap();
}
function hidePausedBanner() {
  document.getElementById("abPausedBanner")?.classList.add("hidden");
  syncActiveBotsWrap();
}
document.getElementById("abPausedResumeBtn")?.addEventListener("click", () => {
  chrome.storage.local.remove("autoBotPaused", () => {
    hidePausedBanner();
    // Re-arm alarms for any future posts so the schedule continues.
    chrome.storage.local.get({ autoBotSchedule: null }, ({ autoBotSchedule }) => {
      if (!autoBotSchedule) return;
      setupScheduleAlarms(autoBotSchedule);
      AppLog.info("Auto Bot resumed by user");
      TechLog.info("SCHEDULE", "bot_resumed", {});
    });
  });
});

// Listen for status messages from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "AUTO_BOT_PAUSED") {
    showPausedBanner(msg.reason);
  }
  if (msg.type === "AUTO_BOT_TRIGGERED") {
    updateScheduledItemStatus(msg.logEntry.postIndex, "triggered");
    chrome.storage.local.get({ autoBotRunLog:[], autoBotSchedule:null }, ({ autoBotRunLog, autoBotSchedule }) => {
      refreshActivityLog(); // reads from persistent activityLog
      const done = autoBotRunLog.filter(e => e.status === "done").length;
      updateProgress(done, autoBotSchedule?.totalPosts || 0);
    });
  }
  if (msg.type === "AUTO_BOT_STATUS_UPDATE") {
    updateScheduledItemStatus(msg.postIndex, msg.status);
    chrome.storage.local.get({ autoBotRunLog:[], autoBotSchedule:null }, ({ autoBotRunLog, autoBotSchedule }) => {
      refreshActivityLog(); // reads from persistent activityLog
      const done = autoBotRunLog.filter(e => e.status === "done").length;
      updateProgress(done, autoBotSchedule?.totalPosts || 0);
      if (autoBotSchedule) updateNextPostLabel(autoBotSchedule);
    });
  }
});

// Restore active state whenever Auto Bot mode is opened
function restoreBotActiveState() {
  chrome.storage.local.get({ autoBotActive:false, autoBotSchedule:null, autoBotRunLog:[], autoBotPaused:null },
    ({ autoBotActive: wasActive, autoBotSchedule: schedule, autoBotRunLog: runLog, autoBotPaused }) => {
      autoBotActive = wasActive;
      refreshActivityLog();
      if (wasActive && schedule) {
        updateBotUI(true);
        renderScheduledPosts(schedule, runLog);
        const done = runLog.filter(e => e.status === "done").length;
        updateProgress(done, schedule.totalPosts);
        updateNextPostLabel(schedule);
        updateConfigSummary();
      } else {
        updateBotUI(false);
      }
      if (autoBotPaused) showPausedBanner(autoBotPaused.reason);
      else hidePausedBanner();
    }
  );
}

// ── Mode selector ────────────────────────────────────────────────────────────

function showMode(mode) {
  document.getElementById("modeSelector").classList.add("hidden");
  document.getElementById("manualMode").classList.add("hidden");
  document.getElementById("autoMode").classList.add("hidden");
  if (mode === "selector") {
    document.getElementById("modeSelector").classList.remove("hidden");
  } else if (mode === "manual") {
    document.getElementById("manualMode").classList.remove("hidden");
  } else if (mode === "auto") {
    document.getElementById("autoMode").classList.remove("hidden");
  }
  chrome.storage.local.set({ lastMode: mode });
}

document.getElementById("btnManualMode").addEventListener("click", () => showMode("manual"));
document.getElementById("btnAutoMode").addEventListener("click",   () => {
  showMode("auto");
  loadAutoBotConfig();
  loadRegionRoundupConfig();
  setTimeout(restoreBotActiveState, 80); // after config loads
  setTimeout(restoreRoundupActiveState, 80);
});
document.getElementById("manualBackBtn").addEventListener("click", () => showMode("selector"));
document.getElementById("autoBackBtn").addEventListener("click",   () => showMode("selector"));

// Restore last mode on open — respect autoBotActive so it doesn't override auto-navigate
chrome.storage.local.get({ lastMode: "selector", autoBotActive: false }, ({ lastMode, autoBotActive: botActive }) => {
  // If bot is active, the main init already navigated to auto mode — don't override it
  if (!botActive) showMode("selector");
});

// ── Auto Bot UI logic ─────────────────────────────────────────────────────────

// ── Province / region data per country ───────────────────────────────────────
const REGIONS = {
  BE: [
    "Antwerp","East Flanders","West Flanders","Flemish Brabant",
    "Walloon Brabant","Hainaut","Liège","Luxembourg","Namur","Limburg",
  ],
  NL: [
    "Groningen","Friesland","Drenthe","Overijssel","Gelderland","Flevoland",
    "Utrecht","North Holland","South Holland","Zeeland","North Brabant","Limburg",
  ],
  LU: ["Luxembourg District","Diekirch District","Grevenmacher District"],
  FR: [
    "Île-de-France","Hauts-de-France","Grand Est","Normandie","Bretagne",
    "Pays de la Loire","Centre-Val de Loire","Bourgogne-Franche-Comté",
    "Nouvelle-Aquitaine","Occitanie","Auvergne-Rhône-Alpes",
    "Provence-Alpes-Côte d'Azur","Corse",
  ],
  DE: [
    "Baden-Württemberg","Bavaria","Berlin","Brandenburg","Bremen","Hamburg",
    "Hesse","Lower Saxony","Mecklenburg-Vorpommern","North Rhine-Westphalia",
    "Rhineland-Palatinate","Saarland","Saxony","Saxony-Anhalt",
    "Schleswig-Holstein","Thuringia",
  ],
};

function buildRegionChips(countryCode, wrapId = "abRegionWrap") {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  wrap.innerHTML = "";
  const regions = REGIONS[countryCode] || [];

  // "All" chip — selected by default
  const allChip = document.createElement("button");
  allChip.type = "button";
  allChip.className = "ab-region-chip all-chip active";
  allChip.textContent = "All";
  allChip.addEventListener("click", () => {
    const isActive = allChip.classList.toggle("active");
    // If "All" is activated, deselect individual regions
    if (isActive) wrap.querySelectorAll(".ab-region-chip:not(.all-chip)").forEach(c => c.classList.remove("active"));
  });
  wrap.appendChild(allChip);

  regions.forEach(name => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "ab-region-chip";
    chip.textContent = name;
    chip.addEventListener("click", () => {
      chip.classList.toggle("active");
      // If any individual region is selected, deactivate "All"
      const anyActive = [...wrap.querySelectorAll(".ab-region-chip:not(.all-chip)")].some(c => c.classList.contains("active"));
      allChip.classList.toggle("active", !anyActive);
    });
    wrap.appendChild(chip);
  });
}

// Build chips for initial country (Belgium)
buildRegionChips("BE");
buildRegionChips("BE", "mmRegionWrap");

// Rebuild when country changes
document.getElementById("abCountry")?.addEventListener("change", e => {
  buildRegionChips(e.target.value);
});
document.getElementById("mmCountry")?.addEventListener("change", e => {
  buildRegionChips(e.target.value, "mmRegionWrap");
});

// ── Single-select pill groups (Type / Stars / Pics) ───────────────────────────
["abType", "abStars", "abPics"].forEach(groupId => {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.addEventListener("click", e => {
    const pill = e.target.closest(".ab-pill");
    if (!pill) return;
    group.querySelectorAll(".ab-pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
  });
});

// ── Social media toggles in Auto Bot ────────────────────────────────────────
["abSocialIG", "abSocialFB", "abSocialTT"].forEach(id => {
  document.getElementById(id)?.addEventListener("click", function() {
    this.classList.toggle("active");
  });
});

// ── Schedule: populate hour selects and set defaults ─────────────────────────
function buildHourSelect(selectId, defaultHour) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  for (let h = 1; h <= 12; h++) {
    const opt = document.createElement("option");
    opt.value = String(h).padStart(2, "0");
    opt.textContent = String(h).padStart(2, "0");
    if (h === defaultHour) opt.selected = true;
    sel.appendChild(opt);
  }
}
buildHourSelect("abFromH", 5);   // 05:00 PM
buildHourSelect("abToH",   10);  // 10:00 PM

// ── Random button toggles (greys out the field row) ───────────────────────────
[
  { btnId: "abFreqRand",   rowId: "abFreqRow",   hintId: "abFreqRandHint"   },
  { btnId: "abWindowRand", rowId: "abWindowRow", hintId: "abWindowRandHint" },
].forEach(({ btnId, rowId, hintId }) => {
  const btn  = document.getElementById(btnId);
  const row  = document.getElementById(rowId);
  const hint = document.getElementById(hintId);
  if (!btn || !row) return;
  btn.addEventListener("click", () => {
    const active = btn.classList.toggle("is-active");
    row.classList.toggle("is-random", active);
    btn.textContent = active ? "🎲 Random ✓" : "🎲 Random";
    if (hint) hint.classList.toggle("hidden", !active);
  });
});

// ── Preview Example Post button ───────────────────────────────────────────────
document.getElementById("abPreviewBtn")?.addEventListener("click", previewExamplePost);
document.getElementById("autoPreviewClose")?.addEventListener("click", () => {
  document.getElementById("autoPreview")?.classList.add("hidden");
});

// ── Ratings slider live value ─────────────────────────────────────────────────
const abSlider = document.getElementById("abMinRatings");
const abSliderVal = document.getElementById("abMinRatingsVal");
if (abSlider && abSliderVal) {
  abSlider.addEventListener("input", () => {
    abSliderVal.textContent = Number(abSlider.value).toLocaleString();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// REGION ROUNDUP — "Top N {type}s in {region}" posts (independent campaign)
// ══════════════════════════════════════════════════════════════════════════════

// ── Single-select region dropdown (one region per roundup, unlike the
// multi-select chip wrap used by the spotlight Auto Bot) ──────────────────────
const RR_RANDOM_REGION = "__random__";

function buildRegionSelect(countryCode, selectId = "rrRegion") {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const regions = REGIONS[countryCode] || [];
  const prev = sel.value;
  sel.innerHTML = "";

  const randomOpt = document.createElement("option");
  randomOpt.value = RR_RANDOM_REGION;
  randomOpt.textContent = "🎲 Random Region";
  sel.appendChild(randomOpt);

  regions.forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  // Preserve previous selection if it still exists for the new country
  if (prev === RR_RANDOM_REGION || regions.includes(prev)) sel.value = prev;
}
buildRegionSelect("BE");
document.getElementById("rrCountry")?.addEventListener("change", e => {
  buildRegionSelect(e.target.value);
});

// ── Region Roundup search waterfall (popup-side, for previews) ────────────────
async function searchAutoPlacesCollection(type, country, region, minRatings, minStars, size, ranking) {
  const typeQuery   = AB_TYPE_QUERY[type] || "restaurant";
  const countryName = AB_COUNTRY_NAMES[country] || "Belgium";
  const bounds      = AB_COUNTRY_BOUNDS[country] || AB_COUNTRY_BOUNDS.BE;
  const locationPart = region ? `${region}, ${countryName}` : `${pickRandomCity(country)}, ${countryName}`;
  const q = `${typeQuery} in ${locationPart}`;

  trackApiCall("search", q);
  AppLog.info("Region Roundup search", { type, country, region, query: q, minRatings, minStars, size, ranking });

  const body = {
    textQuery:           q,
    maxResultCount:      20,
    minRating:           minStars,
    locationRestriction: { rectangle: bounds },
  };

  const res = await fetch(PLACES_SEARCH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri,places.photos",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `API error ${res.status}`;
    if (/quota|billing|exceeded|disabled|SERVICE_DISABLED/i.test(msg))
      throw new Error(`⛔ Google API quota exceeded or billing issue — check your Google Cloud Console. (${msg})`);
    throw new Error(msg);
  }
  const data = await res.json();
  if (!data.places?.length)
    throw new Error(`No ${type}s found in "${locationPart}" (try relaxing filters)`);

  const filtered = data.places.filter(p => (p.userRatingCount || 0) >= minRatings);
  const pool = filtered.length >= size ? filtered : data.places;
  const sortFn = ranking === "reviews"
    ? (a,b) => (b.userRatingCount||0) - (a.userRatingCount||0) || (b.rating||0) - (a.rating||0)
    : (a,b) => (b.rating||0) - (a.rating||0) || (b.userRatingCount||0) - (a.userRatingCount||0);
  return [...pool].sort(sortFn).slice(0, size);
}

// ── Region Roundup caption generator (popup-side, mirrors background) ────────
const RR_TYPE_LABELS = {
  en: { restaurant: { s: "restaurant", p: "restaurants" }, hotel: { s: "hotel", p: "hotels" }, bar: { s: "bar", p: "bars" } },
  nl: { restaurant: { s: "restaurant", p: "restaurants" }, hotel: { s: "hotel", p: "hotels" }, bar: { s: "bar", p: "bars" } },
  fr: { restaurant: { s: "restaurant", p: "restaurants" }, hotel: { s: "hôtel", p: "hôtels" }, bar: { s: "bar", p: "bars" } },
  de: { restaurant: { s: "Restaurant", p: "Restaurants" }, hotel: { s: "Hotel", p: "Hotels" }, bar: { s: "Bar", p: "Bars" } },
};
const RR_HEADER_TEMPLATES = {
  en: (n, p, region) => `🔝 Top ${n} ${p} in ${region}`,
  nl: (n, p, region) => `🔝 Top ${n} ${p} in ${region}`,
  fr: (n, p, region) => `🔝 Top ${n} ${p} à ${region}`,
  de: (n, p, region) => `🔝 Top ${n} ${p} in ${region}`,
};
const RR_INTRO_TEMPLATES = {
  en: (region) => `Here's our pick of the best spots ${region} has to offer 👇`,
  nl: (region) => `Dit zijn de beste plekjes die ${region} te bieden heeft 👇`,
  fr: (region) => `Voici notre sélection des meilleures adresses à ${region} 👇`,
  de: (region) => `Das sind die besten Adressen, die ${region} zu bieten hat 👇`,
};

function getAutoCaptionRoundup(places, type, region, language, captionOpts, songInfo) {
  const lang   = RR_TYPE_LABELS[language] ? language : "en";
  const labels = RR_TYPE_LABELS[lang][type] || RR_TYPE_LABELS[lang].restaurant;
  const n      = places.length;
  const pLabel = n === 1 ? labels.s : labels.p;

  const header = RR_HEADER_TEMPLATES[lang](n, pLabel.charAt(0).toUpperCase() + pLabel.slice(1), region);
  const intro  = RR_INTRO_TEMPLATES[lang](region);

  const list = places.map((place, i) => {
    const name = place.displayName?.text || "";
    let line = `${i + 1}. ${name}`;
    const bits = [];
    if (captionOpts.showRatings && place.rating) bits.push(`⭐${place.rating.toFixed(1)}`);
    if (captionOpts.showReviewCount && place.userRatingCount) bits.push(`(${place.userRatingCount} reviews)`);
    if (bits.length) line += ` — ${bits.join(" ")}`;
    return line;
  });

  const parts = [header, "", intro, "", ...list];

  if (captionOpts.song && songInfo) {
    parts.push("");
    parts.push(`🎵 ${songInfo.name} – ${songInfo.artist}`);
  }

  if (captionOpts.hashtags) {
    const regionTag = region.replace(/[\s,]+/g, "");
    const typeTag   = labels.s.charAt(0).toUpperCase() + labels.s.slice(1);
    parts.push("");
    parts.push(`#${regionTag} #${typeTag}s #TopList #FoodFluencer`);
  }

  return parts.join("\n").trim();
}

// Preview Example Roundup Post — runs a real search and renders the result
async function previewExampleRoundupPost() {
  if (!API_KEY) { setStatus("Please save your API key first.", "error"); return; }

  const panel   = document.getElementById("rrPreview");
  const content = document.getElementById("rrPreviewContent");
  if (!panel || !content) return;

  const settings = getRegionRoundupSettings();
  const runId     = `roundup-demo-${Date.now()}`;
  const runStart  = Date.now();
  TechLog.info("POST", "run_start", { run_id: runId, run_type: "roundup_demo",
    type: settings.type, country: settings.country, region: settings.region, size: settings.size, ranking: settings.ranking });

  panel.classList.remove("hidden");
  content.innerHTML = `<div class="auto-preview-loading">🔍 Searching for top ${settings.size} ${settings.type}s in ${settings.region}…</div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    const t_search = Date.now();
    const [places, songInfo] = await Promise.all([
      searchAutoPlacesCollection(settings.type, settings.country, settings.region,
                                  settings.minRatings, settings.minStars, settings.size, settings.ranking),
      getAutoSong(settings.songGenre, settings.country).catch(e => {
        AppLog.warn("Song fetch failed", e.message);
        return null;
      }),
    ]);
    TechLog.info("SEARCH", "search_done", { run_id: runId, run_type: "roundup_demo",
      count: places.length, duration_ms: Date.now()-t_search });

    const caption   = getAutoCaptionRoundup(places, settings.type, settings.region, settings.language, settings.captionOpts, songInfo);
    const typeLabel = settings.type.charAt(0).toUpperCase() + settings.type.slice(1);
    const langLabels = { nl:"Dutch", en:"English", fr:"French", de:"German" };

    content.innerHTML = `
      <div class="auto-preview-meta">
        <span class="auto-preview-type-badge ${settings.type}">${typeLabel}</span>
        <span class="auto-preview-region">📍 ${escapeHtml(settings.region)}</span>
        <span class="auto-preview-lang">🌐 ${langLabels[settings.language] || settings.language}</span>
      </div>
      <div class="auto-preview-photos" id="rrPreviewPhotos"></div>
      ${songInfo ? `
        <div class="auto-preview-song">
          <img src="${escapeHtml(songInfo.artwork)}" alt="" />
          <div class="auto-preview-song-info">
            <span class="auto-preview-song-name">${escapeHtml(songInfo.name)}</span>
            <span class="auto-preview-song-artist">${escapeHtml(songInfo.artist)}</span>
          </div>
          <span class="auto-preview-genre-badge">${escapeHtml(songInfo.genre)}</span>
        </div>` : ""}
      ${caption ? `<div class="auto-preview-caption">${escapeHtml(caption).replace(/\n/g, "<br>")}</div>` : ""}
      <p class="auto-preview-note">${places.length} entities · ≥${escapeHtml(settings.minRatings)} ratings · ≥${escapeHtml(settings.minStars)}⭐</p>
    `;

    const photoGrid = document.getElementById("rrPreviewPhotos");
    if (photoGrid) {
      places.forEach((place, i) => {
        const div = document.createElement("div");
        div.className = "auto-preview-photo";
        div.innerHTML = `<div class="loading-thumb">…</div>`;
        photoGrid.appendChild(div);
        const photo = (place.photos || [])[0];
        const name  = place.displayName?.text || "";
        if (photo) {
          resolvePhotoUri(photo.name, 400).then(uri => {
            div.innerHTML = `<img src="${uri}" alt="${escapeHtml(name)}" />`;
          }).catch(() => { div.innerHTML = `<div class="loading-thumb">—</div>`; });
        } else {
          div.innerHTML = `<div class="loading-thumb">—</div>`;
        }
      });
    }

    TechLog.info("MEDIA", "photos_done", { run_id: runId, run_type: "roundup_demo",
      photo_source: "google_places_preview", photo_count: places.length });
    TechLog.info("POST", "run_complete", { run_id: runId, run_type: "roundup_demo",
      region: settings.region, status: "rendered", total_duration_ms: Date.now()-runStart });
    TechLog._flush();
    AppLog.info("Region Roundup preview rendered", { region: settings.region, count: places.length, lang: settings.language });
  } catch(err) {
    TechLog.error("POST", "run_failed", { run_id: runId, run_type: "roundup_demo",
      error: err.message, total_duration_ms: Date.now()-runStart });
    TechLog._flush();
    content.innerHTML = `<div class="auto-preview-error">⚠️ ${err.message}</div>`;
    AppLog.error("Region Roundup preview failed", err.message);
  }
}

// ── Region Roundup config persistence ─────────────────────────────────────────
function saveRegionRoundupConfig() {
  const config = {
    type:      document.querySelector("#rrType .ab-pill.active")?.dataset?.val || "restaurant",
    country:   document.getElementById("rrCountry")?.value || "BE",
    region:    document.getElementById("rrRegion")?.value  || "",
    size:      document.querySelector("#rrSize .ab-pill.active")?.dataset?.val || "5",
    ranking:   document.querySelector("#rrRanking .ab-pill.active")?.dataset?.val || "rating",
    minRatings: document.getElementById("rrMinRatings")?.value || "100",
    minStars:   document.querySelector("#rrMinStars .ab-pill.active")?.dataset?.val || "4",
    language:   document.getElementById("rrLanguage")?.value || "nl",
    capRatings:     document.getElementById("rrCapRatings")?.checked     ?? true,
    capReviewCount: document.getElementById("rrCapReviewCount")?.checked ?? false,
    capHashtags:    document.getElementById("rrCapHashtags")?.checked    ?? true,
    freqNum:     document.getElementById("rrFreqNum")?.value    || "1",
    freqPeriod:  document.getElementById("rrFreqPeriod")?.value || "week",
    freqRandom:  document.getElementById("rrFreqRand")?.classList.contains("is-active") || false,
    fromH:       document.getElementById("rrFromH")?.value  || "12",
    fromM:       document.getElementById("rrFromM")?.value  || "00",
    fromAP:      document.getElementById("rrFromAP")?.value || "PM",
    toH:         document.getElementById("rrToH")?.value    || "12",
    toM:         document.getElementById("rrToM")?.value    || "00",
    toAP:        document.getElementById("rrToAP")?.value   || "PM",
    windowRandom: document.getElementById("rrWindowRand")?.classList.contains("is-active") || false,
    socialIG:  document.getElementById("rrSocialIG")?.classList.contains("active") ?? true,
    socialFB:  document.getElementById("rrSocialFB")?.classList.contains("active") ?? true,
    socialTT:  document.getElementById("rrSocialTT")?.classList.contains("active") ?? false,
  };
  chrome.storage.local.set({ regionRoundupConfig: config });
}

const RR_CONFIG_DEFAULTS = {
  type: "restaurant", country: "BE", region: "Antwerp",
  size: "5", ranking: "rating", minRatings: "100", minStars: "4",
  language: "nl", songGenre: "top100",
  capRatings: true, capReviewCount: false, capHashtags: true, capSong: true,
  freqNum: "1", freqPeriod: "week", freqRandom: false,
  fromH: "12", fromM: "00", fromAP: "PM", toH: "12", toM: "00", toAP: "PM",
  windowRandom: false, socialIG: true, socialFB: true, socialTT: false,
};

function loadRegionRoundupConfig() {
  chrome.storage.local.get({ regionRoundupConfig: null }, ({ regionRoundupConfig: raw }) => {
    const cfg = { ...RR_CONFIG_DEFAULTS, ...(raw || {}) };

    const pill = (groupId, val) =>
      document.querySelectorAll(`#${groupId} .ab-pill`)
        .forEach(p => p.classList.toggle("active", p.dataset.val === val));
    const sel = (id, val) => { const e = document.getElementById(id); if (e && val != null) e.value = val; };

    pill("rrType", cfg.type);
    sel("rrCountry", cfg.country);
    buildRegionSelect(cfg.country);
    if (cfg.region) sel("rrRegion", cfg.region);

    pill("rrSize", cfg.size);
    pill("rrRanking", cfg.ranking);

    sel("rrMinRatings", cfg.minRatings);
    const sliderVal = document.getElementById("rrMinRatingsVal");
    if (sliderVal && cfg.minRatings) sliderVal.textContent = cfg.minRatings;

    pill("rrMinStars", cfg.minStars);
    sel("rrLanguage", cfg.language);

    const capMap = { rrCapRatings:"capRatings", rrCapReviewCount:"capReviewCount", rrCapHashtags:"capHashtags" };
    Object.entries(capMap).forEach(([id, key]) => {
      const e = document.getElementById(id);
      if (e && cfg[key] !== undefined) e.checked = cfg[key];
    });

    sel("rrFreqNum",    cfg.freqNum);
    sel("rrFreqPeriod", cfg.freqPeriod);
    if (cfg.freqRandom) {
      document.getElementById("rrFreqRand")?.classList.add("is-active");
      document.getElementById("rrFreqRow")?.classList.add("is-random");
      document.getElementById("rrFreqRandHint")?.classList.remove("hidden");
    }

    sel("rrFromH",  cfg.fromH);  sel("rrFromM",  cfg.fromM);  sel("rrFromAP", cfg.fromAP);
    sel("rrToH",    cfg.toH);    sel("rrToM",    cfg.toM);    sel("rrToAP",   cfg.toAP);
    if (cfg.windowRandom) {
      document.getElementById("rrWindowRand")?.classList.add("is-active");
      document.getElementById("rrWindowRow")?.classList.add("is-random");
      document.getElementById("rrWindowRandHint")?.classList.remove("hidden");
    }

    if (cfg.socialIG !== undefined) document.getElementById("rrSocialIG")?.classList.toggle("active", cfg.socialIG);
    if (cfg.socialFB !== undefined) document.getElementById("rrSocialFB")?.classList.toggle("active", cfg.socialFB);
    if (cfg.socialTT !== undefined) document.getElementById("rrSocialTT")?.classList.toggle("active", cfg.socialTT);

    updateRoundupConfigSummary();
  });
}

// Debounced save — fires 600ms after last change
let _rrSaveTimer = null;
function regionRoundupChanged() {
  clearTimeout(_rrSaveTimer);
  _rrSaveTimer = setTimeout(() => { saveRegionRoundupConfig(); updateRoundupConfigSummary(); }, 600);
}

function initRegionRoundupPersistence() {
  const ids = ["rrCountry","rrRegion","rrLanguage","rrMinRatings","rrFreqNum","rrFreqPeriod",
               "rrFromH","rrFromM","rrFromAP","rrToH","rrToM","rrToAP",
               "rrCapRatings","rrCapReviewCount","rrCapHashtags"];
  ids.forEach(id => {
    document.getElementById(id)?.addEventListener("change", regionRoundupChanged);
    document.getElementById(id)?.addEventListener("input",  regionRoundupChanged);
  });
  ["rrType","rrMinStars","rrSize","rrRanking"].forEach(id =>
    document.getElementById(id)?.addEventListener("click", regionRoundupChanged));
  ["rrSocialIG","rrSocialFB","rrSocialTT","rrFreqRand","rrWindowRand"]
    .forEach(id => document.getElementById(id)?.addEventListener("click", regionRoundupChanged));
}
initRegionRoundupPersistence();

// Read current Region Roundup form values
function getRegionRoundupSettings() {
  const country = document.getElementById("rrCountry")?.value || "BE";
  const type    = document.querySelector("#rrType .ab-pill.active")?.dataset?.val || "restaurant";
  let region    = document.getElementById("rrRegion")?.value || "";
  if (region === RR_RANDOM_REGION) {
    const regions = REGIONS[country] || [];
    region = regions.length ? regions[Math.floor(Math.random() * regions.length)] : "";
  }

  const minRatings = parseInt(document.getElementById("rrMinRatings")?.value || "100", 10);
  const minStars   = parseFloat(document.querySelector("#rrMinStars .ab-pill.active")?.dataset?.val || "4");
  const size       = parseInt(document.querySelector("#rrSize .ab-pill.active")?.dataset?.val || "5", 10);
  const ranking    = document.querySelector("#rrRanking .ab-pill.active")?.dataset?.val || "rating";
  const language   = document.getElementById("rrLanguage")?.value || "nl";
  const songGenre  = document.getElementById("rrSongGenre")?.value || "top100";

  const captionOpts = {
    showRatings:     document.getElementById("rrCapRatings")?.checked     ?? true,
    showReviewCount: document.getElementById("rrCapReviewCount")?.checked ?? true,
    hashtags:        document.getElementById("rrCapHashtags")?.checked    ?? false,
    song:            true,
  };

  const sched = getRoundupScheduleSettings();

  return {
    country, type, region, minRatings, minStars, size, ranking,
    language, songGenre, captionOpts,
    frequency: sched.frequency,
    window:    sched.window,
  };
}

// Helper: get frequency + window settings from current roundup form state
function getRoundupScheduleSettings() {
  return {
    frequency: {
      count:    parseInt(document.getElementById("rrFreqNum")?.value    || "1",    10),
      period:   document.getElementById("rrFreqPeriod")?.value          || "week",
      isRandom: document.getElementById("rrFreqRand")?.classList.contains("is-active") || false,
    },
    window: {
      fromH:    document.getElementById("rrFromH")?.value  || "12",
      fromM:    document.getElementById("rrFromM")?.value  || "00",
      fromAP:   document.getElementById("rrFromAP")?.value || "PM",
      toH:      document.getElementById("rrToH")?.value    || "12",
      toM:      document.getElementById("rrToM")?.value    || "00",
      toAP:     document.getElementById("rrToAP")?.value   || "PM",
      isRandom: document.getElementById("rrWindowRand")?.classList.contains("is-active") || false,
    },
  };
}

// Generate the Region Roundup posting schedule — independent from the spotlight
// Auto Bot schedule (own storage key, own platform list, own date/time slots).
function generateRoundupSchedule(settings) {
  const { frequency: freq, window: win } = settings;
  const platforms = [];
  if (document.getElementById("rrSocialIG")?.classList.contains("active")) platforms.push("instagram");
  if (document.getElementById("rrSocialFB")?.classList.contains("active")) platforms.push("facebook");
  if (document.getElementById("rrSocialTT")?.classList.contains("active")) platforms.push("tiktok");

  if (platforms.length === 0) {
    AppLog.warn("Region Roundup schedule: no platforms selected — schedule not generated");
    return { generatedAt: new Date().toISOString(), period: freq.period, totalPosts: 0, platforms: [], posts: [] };
  }

  const winBounds = abGetWindowMinutes(win);

  let totalPosts;
  if (freq.isRandom) {
    const maxMap = { day: 2, week: 20, month: 40 };
    const maxForPeriod = maxMap[freq.period] || 20;
    totalPosts = Math.floor(Math.random() * maxForPeriod) + 1;
  } else {
    totalPosts = Math.max(1, freq.count);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const posts = [];

  if (freq.period === "day") {
    for (let d = 0; d < 7; d++) {
      const date = new Date(today); date.setDate(today.getDate() + d);
      const times = abRandomTimesInWindow(totalPosts, winBounds.start, winBounds.end);
      times.forEach(time => posts.push({
        date: abFormatDate(date), time, platforms,
        dayOfWeek: date.toLocaleDateString("en-US", { weekday: "short" }),
      }));
    }
  } else if (freq.period === "week") {
    const perDay = abDistributePostsAcrossDays(totalPosts, 7, 2);
    for (let d = 0; d < 7; d++) {
      if (perDay[d] === 0) continue;
      const date = new Date(today); date.setDate(today.getDate() + d);
      const times = abRandomTimesInWindow(perDay[d], winBounds.start, winBounds.end);
      times.forEach(time => posts.push({
        date: abFormatDate(date), time, platforms,
        dayOfWeek: date.toLocaleDateString("en-US", { weekday: "short" }),
      }));
    }
  } else if (freq.period === "month") {
    const perDay = abDistributePostsAcrossDays(totalPosts, 30, 2);
    for (let d = 0; d < 30; d++) {
      if (perDay[d] === 0) continue;
      const date = new Date(today); date.setDate(today.getDate() + d);
      const times = abRandomTimesInWindow(perDay[d], winBounds.start, winBounds.end);
      times.forEach(time => posts.push({
        date: abFormatDate(date), time, platforms,
        dayOfWeek: date.toLocaleDateString("en-US", { weekday: "short" }),
      }));
    }
  }

  const now = new Date();
  posts.sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  const futurePosts = posts.filter(p => new Date(`${p.date}T${p.time}:00`) > now);

  if (futurePosts.length === 0 && posts.length > 0) {
    const schedBtn = document.getElementById("rrScheduleBtn");
    if (schedBtn) {
      const origText = schedBtn.textContent;
      schedBtn.textContent = "⚠️ All times already past — schedule a future window";
      setTimeout(() => { schedBtn.textContent = origText; }, 6000);
    }
    AppLog.warn("Region Roundup schedule: all generated posts were in the past — no alarms will fire");
  }

  const result = {
    generatedAt: new Date().toISOString(),
    period: freq.period,
    frequencyIsRandom: freq.isRandom,
    windowIsRandom: win.isRandom,
    totalPosts: futurePosts.length,
    platforms,
    posts: futurePosts,
  };

  chrome.storage.local.set({ autoBotRoundupSchedule: result });
  AppLog.info("Region Roundup schedule generated", {
    totalPosts: futurePosts.length, period: freq.period,
    platforms, windowRandom: win.isRandom,
  });

  return result;
}

// ── Chrome Alarms (own namespace — ffbot-roundup-*) ───────────────────────────
function setupRoundupScheduleAlarms(schedule) {
  clearAlarmsByPrefix("ffbot-roundup-").then(() => {
    const now = Date.now();
    schedule.posts.forEach((post, idx) => {
      const base = new Date(`${post.date}T${post.time}:00`).getTime();
      const when = base + Math.floor(Math.random() * 15 * 60 * 1000);
      if (when > now) chrome.alarms.create(`ffbot-roundup-${idx}`, { when });
    });
    AppLog.info(`Set ${schedule.posts.length} roundup alarms`);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// REGION ROUNDUP ACTIVATION LOGIC
// ══════════════════════════════════════════════════════════════════════════════

let regionRoundupActive = false;

// ── Collapsible config toggle ─────────────────────────────────────────────────
document.getElementById("rrConfigToggle")?.addEventListener("click", () => {
  const body  = document.getElementById("rrConfigBody");
  const arrow = document.getElementById("rrConfigArrow");
  if (!body) return;
  const collapsed = body.classList.toggle("collapsed");
  arrow?.classList.toggle("collapsed", collapsed);
});

// ── Collapsible scheduled posts toggle ───────────────────────────────────────
document.getElementById("rrSchedToggle")?.addEventListener("click", () => {
  const body  = document.getElementById("rrSchedBody");
  const arrow = document.getElementById("rrSchedArrow");
  if (!body) return;
  const collapsed = body.classList.toggle("collapsed");
  arrow?.classList.toggle("collapsed", collapsed);
});

// ── Activate / Deactivate ─────────────────────────────────────────────────────
document.getElementById("rrScheduleBtn")?.addEventListener("click", () => {
  if (regionRoundupActive) deactivateRoundup();
  else                      activateRoundup();
});

function activateRoundup() {
  if (!API_KEY) { alert("Please save your Google API key before activating Region Roundup."); return; }
  if (!document.getElementById("rrRegion")?.value) { alert("Please select a region for Region Roundup."); return; }
  const platforms = [];
  if (document.getElementById("rrSocialIG")?.classList.contains("active")) platforms.push("instagram");
  if (document.getElementById("rrSocialFB")?.classList.contains("active")) platforms.push("facebook");
  if (document.getElementById("rrSocialTT")?.classList.contains("active")) platforms.push("tiktok");
  if (!platforms.length) { alert("Please select at least one social media platform."); return; }

  const cfgBody  = document.getElementById("rrConfigBody");
  const cfgArrow = document.getElementById("rrConfigArrow");
  cfgBody?.classList.add("collapsed");
  cfgArrow?.classList.add("collapsed");

  const settings = getRegionRoundupSettings();
  const schedule = generateRoundupSchedule(settings);

  regionRoundupActive = true;
  chrome.storage.local.set({ regionRoundupActive: true, autoBotRoundupSchedule: schedule, regionRoundupRunLog: [] });
  setupRoundupScheduleAlarms(schedule);

  updateRoundupUI(true);
  renderScheduledRoundupPosts(schedule);
  updateRoundupProgress(0, schedule.totalPosts);
  updateNextRoundupPostLabel(schedule);
  updateRoundupConfigSummary();

  AppLog.info("Region Roundup activated", { totalPosts: schedule.totalPosts, platforms, region: settings.region });
  TechLog.info("SCHEDULE", "roundup_activated", { totalPosts: schedule.totalPosts, platforms, region: settings.region, period: settings.frequency?.period });
}

function deactivateRoundup() {
  regionRoundupActive = false;
  chrome.storage.local.get({ autoBotRoundupSchedule: null }, ({ autoBotRoundupSchedule: prev }) => {
    const updates = { regionRoundupActive: false, autoBotRoundupSchedule: null, regionRoundupRunLog: [] };
    if (prev) updates.regionRoundupLastSchedule = prev;
    chrome.storage.local.set(updates);
  });
  chrome.storage.local.remove("regionRoundupPaused");
  hideRoundupPausedBanner();
  clearAlarmsByPrefix("ffbot-roundup-");
  updateRoundupUI(false);
  updateRoundupProgress(0, 0);
  const schedBody  = document.getElementById("rrSchedBody");
  const schedBadge = document.getElementById("rrSchedCount");
  const schedTitle = document.querySelector("#rrScheduledSection .ab-collapse-hdr-title");
  if (schedBody)  schedBody.innerHTML = "";
  if (schedBadge) schedBadge.textContent = "0";
  if (schedTitle) schedTitle.textContent = "📅 Scheduled Posts";
  AppLog.info("Region Roundup deactivated — schedule cleared");
  TechLog.info("SCHEDULE", "roundup_deactivated", { scheduleCleared: true });
}

function updateRoundupUI(active) {
  const btn      = document.getElementById("rrScheduleBtn");
  const body     = document.getElementById("rrConfigBody");
  const arrow    = document.getElementById("rrConfigArrow");
  const status   = document.getElementById("rrBotStatus");
  const progress = document.getElementById("rrProgressWrap");
  const schedSec = document.getElementById("rrScheduledSection");

  if (active) {
    if (btn) { btn.textContent = "⏹ Deactivate Region Roundup"; btn.classList.add("is-active"); }
    body?.classList.add("collapsed");
    arrow?.classList.add("collapsed");
    status?.classList.remove("hidden");
    progress?.classList.remove("hidden");
    schedSec?.classList.remove("hidden");
  } else {
    if (btn) { btn.textContent = "⏰ Schedule Region Roundup"; btn.classList.remove("is-active"); }
    body?.classList.remove("collapsed");
    arrow?.classList.remove("collapsed");
    status?.classList.add("hidden");
    progress?.classList.add("hidden");
    schedSec?.classList.add("hidden");
  }
  updateScheduleGroupSummary("rr", active);
  syncActiveBotsWrap();
}

// ── Render scheduled roundup posts list ───────────────────────────────────────
function renderScheduledRoundupPosts(schedule, runLog = []) {
  const body  = document.getElementById("rrSchedBody");
  const badge = document.getElementById("rrSchedCount");
  const title = document.querySelector("#rrScheduledSection .ab-collapse-hdr-title");
  if (!body) return;

  const postCount = schedule?.posts?.length || 0;
  if (badge) badge.textContent = postCount;

  if (title && schedule?.generatedAt) {
    const genTime = new Date(schedule.generatedAt).toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit" });
    const genDate = new Date(schedule.generatedAt).toLocaleDateString("en-GB", { day:"numeric", month:"short" });
    title.textContent = `📅 Scheduled Posts — generated ${genDate} at ${genTime}`;
  }

  body.innerHTML = "";

  if (!postCount) {
    body.innerHTML = `<div style="padding:12px;text-align:center;font-size:.75rem;color:var(--muted)">No upcoming posts scheduled</div>`;
    return;
  }

  const grouped = {};
  schedule.posts.forEach((post, idx) => {
    if (!grouped[post.date]) grouped[post.date] = [];
    grouped[post.date].push({ ...post, idx });
  });

  Object.entries(grouped).sort(([a],[b]) => a.localeCompare(b)).forEach(([date, posts]) => {
    const dayEl  = document.createElement("div");
    dayEl.className = "ab-sched-day-group";
    const dayObj = new Date(`${date}T00:00:00`);
    const dayLbl = dayObj.toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"short" });
    dayEl.innerHTML = `<div class="ab-sched-day-label">${dayLbl}</div>`;

    posts.forEach(post => {
      const plat = post.platforms.map(p => ({ instagram:"📸 IG", facebook:"👥 FB", tiktok:"🎵 TT" }[p] || p)).join("  ");

      const logStatus = runLog.find(e => e.postIndex === post.idx)?.status;
      const status    = SCHED_STATUS_LABELS[logStatus] ? logStatus : "pending";

      const item = document.createElement("div");
      item.className = "ab-sched-item";
      item.id = `rrSchedItem-${post.idx}`;
      item.innerHTML = `
        <span class="ab-sched-time">${escapeHtml(post.time)}</span>
        <span class="ab-sched-platforms">${escapeHtml(plat)}</span>
        <span class="ab-sched-status ${status}" id="rrSchedStatus-${post.idx}">
          ${SCHED_STATUS_LABELS[status]}
        </span>`;
      dayEl.appendChild(item);
    });
    body.appendChild(dayEl);
  });
}

function updateScheduledRoundupItemStatus(idx, status) {
  const el = document.getElementById(`rrSchedStatus-${idx}`);
  if (!el) return;
  el.textContent = SCHED_STATUS_LABELS[status] || status;
  el.className   = `ab-sched-status ${status}`;
}

// ── Progress ──────────────────────────────────────────────────────────────────
function updateRoundupProgress(done, total) {
  const fill  = document.getElementById("rrProgressFill");
  const label = document.getElementById("rrProgressLabel");
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  if (fill)  fill.style.width = `${pct}%`;
  if (label) label.textContent = `${done} of ${total} posts published`;
  const txt = document.getElementById("rrBotProgressText");
  if (txt)   txt.textContent = `${done} / ${total} posts`;
}

function updateNextRoundupPostLabel(schedule) {
  const el = document.getElementById("rrBotNextPost");
  if (!el) return;
  const now  = new Date();
  const next = schedule.posts.find(p => new Date(`${p.date}T${p.time}:00`) > now);
  if (next) {
    const d = new Date(`${next.date}T${next.time}:00`);
    el.textContent = `Next: ${d.toLocaleDateString("en-GB", { weekday:"short", day:"numeric", month:"short" })} at ${next.time}`;
  } else {
    el.textContent = "All posts complete";
  }
}

// ── Config summary (shown when config is collapsed) ───────────────────────────
function updateRoundupConfigSummary() {
  const el = document.getElementById("rrConfigSummary");
  if (!el) return;
  const type    = document.querySelector("#rrType .ab-pill.active")?.dataset?.val || "restaurant";
  const size    = document.querySelector("#rrSize .ab-pill.active")?.dataset?.val || "5";
  const cc      = document.getElementById("rrCountry")?.value || "BE";
  const country = AB_COUNTRY_NAMES[cc] || cc;
  const regionVal = document.getElementById("rrRegion")?.value || "—";
  const region  = regionVal === RR_RANDOM_REGION ? "🎲 Random region" : regionVal;
  el.textContent = `Top ${size} ${type}s · ${region}, ${country}`;
}

// ── Paused banner ──────────────────────────────────────────────────────────────
function showRoundupPausedBanner(reason) {
  const banner   = document.getElementById("rrPausedBanner");
  const reasonEl = document.getElementById("rrPausedReason");
  if (reasonEl) reasonEl.textContent = reason || "Region Roundup needs your attention.";
  banner?.classList.remove("hidden");
  syncActiveBotsWrap();
}
function hideRoundupPausedBanner() {
  document.getElementById("rrPausedBanner")?.classList.add("hidden");
  syncActiveBotsWrap();
}
document.getElementById("rrPausedResumeBtn")?.addEventListener("click", () => {
  chrome.storage.local.remove("regionRoundupPaused", () => {
    hideRoundupPausedBanner();
    chrome.storage.local.get({ autoBotRoundupSchedule: null }, ({ autoBotRoundupSchedule }) => {
      if (!autoBotRoundupSchedule) return;
      setupRoundupScheduleAlarms(autoBotRoundupSchedule);
      AppLog.info("Region Roundup resumed by user");
      TechLog.info("SCHEDULE", "roundup_resumed", {});
    });
  });
});

// Listen for status messages from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ROUNDUP_PAUSED") {
    showRoundupPausedBanner(msg.reason);
  }
  if (msg.type === "ROUNDUP_TRIGGERED") {
    updateScheduledRoundupItemStatus(msg.logEntry.postIndex, "triggered");
    chrome.storage.local.get({ regionRoundupRunLog:[], autoBotRoundupSchedule:null }, ({ regionRoundupRunLog, autoBotRoundupSchedule }) => {
      const done = regionRoundupRunLog.filter(e => e.status === "done").length;
      updateRoundupProgress(done, autoBotRoundupSchedule?.totalPosts || 0);
    });
  }
  if (msg.type === "ROUNDUP_STATUS_UPDATE") {
    updateScheduledRoundupItemStatus(msg.postIndex, msg.status);
    chrome.storage.local.get({ regionRoundupRunLog:[], autoBotRoundupSchedule:null }, ({ regionRoundupRunLog, autoBotRoundupSchedule }) => {
      refreshActivityLog(); // roundup posts also feed the shared activity log
      const done = regionRoundupRunLog.filter(e => e.status === "done").length;
      updateRoundupProgress(done, autoBotRoundupSchedule?.totalPosts || 0);
      if (autoBotRoundupSchedule) updateNextRoundupPostLabel(autoBotRoundupSchedule);
    });
  }
});

// Restore active state whenever Auto Bot mode is opened
function restoreRoundupActiveState() {
  chrome.storage.local.get({ regionRoundupActive:false, autoBotRoundupSchedule:null, regionRoundupRunLog:[], regionRoundupPaused:null },
    ({ regionRoundupActive: wasActive, autoBotRoundupSchedule: schedule, regionRoundupRunLog: runLog, regionRoundupPaused }) => {
      regionRoundupActive = wasActive;
      if (wasActive && schedule) {
        updateRoundupUI(true);
        renderScheduledRoundupPosts(schedule, runLog);
        const done = runLog.filter(e => e.status === "done").length;
        updateRoundupProgress(done, schedule.totalPosts);
        updateNextRoundupPostLabel(schedule);
        updateRoundupConfigSummary();
      } else {
        updateRoundupUI(false);
      }
      if (regionRoundupPaused) showRoundupPausedBanner(regionRoundupPaused.reason);
      else hideRoundupPausedBanner();
    }
  );
}

// ── Pill groups (Type / Min stars / Size / Ranking) ───────────────────────────
["rrType", "rrMinStars", "rrSize", "rrRanking"].forEach(groupId => {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.addEventListener("click", e => {
    const pill = e.target.closest(".ab-pill");
    if (!pill) return;
    group.querySelectorAll(".ab-pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
  });
});

// ── Social media toggles ───────────────────────────────────────────────────────
["rrSocialIG", "rrSocialFB", "rrSocialTT"].forEach(id => {
  document.getElementById(id)?.addEventListener("click", function() {
    this.classList.toggle("active");
  });
});

// ── Schedule: populate hour selects ───────────────────────────────────────────
buildHourSelect("rrFromH", 12);
buildHourSelect("rrToH",   12);

// ── Random button toggles (greys out the field row) ───────────────────────────
[
  { btnId: "rrFreqRand",   rowId: "rrFreqRow",   hintId: "rrFreqRandHint"   },
  { btnId: "rrWindowRand", rowId: "rrWindowRow", hintId: "rrWindowRandHint" },
].forEach(({ btnId, rowId, hintId }) => {
  const btn  = document.getElementById(btnId);
  const row  = document.getElementById(rowId);
  const hint = document.getElementById(hintId);
  if (!btn || !row) return;
  btn.addEventListener("click", () => {
    const active = btn.classList.toggle("is-active");
    row.classList.toggle("is-random", active);
    btn.textContent = active ? "🎲 Random ✓" : "🎲 Random";
    if (hint) hint.classList.toggle("hidden", !active);
  });
});

// ── Preview Example Roundup Post button ───────────────────────────────────────
document.getElementById("rrPreviewBtn")?.addEventListener("click", previewExampleRoundupPost);
document.getElementById("rrPreviewClose")?.addEventListener("click", () => {
  document.getElementById("rrPreview")?.classList.add("hidden");
});

// ── Ratings slider live value ─────────────────────────────────────────────────
const rrSlider = document.getElementById("rrMinRatings");
const rrSliderVal = document.getElementById("rrMinRatingsVal");
if (rrSlider && rrSliderVal) {
  rrSlider.addEventListener("input", () => {
    rrSliderVal.textContent = Number(rrSlider.value).toLocaleString();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// MANUAL POST — REGION ROUNDUP (one-off "Top N" generate & post)
// ══════════════════════════════════════════════════════════════════════════════

let currentRoundup = null; // { places, photoDataUrls, caption, type, region, size }

buildRegionSelect("BE", "mrRegion");
document.getElementById("mrCountry")?.addEventListener("change", e => {
  buildRegionSelect(e.target.value, "mrRegion");
});

// ── Collapsible config toggle ─────────────────────────────────────────────────
document.getElementById("mrConfigToggle")?.addEventListener("click", () => {
  const body  = document.getElementById("mrConfigBody");
  const arrow = document.getElementById("mrConfigArrow");
  if (!body) return;
  const collapsed = body.classList.toggle("collapsed");
  arrow?.classList.toggle("collapsed", collapsed);
});

// ── Pill groups (Type / Min stars / Size / Ranking) ───────────────────────────
["mrType", "mrMinStars", "mrSize", "mrRanking"].forEach(groupId => {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.addEventListener("click", e => {
    const pill = e.target.closest(".ab-pill");
    if (!pill) return;
    group.querySelectorAll(".ab-pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
  });
});

// ── Social media toggles ───────────────────────────────────────────────────────
["mrSocialIG", "mrSocialFB", "mrSocialTT"].forEach(id => {
  document.getElementById(id)?.addEventListener("click", function() {
    this.classList.toggle("active");
  });
});

// ── Ratings slider live value ─────────────────────────────────────────────────
const mrSlider    = document.getElementById("mrMinRatings");
const mrSliderVal = document.getElementById("mrMinRatingsVal");
if (mrSlider && mrSliderVal) {
  mrSlider.addEventListener("input", () => {
    mrSliderVal.textContent = Number(mrSlider.value).toLocaleString();
  });
}

// ── Read current Manual Roundup form values ───────────────────────────────────
function getManualRoundupSettings() {
  const country = document.getElementById("mrCountry")?.value || "BE";
  let region    = document.getElementById("mrRegion")?.value || "";
  if (region === RR_RANDOM_REGION) {
    const regions = REGIONS[country] || [];
    region = regions.length ? regions[Math.floor(Math.random() * regions.length)] : "";
  }

  return {
    type:     document.querySelector("#mrType .ab-pill.active")?.dataset?.val || "restaurant",
    country,
    region,
    size:     parseInt(document.querySelector("#mrSize .ab-pill.active")?.dataset?.val || "5", 10),
    ranking:  document.querySelector("#mrRanking .ab-pill.active")?.dataset?.val || "rating",
    minRatings: parseInt(document.getElementById("mrMinRatings")?.value || "100", 10),
    minStars:   parseFloat(document.querySelector("#mrMinStars .ab-pill.active")?.dataset?.val || "4"),
    language:   document.getElementById("mrLanguage")?.value || "nl",
    captionOpts: {
      showRatings:     document.getElementById("mrCapRatings")?.checked     ?? true,
      showReviewCount: document.getElementById("mrCapReviewCount")?.checked ?? true,
      hashtags:        document.getElementById("mrCapHashtags")?.checked    ?? false,
      song: false,
    },
  };
}

// ── Generate Top N List ────────────────────────────────────────────────────────
document.getElementById("mrGenerateBtn")?.addEventListener("click", generateManualRoundup);

async function generateManualRoundup() {
  if (!API_KEY) { setStatus("Please save your API key first.", "error"); return; }

  const settings = getManualRoundupSettings();
  if (!settings.region) { setStatus("Please select a region for the roundup.", "error"); return; }

  const panel   = document.getElementById("mrPreview");
  const content = document.getElementById("mrPreviewContent");
  if (!panel || !content) return;

  const genBtn = document.getElementById("mrGenerateBtn");
  if (genBtn) genBtn.disabled = true;

  panel.classList.remove("hidden");
  content.innerHTML = `<div class="auto-preview-loading">🔍 Searching for top ${settings.size} ${settings.type}s in ${settings.region}…</div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const runId    = `manual-roundup-${Date.now()}`;
  const runStart = Date.now();
  TechLog.info("POST", "run_start", { run_id: runId, run_type: "manual_roundup",
    type: settings.type, country: settings.country, region: settings.region, size: settings.size, ranking: settings.ranking });

  try {
    const t_search = Date.now();
    const places = await searchAutoPlacesCollection(settings.type, settings.country, settings.region,
      settings.minRatings, settings.minStars, settings.size, settings.ranking);
    TechLog.info("SEARCH", "search_done", { run_id: runId, run_type: "manual_roundup",
      count: places.length, duration_ms: Date.now()-t_search });

    setStatus(`Preparing ${places.length} cover photos…`);
    const photoDataUrls = [];
    for (const place of places) {
      const photo = (place.photos || [])[0];
      if (!photo) continue;
      try {
        const uri = await resolvePhotoUri(photo.name, 1440);
        photoDataUrls.push(await photoToDataUrl(uri));
      } catch (e) {
        AppLog.error("Roundup photo fetch failed", { place: place.displayName?.text, error: String(e) });
      }
    }

    const caption  = getAutoCaptionRoundup(places, settings.type, settings.region, settings.language, settings.captionOpts, null);
    const typeLabel  = settings.type.charAt(0).toUpperCase() + settings.type.slice(1);
    const langLabels = { nl:"Dutch", en:"English", fr:"French", de:"German" };

    currentRoundup = { places, photoDataUrls, caption, type: settings.type, region: settings.region };

    content.innerHTML = `
      <div class="auto-preview-meta">
        <span class="auto-preview-type-badge ${settings.type}">${typeLabel}</span>
        <span class="auto-preview-region">📍 ${escapeHtml(settings.region)}</span>
        <span class="auto-preview-lang">🌐 ${langLabels[settings.language] || settings.language}</span>
      </div>
      <div class="auto-preview-photos" id="mrPreviewPhotos"></div>
      ${caption ? `<div class="auto-preview-caption">${escapeHtml(caption).replace(/\n/g, "<br>")}</div>` : ""}
      <p class="auto-preview-note">${places.length} entities · ≥${escapeHtml(settings.minRatings)} ratings · ≥${escapeHtml(settings.minStars)}⭐</p>
    `;

    const photoGrid = document.getElementById("mrPreviewPhotos");
    if (photoGrid) {
      photoDataUrls.forEach((dataUrl, i) => {
        const div = document.createElement("div");
        div.className = "auto-preview-photo";
        div.innerHTML = `<img src="${dataUrl}" alt="${escapeHtml(places[i]?.displayName?.text || "")}" />`;
        photoGrid.appendChild(div);
      });
    }

    TechLog.info("MEDIA", "photos_done", { run_id: runId, run_type: "manual_roundup",
      photo_source: "google_places_manual", photo_count: photoDataUrls.length });
    TechLog.info("POST", "run_complete", { run_id: runId, run_type: "manual_roundup",
      region: settings.region, status: "rendered", total_duration_ms: Date.now()-runStart });
    TechLog._flush();
    AppLog.info("Manual Region Roundup generated", { region: settings.region, count: places.length });
    setStatus("✅ Roundup ready — choose platforms and post!", "success");
  } catch (err) {
    TechLog.error("POST", "run_failed", { run_id: runId, run_type: "manual_roundup",
      error: err.message, total_duration_ms: Date.now()-runStart });
    TechLog._flush();
    content.innerHTML = `<div class="auto-preview-error">⚠️ ${err.message}</div>`;
    AppLog.error("Manual Region Roundup failed", err.message);
    currentRoundup = null;
  } finally {
    if (genBtn) genBtn.disabled = false;
  }
}

document.getElementById("mrPreviewClose")?.addEventListener("click", () => {
  document.getElementById("mrPreview")?.classList.add("hidden");
  currentRoundup = null;
});

// ── Post Roundup Now ───────────────────────────────────────────────────────────
document.getElementById("mrPostBtn")?.addEventListener("click", postManualRoundup);

async function postManualRoundup() {
  if (!currentRoundup || !currentRoundup.photoDataUrls.length) {
    setStatus("⚠️ Generate a roundup first.", "error");
    return;
  }

  const platforms = [];
  if (document.getElementById("mrSocialIG")?.classList.contains("active")) platforms.push("instagram");
  if (document.getElementById("mrSocialFB")?.classList.contains("active")) platforms.push("facebook");
  if (document.getElementById("mrSocialTT")?.classList.contains("active")) platforms.push("tiktok");

  if (!platforms.length) {
    setStatus("⚠️ Select at least one social media platform to post.", "error");
    return;
  }

  const { photoDataUrls, caption, type, region, places } = currentRoundup;
  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
  const header    = `Top ${places.length} ${typeLabel}s in ${region}`;

  const runId    = `manual-roundup-post-${Date.now()}`;
  const runStart = Date.now();
  TechLog.info("POST", "run_start", { run_id: runId, run_type: "manual_roundup_post",
    region, type, platforms, photo_count: photoDataUrls.length });

  const postBtn = document.getElementById("mrPostBtn");
  if (postBtn) postBtn.disabled = true;

  for (const platform of platforms) {
    const t_plat = Date.now();
    TechLog.info("POST", "platform_start", { run_id: runId, run_type: "manual_roundup_post", platform });
    setStatus(`Opening ${platform}…`);
    chrome.runtime.sendMessage({
      type: "OPEN_SOCIAL", platform, photoDataUrls, caption, songName: "",
      location: region, restaurantName: header, tiktokAudioDataUrl: null,
    });
    await new Promise(r => setTimeout(r, 900));
    TechLog.info("POST", "platform_opened", { run_id: runId, run_type: "manual_roundup_post",
      platform, duration_ms: Date.now()-t_plat });
  }

  TechLog.info("POST", "run_complete", { run_id: runId, run_type: "manual_roundup_post",
    region, type, platforms, photo_count: photoDataUrls.length, total_duration_ms: Date.now()-runStart });
  TechLog._flush();
  AppLog.info("Manual Region Roundup posted", { region, type, platforms, photo_count: photoDataUrls.length });
  setStatus(`✅ Opening ${platforms.join(", ")} — ${photoDataUrls.length} photos & caption ready!`, "success");

  if (postBtn) postBtn.disabled = false;
}

// ── Export Roundup (photos + caption to Downloads) ────────────────────────────
document.getElementById("mrExportBtn")?.addEventListener("click", exportManualRoundup);

async function exportManualRoundup() {
  if (!currentRoundup || !currentRoundup.photoDataUrls.length) {
    setStatus("⚠️ Generate a roundup first.", "error");
    return;
  }

  const { photoDataUrls, caption, type, region, places } = currentRoundup;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = `${type}-roundup-${region}`.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "roundup";
  const folder = `FoodFluencer/${slug}_${timestamp}`;

  const runId    = `manual-roundup-export-${Date.now()}`;
  const runStart = Date.now();
  TechLog.info("EXPORT", "run_start", { run_id: runId, run_type: "manual_roundup_export",
    region, type, photo_count: photoDataUrls.length });

  const exportBtn = document.getElementById("mrExportBtn");
  const postBtn   = document.getElementById("mrPostBtn");
  if (exportBtn) exportBtn.disabled = true;
  if (postBtn)   postBtn.disabled   = true;

  let saved = 0;
  for (let i = 0; i < photoDataUrls.length; i++) {
    setStatus(`Exporting photo ${i + 1}/${photoDataUrls.length}…`);
    try {
      await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type:     "DOWNLOAD",
          url:      photoDataUrls[i],
          filename: `${folder}/photo_${i + 1}.jpg`,
        }, resolve);
      });
      saved++;
    } catch (e) {
      AppLog.error("Roundup photo export failed", { index: i, error: String(e) });
    }
  }

  if (caption) {
    await new Promise(resolve => {
      chrome.runtime.sendMessage({
        type:     "DOWNLOAD",
        url:      `data:text/plain;charset=utf-8,${encodeURIComponent(caption)}`,
        filename: `${folder}/caption.txt`,
      }, resolve);
    });
  }

  chrome.storage.local.get({ exportLog: [] }, ({ exportLog }) => {
    exportLog.push({
      timestamp, name: `Top ${places.length} ${type}s in ${region}`, address: region,
      photos: saved, song: null, platforms: [], caption,
    });
    chrome.storage.local.set({ exportLog });
  });

  TechLog.info("EXPORT", "run_complete", { run_id: runId, run_type: "manual_roundup_export",
    region, type, photo_count: saved, total_duration_ms: Date.now()-runStart });
  TechLog._flush();

  if (saved > 0) {
    AppLog.info(`Exported roundup: ${saved}/${photoDataUrls.length} photos`, { region, type });
    setStatus(`✅ Exported ${saved} photo${saved === 1 ? "" : "s"} & caption to Downloads/${folder}/`, "success");
  } else {
    AppLog.error("Roundup export failed — no photos saved");
    setStatus("⚠️ Could not export any photos.", "error");
  }

  if (exportBtn) exportBtn.disabled = false;
  if (postBtn)   postBtn.disabled   = false;
}

// Boot
checkUsageWarning();

// ── Test hooks (no-op in the extension; used by the Jest suite) ──────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    doSearch,
    searchRestaurantMulti,
    searchAutoPlace,
    renderResults,
    renderSearchResultsDropdown,
    hideSearchResultsDropdown,
    getAutoBotSettings,
    loadAutoBotConfig,
    getManualSettings,
    loadManualConfig,
    saveManualConfig,
    buildRegionChips,
    MM_CONFIG_DEFAULTS,
    AB_COUNTRY_NAMES,
    AB_COUNTRY_BOUNDS,
    AB_TYPE_QUERY,
    getCurrentRestaurant: () => currentRestaurant,
    // Region Roundup
    REGIONS,
    buildRegionSelect,
    searchAutoPlacesCollection,
    getAutoCaptionRoundup,
    getRegionRoundupSettings,
    loadRegionRoundupConfig,
    saveRegionRoundupConfig,
    generateRoundupSchedule,
    getRoundupScheduleSettings,
    RR_CONFIG_DEFAULTS,
    // Manual Post Region Roundup
    getManualRoundupSettings,
    generateManualRoundup,
    postManualRoundup,
    exportManualRoundup,
    getCurrentRoundup: () => currentRoundup,
  };
}

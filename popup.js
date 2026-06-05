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

function buildFeatureStatus(hasKey) {
  return [
    { label: 'Google Maps photo scraping',  on: true  },
    { label: 'DuckDuckGo image search',     on: true  },
    { label: 'Yelp photo scraping',         on: true  },
    { label: 'Google Places API (source 4)',on: hasKey, note: hasKey ? '' : ' — add API key to enable' },
    { label: 'Automatic business discovery',on: hasKey, note: hasKey ? '' : ' — add API key to enable' },
    { label: 'Scheduled auto-posting',      on: hasKey, note: hasKey ? '' : ' — add API key to enable' },
  ];
}

function renderFeatureStatus(containerId, hasKey) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = buildFeatureStatus(hasKey).map(f => `
    <div class="settings-feature ${f.on ? '' : 'disabled'}">
      <span class="feat-icon">${f.on ? '✅' : '⚠️'}</span>
      <span>${f.label}${f.note ? `<em style="font-size:.68rem;color:var(--muted)">${f.note}</em>` : ''}</span>
    </div>`).join('');
}

function openSettings() {
  const panel = document.getElementById('settingsPanel');
  const backdrop = document.getElementById('settingsBackdrop');
  if (!panel) return;

  // Populate current API key (masked)
  chrome.storage.local.get({ googleApiKey: '' }, ({ googleApiKey }) => {
    const input = document.getElementById('settingsApiKey');
    if (input) input.value = googleApiKey ? '••••••••••••••••' : '';
    const status = document.getElementById('settingsKeyStatus');
    if (status) {
      status.className = 'settings-key-status ' + (googleApiKey ? 'ok' : 'warn');
      status.textContent = googleApiKey ? '✓ API key saved' : '⚠ No API key — 3 of 4 image sources active';
    }
    renderFeatureStatus('settingsFeatures', !!googleApiKey);
  });

  const sv = document.getElementById('settingsVersion');
  if (sv && CURRENT_VERSION) sv.textContent = CURRENT_VERSION;

  panel.classList.remove('hidden');
  backdrop.classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settingsPanel')?.classList.add('hidden');
  document.getElementById('settingsBackdrop')?.classList.add('hidden');
}

// Settings open buttons (selector + both modes)
['settingsBtnSelector','settingsBtnManual','settingsBtnAuto'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', openSettings);
});
document.getElementById('settingsCloseBtn')?.addEventListener('click', closeSettings);
document.getElementById('settingsBackdrop')?.addEventListener('click', closeSettings);

// Save API key from settings panel
document.getElementById('settingsSaveKey')?.addEventListener('click', () => {
  const input  = document.getElementById('settingsApiKey');
  const status = document.getElementById('settingsKeyStatus');
  const val = (input?.value || '').trim();
  if (!val || val.startsWith('•')) { if (status) { status.className='settings-key-status warn'; status.textContent='Enter a new key to update.'; } return; }
  chrome.storage.local.set({ googleApiKey: val }, () => {
    API_KEY = val;
    if (input)  input.value = '••••••••••••••••';
    if (status) { status.className='settings-key-status ok'; status.textContent='✓ API key saved'; }
    renderFeatureStatus('settingsFeatures', true);
    checkUsageWarning();
    initAfterKey();
  });
});

// Settings action buttons
document.getElementById('settingsExportLogs')?.addEventListener('click', () => { TechLog.exportCSV(); closeSettings(); });
document.getElementById('settingsResetActivity')?.addEventListener('click', () => {
  if (confirm('Reset the activity log? This cannot be undone.')) {
    chrome.storage.local.set({ activityLog: [] }, () => { refreshActivityLog(); closeSettings(); });
  }
});
document.getElementById('settingsUsageStats')?.addEventListener('click', () => {
  chrome.storage.local.get({ apiLog: [], totalCost: 0 }, ({ apiLog, totalCost }) => {
    // Build per-day breakdown for the last 7 days
    const dayMap = {};
    apiLog.forEach(entry => {
      const day = (entry.ts || entry.timestamp || '').slice(0, 10);
      if (day) { dayMap[day] = (dayMap[day] || 0) + 1; }
    });
    const days = Object.keys(dayMap).sort().slice(-7);
    const dayRows = days.length
      ? days.map(d => `  ${d}: ${dayMap[d]} call${dayMap[d]>1?'s':''}`).join('\n')
      : '  No data yet';

    // Call type breakdown
    const typeMap = {};
    apiLog.forEach(e => { const t = e.type || e.callType || 'search'; typeMap[t] = (typeMap[t]||0)+1; });
    const typeRows = Object.entries(typeMap).map(([t,n]) => `  ${t}: ${n}`).join('\n') || '  —';

    const msg = [
      `📊 Google Places API Usage`,
      ``,
      `Total calls : ${apiLog.length}`,
      `Est. cost   : $${totalCost.toFixed(4)}`,
      ``,
      `Last 7 days:`,
      dayRows,
      ``,
      `By type:`,
      typeRows,
      ``,
      `⚠ These are estimates. For exact usage, visit Google Cloud Console (see the "View in Console" button).`,
    ].join('\n');
    alert(msg);
  });
});

// Cloud Console link — opens the actual API metrics dashboard
const consoleBtn = document.createElement('button');
consoleBtn.className = 'btn btn--ghost btn--sm';
consoleBtn.style.cssText = 'margin-top:6px;width:100%;';
consoleBtn.textContent = '🔗 View in Google Cloud Console';
consoleBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://console.cloud.google.com/apis/api/places.googleapis.com/metrics' });
  closeSettings();
});
document.getElementById('settingsUsageStats')?.parentElement?.appendChild(consoleBtn);
document.getElementById('settingsShowOnboarding')?.addEventListener('click', () => {
  closeSettings();
  showOnboarding();
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

// Skip API key
document.getElementById('obSkipKey')?.addEventListener('click', () => {
  showObComplete(false);
  goObStep(4);
});

// Save API key in onboarding
document.getElementById('obSaveKey')?.addEventListener('click', () => {
  const input  = document.getElementById('obApiKeyInput');
  const status = document.getElementById('obKeyStatus');
  const val = (input?.value || '').trim();
  if (!val) { if (status) { status.className='ob-key-status err'; status.textContent='Please enter an API key.'; } return; }
  if (status) { status.className='ob-key-status'; status.textContent='Saving…'; }
  chrome.storage.local.set({ googleApiKey: val }, () => {
    API_KEY = val;
    if (status) { status.className='ob-key-status ok'; status.textContent='✓ Key saved!'; }
    setTimeout(() => { showObComplete(true); goObStep(4); }, 700);
  });
});

function showObComplete(hasKey) {
  const el = document.getElementById('obFeatureStatus');
  if (!el) return;
  const features = buildFeatureStatus(hasKey);
  el.innerHTML = features.map(f => `
    <div class="ob-feat ${f.on ? 'enabled' : 'disabled'}">
      ${f.on ? '✅' : '⚠️'} ${f.label}${f.note ? ` <em style="font-size:.67rem">${f.note}</em>` : ''}
    </div>`).join('');
}

// Finish onboarding
document.getElementById('obFinishBtn')?.addEventListener('click', () => {
  hideOnboarding();
  // Re-init with potentially new API key
  chrome.storage.local.get({ googleApiKey: '' }, ({ googleApiKey }) => {
    if (googleApiKey) { API_KEY = googleApiKey; initAfterKey(); }
  });
});

// ── Check on popup open whether to show onboarding ───────────────────────────
chrome.storage.local.get({ hasSeenOnboarding: false, googleApiKey: '' }, ({ hasSeenOnboarding, googleApiKey }) => {
  if (!hasSeenOnboarding) {
    showOnboarding();
    // Pre-fill step 3 if key already exists (unlikely on first run but safe)
    if (googleApiKey) {
      const input = document.getElementById('obApiKeyInput');
      if (input) input.value = googleApiKey;
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

const BELGIAN_RESTAURANTS = [
  "Comme Chez Soi Brussels",       "In De Wulf Dranouter",
  "The Jane Antwerp",               "Hof van Cleve Kruishoutem",
  "Bon Bon Brussels",               "Zilte Antwerp",
  "De Karmeliet Bruges",            "La Paix Brussels",
  "Bozar Restaurant Brussels",      "Humphrey Brussels",
  "Vrijmoed Ghent",                 "OAK Ghent",
  "Balls & Glory Ghent",            "Fiskebar Antwerp",
  "Dôme Antwerp",                   "Den Dyver Bruges",
  "Le Chalet de la Foret Brussels", "La Villa Lorraine Brussels",
  "La Menuiserie Ghent",            "Gruut Stadsbrouwerij Ghent",
  "Le Tournant Liège",              "Numerus Clausus Namur",
  "Braserie Appelmans Antwerp",     "De Troubadour Bruges",
];

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
  },

  exportCSV() {
    chrome.storage.local.get({ techLog: [] }, ({ techLog }) => {
      // Comprehensive columns including all new fields added in V1.8
      const cols = [
        "ts","run_type","run_id","level","source","category","action",
        "duration_ms","name","platform","status","photo_source","photo_count",
        "source_breakdown","song","artist","language","error","session","id"
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

// ── State ─────────────────────────────────────────────────────────────────────

let API_KEY           = "";
let currentRestaurant = null;
const uriCache        = new Map(); // "photoName|maxWidth" → uri
let selectedSong      = null;
let activePlatforms   = new Set();
let coverPhotoIndex   = 0;         // index into currentRestaurant.photos[]
const coverOverlayCache = new Map(); // "photoName|restaurantName" → overlayDataUrl

const $ = id => document.getElementById(id);

// ── Cover photo overlay ───────────────────────────────────────────────────────

// Wait for Cormorant Garamond (loaded via Google Fonts <link> in popup.html)
async function ensureCoverFont() {
  try { await document.fonts.ready; } catch(_) {}
}
ensureCoverFont();

// Short tagline for cover — varies per restaurant (consistent per name)
function getCoverTagline(restaurantName, city) {
  const seed = restaurantName.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const c = city || 'Belgium';
  const lines = [
    `Must visit in ${c} 📍`,
    `Hidden gem in ${c} ✨`,
    `Have you been here? 🍽️`,
    `${c}'s finest dining`,
    `Worth every bite 😍`,
    `Don't miss this spot! 🔥`,
    `A must in ${c}!`,
    `Next stop: ${c} 📍`,
  ];
  return lines[seed % lines.length];
}

async function createCoverOverlay(imgUri, restaurantName, address) {
  const key = `${imgUri.slice(-40)}|${restaurantName}`;
  if (coverOverlayCache.has(key)) return coverOverlayCache.get(key);

  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const W = img.naturalWidth  || 900;
      const H = img.naturalHeight || 900;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');

      // Draw base image
      ctx.drawImage(img, 0, 0, W, H);

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
      const cityM = address.match(/\d{4}\s+([A-Za-zÀ-ÿ\s-]+),\s*Belgium/i);
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

      const result = canvas.toDataURL('image/jpeg', 0.93);
      coverOverlayCache.set(key, result);
      resolve(result);
    };
    img.onerror = () => resolve(null);
    img.src = imgUri;
  });
}

function setCoverPhoto(newIndex) {
  if (!currentRestaurant) return;
  coverPhotoIndex = newIndex;
  coverOverlayCache.clear(); // invalidate cache (photo changed)
  renderPhotoGrid();
  saveState();
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
    },
  });
}

// Debounced save for caption edits
let _saveTimer = null;
function saveStateSoon() { clearTimeout(_saveTimer); _saveTimer = setTimeout(saveState, 600); }

function restoreState(saved) {
  if (!saved?.restaurant) return;

  // Restore URI cache
  (saved.uriCacheEntries || []).forEach(([k, v]) => uriCache.set(k, v));

  // Restore restaurant
  currentRestaurant = saved.restaurant;

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
      if (API_KEY && lastState) restoreState(lastState);
    }
  }
);

// ── API key setup ─────────────────────────────────────────────────────────────

function showKeySetup(show) {
  $("keySetup").classList.toggle("hidden", !show);
  document.querySelector(".search-section").classList.toggle("hidden", show);
  $("settingsFooter").classList.toggle("hidden", show);
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

$("changeKeyBtn").addEventListener("click", () => {
  $("apiKeyInput").value = API_KEY;
  showKeySetup(true);
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

$("usageStatsBtn").addEventListener("click", () => {
  chrome.storage.local.get({ apiLog: [], totalCost: 0 }, ({ apiLog, totalCost }) => {
    alert(`📊 API Usage\n\nTotal calls : ${apiLog.length}\nEst. cost   : $${totalCost.toFixed(4)}\n\nClick "Export Logs" for a full debug report.`);
  });
});

$("exportLogsBtn").addEventListener("click", () => {
  AppLog.info("Export logs requested by user");
  TechLog._flush(); // flush any pending entries before export
  TechLog.exportCSV(); // export tech log as CSV
  chrome.storage.local.get(
    { appLog: [], apiLog: [], exportLog: [], totalCost: 0 },
    (data) => {
      const report = {
        exportedAt:    new Date().toISOString(),
        version:       chrome.runtime.getManifest().version,
        apiUsage: {
          totalCalls:   data.apiLog.length,
          estimatedUSD: data.totalCost,
          calls:        data.apiLog,
        },
        appEvents:     data.appLog,
        exportHistory: data.exportLog,
      };
      const json = JSON.stringify(report, null, 2);
      const slug = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
      chrome.runtime.sendMessage({
        type:     "DOWNLOAD",
        url:      "data:application/json;charset=utf-8," + encodeURIComponent(json),
        filename: `FoodFluencer/debug_log_${slug}.json`,
      });
      setStatus("📋 Debug log exported to Downloads/FoodFluencer/", "success");
    }
  );
});

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

async function searchRestaurant(query) {
  const q = /belgium/i.test(query) ? query : `${query} Belgium`;
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
      maxResultCount: 1,
      locationRestriction: {
        rectangle: {
          low:  { latitude: 49.5, longitude: 2.5 },
          high: { latitude: 51.5, longitude: 6.4 },
        },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${res.status}`);
  }
  const data = await res.json();
  if (!data.places?.length)
    throw new Error(`No restaurant found for "${query}" in Belgium.`);
  return data.places[0];
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

function renderResults(place) {
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

  $("results").classList.remove("hidden");
  saveState();
}

function renderPhotoGrid() {
  const grid   = $("photoGrid");
  const photos = currentRestaurant.photos;
  grid.innerHTML = "";

  photos.forEach((photo, i) => {
    const div = document.createElement("div");
    div.className = "photo-item";
    div.dataset.slot = i;
    grid.appendChild(div);

    const cached = uriCache.get(`${photo.name}|400`);
    if (cached) {
      fillPhotoSlot(div, cached, i);
    } else {
      div.innerHTML = `<div class="loading-thumb">Loading…</div>`;
      resolvePhotoUri(photo.name, 400)
        .then(uri => fillPhotoSlot(div, uri, i))
        .catch(() => { div.innerHTML = `<div class="loading-thumb">Unavailable</div>`; });
    }
  });
}

function fillPhotoSlot(div, uri, index) {
  const isCover = index === coverPhotoIndex;
  if (isCover) div.classList.add('is-cover'); else div.classList.remove('is-cover');

  div.innerHTML = `
    <img src="${uri}" alt="Photo ${index + 1}" />
    ${isCover
      ? '<span class="cover-badge">Cover</span>'
      : `<button class="make-cover-btn" title="Set as cover photo">⭐ Cover</button>`}
    <span class="photo-label">${isCover ? '★' : index + 1}</span>
    <button class="dismiss-btn" title="Replace with another photo">✕</button>`;

  // Show cover overlay preview on the cover photo
  if (isCover && currentRestaurant) {
    createCoverOverlay(uri, currentRestaurant.name, currentRestaurant.address)
      .then(overlayUri => {
        if (overlayUri) {
          const imgEl = div.querySelector('img');
          if (imgEl && div.dataset.slot == index) imgEl.src = overlayUri;
        }
      });
  }

  div.querySelector(".dismiss-btn").addEventListener("click", e => {
    e.stopPropagation();
    dismissPhoto(index);
  });

  if (!isCover) {
    div.querySelector(".make-cover-btn")?.addEventListener("click", e => {
      e.stopPropagation();
      setCoverPhoto(index);
    });
  }
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
  const cityMatch   = address.match(/\d{4}\s+([A-Za-zÀ-ÿ\s-]+),\s*Belgium/i);
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
  return openers[seed % openers.length];
}

function buildDefaultCaption() {
  if (!currentRestaurant) return "";
  const { name, address, rating } = currentRestaurant;

  const cityMatch   = address.match(/\d{4}\s+([A-Za-zÀ-ÿ\s-]+),\s*Belgium/i);
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

async function doSearch(query) {
  if (!query.trim()) return;
  if (!API_KEY) { setStatus("Please save your API key first.", "error"); return; }
  setStatus("Searching…");
  $("results").classList.add("hidden");
  // Clear song for a fresh search
  selectedSong = null;
  $("selectedSong")?.classList.add("hidden");
  try {
    const place = await searchRestaurant(query);
    renderResults(place);
    AppLog.info("Restaurant found", { name: place.displayName?.text, query });
    $("status").classList.add("hidden");
  } catch (err) {
    AppLog.error("Restaurant search failed", { query, error: err.message });
    setStatus(err.message, "error");
  }
}

$("searchBtn").addEventListener("click", () => doSearch($("query").value));
$("query").addEventListener("keydown", e => { if (e.key === "Enter") doSearch($("query").value); });
$("randomBtn").addEventListener("click", () => {
  const pick = BELGIAN_RESTAURANTS[Math.floor(Math.random() * BELGIAN_RESTAURANTS.length)];
  $("query").value = pick;
  doSearch(pick);
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

$("exportBtn").addEventListener("click", exportAndPost);

async function photoToDataUrl(uri, maxWidth = 900) {
  const res    = await fetch(uri);
  const blob   = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const scale  = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width  = Math.round(bitmap.width  * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

async function exportAndPost() {
  if (!currentRestaurant) return;

  const { name, address, photos } = currentRestaurant;
  const caption   = $("caption")?.value.trim() || buildDefaultCaption();
  const songName  = selectedSong?.name || "";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const platforms = [...activePlatforms];

  const runId    = `manual-${Date.now()}`;
  const runStart = Date.now();
  TechLog.info("POST", "run_start", { run_id: runId, run_type: "manual",
    restaurant: name, address, platforms, song: songName });

  $("exportBtn").disabled = true;
  AppLog.info("Export & Post started", { restaurant: name, photos: photos.length, platforms, song: songName });
  setStatus("Resolving photos…");

  // ── 1. Resolve full-res photo URIs from Google Places CDN ─────────────────
  const t_photos = Date.now();
  TechLog.info("MEDIA", "photos_start", { run_id: runId, run_type: "manual", name });
  const photoUris = [];
  for (const photo of photos) {
    try {
      photoUris.push(await resolvePhotoUri(photo.name, 1200));
    } catch (e) {
      AppLog.error("Photo resolve failed", { photo: photo.name, error: String(e) });
      console.warn("Photo resolve failed:", e);
    }
  }
  TechLog.info("MEDIA", "photos_done", { run_id: runId, run_type: "manual",
    photo_source: "google_places_manual", photo_count: photoUris.length,
    source_breakdown: { google_places_manual: photoUris.length },
    duration_ms: Date.now()-t_photos });
  AppLog.info(`Resolved ${photoUris.length}/${photos.length} photo URIs`);

  // ── 2. Log the export (no local file download) ────────────────────────────
  chrome.storage.local.get({ exportLog: [] }, ({ exportLog }) => {
    exportLog.push({
      timestamp, name, address, photos: photoUris.length,
      song:      selectedSong ? `${selectedSong.name} – ${selectedSong.artist}` : null,
      platforms,
      caption,
    });
    chrome.storage.local.set({ exportLog });
  });

  // ── 3. Prepare data URLs — cover photo (with overlay) first ─────────────────
  if (platforms.length > 0 && photoUris.length > 0) {
    setStatus(`Preparing photos… applying cover overlay…`);

    // Build photo data URLs with cover (+ text overlay) at position 0
    const covIdx   = Math.min(coverPhotoIndex, photoUris.length - 1);
    const photoDataUrls = [];

    // Cover photo: apply restaurant name + location overlay
    try {
      setStatus("Rendering cover photo overlay…");
      const coverUri = photoUris[covIdx];
      const overlay  = await createCoverOverlay(coverUri, name, address);
      photoDataUrls.push(overlay || await photoToDataUrl(coverUri));
      AppLog.info("Cover overlay applied", { index: covIdx });
    } catch(e) {
      AppLog.warn("Cover overlay failed, using plain photo", String(e));
      try { photoDataUrls.push(await photoToDataUrl(photoUris[covIdx])); } catch(_) {}
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
          restaurantName:   currentRestaurant.name    || "",
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
  } else if (platforms.length === 0) {
    // No platforms selected — just log
    AppLog.info("No platforms selected, logged only");
    setStatus("✅ Logged — select a platform above to post to social media.", "success");
  } else {
    AppLog.error("No photo URIs resolved");
    setStatus("⚠️ Could not resolve any photos.", "error");
  }

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
    throw new Error(err?.error?.message || `API error ${res.status}`);
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
  const cityM   = address.match(/\d{4}\s+([A-Za-zÀ-ÿ\s-]+),\s*(?:Belgium|France|Germany|Luxembourg|Netherlands)/i);
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
        <span class="auto-preview-name">${name}</span>
        <span class="auto-preview-addr">${address}</span>
        ${rating ? `<span class="auto-preview-rating">⭐ ${rating} · ${ratingCount.toLocaleString()} ratings</span>` : ""}
      </div>
      <div class="auto-preview-photos" id="autoPreviewPhotos"></div>
      ${songInfo ? `
        <div class="auto-preview-song">
          <img src="${songInfo.artwork}" alt="" />
          <div class="auto-preview-song-info">
            <span class="auto-preview-song-name">${songInfo.name}</span>
            <span class="auto-preview-song-artist">${songInfo.artist}</span>
          </div>
          <span class="auto-preview-genre-badge">${songInfo.genre}</span>
        </div>` : ""}
      ${caption ? `<div class="auto-preview-caption">${caption.replace(/\n/g, "<br>")}</div>` : ""}
      <p class="auto-preview-note">${photos.length} photo${photos.length !== 1 ? "s" : ""} · ≥${settings.minRatings} ratings · ≥${settings.minStars}⭐</p>
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

function loadAutoBotConfig() {
  chrome.storage.local.get({ autoBotConfig: null }, ({ autoBotConfig: cfg }) => {
    if (!cfg) return;

    const pill = (groupId, val) =>
      document.querySelectorAll(`#${groupId} .ab-pill`)
        .forEach(p => p.classList.toggle("active", p.dataset.val === val));
    const sel = (id, val) => { const e = document.getElementById(id); if (e && val) e.value = val; };

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
  const perDay = new Array(numDays).fill(0);
  let remaining = Math.min(total, maxPerDay * numDays);
  let attempts = 0;
  while (remaining > 0 && attempts < 10000) {
    const d = Math.floor(Math.random() * numDays);
    if (perDay[d] < maxPerDay) { perDay[d]++; remaining--; }
    attempts++;
  }
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
  // Clear SCHEDULE data only — activityLog (persistent history) is preserved
  chrome.storage.local.set({ autoBotActive: false, autoBotSchedule: null, autoBotRunLog: [] });
  chrome.alarms.clearAll();
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
}

// ── Chrome Alarms ─────────────────────────────────────────────────────────────
function setupScheduleAlarms(schedule) {
  chrome.alarms.clearAll(() => {
    const now = Date.now();
    schedule.posts.forEach((post, idx) => {
      const when = new Date(`${post.date}T${post.time}:00`).getTime();
      if (when > now) chrome.alarms.create(`ffbot-auto-${idx}`, { when });
    });
    AppLog.info(`Set ${schedule.posts.length} alarms`);
  });
}

// ── Render scheduled posts list ───────────────────────────────────────────────
function renderScheduledPosts(schedule) {
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

  const now = new Date();
  Object.entries(grouped).sort(([a],[b]) => a.localeCompare(b)).forEach(([date, posts]) => {
    const dayEl  = document.createElement("div");
    dayEl.className = "ab-sched-day-group";
    const dayObj = new Date(`${date}T00:00:00`);
    const dayLbl = dayObj.toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"short" });
    dayEl.innerHTML = `<div class="ab-sched-day-label">${dayLbl}</div>`;

    posts.forEach(post => {
      const postTime = new Date(`${date}T${post.time}:00`);
      const isPast   = postTime < now;
      const plat = post.platforms.map(p => ({ instagram:"📸 IG", facebook:"👥 FB", tiktok:"🎵 TT" }[p] || p)).join("  ");

      const item = document.createElement("div");
      item.className = "ab-sched-item";
      item.id = `abSchedItem-${post.idx}`;
      item.innerHTML = `
        <span class="ab-sched-time">${post.time}</span>
        <span class="ab-sched-platforms">${plat}</span>
        <span class="ab-sched-status ${isPast ? 'done' : 'pending'}" id="abSchedStatus-${post.idx}">
          ${isPast ? "✓ Done" : "⏳ Pending"}
        </span>`;
      dayEl.appendChild(item);
    });
    body.appendChild(dayEl);
  });
}

function updateScheduledItemStatus(idx, status) {
  const el = document.getElementById(`abSchedStatus-${idx}`);
  if (!el) return;
  const labels = { pending:"⏳ Pending", triggered:"🔄 Posting…", done:"✓ Done", failed:"✗ Failed" };
  el.textContent = labels[status] || status;
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

// ── Activity log — reads from persistent activityLog, filtered by time ────────
function refreshActivityLog(filter) {
  if (filter) activityLogFilter = filter;
  const now    = new Date();
  const ms     = { day:864e5, week:6048e5, month:2592e6, year:31536e6 };
  const cutoff = new Date(now - (ms[activityLogFilter] || ms.month));

  chrome.storage.local.get({ activityLog:[] }, ({ activityLog }) => {
    const counts = { instagram:0, facebook:0, tiktok:0 };
    activityLog
      .filter(e => e.status === "done" && new Date(e.ts) >= cutoff)
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

// Listen for status messages from background
chrome.runtime.onMessage.addListener((msg) => {
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
  chrome.storage.local.get({ autoBotActive:false, autoBotSchedule:null, autoBotRunLog:[] },
    ({ autoBotActive: wasActive, autoBotSchedule: schedule, autoBotRunLog: runLog }) => {
      autoBotActive = wasActive;
      refreshActivityLog();
      if (wasActive && schedule) {
        updateBotUI(true);
        renderScheduledPosts(schedule);
        const done = runLog.filter(e => e.status === "done").length;
        updateProgress(done, schedule.totalPosts);
        updateNextPostLabel(schedule);
        updateConfigSummary();
      } else {
        updateBotUI(false);
      }
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
  setTimeout(restoreBotActiveState, 80); // after config loads
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

function buildRegionChips(countryCode) {
  const wrap = document.getElementById("abRegionWrap");
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

// Rebuild when country changes
document.getElementById("abCountry")?.addEventListener("change", e => {
  buildRegionChips(e.target.value);
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

// Boot
checkUsageWarning();

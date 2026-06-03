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
      const citySize   = Math.max(13, Math.round(W * 0.024));
      const cornerSize = Math.max(10, Math.round(W * 0.016));
      const gap        = Math.round(nameSize * 0.38);

      // Extract city
      const cityM = address.match(/\d{4}\s+([A-Za-zÀ-ÿ\s-]+),\s*Belgium/i);
      const city  = (cityM?.[1] || address.split(',')[0] || '').trim();
      const tagline = getCoverTagline(restaurantName, city);

      // Total text block height: tagline + gap + name + (gap + city)?
      const blockH = tagSize + gap + nameSize + (city ? gap + citySize : 0);
      let y = best.centerY - blockH / 2;

      ctx.fillStyle    = '#FFFFFF';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.shadowColor  = 'rgba(0,0,0,0.72)';
      ctx.shadowOffsetX = 0;

      // ── Tagline (small, italic) ───────────────────────────────────────────
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
      y += nameSize + gap;

      // ── City subtitle ─────────────────────────────────────────────────────
      if (city) {
        ctx.font       = `300 italic ${citySize}px "Cormorant Garamond", Georgia, serif`;
        ctx.shadowBlur = Math.round(citySize * 0.4);
        ctx.shadowOffsetY = 1;
        ctx.fillText(city, W / 2, y);
      }

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
  { googleApiKey: "", lastState: null },
  ({ googleApiKey, lastState }) => {
    API_KEY = googleApiKey;
    showKeySetup(!API_KEY);
    checkUsageWarning();
    if (API_KEY && lastState) restoreState(lastState);
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

  $("exportBtn").disabled = true;
  AppLog.info("Export & Post started", { restaurant: name, photos: photos.length, platforms, song: songName });
  setStatus("Resolving photos…");

  // ── 1. Resolve full-res photo URIs from Google Places CDN ─────────────────
  const photoUris = [];
  for (const photo of photos) {
    try {
      photoUris.push(await resolvePhotoUri(photo.name, 1200));
    } catch (e) {
      AppLog.error("Photo resolve failed", { photo: photo.name, error: String(e) });
      console.warn("Photo resolve failed:", e);
    }
  }
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
        setStatus(`Opening ${platform}…`);
        chrome.runtime.sendMessage({
          type: "OPEN_SOCIAL", platform, photoDataUrls, caption, songName,
          location:         currentRestaurant.address || "",
          restaurantName:   currentRestaurant.name    || "",
          tiktokAudioDataUrl: platform === "tiktok" ? (tiktokAudioDataUrl || null) : null,
        });
        await new Promise(r => setTimeout(r, 900));
      }
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

// Boot
checkUsageWarning();

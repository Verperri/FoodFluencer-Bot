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

// ── State ─────────────────────────────────────────────────────────────────────

let API_KEY           = "";
let currentRestaurant = null;
let selectedSong      = null;
let activePlatforms   = new Set();

const $ = id => document.getElementById(id);

// ── Init ──────────────────────────────────────────────────────────────────────

chrome.storage.local.get(
  { googleApiKey: "", activePlatforms: [] },
  ({ googleApiKey, activePlatforms: saved }) => {
    API_KEY = googleApiKey;
    saved.forEach(p => {
      activePlatforms.add(p);
      document.querySelector(`.social-btn[data-platform="${p}"]`)?.classList.add("active");
    });
    showKeySetup(!API_KEY);
    checkUsageWarning();
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
    alert(`📊 API Usage\n\nTotal calls : ${apiLog.length}\nEst. cost   : $${totalCost.toFixed(4)}\n\nUse "Download log" in the warning banner to export full CSV history.`);
  });
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
  trackApiCall("photo", "");
  const res  = await fetch(`${PLACES_PHOTO}/${photoName}/media?maxWidthPx=${maxWidth}&key=${API_KEY}&skipHttpRedirect=true`);
  const data = await res.json();
  return data.photoUri;
}

// ── Render restaurant ─────────────────────────────────────────────────────────

function renderResults(place) {
  const photos = (place.photos || []).slice(0, CONFIG.MAX_PHOTOS);
  currentRestaurant = {
    name:         place.displayName?.text || "",
    address:      place.formattedAddress  || "",
    rating:       place.rating,
    totalRatings: place.userRatingCount,
    mapsUrl:      place.googleMapsUri     || "",
    photos:       photos.map(p => ({ name: p.name })),
  };

  $("restaurantName").textContent    = currentRestaurant.name;
  $("restaurantAddress").textContent = currentRestaurant.address;
  $("restaurantMeta").textContent    = place.rating
    ? `⭐ ${place.rating} · ${(place.userRatingCount || 0).toLocaleString()} ratings` : "";

  const link = $("restaurantMapsLink");
  link.href = currentRestaurant.mapsUrl || "#";
  link.style.display = currentRestaurant.mapsUrl ? "inline" : "none";

  updateCaption();

  // Photo grid
  const grid = $("photoGrid");
  grid.innerHTML = "";
  photos.forEach((photo, i) => {
    const div = document.createElement("div");
    div.className = "photo-item";
    div.innerHTML = `<div class="loading-thumb">Loading…</div>`;
    grid.appendChild(div);
    resolvePhotoUri(photo.name, 400)
      .then(uri => { div.innerHTML = `<img src="${uri}" alt="Photo ${i+1}" /><span class="photo-label">${i+1}</span>`; })
      .catch(() => { div.innerHTML = `<div class="loading-thumb">Unavailable</div>`; });
  });

  $("results").classList.remove("hidden");
}

function updateCaption() {
  if (!currentRestaurant) return;
  let text = `📍 ${currentRestaurant.name}\n${currentRestaurant.address}`;
  if (selectedSong) text += `\n🎵 ${selectedSong.name} – ${selectedSong.artist}`;
  $("caption").value = text;
}

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
  try {
    const place = await searchRestaurant(query);
    renderResults(place);
    $("status").classList.add("hidden");
  } catch (err) {
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
    chrome.storage.local.set({ activePlatforms: [...activePlatforms] });
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
  $("selectedSongArt").src          = song.artwork;
  $("selectedSongName").textContent   = song.name;
  $("selectedSongArtist").textContent = song.artist;
  $("selectedSong").classList.remove("hidden");
  updateCaption();
}

$("removeSongBtn").addEventListener("click", () => {
  selectedSong = null;
  $("selectedSong").classList.add("hidden");
  updateCaption();
});

// ── Export & Post ─────────────────────────────────────────────────────────────

$("exportBtn").addEventListener("click", exportAndPost);

async function exportAndPost() {
  if (!currentRestaurant) return;

  const { name, address, photos } = currentRestaurant;
  const caption   = $("caption").value.trim();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName  = name.replace(/[/\\?%*:|"<>]/g, "_");
  const folder    = `FoodFluencer/${safeName}_${timestamp}`;

  $("exportBtn").disabled = true;
  setStatus("Resolving photos…");

  // 1. Resolve all photo URIs
  const photoUris = [];
  for (let i = 0; i < photos.length; i++) {
    try {
      const uri = await resolvePhotoUri(photos[i].name, 1200);
      photoUris.push(uri);
    } catch (e) { console.warn("Photo resolve failed:", e); }
  }

  // 2. Download all photos to disk
  setStatus("Downloading photos…");
  photoUris.forEach((uri, i) => {
    chrome.runtime.sendMessage({
      type: "DOWNLOAD", url: uri,
      filename: `${folder}/photo_${String(i+1).padStart(2,"0")}.jpg`,
    });
  });

  // 3. Write info note
  const noteLines = [
    `Restaurant : ${name}`,
    `Address    : ${address}`,
    `Exported   : ${new Date().toLocaleString()}`,
    `Photos     : ${photos.length}`,
    selectedSong ? `Song       : ${selectedSong.name} – ${selectedSong.artist}` : null,
    ``,
    `Caption:`,
    caption,
  ].filter(l => l !== null);
  chrome.runtime.sendMessage({
    type: "DOWNLOAD",
    url: "data:text/plain;charset=utf-8," + encodeURIComponent(noteLines.join("\n")),
    filename: `${folder}/info.txt`,
  });

  // 4. Persist export log
  chrome.storage.local.get({ exportLog: [] }, ({ exportLog }) => {
    exportLog.push({
      timestamp, name, address, photos: photos.length, folder,
      song: selectedSong ? `${selectedSong.name} – ${selectedSong.artist}` : null,
      platforms: [...activePlatforms],
    });
    chrome.storage.local.set({ exportLog });
  });

  // 5. Social media posting
  const platforms = [...activePlatforms];
  if (platforms.length > 0 && photoUris.length > 0) {
    setStatus("Copying image to clipboard…");
    await copyImageToClipboard(photoUris[0]);
    setStatus("Opening social media…");
    await openSocialMediaTabs(platforms, caption);
    setStatus(
      `✅ Photo copied to clipboard! Paste (Ctrl+V) in the opened tab(s) to post.`,
      "success"
    );
  } else {
    setStatus(`✅ Exported ${photoUris.length} photos → Downloads/${folder}`, "success");
  }

  $("exportBtn").disabled = false;
}

// ── Clipboard helper ──────────────────────────────────────────────────────────

async function copyImageToClipboard(photoUri) {
  try {
    const res  = await fetch(photoUri);
    const blob = await res.blob();

    // Convert to PNG so ClipboardItem always accepts it
    const bitmap  = await createImageBitmap(blob);
    const canvas  = document.createElement("canvas");
    canvas.width  = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);

    const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
    return true;
  } catch (err) {
    console.warn("Clipboard write failed:", err);
    return false;
  }
}

// ── Social media tab opener ───────────────────────────────────────────────────

const PLATFORM_CONFIG = {
  instagram: {
    url:   "https://www.instagram.com/",
    label: "Instagram",
    hint:  "Tap the <strong>+</strong> button → <em>Post</em> → select your photo from <strong>Downloads/FoodFluencer</strong>.",
  },
  facebook: {
    url:   "https://www.facebook.com/",
    label: "Facebook",
    hint:  "Click <strong>Photo/video</strong> in the post composer → select from <strong>Downloads/FoodFluencer</strong>, then <strong>paste (Ctrl+V)</strong> the caption.",
  },
  tiktok: {
    url:   "https://www.tiktok.com/upload",
    label: "TikTok",
    hint:  "Drag &amp; drop your photo from <strong>Downloads/FoodFluencer</strong> onto the upload area.",
  },
};

async function openSocialMediaTabs(platforms, caption) {
  for (const platform of platforms) {
    const cfg = PLATFORM_CONFIG[platform];
    try {
      const tab = await chrome.tabs.create({ url: cfg.url, active: true });
      // Inject helper banner + caption pre-fill after page loads
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId !== tab.id || info.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: injectPostingHelper,
          args: [cfg.label, cfg.hint, caption],
        }).catch(err => console.warn(`Inject failed on ${platform}:`, err));
      });
    } catch (err) {
      console.warn(`Could not open ${platform}:`, err);
    }
  }
}

// Runs INSIDE the social media tab
function injectPostingHelper(platformLabel, hint, caption) {
  // Avoid double-inject
  if (document.getElementById("ffbot-banner")) return;

  // ── Floating banner ────────────────────────────────────────────────────
  const banner = document.createElement("div");
  banner.id = "ffbot-banner";
  banner.style.cssText = `
    position:fixed;top:0;left:0;right:0;z-index:2147483647;
    background:#e8490f;color:#fff;font-family:-apple-system,sans-serif;
    font-size:13px;padding:10px 16px;display:flex;align-items:center;
    gap:12px;box-shadow:0 3px 12px rgba(0,0,0,.3);
  `;

  const icon   = `<strong style="font-size:16px">🍽️</strong>`;
  const title  = `<strong>FoodFluencer Bot</strong>`;
  const hintEl = `<span style="font-weight:400">${hint}</span>`;
  const close  = `<button id="ffbot-close" style="margin-left:auto;background:rgba(255,255,255,.25);border:none;color:#fff;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px;">✕ Close</button>`;

  banner.innerHTML = `${icon}${title}${hintEl}${close}`;
  document.body.prepend(banner);
  document.getElementById("ffbot-close").addEventListener("click", () => banner.remove());

  // ── Auto-fill caption on Facebook ─────────────────────────────────────
  if (platformLabel === "Facebook") {
    const tryFillCaption = () => {
      const selectors = [
        '[aria-label="What\'s on your mind?"]',
        '[data-testid="status-attachment-mentions-input"]',
        '[role="textbox"][contenteditable="true"]',
      ];
      for (const sel of selectors) {
        const box = document.querySelector(sel);
        if (box) {
          box.focus();
          // Use execCommand for contenteditable divs
          document.execCommand("selectAll", false, null);
          document.execCommand("insertText", false, caption);
          return true;
        }
      }
      return false;
    };
    // Try immediately, then retry after a short delay (FB loads async)
    if (!tryFillCaption()) {
      setTimeout(tryFillCaption, 2000);
      setTimeout(tryFillCaption, 4000);
    }
  }

  // ── Navigate Instagram to the create page ─────────────────────────────
  if (platformLabel === "Instagram") {
    setTimeout(() => {
      // Click the "New post" / "+" button if visible
      const createBtn =
        document.querySelector('a[href="/create/select/"]') ||
        document.querySelector('[aria-label="New post"]')   ||
        document.querySelector('svg[aria-label="New post"]')?.closest("a");
      if (createBtn) createBtn.click();
    }, 2000);
  }
}

// Boot
checkUsageWarning();

// ── Constants ─────────────────────────────────────────────────────────────────

const PLACES_SEARCH = "https://places.googleapis.com/v1/places:searchText";
const PLACES_PHOTO  = "https://places.googleapis.com/v1";
const ITUNES_SEARCH = "https://itunes.apple.com/search";

// Cost estimates for Places API (New), in USD
const COST_TEXT_SEARCH = 0.017;  // per Text Search call
const COST_PHOTO       = 0.007;  // per Photo resolve call

// Warning thresholds (estimated USD spent)
const WARN_SOFT  = 5;    // show yellow warning
const WARN_HARD  = 20;   // show red warning + prompt to pause

const BELGIAN_RESTAURANTS = [
  "Comme Chez Soi Brussels",    "In De Wulf Dranouter",
  "The Jane Antwerp",            "Hof van Cleve Kruishoutem",
  "Bon Bon Brussels",            "Zilte Antwerp",
  "De Karmeliet Bruges",         "La Paix Brussels",
  "Bozar Restaurant Brussels",   "Humphrey Brussels",
  "Vrijmoed Ghent",              "OAK Ghent",
  "Balls & Glory Ghent",         "Fiskebar Antwerp",
  "Dôme Antwerp",                "Den Dyver Bruges",
  "Le Chalet de la Foret Brussels", "La Villa Lorraine Brussels",
  "La Menuiserie Ghent",         "Gruut Stadsbrouwerij Ghent",
  "Le Tournant Liège",           "Numerus Clausus Namur",
  "Braserie Appelmans Antwerp",  "De Troubadour Bruges",
];

// ── State ─────────────────────────────────────────────────────────────────────

let API_KEY            = "";
let currentRestaurant  = null;
let selectedSong       = null;
let activePlatforms    = new Set();

const $ = id => document.getElementById(id);

// ── Initialise ────────────────────────────────────────────────────────────────

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
  $("songSection").classList.toggle("hidden", show);
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
    apiLog.push({
      ts:    new Date().toISOString(),
      type,
      query,
      cost,
    });
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
      warn.style.borderColor = "#dc2626";
      warn.style.background  = "#fef2f2";
      warn.style.color       = "#991b1b";
      txt.textContent = `⛔ High API usage: ~$${totalCost.toFixed(2)} spent (${apiLog.length} calls). Consider pausing your key.`;
    } else if (totalCost >= WARN_SOFT) {
      warn.classList.remove("hidden");
      txt.textContent = `⚠️ API usage: ~$${totalCost.toFixed(2)} spent across ${apiLog.length} calls.`;
    } else {
      warn.classList.add("hidden");
    }
  });
}

$("usageStatsBtn").addEventListener("click", () => {
  chrome.storage.local.get({ apiLog: [], totalCost: 0 }, ({ apiLog, totalCost }) => {
    alert(`📊 API Usage Summary\n\nTotal calls: ${apiLog.length}\nEstimated cost: $${totalCost.toFixed(4)}\n\nClick "Download log" in the warning banner to export full history.`);
  });
});

$("downloadLogBtn").addEventListener("click", downloadApiLog);

function downloadApiLog() {
  chrome.storage.local.get({ apiLog: [] }, ({ apiLog }) => {
    const rows = ["timestamp,type,query,cost_usd",
      ...apiLog.map(r => `${r.ts},${r.type},"${(r.query||"").replace(/"/g,'""')}",${r.cost}`)
    ].join("\n");
    const uri = "data:text/csv;charset=utf-8," + encodeURIComponent(rows);
    chrome.runtime.sendMessage({
      type: "DOWNLOAD", url: uri,
      filename: `FoodFluencer/api_log_${new Date().toISOString().slice(0,10)}.csv`,
    });
  });
}

// ── Places API (New) ──────────────────────────────────────────────────────────

async function searchRestaurant(query) {
  const searchQuery = /belgium/i.test(query) ? query : `${query} Belgium`;
  trackApiCall("search", searchQuery);

  const res = await fetch(PLACES_SEARCH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask": [
        "places.id", "places.displayName", "places.formattedAddress",
        "places.rating", "places.userRatingCount", "places.googleMapsUri", "places.photos",
      ].join(","),
    },
    body: JSON.stringify({
      textQuery: searchQuery,
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

function photoMediaUrl(photoName, maxWidth = 400) {
  return `${PLACES_PHOTO}/${photoName}/media?maxWidthPx=${maxWidth}&key=${API_KEY}&skipHttpRedirect=true`;
}

async function resolvePhotoUri(photoName, maxWidth = 400) {
  trackApiCall("photo", photoName.split("/")[1] || "");
  const res  = await fetch(photoMediaUrl(photoName, maxWidth));
  const data = await res.json();
  return data.photoUri;
}

// ── Render results ────────────────────────────────────────────────────────────

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

  // Auto-fill caption
  $("caption").value =
    `📍 ${currentRestaurant.name}\n${currentRestaurant.address}` +
    (selectedSong ? `\n🎵 ${selectedSong.name} – ${selectedSong.artist}` : "");

  // Render photo grid
  const grid = $("photoGrid");
  grid.innerHTML = "";
  photos.forEach((photo, i) => {
    const div = document.createElement("div");
    div.className = "photo-item";
    div.innerHTML = `<div class="loading-thumb">Loading…</div>`;
    grid.appendChild(div);

    resolvePhotoUri(photo.name, 400).then(uri => {
      div.innerHTML = `<img src="${uri}" alt="Photo ${i+1}" /><span class="photo-label">${i+1}</span>`;
    }).catch(() => {
      div.innerHTML = `<div class="loading-thumb">Unavailable</div>`;
    });
  });

  $("results").classList.remove("hidden");
}

// ── Search ────────────────────────────────────────────────────────────────────

function setStatus(msg, type = "loading") {
  const el = $("status");
  el.textContent = msg;
  el.className = `status status--${type}`;
  el.classList.remove("hidden");
  if (type !== "loading") setTimeout(() => el.classList.add("hidden"), 5000);
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
    if (activePlatforms.has(p)) {
      activePlatforms.delete(p);
      btn.classList.remove("active");
    } else {
      activePlatforms.add(p);
      btn.classList.add("active");
    }
    chrome.storage.local.set({ activePlatforms: [...activePlatforms] });
  });
});

// ── Song search (iTunes API — free, no key needed) ────────────────────────────

$("songSearchBtn").addEventListener("click", searchSong);
$("songQuery").addEventListener("keydown", e => { if (e.key === "Enter") searchSong(); });

async function searchSong() {
  const q = $("songQuery").value.trim();
  if (!q) return;
  $("songResults").innerHTML = "<div style='padding:6px;color:#999;font-size:.75rem'>Searching…</div>";
  $("songResults").classList.remove("hidden");
  try {
    const url = `${ITUNES_SEARCH}?term=${encodeURIComponent(q)}&media=music&entity=song&limit=6`;
    const res  = await fetch(url);
    const data = await res.json();
    renderSongResults(data.results || []);
  } catch {
    $("songResults").innerHTML = "<div style='padding:6px;color:#dc2626;font-size:.75rem'>Search failed.</div>";
  }
}

function renderSongResults(songs) {
  const el = $("songResults");
  if (!songs.length) {
    el.innerHTML = "<div style='padding:6px;color:#999;font-size:.75rem'>No results.</div>";
    return;
  }
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
      name:       song.trackName,
      artist:     song.artistName,
      artwork:    song.artworkUrl100,
      previewUrl: song.previewUrl,
      trackId:    song.trackId,
    }));
    el.appendChild(div);
  });
}

function selectSong(song) {
  selectedSong = song;
  $("songResults").classList.add("hidden");
  $("songQuery").value = "";
  $("selectedSongArt").src        = song.artwork;
  $("selectedSongName").textContent   = song.name;
  $("selectedSongArtist").textContent = song.artist;
  $("selectedSong").classList.remove("hidden");
  // Update caption if restaurant is loaded
  if (currentRestaurant) {
    const base = $("caption").value.replace(/\n🎵 .+$/, "");
    $("caption").value = base + `\n🎵 ${song.name} – ${song.artist}`;
  }
}

$("removeSongBtn").addEventListener("click", () => {
  selectedSong = null;
  $("selectedSong").classList.add("hidden");
  if (currentRestaurant) {
    $("caption").value = $("caption").value.replace(/\n🎵 .+$/, "");
  }
});

// ── Export & social posting ───────────────────────────────────────────────────

$("exportBtn").addEventListener("click", exportAndPost);

async function exportAndPost() {
  if (!currentRestaurant) return;
  const { name, address, photos } = currentRestaurant;
  const caption   = $("caption").value.trim();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName  = name.replace(/[/\\?%*:|"<>]/g, "_");
  const folder    = `FoodFluencer/${safeName}_${timestamp}`;

  $("exportBtn").disabled = true;
  setStatus(`Exporting ${photos.length} photos…`);

  // 1. Resolve all photo URIs
  const photoUris = [];
  for (let i = 0; i < photos.length; i++) {
    try {
      const uri = await resolvePhotoUri(photos[i].name, 1200);
      photoUris.push(uri);
      chrome.runtime.sendMessage({
        type: "DOWNLOAD", url: uri,
        filename: `${folder}/photo_${String(i+1).padStart(2,"0")}.jpg`,
      });
    } catch (e) {
      console.warn("Photo export failed:", e);
    }
  }

  // 2. Save info note with song info
  const note = [
    `Restaurant: ${name}`,
    `Address:    ${address}`,
    `Exported:   ${new Date().toLocaleString()}`,
    `Photos:     ${photos.length}`,
    selectedSong ? `Song:       ${selectedSong.name} – ${selectedSong.artist}` : "",
    "",
    "Caption:",
    caption,
  ].filter(l => l !== undefined).join("\n");

  chrome.runtime.sendMessage({
    type: "DOWNLOAD",
    url: "data:text/plain;charset=utf-8," + encodeURIComponent(note),
    filename: `${folder}/info.txt`,
  });

  // 3. Log export
  chrome.storage.local.get({ exportLog: [] }, ({ exportLog }) => {
    exportLog.push({
      timestamp, name, address,
      photos: photos.length,
      folder,
      song: selectedSong ? `${selectedSong.name} – ${selectedSong.artist}` : null,
      platforms: [...activePlatforms],
    });
    chrome.storage.local.set({ exportLog });
  });

  // 4. Post to selected social platforms
  const platforms = [...activePlatforms];
  if (platforms.length > 0) {
    setStatus(`Opening ${platforms.join(", ")}…`);
    await postToSocialMedia(platforms, photoUris[0], caption);
  }

  setStatus(
    `✅ Exported ${photoUris.length} photos → Downloads/${folder}` +
    (platforms.length ? ` · Opening ${platforms.join(", ")}` : ""),
    "success"
  );
  $("exportBtn").disabled = false;
}

// ── Social media posting ──────────────────────────────────────────────────────

const PLATFORM_URLS = {
  instagram: "https://www.instagram.com/",
  facebook:  "https://www.facebook.com/",
  tiktok:    "https://www.tiktok.com/upload",
};

async function postToSocialMedia(platforms, firstPhotoUri, caption) {
  for (const platform of platforms) {
    try {
      // Open the platform's upload page in a new tab
      const tab = await chrome.tabs.create({
        url: PLATFORM_URLS[platform],
        active: false,
      });

      // Wait for the page to load, then inject a helper that pre-fills the caption
      // and — for Facebook — triggers the share dialog with the caption pre-filled.
      // Full automated upload requires the user to select the downloaded file.
      setTimeout(() => {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: injectSocialHelper,
          args: [platform, caption, firstPhotoUri],
        }).catch(err => console.warn(`Inject failed for ${platform}:`, err));
      }, 2500);

    } catch (err) {
      console.warn(`Could not open ${platform}:`, err);
    }
  }
}

// This function runs INSIDE the social media tab
function injectSocialHelper(platform, caption, photoUri) {
  if (platform === "facebook") {
    // Pre-fill the "What's on your mind?" box if visible
    const box = document.querySelector('[data-testid="status-attachment-mentions-input"]')
              || document.querySelector('[aria-label="What\'s on your mind?"]')
              || document.querySelector('[role="textbox"]');
    if (box) {
      box.focus();
      document.execCommand("insertText", false, caption);
    }
  }

  // Show a floating helper banner on all platforms
  const banner = document.createElement("div");
  banner.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
    background: #e8490f; color: #fff; font-family: sans-serif;
    font-size: 14px; font-weight: 600; padding: 10px 16px;
    display: flex; align-items: center; gap: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.3);
  `;
  banner.innerHTML = `
    <span>🍽️ FoodFluencer Bot</span>
    <span style="font-weight:400">Photos downloaded to your <strong>Downloads/FoodFluencer</strong> folder. Select them to post!</span>
    <button onclick="this.parentNode.remove()" style="margin-left:auto;background:rgba(255,255,255,.25);border:none;color:#fff;border-radius:6px;padding:3px 10px;cursor:pointer;">✕</button>
  `;
  document.body.prepend(banner);
}

// ── Usage stats shortcut ──────────────────────────────────────────────────────
// Already wired above. Re-check on popup open:
checkUsageWarning();

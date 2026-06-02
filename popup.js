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
const uriCache        = new Map(); // photoName|maxWidth → photoUri
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
  // Store ALL photos from API (up to ~10); display first MAX_PHOTOS
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
    photos: allPhotos.slice(0, CONFIG.MAX_PHOTOS), // currently shown
  };

  $("restaurantName").textContent    = currentRestaurant.name;
  $("restaurantAddress").textContent = currentRestaurant.address;
  $("restaurantMeta").textContent    = place.rating
    ? `⭐ ${place.rating} · ${(place.userRatingCount || 0).toLocaleString()} ratings` : "";

  const link = $("restaurantMapsLink");
  link.href = currentRestaurant.mapsUrl || "#";
  link.style.display = currentRestaurant.mapsUrl ? "inline" : "none";

  renderPhotoGrid();
  $("results").classList.remove("hidden");
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
  div.innerHTML = `
    <img src="${uri}" alt="Photo ${index + 1}" />
    <span class="photo-label">${index + 1}</span>
    <button class="dismiss-btn" title="Replace with another photo">✕</button>`;
  div.querySelector(".dismiss-btn").addEventListener("click", e => {
    e.stopPropagation();
    dismissPhoto(index);
  });
}

async function dismissPhoto(index) {
  const { photos, allPhotos } = currentRestaurant;
  const shownNames = new Set(photos.map(p => p.name));
  const next = allPhotos.find(p => !shownNames.has(p.name));

  const grid = $("photoGrid");
  const slot = grid.querySelector(`[data-slot="${index}"]`);

  if (next) {
    // Replace in-place
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
    // No more replacements — remove slot and re-index
    photos.splice(index, 1);
    renderPhotoGrid();
  }
}

// Build caption string (used internally — not shown in UI)
function buildCaption() {
  if (!currentRestaurant) return "";
  let text = `📍 ${currentRestaurant.name}\n${currentRestaurant.address}`;
  if (selectedSong) text += `\n🎵 ${selectedSong.name} – ${selectedSong.artist}`;
  return text;
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
  $("selectedSongArt").src            = song.artwork;
  $("selectedSongName").textContent   = song.name;
  $("selectedSongArtist").textContent = song.artist;
  $("selectedSong").classList.remove("hidden");
}

$("removeSongBtn").addEventListener("click", () => {
  selectedSong = null;
  $("selectedSong").classList.add("hidden");
});

// ── Export & Post ─────────────────────────────────────────────────────────────

$("exportBtn").addEventListener("click", exportAndPost);

// Resize + convert a photo URI to a compact JPEG data URL for injection
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
  const caption   = buildCaption();
  const songName  = selectedSong?.name || "";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName  = name.replace(/[/\\?%*:|"<>]/g, "_");
  const folder    = `FoodFluencer/${safeName}_${timestamp}`;

  $("exportBtn").disabled = true;
  setStatus("Resolving photos…");

  // 1. Resolve all photo URIs at full resolution
  const photoUris = [];
  for (const photo of photos) {
    try { photoUris.push(await resolvePhotoUri(photo.name, 1200)); }
    catch (e) { console.warn("Photo resolve failed:", e); }
  }

  // 2. Download all photos to disk
  setStatus("Saving photos…");
  photoUris.forEach((uri, i) => {
    chrome.runtime.sendMessage({
      type: "DOWNLOAD", url: uri,
      filename: `${folder}/photo_${String(i+1).padStart(2,"0")}.jpg`,
    });
  });

  // 3. Save info note
  const noteLines = [
    `Restaurant : ${name}`, `Address    : ${address}`,
    `Exported   : ${new Date().toLocaleString()}`, `Photos     : ${photos.length}`,
    selectedSong ? `Song       : ${selectedSong.name} – ${selectedSong.artist}` : null,
    ``, `Caption:`, caption,
  ].filter(l => l !== null);
  chrome.runtime.sendMessage({
    type: "DOWNLOAD",
    url: "data:text/plain;charset=utf-8," + encodeURIComponent(noteLines.join("\n")),
    filename: `${folder}/info.txt`,
  });

  // 4. Persist export log
  chrome.storage.local.get({ exportLog: [] }, ({ exportLog }) => {
    exportLog.push({ timestamp, name, address, photos: photos.length, folder,
      song: selectedSong ? `${selectedSong.name} – ${selectedSong.artist}` : null,
      platforms: [...activePlatforms] });
    chrome.storage.local.set({ exportLog });
  });

  // 5. Open social platforms with ALL photos pre-loaded
  const platforms = [...activePlatforms];
  if (platforms.length > 0 && photoUris.length > 0) {
    setStatus(`Resizing ${photoUris.length} photos for social media…`);
    const photoDataUrls = [];
    for (const uri of photoUris) {
      try { photoDataUrls.push(await photoToDataUrl(uri)); }
      catch (e) { console.warn("Photo resize failed:", e); }
    }

    if (photoDataUrls.length > 0) {
      for (const platform of platforms) {
        setStatus(`Opening ${platform}…`);
        chrome.runtime.sendMessage({ type: "OPEN_SOCIAL", platform, photoDataUrls, caption, songName });
        await new Promise(r => setTimeout(r, 900));
      }
      setStatus(`✅ Opened ${platforms.join(", ")} — ${photoDataUrls.length} photos &amp; caption injected!`, "success");
    } else {
      setStatus("⚠️ Could not prepare photos for social media.", "error");
    }
  } else {
    setStatus(`✅ Exported ${photoUris.length} photos → Downloads/${folder}`, "success");
  }

  $("exportBtn").disabled = false;
}

// Boot
checkUsageWarning();

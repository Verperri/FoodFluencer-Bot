// ── Constants ─────────────────────────────────────────────────────────────────

const PLACES_SEARCH = "https://places.googleapis.com/v1/places:searchText";
const PLACES_PHOTO  = "https://places.googleapis.com/v1";

const BELGIAN_RESTAURANTS = [
  "Comme Chez Soi Brussels",
  "In De Wulf Dranouter",
  "The Jane Antwerp",
  "Hof van Cleve Kruishoutem",
  "Bon Bon Brussels",
  "Zilte Antwerp",
  "De Karmeliet Bruges",
  "La Paix Brussels",
  "Bozar Restaurant Brussels",
  "Humphrey Brussels",
  "Vrijmoed Ghent",
  "OAK Ghent",
  "Balls & Glory Ghent",
  "Fiskebar Antwerp",
  "Dôme Antwerp",
  "Den Dyver Bruges",
  "Le Chalet de la Foret Brussels",
  "La Villa Lorraine Brussels",
  "La Menuiserie Ghent",
  "Gruut Stadsbrouwerij Ghent",
  "Le Tournant Liège",
  "Numerus Clausus Namur",
  "Braserie Appelmans Antwerp",
  "De Troubadour Bruges",
];

// ── State ─────────────────────────────────────────────────────────────────────

let currentRestaurant = null;
let API_KEY = "";

const $ = id => document.getElementById(id);

// ── API key setup ─────────────────────────────────────────────────────────────

function showKeySetup(show) {
  $("keySetup").classList.toggle("hidden", !show);
  $("query").closest(".search-section").classList.toggle("hidden", show);
  if (show) $("results").classList.add("hidden");
}

chrome.storage.local.get({ googleApiKey: "" }, ({ googleApiKey }) => {
  API_KEY = googleApiKey;
  showKeySetup(!API_KEY);
});

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

// ── Places API (New) helpers ──────────────────────────────────────────────────

async function searchRestaurant(query) {
  const searchQuery = /belgium/i.test(query) ? query : `${query} Belgium`;

  const res = await fetch(PLACES_SEARCH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask": [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.rating",
        "places.userRatingCount",
        "places.googleMapsUri",
        "places.photos",
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

function photoUrl(photoName, maxWidth = 400) {
  return `${PLACES_PHOTO}/${photoName}/media?maxWidthPx=${maxWidth}&key=${API_KEY}&skipHttpRedirect=true`;
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderResults(place) {
  const photos = (place.photos || []).slice(0, CONFIG.MAX_PHOTOS);

  currentRestaurant = {
    name:         place.displayName?.text || "",
    address:      place.formattedAddress || "",
    rating:       place.rating,
    totalRatings: place.userRatingCount,
    mapsUrl:      place.googleMapsUri || "",
    photos:       photos.map(p => ({ name: p.name })),
  };

  $("restaurantName").textContent    = currentRestaurant.name;
  $("restaurantAddress").textContent = currentRestaurant.address;
  $("restaurantMeta").textContent    = place.rating
    ? `⭐ ${place.rating} · ${place.userRatingCount?.toLocaleString() ?? 0} ratings`
    : "";

  const link = $("restaurantMapsLink");
  link.href         = currentRestaurant.mapsUrl || "#";
  link.style.display = currentRestaurant.mapsUrl ? "inline" : "none";

  const grid = $("photoGrid");
  grid.innerHTML = "";
  photos.forEach((photo, i) => {
    const div = document.createElement("div");
    div.className = "photo-item";

    // Resolve the media redirect first so the img src gets the real image URL
    fetch(photoUrl(photo.name, 400))
      .then(r => r.json())
      .then(({ photoUri }) => {
        const img = document.createElement("img");
        img.src = photoUri;
        img.alt = `Photo ${i + 1}`;
        const label = document.createElement("span");
        label.className = "photo-label";
        label.textContent = i + 1;
        div.appendChild(img);
        div.appendChild(label);
      })
      .catch(() => {
        div.innerHTML = `<div class="photo-error">Photo ${i + 1} unavailable</div>`;
      });

    grid.appendChild(div);
  });

  $("results").classList.remove("hidden");
}

// ── Search flow ───────────────────────────────────────────────────────────────

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

// ── Export ────────────────────────────────────────────────────────────────────

async function exportPhotos() {
  if (!currentRestaurant) return;

  const { name, address, photos } = currentRestaurant;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName  = name.replace(/[/\\?%*:|"<>]/g, "_");
  const folder    = `FoodFluencer/${safeName}_${timestamp}`;

  setStatus(`Downloading ${photos.length} photos…`);
  $("exportBtn").disabled = true;

  for (let i = 0; i < photos.length; i++) {
    try {
      const res  = await fetch(photoUrl(photos[i].name, 1200));
      const data = await res.json();
      chrome.runtime.sendMessage({
        type: "DOWNLOAD",
        url: data.photoUri,
        filename: `${folder}/photo_${String(i + 1).padStart(2, "0")}.jpg`,
      });
    } catch (e) {
      console.warn("Photo download failed:", e);
    }
  }

  // Save info note
  const note = [
    `Restaurant: ${name}`,
    `Address:    ${address}`,
    `Exported:   ${new Date().toLocaleString()}`,
    `Photos:     ${photos.length}`,
  ].join("\n");
  chrome.runtime.sendMessage({
    type: "DOWNLOAD",
    url: "data:text/plain;charset=utf-8," + encodeURIComponent(note),
    filename: `${folder}/info.txt`,
  });

  // Persist to log
  chrome.storage.local.get({ exportLog: [] }, ({ exportLog }) => {
    exportLog.push({ timestamp, name, address, photos: photos.length, folder });
    chrome.storage.local.set({ exportLog });
  });

  setStatus(`✅ Saved ${photos.length} photos → Downloads/${folder}`, "success");
  $("exportBtn").disabled = false;

  // Hook point for future social media auto-posting
  onExportComplete({ name, address, folder, photos });
}

function onExportComplete({ name, address, folder, photos }) {
  // TODO: auto-post to Instagram / Facebook / TikTok using the user's active session
}

// ── Event listeners ───────────────────────────────────────────────────────────

$("searchBtn").addEventListener("click", () => doSearch($("query").value));

$("query").addEventListener("keydown", e => {
  if (e.key === "Enter") doSearch($("query").value);
});

$("randomBtn").addEventListener("click", () => {
  const pick = BELGIAN_RESTAURANTS[Math.floor(Math.random() * BELGIAN_RESTAURANTS.length)];
  $("query").value = pick;
  doSearch(pick);
});

$("exportBtn").addEventListener("click", exportPhotos);

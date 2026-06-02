const BELGIAN_RESTAURANTS = [
  "Comme Chez Soi Brussels",
  "In De Wulf Dranouter",
  "The Jane Antwerp",
  "Hof van Cleve Kruishoutem",
  "Bon Bon Brussels",
  "Zilte Antwerp",
  "De Librije Bruges",
  "La Paix Brussels",
  "Bozar Restaurant Brussels",
  "De Karmeliet Bruges",
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

const BASE = "https://maps.googleapis.com/maps/api/place";

let currentRestaurant = null;
let API_KEY = "";

const $ = id => document.getElementById(id);

// ── API key setup ─────────────────────────────────────────────────────────────

function showKeySetup(show) {
  $("keySetup").classList.toggle("hidden", !show);
  $("query").closest(".search-section").classList.toggle("hidden", show);
  $("results").classList.toggle("hidden", show || !currentRestaurant);
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

function setStatus(msg, type = "loading") {
  const el = $("status");
  el.textContent = msg;
  el.className = `status status--${type}`;
  el.classList.remove("hidden");
  if (type !== "loading") setTimeout(() => el.classList.add("hidden"), 5000);
}

function setLoading(btn, on) {
  btn.disabled = on;
  if (!btn._orig) btn._orig = btn.textContent;
  btn.textContent = on ? "…" : btn._orig;
}

async function placesGet(path, params) {
  const url = new URL(`${BASE}/${path}/json`);
  Object.entries({ ...params, key: API_KEY }).forEach(([k, v]) =>
    url.searchParams.set(k, v)
  );
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function searchRestaurant(query) {
  const data = await placesGet("textsearch", {
    query: query.toLowerCase().includes("belgium") ? query : `${query} Belgium`,
    region: CONFIG.REGION,
    type: "restaurant",
  });
  if (data.status !== "OK" || !data.results?.length)
    throw new Error(`No restaurant found for "${query}" in Belgium.`);
  return data.results[0];
}

async function getDetails(placeId) {
  const data = await placesGet("details", {
    place_id: placeId,
    fields: "name,formatted_address,photos,url,rating,user_ratings_total",
  });
  return data.result || {};
}

function photoUrl(ref, maxWidth = 400) {
  return `${BASE}/photo?maxwidth=${maxWidth}&photo_reference=${ref}&key=${API_KEY}`;
}

function renderResults(data) {
  currentRestaurant = data;
  $("restaurantName").textContent = data.name;
  $("restaurantAddress").textContent = data.address;
  $("restaurantMeta").textContent = data.rating
    ? `⭐ ${data.rating} · ${data.totalRatings?.toLocaleString() ?? 0} ratings`
    : "";
  const link = $("restaurantMapsLink");
  link.href = data.mapsUrl || "#";
  link.style.display = data.mapsUrl ? "inline" : "none";

  const grid = $("photoGrid");
  grid.innerHTML = "";
  data.photos.forEach((photo, i) => {
    const div = document.createElement("div");
    div.className = "photo-item";
    div.innerHTML = `<img src="${photoUrl(photo.reference)}" alt="Photo ${i + 1}" /><span class="photo-label">${i + 1}</span>`;
    grid.appendChild(div);
  });

  $("results").classList.remove("hidden");
}

async function doSearch(query) {
  if (!query.trim()) return;
  setStatus("Searching…");
  try {
    const place = await searchRestaurant(query);
    const details = await getDetails(place.place_id);
    const photos = (details.photos || [])
      .sort((a, b) => (b.width || 0) - (a.width || 0))
      .slice(0, CONFIG.MAX_PHOTOS);

    renderResults({
      placeId: place.place_id,
      name: details.name || place.name,
      address: details.formatted_address || "",
      rating: details.rating,
      totalRatings: details.user_ratings_total,
      mapsUrl: details.url || "",
      photos: photos.map(p => ({
        reference: p.photo_reference,
        width: p.width,
        height: p.height,
      })),
    });
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
  const folder = `FoodFluencer/${name.replace(/[/\\?%*:|"<>]/g, "_")}_${timestamp}`;

  setStatus(`Downloading ${photos.length} photos…`);
  $("exportBtn").disabled = true;

  let saved = 0;
  for (let i = 0; i < photos.length; i++) {
    const url = photoUrl(photos[i].reference, 1200);
    chrome.runtime.sendMessage(
      { type: "DOWNLOAD", url, filename: `${folder}/photo_${String(i + 1).padStart(2, "0")}.jpg` },
      () => { saved++; }
    );
  }

  // Write info note as a data-URI text file
  const note = [
    `Restaurant: ${name}`,
    `Address:    ${address}`,
    `Exported:   ${new Date().toLocaleString()}`,
    `Photos:     ${photos.length}`,
  ].join("\n");
  const noteUri = "data:text/plain;charset=utf-8," + encodeURIComponent(note);
  chrome.runtime.sendMessage({ type: "DOWNLOAD", url: noteUri, filename: `${folder}/info.txt` });

  // Log to chrome.storage
  chrome.storage.local.get({ exportLog: [] }, ({ exportLog }) => {
    exportLog.push({ timestamp, name, address, photos: photos.length, folder });
    chrome.storage.local.set({ exportLog });
  });

  setStatus(`✅ Exported ${photos.length} photos to Downloads/${folder}`, "success");
  $("exportBtn").disabled = false;

  // Hook point for future social media posting
  onExportComplete({ name, address, folder, photos });
}

// Called after every successful export — wire up social posting here later
function onExportComplete({ name, address, folder, photos }) {
  // TODO: if user is logged into Instagram/Facebook/TikTok,
  // use their active session to post photos[0] with caption `${name} — ${address}`
}

// ── Event listeners ───────────────────────────────────────────────────────────

$("searchBtn").addEventListener("click", () => {
  doSearch($("query").value);
});

$("query").addEventListener("keydown", e => {
  if (e.key === "Enter") doSearch($("query").value);
});

$("randomBtn").addEventListener("click", async () => {
  const pick = BELGIAN_RESTAURANTS[Math.floor(Math.random() * BELGIAN_RESTAURANTS.length)];
  $("query").value = pick.replace(" Belgium", "").replace(/ (Brussels|Antwerp|Ghent|Bruges|Liège|Namur|Kruishoutem|Dranouter)$/, "");
  await doSearch(pick);
});

$("exportBtn").addEventListener("click", exportPhotos);

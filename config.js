const CONFIG = {
  REGION: "be",
  MAX_PHOTOS: 5,
  // Cloudflare Worker URL for opt-in centralized telemetry (image-feedback +
  // technical logs). Leave empty to disable telemetry entirely. See cloud/README.md.
  TELEMETRY_ENDPOINT: "https://foodfluencer-telemetry.stefanverresen.workers.dev",
};

// ── Shared reference data ─────────────────────────────────────────────────────
// Loaded verbatim by BOTH the popup (<script src="config.js">) and the service
// worker (importScripts('config.js')), so these are the single source of truth
// for country/type/city data — previously duplicated (and drift-prone) as the
// AB_*_BG copies in background.js and the AB_* copies in popup.js.

// UI type value → plain-language search term.
const SHARED_TYPE_QUERY = {
  restaurant: "restaurant",
  hotel:      "hotel",
  bar:        "bar",
};

// Country code → iTunes Store country code (for the Top-100 RSS feed / Search
// API). Luxembourg has no dedicated iTunes storefront, so it maps to Belgium.
const SHARED_ITUNES_CC = { BE: "be", FR: "fr", DE: "de", LU: "be", NL: "nl" };

// Country code → display name.
const SHARED_COUNTRY_NAMES = {
  BE: "Belgium",
  FR: "France",
  DE: "Germany",
  LU: "Luxembourg",
  NL: "The Netherlands",
};

// City pools — used when no specific region is selected so each search anchors
// to a different city (country-wide queries always return the same nationally
// popular places).
const SHARED_CITY_POOL = {
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

// Extracts the city from a Google-style formatted address: a 4-digit postcode,
// then the city up to the next comma or end-of-string. Deliberately does NOT
// anchor on a country name — Google returns the country localized ("België",
// "Deutschland"), so a country-anchored pattern silently failed and fell back to
// the street name. Single source of truth shared by the popup and service worker.
const SHARED_CITY_FROM_ADDRESS_RE = /\d{4}\s+([A-Za-zÀ-ÿ\s-]+?)(?:,|$)/;

// Region Round-Up caption building blocks (singular/plural type labels, header
// and intro templates per language). Identical in the popup preview and the
// service-worker post path — shared here to keep them in lockstep.
const SHARED_RR_TYPE_LABELS = {
  en: { restaurant: { s: "restaurant", p: "restaurants" }, hotel: { s: "hotel", p: "hotels" }, bar: { s: "bar", p: "bars" } },
  nl: { restaurant: { s: "restaurant", p: "restaurants" }, hotel: { s: "hotel", p: "hotels" }, bar: { s: "bar", p: "bars" } },
  fr: { restaurant: { s: "restaurant", p: "restaurants" }, hotel: { s: "hôtel", p: "hôtels" }, bar: { s: "bar", p: "bars" } },
  de: { restaurant: { s: "Restaurant", p: "Restaurants" }, hotel: { s: "Hotel", p: "Hotels" }, bar: { s: "Bar", p: "Bars" } },
};
const SHARED_RR_HEADER_TEMPLATES = {
  en: (n, p, region) => `🔝 Top ${n} ${p} in ${region}`,
  nl: (n, p, region) => `🔝 Top ${n} ${p} in ${region}`,
  fr: (n, p, region) => `🔝 Top ${n} ${p} à ${region}`,
  de: (n, p, region) => `🔝 Top ${n} ${p} in ${region}`,
};
const SHARED_RR_INTRO_TEMPLATES = {
  en: (region) => `Here's our pick of the best spots ${region} has to offer 👇`,
  nl: (region) => `Dit zijn de beste plekjes die ${region} te bieden heeft 👇`,
  fr: (region) => `Voici notre sélection des meilleures adresses à ${region} 👇`,
  de: (region) => `Das sind die besten Adressen, die ${region} zu bieten hat 👇`,
};

// ── Shared helpers ────────────────────────────────────────────────────────────
// Logic (not just reference data) that was previously copy-pasted verbatim into
// BOTH popup.js and background.js — a recurring drift hazard. Declared here once
// as the single source of truth. At runtime config.js loads into the same global
// scope as its host (importScripts() in the service worker, <script> in the
// popup), so these top-level declarations are visible to both, exactly like the
// SHARED_* data above.
//
// NOTE: sendTelemetry() is deliberately NOT shared here. It reads `CONFIG`
// lexically, and the Jest suite swaps CONFIG via a test-global before requiring
// the host file; moving sendTelemetry into this (separately require()d) module
// would bind it to config.js's own CONFIG instead of the host's. It therefore
// stays duplicated in each host — getInstallId() (no CONFIG dependency) is shared.

// Anonymous, per-install UUID used to group opt-in telemetry. Generated once on
// first use and persisted; every later call reuses the stored id.
async function getInstallId() {
  const { installId } = await chrome.storage.local.get({ installId: null });
  if (installId) return installId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installId: id });
  return id;
}

// Clears only the alarms belonging to one campaign (identified by its alarm
// name prefix) — leaves the other campaign's alarms untouched. Each campaign
// (single-spotlight "ffbot-auto-" vs region-roundup "ffbot-roundup-") runs on
// its own independent schedule, so pausing/deactivating one must not wipe the
// other's pending alarms.
async function clearAlarmsByPrefix(prefix) {
  const all = await chrome.alarms.getAll();
  await Promise.all(all.filter(a => a.name.startsWith(prefix)).map(a => chrome.alarms.clear(a.name)));
}

// Picks a random city from a country's pool — used when no specific region is
// selected so each search anchors to a different city (a country-wide query
// always returns the same nationally popular places). Falls back to Belgium.
function pickRandomCity(countryCode) {
  const pool = SHARED_CITY_POOL[countryCode] || SHARED_CITY_POOL.BE;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Content appeal heuristics ─────────────────────────────────────────────────
// On top of the technical pass/fail gate, candidate photos are ranked by an
// "appeal" score meant to proxy how engaging the content looks for a food/venue
// post — favouring vibrant, warm-toned shots with a clear central subject over
// flat, cold, or cluttered ones.
//
//   colorfulness  Hasler–Süsstrunk metric over the rg/yb opponent channels.
//                 Vibrant, colourful shots (food close-ups) score high; drab
//                 or monochrome scenes score low.
//
//   warmth        Mean (R - B) across pixels. Positive = warm tones (reds/
//                 oranges/browns typical of appetising food shots).
//
//   centerFocus   Ratio of edge energy (Laplacian²) in the center 50% of the
//                 frame vs. the surrounding border. >1 means the center is
//                 more "in focus"/detailed than the edges — suggests a clear
//                 subject rather than a busy or empty background.
//
// Returns { colorfulness, warmth, centerFocus, appeal } where `appeal` is a
// 0-100 weighted blend of the normalised sub-scores.
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

// Formats an OpenStreetMap (Overpass) element's address tags into a single
// "street number, postcode city, country" line — used by both the popup and the
// service-worker OSM discovery fallback so the address shape stays identical.
function formatOSMAddress(tags = {}, fallbackCity, country) {
  const parts = [];
  if (tags["addr:street"]) {
    parts.push(tags["addr:housenumber"] ? `${tags["addr:street"]} ${tags["addr:housenumber"]}` : tags["addr:street"]);
  }
  const city = tags["addr:city"] || fallbackCity;
  const cityLine = `${tags["addr:postcode"] || ""} ${city || ""}`.trim();
  if (cityLine) parts.push(cityLine);
  parts.push(country);
  return parts.filter(Boolean).join(", ");
}

// CommonJS export so the Jest harness can load this as the single source of
// truth too (no-op in the browser / service worker, where `module` is undefined).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CONFIG, SHARED_TYPE_QUERY, SHARED_COUNTRY_NAMES, SHARED_CITY_POOL,
    SHARED_CITY_FROM_ADDRESS_RE,
    SHARED_RR_TYPE_LABELS, SHARED_RR_HEADER_TEMPLATES, SHARED_RR_INTRO_TEMPLATES,
    SHARED_ITUNES_CC,
    getInstallId, clearAlarmsByPrefix, pickRandomCity, computeAppealMetrics,
    formatOSMAddress,
  };
}

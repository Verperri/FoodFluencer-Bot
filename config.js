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

// CommonJS export so the Jest harness can load this as the single source of
// truth too (no-op in the browser / service worker, where `module` is undefined).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CONFIG, SHARED_TYPE_QUERY, SHARED_COUNTRY_NAMES, SHARED_CITY_POOL,
    SHARED_CITY_FROM_ADDRESS_RE,
    SHARED_RR_TYPE_LABELS, SHARED_RR_HEADER_TEMPLATES, SHARED_RR_INTRO_TEMPLATES,
  };
}

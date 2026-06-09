// ── First-install flag ────────────────────────────────────────────────────────
// Sets hasSeenOnboarding:false on fresh install so the popup shows onboarding.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({ hasSeenOnboarding: false });
  }
});

// ── Auto Bot alarm handler ────────────────────────────────────────────────────
// Fires when a scheduled post time is reached.
// Logs the trigger and notifies the popup. Actual posting will be added in V1.5.

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith("ffbot-auto-")) return;

  const postIndex = parseInt(alarm.name.replace("ffbot-auto-", ""), 10);

  chrome.storage.local.get(["autoBotActive", "autoBotSchedule", "autoBotRunLog"], (data) => {
    if (!data.autoBotActive) return; // bot was deactivated

    const post = data.autoBotSchedule?.posts?.[postIndex];
    if (!post) return;

    const logEntry = {
      id:          `post-${Date.now()}`,
      ts:          new Date().toISOString(),
      postIndex,
      date:        post.date,
      time:        post.time,
      platforms:   post.platforms,
      status:      "triggered", // changes to "done" when posting is implemented in V1.5
    };

    const runLog = [...(data.autoBotRunLog || []), logEntry];
    chrome.storage.local.set({ autoBotRunLog: runLog });

    // Notify popup if open
    chrome.runtime.sendMessage({ type: "AUTO_BOT_TRIGGERED", logEntry }).catch(() => {});

    bgLog("info", `Auto Bot alarm triggered: post ${postIndex}`, {
      date:      post.date,
      time:      post.time,
      platforms: post.platforms,
    });

    // Trigger the full auto-posting flow
    autoPostNow(postIndex);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO BOT — full posting pipeline (runs in background service worker)
// ══════════════════════════════════════════════════════════════════════════════

// ── Helpers ───────────────────────────────────────────────────────────────────

const AB_PLACES_SEARCH = "https://places.googleapis.com/v1/places:searchText";
const AB_PLACES_PHOTO  = "https://places.googleapis.com/v1";
const AB_ITUNES_SEARCH = "https://itunes.apple.com/search";

const AB_TYPE_QUERY_BG = { restaurant:"restaurant", hotel:"hotel", bar:"bar" };
const AB_COUNTRY_NAMES_BG = { BE:"Belgium", FR:"France", DE:"Germany", LU:"Luxembourg", NL:"The Netherlands" };
const AB_BOUNDS_BG = {
  BE: { low:{latitude:49.5,longitude:2.5},  high:{latitude:51.5,longitude:6.4}  },
  FR: { low:{latitude:41.3,longitude:-5.1}, high:{latitude:51.1,longitude:9.6}  },
  DE: { low:{latitude:47.2,longitude:5.9},  high:{latitude:55.1,longitude:15.0} },
  LU: { low:{latitude:49.4,longitude:5.7},  high:{latitude:50.2,longitude:6.5}  },
  NL: { low:{latitude:50.7,longitude:3.3},  high:{latitude:53.6,longitude:7.2}  },
};

// City pools used when no specific region is selected.
// Cycling through cities gives genuine variety — the Places API always returns
// the same top-20 national results for a country-wide query, so we anchor each
// search to a different city to get a truly different result set every time.
const AB_CITY_POOL_BG = {
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

function pickRandomCity(countryCode) {
  const pool = AB_CITY_POOL_BG[countryCode] || AB_CITY_POOL_BG.BE;
  return pool[Math.floor(Math.random() * pool.length)];
}
const AB_ITUNES_CC_BG = { BE:"be", FR:"fr", DE:"de", LU:"be", NL:"nl" };

async function getApiKey() {
  return new Promise(res => chrome.storage.local.get({ googleApiKey:"" }, d => res(d.googleApiKey)));
}

// ── Business discovery waterfall ──────────────────────────────────────────────
// Tries sources in priority order, stopping as soon as one yields a result.
//
//  1. Google Maps search page   — no key needed; extracts displayName /
//     formattedAddress / rating from the JSON Google embeds in the HTML,
//     using the same field names as the Places API response.
//  2. Yelp search page          — no key needed; extracts business slugs as a
//     lighter fallback when Maps is unavailable or returns no parseable data.
//  3. Google Places API         — only attempted when an API key is configured;
//     delivers the richest structured data including photo references.
//  4. City fallback             — always available; returns a synthetic place so
//     the photo waterfall can still run and find real images.
async function searchAutoPlaceBG(config, apiKey) {
  const typeQ      = AB_TYPE_QUERY_BG[config.type] || "restaurant";
  const country    = AB_COUNTRY_NAMES_BG[config.country] || "Belgium";
  const city       = config.region || pickRandomCity(config.country);
  const minStars   = parseFloat(config.minStars   || "4");
  const minRatings = parseInt (config.minRatings  || "100", 10);

  bgLog('info', `AutoSearch: looking for ${typeQ} in ${city}, ${country}`);
  TechLog.info('SEARCH', 'auto_search_start', { type: typeQ, city, country, source: 'scrape' });

  // ── 1. Google Maps search HTML ─────────────────────────────────────────────
  try {
    const query = `${typeQ} in ${city} ${country}`;
    const html  = await Promise.race([
      fetch(`https://www.google.com/maps/search/${encodeURIComponent(query)}`,
        { headers: { 'User-Agent': SCRAPE_UA, 'Accept-Language': 'en-US,en;q=0.9' } })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
    ]);

    // Google Maps embeds business data using the same field names as the Places
    // API — extract them directly with regex.
    const names     = [...html.matchAll(/"displayName":\{"text":"([^"]{3,80})"/g)].map(m => m[1]);
    const addrs     = [...html.matchAll(/"formattedAddress":"([^"]{10,150})"/g)].map(m => m[1]);
    const ratings   = [...html.matchAll(/"rating":([\d.]+)/g)].map(m => parseFloat(m[1]));
    const revCounts = [...html.matchAll(/"userRatingCount":(\d+)/g)].map(m => parseInt(m[1], 10));

    if (names.length) {
      const candidates = names.map((name, i) => ({
        displayName:      { text: name },
        formattedAddress: addrs[i]     || `${city}, ${country}`,
        rating:           ratings[i]   || 0,
        userRatingCount:  revCounts[i] || 0,
        photos: [],
      }));
      const filtered = candidates.filter(p => p.rating >= minStars && p.userRatingCount >= minRatings);
      const pool     = filtered.length ? filtered : candidates;
      const pick     = pool[Math.floor(Math.random() * pool.length)];
      bgLog('info', `AutoSearch[Maps]: ${candidates.length} found, ${filtered.length} quality — picked "${pick.displayName.text}"`);
      TechLog.info('SEARCH', 'auto_search_done', {
        source: 'maps_scrape', total: candidates.length, quality: filtered.length,
        picked: pick.displayName.text,
      });
      return pick;
    }
    bgLog('warn', 'AutoSearch[Maps]: no parseable businesses in HTML — trying Yelp');
  } catch(e) {
    bgLog('warn', `AutoSearch[Maps] failed: ${e.message} — trying Yelp`);
    TechLog.warn('SEARCH', 'auto_search_error', { source: 'maps_scrape', error: e.message });
  }

  // ── 2. Yelp search page ────────────────────────────────────────────────────
  try {
    const html = await Promise.race([
      fetch(
        `https://www.yelp.com/search?find_desc=${encodeURIComponent(typeQ)}&find_loc=${encodeURIComponent(`${city}, ${country}`)}`,
        { headers: { 'User-Agent': SCRAPE_UA, 'Accept-Language': 'en-US,en;q=0.9' } })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
    ]);

    if (/datadome|are you a robot/i.test(html)) throw new Error('DataDome block');

    // Extract business slugs and convert to human-readable names.
    // Slug format: "le-pain-quotidien-brussels-3" → "Le Pain Quotidien"
    const slugs = [...new Set(
      [...html.matchAll(/href="\/biz\/([a-z0-9][a-z0-9-]{3,60})(?:[?"#][^"]*)?"/g)].map(m => m[1])
    )];

    if (slugs.length) {
      const toName = slug => slug
        .replace(/-\d+$/, '')   // drop trailing numeric suffix
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

      const candidates = slugs.slice(0, 12).map(slug => ({
        displayName:      { text: toName(slug) },
        formattedAddress: `${city}, ${country}`,
        rating:           0,
        userRatingCount:  0,
        photos:           [],
      }));
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      bgLog('info', `AutoSearch[Yelp]: ${candidates.length} slugs — picked "${pick.displayName.text}"`);
      TechLog.info('SEARCH', 'auto_search_done', {
        source: 'yelp_scrape', total: candidates.length, picked: pick.displayName.text,
      });
      return pick;
    }
    bgLog('warn', 'AutoSearch[Yelp]: no slugs found');
  } catch(e) {
    bgLog('warn', `AutoSearch[Yelp] failed: ${e.message}`);
    TechLog.warn('SEARCH', 'auto_search_error', { source: 'yelp_scrape', error: e.message });
  }

  // ── 3. Google Places API ──────────────────────────────────────────────────
  // Only attempted when an API key is configured. Skipped entirely otherwise
  // so no quota is consumed for users without a key.
  if (apiKey) {
    try {
      bgLog('info', `AutoSearch[Places API] fallback for ${typeQ} in ${city}`);
      const bounds  = AB_BOUNDS_BG[config.country] || AB_BOUNDS_BG.BE;
      const locPart = `${city}, ${country}`;
      const res = await Promise.race([
        fetch(AB_PLACES_SEARCH, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.photos',
          },
          body: JSON.stringify({
            textQuery: `${typeQ} in ${locPart}`,
            maxResultCount: 20,
            minRating: minStars,
            locationRestriction: { rectangle: bounds },
          }),
        }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
      ]);

      if (res.places?.length) {
        const filtered = res.places.filter(p =>
          (p.userRatingCount || 0) >= minRatings
        );
        const pool = filtered.length ? filtered : res.places;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        bgLog('info', `AutoSearch[Places API]: ${res.places.length} found, ${filtered.length} quality — picked "${pick.displayName?.text}"`);
        TechLog.info('SEARCH', 'auto_search_done', {
          source: 'places_api', total: res.places.length, quality: filtered.length,
          picked: pick.displayName?.text,
        });
        return pick;
      }
    } catch(e) {
      bgLog('warn', `AutoSearch[Places API] failed: ${e.message}`);
      TechLog.warn('SEARCH', 'auto_search_error', { source: 'places_api', error: e.message });
    }
  }

  // ── 4. City fallback ───────────────────────────────────────────────────────
  // All discovery sources failed. Return a city-level placeholder so the photo
  // waterfall can still run and produce real images for the post.
  bgLog('warn', `AutoSearch: all sources failed — using city fallback (${city})`);
  TechLog.warn('SEARCH', 'auto_search_fallback', { city, type: typeQ });
  return {
    displayName:      { text: `${typeQ} ${city}` },
    formattedAddress: `${city}, ${country}`,
    rating:           0,
    userRatingCount:  0,
    photos:           [],
  };
}

async function resolvePhotoUriBG(photoName, maxWidth, apiKey) {
  const res  = await fetch(`${AB_PLACES_PHOTO}/${photoName}/media?maxWidthPx=${maxWidth}&key=${apiKey}&skipHttpRedirect=true`);
  const data = await res.json();
  return data.photoUri;
}

// Generates a small, locally-drawn test image (no network involved) — used as a
// fallback for the Instagram diagnostic's photo-retrieval step when the live
// scrape waterfall comes back empty (Google Maps / DuckDuckGo / Yelp are flaky,
// rate-limited, third-party sources — an empty result there says nothing about
// whether Instagram's *composer* can be driven). This mirrors the same principle
// already used for TikTok, which generates its own synthetic test clip locally
// (via canvas + MediaRecorder) so its later checks never depend on an external
// source's availability.
async function generateSyntheticTestPhotoDataUrl() {
  const canvas = new OffscreenCanvas(1080, 1080);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3a6ea5';
  ctx.fillRect(0, 0, 1080, 1080);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 54px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('FoodFluencer', 540, 500);
  ctx.font = '36px sans-serif';
  ctx.fillText('diagnostic test photo', 540, 560);
  ctx.fillText('(generated locally — never posted)', 540, 610);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  const parts = [];
  for (let i = 0; i < bytes.length; i += 8192)
    parts.push(String.fromCharCode(...bytes.slice(i, i + 8192)));
  return `data:image/jpeg;base64,${btoa(parts.join(''))}`;
}

async function fetchAsDataUrl(url, signal) {
  const res  = await fetch(url, signal ? { signal } : undefined);
  const blob = await res.blob();
  const ab   = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  const parts = [];
  for (let i = 0; i < bytes.length; i += 8192)
    parts.push(String.fromCharCode(...bytes.slice(i, i + 8192)));
  return `data:${blob.type || "image/jpeg"};base64,${btoa(parts.join(''))}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Image Quality Scorer — canvas-based, zero-cost, runs in the service worker
//
// Draws each downloaded image onto a small OffscreenCanvas (150×150) and derives
// four pixel-level metrics:
//
//   blur        Laplacian variance — measures edge sharpness.
//               Sharp images have high local gradient variance; blurry or
//               heavily-compressed images look "smooth" and score low.
//               Threshold: < 80  → rejected as blurry.
//
//   brightness  Mean luminance (0–255, rec.601 weighting).
//               Threshold: < 40  → too dark; > 220 → overexposed.
//
//   contrast    Standard deviation of per-pixel luminance.
//               Flat, washed-out images score low.
//               Threshold: < 20  → rejected as low contrast.
//
//   saturation  Mean HSL saturation (0–100 %).
//               Catches accidental greyscale, heavily-tinted, or near-B&W images.
//               Threshold: < 8 % → rejected as near-greyscale.
//
// Returns { blur, brightness, contrast, saturation, passed, reasons[] }.
// A photo passes only when all four metrics are within acceptable bounds.
// ═══════════════════════════════════════════════════════════════════════════════

async function scoreImageQuality(dataUrl) {
  try {
    const SIZE = 150;
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d');

    // Decode the data-URL into a bitmap and draw it at analysis resolution
    const blob   = await fetch(dataUrl).then(r => r.blob());
    const bitmap = await createImageBitmap(blob);
    ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
    bitmap.close();

    const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
    const total    = SIZE * SIZE;

    // ── Greyscale luminance array ─────────────────────────────────────────────
    const gray  = new Float32Array(total);
    let   sumL  = 0;
    for (let i = 0; i < total; i++) {
      const lum  = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      gray[i]    = lum;
      sumL      += lum;
    }
    const brightness = sumL / total;

    // ── Contrast = std-dev of luminance ───────────────────────────────────────
    let sumSq = 0;
    for (let i = 0; i < total; i++) {
      const d = gray[i] - brightness;
      sumSq  += d * d;
    }
    const contrast = Math.sqrt(sumSq / total);

    // ── Blur = variance of the Laplacian (3×3 kernel) ─────────────────────────
    // Kernel: [0, 1, 0,  1, -4, 1,  0, 1, 0]
    // High variance → lots of sharp edges → sharp image.
    // Low variance  → smooth gradients everywhere → blurry image.
    let lapSum = 0, lapSumSq = 0, lapCount = 0;
    for (let y = 1; y < SIZE - 1; y++) {
      for (let x = 1; x < SIZE - 1; x++) {
        const idx = y * SIZE + x;
        const lap = gray[idx - SIZE] + gray[idx + SIZE]
                  + gray[idx - 1]   + gray[idx + 1]
                  - 4 * gray[idx];
        lapSum   += lap;
        lapSumSq += lap * lap;
        lapCount++;
      }
    }
    const lapMean  = lapSum / lapCount;
    const blurScore = lapSumSq / lapCount - lapMean * lapMean; // variance

    // ── Saturation = mean HSL saturation (0–100 %) ────────────────────────────
    let satSum = 0;
    for (let i = 0; i < total; i++) {
      const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l   = (max + min) / 2;
      const s   = max === min ? 0 : (max - min) / (l > 0.5 ? 2 - max - min : max + min);
      satSum   += s;
    }
    const saturation = (satSum / total) * 100;

    // ── Gate each metric ──────────────────────────────────────────────────────
    const reasons = [];
    if (blurScore   <  80)  reasons.push(`blurry (Laplacian variance ${blurScore.toFixed(0)})`);
    if (brightness  <  40)  reasons.push(`too dark (brightness ${brightness.toFixed(0)}/255)`);
    if (brightness  > 220)  reasons.push(`overexposed (brightness ${brightness.toFixed(0)}/255)`);
    if (contrast    <  20)  reasons.push(`low contrast (σ ${contrast.toFixed(0)})`);
    if (saturation  <   8)  reasons.push(`near-greyscale (saturation ${saturation.toFixed(1)} %)`);

    return { blur: blurScore, brightness, contrast, saturation, passed: reasons.length === 0, reasons };
  } catch (e) {
    // If scoring itself fails for any reason, let the photo through rather than
    // silently dropping a potentially good image.
    bgLog('warn', `PhotoQuality: scoring error — letting photo through (${e.message})`);
    return { blur: 999, brightness: 128, contrast: 50, saturation: 50, passed: true, reasons: [] };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Photo Waterfall — 4 sources tried in order, each with quality threshold
//
//  1. Google Maps embedded JSON   (venue-specific, highest quality)
//  2. DuckDuckGo image search     (broadest coverage, no slug needed)
//  3. Yelp photo pages            (categorised food/interior photos)
//  4. Google Places API           (existing fallback — uses API quota)
//
// Each scraped photo is tagged with its source for TechLog tracing.
// ═══════════════════════════════════════════════════════════════════════════════

const SCRAPE_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CITY_FROM_ADDRESS_RE_BG = /\d{4}\s+([A-Za-zÀ-ÿ\s-]+),/;
const SCRAPE_MIN = 3;   // minimum usable photos before accepting a source

function raceTimeout(promise, ms) {
  return Promise.race([promise, new Promise(res => setTimeout(() => res([]), ms))]);
}

// ── Source 1: Google Maps embedded JSON ──────────────────────────────────────
// Fetches the Maps search page and extracts lh3.googleusercontent.com photo
// URLs from the server-rendered JSON blobs. Photos are ordered by engagement
// (views / quality score) in the embedded data.
async function scrapeGoogleMapsPhotos(businessName, city) {
  const query = `${businessName} ${city}`;
  bgLog('info', 'PhotoScrape[GoogleMaps] start', { query });
  try {
    const res = await fetch(
      `https://www.google.com/maps/search/${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': SCRAPE_UA, 'Accept-Language': 'en-US,en;q=0.9' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const urls = new Set();

    // Pattern A: direct lh3 URL (already includes photo ID + optional size suffix)
    for (const m of html.matchAll(/https:\/\/lh3\.googleusercontent\.com\/p\/([A-Za-z0-9_\-]{20,})/g))
      urls.add(`https://lh3.googleusercontent.com/p/${m[1]}=s1200`);

    // Pattern B: AF1Qip photo IDs embedded in protobuf JSON
    for (const m of html.matchAll(/AF1Qip([A-Za-z0-9_\-]{20,})/g))
      urls.add(`https://lh3.googleusercontent.com/p/AF1Qip${m[1]}=s1200`);

    // Pattern C: gps-cs-s sub-path
    for (const m of html.matchAll(/https:\/\/lh3\.googleusercontent\.com\/gps-cs-s\/([A-Za-z0-9_\-]{20,})/g))
      urls.add(`https://lh3.googleusercontent.com/gps-cs-s/${m[1]}=s1200`);

    const result = [...urls].slice(0, 12);
    bgLog('info', `PhotoScrape[GoogleMaps] found ${result.length} URLs`);
    TechLog.info('PHOTO', 'google_maps_scrape', { business: businessName, city, count: result.length });
    return result;
  } catch(e) {
    bgLog('warn', `PhotoScrape[GoogleMaps] failed: ${e.message}`);
    TechLog.warn('PHOTO', 'google_maps_scrape_error', { error: e.message });
    return [];
  }
}

// ── Source 2: DuckDuckGo image search (vqd-token flow) ───────────────────────
// Two-step: get vqd session token, then query the i.js image endpoint.
// Filters out stock-photo sites and extreme aspect ratios.
// Returns DDG proxy thumbnail URLs (external-content.duckduckgo.com) which
// are always fetchable without additional CORS issues.
async function scrapeDDGPhotos(businessName, city, entityType) {
  const query = `"${businessName}" ${city} ${entityType} food interior atmosphere`;
  bgLog('info', 'PhotoScrape[DDG] start', { query });
  try {
    // Step 1: obtain vqd session token
    const initRes = await fetch('https://duckduckgo.com/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': SCRAPE_UA },
      body: new URLSearchParams({ q: query }).toString(),
    });
    if (!initRes.ok) throw new Error(`vqd fetch HTTP ${initRes.status}`);
    const initHtml = await initRes.text();

    const vqd = (initHtml.match(/vqd=['"]?([\d-]+)['"]?/) || initHtml.match(/vqd=([\d-]+)/) || [])[1];
    if (!vqd) throw new Error('vqd token not found');

    // Step 2: image search endpoint
    const params = new URLSearchParams({ q: query, o: 'json', l: 'us-en', vqd, f: ',,,,,', p: '-1', s: '0' });
    const imgRes = await fetch(`https://duckduckgo.com/i.js?${params}`, {
      headers: {
        'User-Agent': SCRAPE_UA,
        'Referer': 'https://duckduckgo.com/',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
      },
    });
    if (!imgRes.ok) throw new Error(`i.js HTTP ${imgRes.status}`);
    const data = await imgRes.json();

    const STOCK_RE = /shutterstock|getty|istock|alamy|dreamstime|depositphotos|fotolia|123rf|bigstock/i;
    const filtered = (data.results || [])
      .filter(r => r.width >= 800 && r.height >= 600)
      .filter(r => !STOCK_RE.test(r.url || ''))
      .filter(r => (r.width / r.height) < 3 && (r.height / r.width) < 3);

    // Use DDG proxy thumbnail — always accessible, avoids arbitrary domain CORS
    const urls = filtered.map(r => r.thumbnail || r.image).filter(Boolean).slice(0, 12);

    bgLog('info', `PhotoScrape[DDG] ${filtered.length} quality results from ${(data.results||[]).length} total`);
    TechLog.info('PHOTO', 'ddg_scrape', {
      business: businessName, city, total: (data.results||[]).length, filtered: filtered.length,
    });
    return urls;
  } catch(e) {
    bgLog('warn', `PhotoScrape[DDG] failed: ${e.message}`);
    TechLog.warn('PHOTO', 'ddg_scrape_error', { error: e.message });
    return [];
  }
}

// ── Source 3: Yelp photo pages ────────────────────────────────────────────────
// Searches Yelp for the business, extracts the slug, then fetches the
// food + inside photo tabs. Uses Yelp CDN URL regex — robust to class-name churn.
// Gracefully detects DataDome blocks and returns empty rather than crashing.
async function scrapeYelpPhotos(businessName, city) {
  bgLog('info', 'PhotoScrape[Yelp] start', { businessName, city });
  try {
    const searchRes = await fetch(
      `https://www.yelp.com/search?find_desc=${encodeURIComponent(businessName)}&find_loc=${encodeURIComponent(city)}`,
      { headers: { 'User-Agent': SCRAPE_UA, 'Accept-Language': 'en-US,en;q=0.9' } }
    );
    if (!searchRes.ok) throw new Error(`search HTTP ${searchRes.status}`);
    const searchHtml = await searchRes.text();

    if (/datadome|are you a robot/i.test(searchHtml)) {
      bgLog('warn', 'PhotoScrape[Yelp] DataDome block detected');
      TechLog.warn('PHOTO', 'yelp_blocked', { reason: 'DataDome' });
      return [];
    }

    const slugM = searchHtml.match(/href="\/biz\/([a-z0-9-]+)(?:[?"][^>]*)?"/);
    if (!slugM) { bgLog('warn', 'PhotoScrape[Yelp] no slug found'); return []; }
    const slug = slugM[1];
    bgLog('info', `PhotoScrape[Yelp] slug: ${slug}`);

    const allPhotos = new Set();
    for (const tab of ['food', 'inside', 'outside']) {
      await new Promise(r => setTimeout(r, 600)); // polite crawl delay
      try {
        const photoRes = await fetch(`https://www.yelp.com/biz/${slug}/photos?tab=${tab}`, {
          headers: { 'User-Agent': SCRAPE_UA, 'Referer': 'https://www.yelp.com/' },
        });
        if (!photoRes.ok) continue;
        const html = await photoRes.text();
        if (/datadome/i.test(html)) continue;

        for (const m of html.matchAll(/https:\/\/s3-media\d+\.fl\.yelpcdn\.com\/bphoto\/([A-Za-z0-9_\-]+)\/[a-z0-9]+\.jpg/g))
          allPhotos.add(`https://s3-media1.fl.yelpcdn.com/bphoto/${m[1]}/o.jpg`);
      } catch(_) {}
    }

    const result = [...allPhotos].slice(0, 12);
    bgLog('info', `PhotoScrape[Yelp] found ${result.length} photos for "${slug}"`);
    TechLog.info('PHOTO', 'yelp_scrape', { slug, count: result.length });
    return result;
  } catch(e) {
    bgLog('warn', `PhotoScrape[Yelp] failed: ${e.message}`);
    TechLog.warn('PHOTO', 'yelp_scrape_error', { error: e.message });
    return [];
  }
}

// Searches TripAdvisor for the business and scrapes the photo page.
// Follows same pattern as scrapeYelpPhotos — polite delays, graceful fallback.
async function scrapeTripAdvisorPhotos(businessName, city) {
  bgLog('info', 'PhotoScrape[TripAdvisor] start', { businessName, city });
  try {
    const searchRes = await fetch(
      `https://www.tripadvisor.com/Search?q=${encodeURIComponent(businessName + ' ' + city)}&searchSessionId=&sid=&blockRedirect=true`,
      { headers: { 'User-Agent': SCRAPE_UA, 'Accept-Language': 'en-US,en;q=0.9' } }
    );
    if (!searchRes.ok) throw new Error(`search HTTP ${searchRes.status}`);
    const searchHtml = await searchRes.text();

    if (/are you a human|captcha|blocked/i.test(searchHtml)) {
      bgLog('warn', 'PhotoScrape[TripAdvisor] bot-detection block');
      TechLog.warn('PHOTO', 'tripadvisor_blocked', { reason: 'bot-detection' });
      return [];
    }

    // Match Restaurant_Review or Hotel_Review or Attraction_Review slugs
    const slugM = searchHtml.match(/href="(\/(?:Restaurant|Hotel|Attraction)_Review-[^"]+)"/);
    if (!slugM) { bgLog('warn', 'PhotoScrape[TripAdvisor] no review slug found'); return []; }
    const slug = slugM[1].split('?')[0]; // strip query params
    bgLog('info', `PhotoScrape[TripAdvisor] slug: ${slug}`);

    await new Promise(r => setTimeout(r, 800)); // polite crawl delay

    // Fetch the /Photos sub-page for this listing
    const photoPageUrl = `https://www.tripadvisor.com${slug.replace(/-Reviews-/, '-Photos-')}`;
    const photoRes = await fetch(photoPageUrl, {
      headers: { 'User-Agent': SCRAPE_UA, 'Referer': 'https://www.tripadvisor.com/' },
    });
    if (!photoRes.ok) throw new Error(`photos HTTP ${photoRes.status}`);
    const photoHtml = await photoRes.text();

    if (/are you a human|captcha/i.test(photoHtml)) {
      bgLog('warn', 'PhotoScrape[TripAdvisor] bot-detection on photos page');
      return [];
    }

    const allPhotos = new Set();
    // data-src on <img> tags (lazy-loaded CDN images)
    for (const m of photoHtml.matchAll(/data-src="(https:\/\/(?:dynamic-media|media)[-a-z0-9.]*\.tripadvisor\.com\/[^"]+\.(?:jpg|jpeg|png))"/gi))
      allPhotos.add(m[1].replace(/\/\d+x\d+(\/|$)/, '/0x0$1')); // request max resolution
    // Also capture standard src URLs from TripAdvisor CDN
    for (const m of photoHtml.matchAll(/src="(https:\/\/(?:dynamic-media|media)[-a-z0-9.]*\.tripadvisor\.com\/[^"]+\.(?:jpg|jpeg|png))"/gi))
      allPhotos.add(m[1]);

    const result = [...allPhotos].slice(0, 12);
    bgLog('info', `PhotoScrape[TripAdvisor] found ${result.length} photos for "${slug}"`);
    TechLog.info('PHOTO', 'tripadvisor_scrape', { slug, count: result.length });
    return result;
  } catch(e) {
    bgLog('warn', `PhotoScrape[TripAdvisor] failed: ${e.message}`);
    TechLog.warn('PHOTO', 'tripadvisor_scrape_error', { error: e.message });
    return [];
  }
}

const FOURSQUARE_QUOTA_KEY = 'foursquareQuota';
const FOURSQUARE_DAILY_LIMIT = 950;

// Returns Foursquare venue photo URLs for the business.
// Tracks daily call count in chrome.storage.local; skips if limit reached.
async function fetchFoursquarePhotos(businessName, city, apiKey) {
  if (!apiKey) return [];

  // Check / reset daily quota
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const stored = await chrome.storage.local.get({ [FOURSQUARE_QUOTA_KEY]: { count: 0, date: '' } });
  let quota = stored[FOURSQUARE_QUOTA_KEY];
  if (quota.date !== today) quota = { count: 0, date: today };
  if (quota.count >= FOURSQUARE_DAILY_LIMIT) {
    bgLog('warn', `PhotoScrape[Foursquare] daily limit reached (${quota.count}/${FOURSQUARE_DAILY_LIMIT})`);
    TechLog.warn('PHOTO', 'foursquare_quota_exceeded', { count: quota.count, limit: FOURSQUARE_DAILY_LIMIT });
    return [];
  }

  bgLog('info', 'PhotoScrape[Foursquare] start', { businessName, city, quota: quota.count });
  try {
    // Search for the venue
    const searchUrl = `https://api.foursquare.com/v3/places/search?query=${encodeURIComponent(businessName)}&near=${encodeURIComponent(city)}&limit=1`;
    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: apiKey, Accept: 'application/json' },
    });
    quota.count++;
    await chrome.storage.local.set({ [FOURSQUARE_QUOTA_KEY]: quota });

    if (!searchRes.ok) throw new Error(`search HTTP ${searchRes.status}`);
    const searchData = await searchRes.json();
    const venue = searchData.results?.[0];
    if (!venue) { bgLog('warn', 'PhotoScrape[Foursquare] no venue found'); return []; }
    const fsqId = venue.fsq_id;
    bgLog('info', `PhotoScrape[Foursquare] venue: ${venue.name} (${fsqId})`);

    // Fetch photos for the venue
    const photosUrl = `https://api.foursquare.com/v3/places/${fsqId}/photos?limit=10&sort=POPULAR`;
    const photosRes = await fetch(photosUrl, {
      headers: { Authorization: apiKey, Accept: 'application/json' },
    });
    quota.count++;
    await chrome.storage.local.set({ [FOURSQUARE_QUOTA_KEY]: quota });

    if (!photosRes.ok) throw new Error(`photos HTTP ${photosRes.status}`);
    const photosData = await photosRes.json();

    const urls = (photosData || []).map(p => `${p.prefix}original${p.suffix}`);
    bgLog('info', `PhotoScrape[Foursquare] found ${urls.length} photos (quota: ${quota.count}/${FOURSQUARE_DAILY_LIMIT})`);
    TechLog.info('PHOTO', 'foursquare_photos', { fsqId, count: urls.length, quota: quota.count });
    return urls;
  } catch(e) {
    bgLog('warn', `PhotoScrape[Foursquare] failed: ${e.message}`);
    TechLog.warn('PHOTO', 'foursquare_error', { error: e.message });
    return [];
  }
}

// ── Waterfall orchestrator ────────────────────────────────────────────────────
// Sources are tried in priority order. Rather than returning as soon as one
// source meets the minimum threshold, the waterfall now *accumulates* quality-
// passing photos across sources until the target count is reached.
//
// Concretely: if Google Maps yields 2 good photos and the target is 4, the
// waterfall continues to DuckDuckGo and collects the remaining 2 from there
// (or Yelp, or Google Places API as a last resort). Quality-rejected photos
// from a source are automatically replaced by additional candidates from that
// same source first; only once a source's URL pool is exhausted does the
// waterfall advance to the next one.
//
// The `source` field in the return value reflects the first (primary) source
// that contributed photos. When multiple sources are needed, `photoLog` records
// the origin of every individual photo for full TechLog traceability.
async function fetchPhotosWaterfall(businessName, address, entityType, minPics, apiKey, placePhotoObjects, foursquareApiKey = null) {
  const cityM = address.match(CITY_FROM_ADDRESS_RE_BG);
  const city  = (cityM?.[1] || address.split(',')[0] || '').trim();
  const target = Math.min(Math.max(minPics, SCRAPE_MIN), 5);

  bgLog('info', `PhotoWaterfall start — "${businessName}" ${city}, target=${target}`);
  TechLog.info('PHOTO', 'waterfall_start', { businessName, city, entityType, target });

  // Shared accumulator — filled incrementally across sources.
  const collected = [];

  // Convert scraped URLs → quality-passing data URLs, contributing up to
  // `needed` photos into `collected`. Exhausts the full URL list before
  // giving up so that every candidate from a source is evaluated before
  // moving on. Quality failures are logged and skipped; the loop simply
  // continues to the next URL in the same source's pool.
  async function collectFromUrls(urls, sourceName) {
    const needed = target - collected.length;
    if (needed <= 0) return;

    let accepted = 0, rejected = 0;
    for (const url of urls) {
      if (collected.length >= target) break;
      try {
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 9000);
        let dataUrl;
        try {
          dataUrl = await fetchAsDataUrl(url, controller.signal);
        } finally {
          clearTimeout(timeoutId);
        }

        // ── Canvas-based quality gate ──────────────────────────────────────
        const quality = await scoreImageQuality(dataUrl);
        if (!quality.passed) {
          rejected++;
          bgLog('info', `PhotoQuality[${sourceName}]: ✗ ${url.slice(0, 80)} — ${quality.reasons.join(', ')}`);
          TechLog.info('PHOTO', 'quality_rejected', {
            source: sourceName,
            url: url.slice(0, 120),
            reasons: quality.reasons,
            metrics: {
              blur:       Math.round(quality.blur),
              brightness: Math.round(quality.brightness),
              contrast:   Math.round(quality.contrast),
              saturation: +quality.saturation.toFixed(1),
            },
          });
          continue;
        }
        accepted++;
        bgLog('info', `PhotoQuality[${sourceName}]: ✓ blur=${quality.blur.toFixed(0)} bright=${quality.brightness.toFixed(0)} contrast=${quality.contrast.toFixed(0)} sat=${quality.saturation.toFixed(1)}% (${collected.length + 1}/${target})`);
        // ──────────────────────────────────────────────────────────────────

        collected.push({ dataUrl, sourceUrl: url, source: sourceName });
      } catch(_) {}
    }

    if (accepted > 0) {
      bgLog('info', `PhotoWaterfall[${sourceName}]: contributed ${accepted} photos (${rejected} rejected) — total ${collected.length}/${target}`);
      TechLog.info('PHOTO', 'source_contribution', {
        source: sourceName, accepted, rejected, total: collected.length, target,
      });
    } else {
      bgLog('info', `PhotoWaterfall[${sourceName}]: 0 quality photos from ${urls.length} URLs (${rejected} rejected)`);
    }
  }

  // ── 1. Google Maps ─────────────────────────────────────────────────────────
  const gmUrls = await raceTimeout(scrapeGoogleMapsPhotos(businessName, city), 10000);
  if (gmUrls.length > 0) await collectFromUrls(gmUrls, 'google_maps');

  // ── 2. DuckDuckGo — only if still short of target ─────────────────────────
  if (collected.length < target) {
    bgLog('info', `PhotoWaterfall: need ${target - collected.length} more — trying DuckDuckGo`);
    const ddgUrls = await raceTimeout(scrapeDDGPhotos(businessName, city, entityType), 14000);
    if (ddgUrls.length > 0) await collectFromUrls(ddgUrls, 'duckduckgo');
  }

  // ── 3. Yelp — only if still short of target ───────────────────────────────
  if (collected.length < target) {
    bgLog('info', `PhotoWaterfall: need ${target - collected.length} more — trying Yelp`);
    const yelpUrls = await raceTimeout(scrapeYelpPhotos(businessName, city), 18000);
    if (yelpUrls.length > 0) await collectFromUrls(yelpUrls, 'yelp');
  }

  // ── 3.5 TripAdvisor — only if still short of target ──────────────────────
  if (collected.length < target) {
    bgLog('info', `PhotoWaterfall: need ${target - collected.length} more — trying TripAdvisor`);
    const taUrls = await raceTimeout(scrapeTripAdvisorPhotos(businessName, city), 20000);
    if (taUrls.length > 0) await collectFromUrls(taUrls, 'tripadvisor');
  }

  // ── 3.8 Foursquare API — quota-tracked, only if key configured ───────────
  if (collected.length < target && foursquareApiKey) {
    bgLog('info', `PhotoWaterfall: need ${target - collected.length} more — trying Foursquare`);
    const fsqUrls = await raceTimeout(fetchFoursquarePhotos(businessName, city, foursquareApiKey), 15000);
    if (fsqUrls.length > 0) await collectFromUrls(fsqUrls, 'foursquare');
  }

  // ── 4. Google Places API — last resort, quota-consuming ───────────────────
  if (collected.length < target) {
    if (!apiKey) {
      bgLog('warn', 'PhotoWaterfall: no API key — skipping Google Places fallback.');
      TechLog.warn('PHOTO', 'waterfall_no_api_key', { collected: collected.length });
    } else {
      bgLog('info', `PhotoWaterfall: need ${target - collected.length} more — trying Google Places API`);
      const needed   = target - collected.length;
      const uris     = await Promise.all(
        placePhotoObjects.slice(0, needed + 2).map(p => resolvePhotoUriBG(p.name, 900, apiKey))
      );
      await collectFromUrls(uris, 'google_places');
    }
  }

  // ── Final result ───────────────────────────────────────────────────────────
  if (collected.length === 0) {
    bgLog('warn', 'PhotoWaterfall: all sources exhausted — no quality photos found');
    TechLog.warn('PHOTO', 'waterfall_result', { source: 'none', count: 0 });
    return { dataUrls: [], source: 'none', photoLog: [] };
  }

  // Summarise which sources contributed to this post
  const sourceBreakdown = collected.reduce((acc, p) => {
    acc[p.source] = (acc[p.source] || 0) + 1;
    return acc;
  }, {});
  const primarySource = collected[0].source;
  const sourceLabel   = Object.keys(sourceBreakdown).length > 1 ? 'mixed' : primarySource;

  bgLog('info', `PhotoWaterfall complete — ${collected.length} photos from: ${JSON.stringify(sourceBreakdown)}`);
  TechLog.info('PHOTO', 'waterfall_result', {
    source: sourceLabel, primarySource, count: collected.length,
    sourceBreakdown, urls: collected.map(p => p.sourceUrl),
  });

  return {
    dataUrls: collected.map(p => p.dataUrl),
    source:   sourceLabel,
    photoLog: collected,
  };
}

const _songCacheBG = new Map(); // "genre|cc" → { song, expiresAt }
const SONG_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function getAutoSongBG(genre, country) {
  const cc       = AB_ITUNES_CC_BG[country] || "be";
  const cacheKey = `${genre}|${cc}`;
  const cached   = _songCacheBG.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.song;
  if (genre === "top100") {
    try {
      const feedRes = await fetch(`https://itunes.apple.com/${cc}/rss/topsongs/limit=100/json`);
      if (feedRes.ok) {
        const fd      = await feedRes.json();
        const entries = fd.feed?.entry || [];
        if (entries.length) {
          const entry   = entries[Math.floor(Math.random() * entries.length)];
          const trackId = entry.id?.attributes?.["im:id"];
          if (trackId) {
            const lr = await fetch(`https://itunes.apple.com/lookup?id=${trackId}`);
            if (lr.ok) {
              const ld    = await lr.json();
              const track = ld.results?.[0];
              if (track) {
                const song = { name:track.trackName, artist:track.artistName, artwork:track.artworkUrl100, previewUrl:track.previewUrl||null, genre:"Top 100" };
                _songCacheBG.set(cacheKey, { song, expiresAt: Date.now() + SONG_CACHE_TTL_MS });
                return song;
              }
            }
          }
        }
      }
    } catch(_) {}
  }
  const queries = { top100:`top hits ${new Date().getFullYear()}`, pop:"pop hit", socialmedia:`viral trending ${new Date().getFullYear()}` };
  const labels  = { top100:"Top 100", pop:"Pop", socialmedia:"Social Media" };
  const res = await fetch(`${AB_ITUNES_SEARCH}?term=${encodeURIComponent(queries[genre]||"pop hit")}&media=music&entity=song&limit=50`);
  const d   = await res.json();
  const songs = d.results || [];
  if (!songs.length) return null;
  const s = songs[Math.floor(Math.random() * songs.length)];
  const song = { name:s.trackName, artist:s.artistName, artwork:s.artworkUrl100, previewUrl:s.previewUrl||null, genre:labels[genre]||genre };
  _songCacheBG.set(cacheKey, { song, expiresAt: Date.now() + SONG_CACHE_TTL_MS });
  return song;
}

function getAutoCaptionBG(name, address, type, language, captionOpts, songInfo, entityMeta = {}) {
  // entityMeta: { createdYear, lastVisitYear, province }
  const cityM  = address.match(CITY_FROM_ADDRESS_RE_BG);
  const city   = (cityM?.[1] || address.split(",")[0] || "").trim();
  const seed   = name.split("").reduce((a,c) => a+c.charCodeAt(0), 0);
  const tLabel = { restaurant:"restaurant", hotel:"hotel", bar:"bar" }[type] || type;
  const province = entityMeta.province || "";
  const area = province || city;

  const currentYear = new Date().getFullYear();
  const entityAge   = entityMeta.createdYear ? currentYear - entityMeta.createdYear : null;
  const lastVisit   = entityMeta.lastVisitYear || null;
  const recencyYrs  = lastVisit ? currentYear - lastVisit : null;

  // Build large template pool indexed per language
  const TEMPLATES = {
    en: [
      // Generic discovery & engagement
      `Have you visited ${name} yet? 💬`,
      `Best ${tLabel} in ${city}? ${name} is worth a visit! 🔥`,
      `What do you think of ${name}? 👇`,
      `Discover ${city}'s hidden gem: ${name} ✨`,
      `Don't miss ${name} in ${city}! 📍`,
      `Have you tried ${name}? 😍`,
      `${name} — one of ${city}'s finest! 🌟`,
      `Looking for a great ${tLabel} in ${city}? Say hello to ${name}! 👋`,
      `${city} has so much to offer — and ${name} is at the top of the list! 🗺️`,
      `Drop everything and go visit ${name} in ${city}! 📸`,
      `Ever wondered where the locals go in ${city}? ${name} is the answer! 🤫`,
      `${name} is giving us all the right vibes in ${city}! ✨`,
      `Tag someone who would love ${name}! 🏷️`,
      `This one deserves a spot on your bucket list: ${name} in ${city} 🙌`,
      `Sharing one of ${city}'s best-kept secrets — ${name} 🤩`,
      // Type-specific: restaurant
      ...(type === 'restaurant' ? [
        `The kitchen at ${name} is doing something special 🍽️`,
        `Incredible cuisine at ${name} in ${city} — a must-try! 🥂`,
        `${name}'s menu is a love letter to flavour 🌶️`,
        `From the first dish to the last bite — ${name} delivers! 🍴`,
        `${city}'s dining scene wouldn't be the same without ${name} 🍷`,
        `If you love great cuisine, ${name} in ${city} is calling your name 📞`,
        `The chef at ${name} is truly bringing something unique to ${city} 👨‍🍳`,
        `Comfort food elevated — that's ${name} for you! 🫶`,
        `Fine dining or casual feast? ${name} in ${city} nails both! 🎯`,
        `${name} proves that the best meals are the ones shared with good company 🥗`,
      ] : []),
      // Type-specific: hotel
      ...(type === 'hotel' ? [
        `Luxury hospitality at its finest — welcome to ${name} 🏨`,
        `${name} in ${city}: where every stay feels like home 🛎️`,
        `A brand that knows how to take care of its guests: ${name} ⭐`,
        `Looking for your next city stay? ${name} in ${city} is the one 🌆`,
        `The ${name} chain continues to impress in ${city} 🏅`,
        `Great service, stunning rooms — ${name} in ${city} exceeds expectations 🌟`,
        `Your perfect base for exploring ${city}: ${name} 🗺️`,
        `${name} — where comfort meets class in ${city} 🎩`,
        `Whether business or leisure, ${name} in ${city} gets it right every time ✔️`,
        `The ${name} property in ${city} is a genuine hidden gem 💎`,
      ] : []),
      // Type-specific: bar
      ...(type === 'bar' ? [
        `The tap selection at ${name} is something else entirely 🍺`,
        `Craft brews, great vibes — ${name} in ${city} is the spot 🎶`,
        `${name}'s drinks menu is a work of art 🍹`,
        `Looking for the best bar atmosphere in ${city}? ${name} has it 🎉`,
        `From IPAs to stouts — ${name} in ${city} covers all your bases 🍻`,
        `The cocktail game at ${name} is seriously underrated 🍸`,
        `${name} is the bar that ${city} deserves 🏆`,
        `Beer lovers — you need to visit ${name} in ${city} immediately! 🚨`,
        `Great beers, great company, great times — that's ${name} for you! 🥂`,
        `The vibe at ${name} in ${city} is absolutely unmatched 🌃`,
      ] : []),
      // Location-aware
      ...(area ? [
        `Best ${tLabel} of ${area}? We'd put our money on ${name}! 🏅`,
        `Repping ${area} with pride: ${name} 💪`,
        `${area}'s food scene just hit different with ${name} around 🔥`,
        `If you're ever in ${area}, ${name} needs to be on your itinerary! 📋`,
      ] : []),
      // Age-aware
      ...(entityAge !== null && entityAge >= 2 ? [
        `Celebrating ${entityAge} years of excellence — that's ${name} for you! 🎂`,
        `${entityAge} years in ${city} and ${name} is still going strong! 💪`,
        `Since ${entityMeta.createdYear}, ${name} has been a cornerstone of ${city} 🏛️`,
      ] : []),
      // Recency-aware
      ...(recencyYrs !== null && recencyYrs === 0 ? [
        `Just visited ${name} in ${city} — absolutely worth it! ⭐`,
        `Fresh from ${name} in ${city} — what a great spot! 📸`,
      ] : recencyYrs !== null && recencyYrs === 1 ? [
        `Back at ${name} in ${city} — still as great as ever! 🔄`,
        `Revisiting ${name} in ${city} — some places just never disappoint 💯`,
      ] : []),
    ],
    nl: [
      `Ben je al bij ${name}? Laat het weten! 💬`,
      `Beste ${tLabel} in ${city}? ${name} is een bezoek waard! 🔥`,
      `Wat vind je van ${name}? 👇`,
      `Ontdek de parel van ${city}: ${name} ✨`,
      `Mis ${name} niet als je in ${city} bent! 📍`,
      `Heb je ${name} al geprobeerd? 😍`,
      `${name} — een van de beste in ${city}! 🌟`,
      `Op zoek naar een goede ${tLabel} in ${city}? Dan moet je bij ${name} zijn! 👋`,
      `${city} heeft zoveel te bieden — en ${name} staat bovenaan de lijst! 🗺️`,
      `Tag iemand die ${name} zou waarderen! 🏷️`,
      `Dit verdient een plekje op je bucketlist: ${name} in ${city} 🙌`,
      `Een van de best bewaarde geheimen van ${city} — ${name} 🤩`,
      // Type-specific: restaurant
      ...(type === 'restaurant' ? [
        `De keuken van ${name} doet iets speciaals 🍽️`,
        `Ongelooflijke keuken bij ${name} in ${city} — een aanrader! 🥂`,
        `Het menu van ${name} is een ode aan smaak 🌶️`,
        `Van het eerste gerecht tot de laatste hap — ${name} maakt het waar! 🍴`,
        `${city}'s restaurantscene zou niet hetzelfde zijn zonder ${name} 🍷`,
        `De chef van ${name} brengt iets unieks naar ${city} 👨‍🍳`,
        `Lekker eten én een fijn sfeertje — ${name} in ${city} heeft het allebei! 🎯`,
      ] : []),
      // Type-specific: hotel
      ...(type === 'hotel' ? [
        `Luxe gastvrijheid op zijn best — welkom bij ${name} 🏨`,
        `${name} in ${city}: waar elk verblijf als thuis voelt 🛎️`,
        `Op zoek naar je volgende stadsverblijf? ${name} in ${city} is de keuze 🌆`,
        `Top service, prachtige kamers — ${name} in ${city} overtreft alle verwachtingen 🌟`,
        `Jouw perfecte uitvalsbasis om ${city} te verkennen: ${name} 🗺️`,
      ] : []),
      // Type-specific: bar
      ...(type === 'bar' ? [
        `De bierselectie bij ${name} is iets heel bijzonders 🍺`,
        `Craft bieren, geweldige sfeer — ${name} in ${city} is dé plek 🎶`,
        `Het drankenmenu van ${name} is een kunstwerk 🍹`,
        `Op zoek naar de beste baratmosfeer in ${city}? ${name} heeft het! 🎉`,
        `Bierliefhebbers — ga direct naar ${name} in ${city}! 🚨`,
        `De cocktails bij ${name} zijn serieus ondergewaardeerd 🍸`,
        `${name} is de bar die ${city} verdient 🏆`,
      ] : []),
      // Location-aware
      ...(area ? [
        `Beste ${tLabel} van ${area}? Onze stem gaat naar ${name}! 🏅`,
        `Trots op ${area}: ${name} 💪`,
        `Als je ooit in ${area} bent, moet ${name} op je lijstje staan! 📋`,
      ] : []),
      // Age-aware
      ...(entityAge !== null && entityAge >= 2 ? [
        `Al ${entityAge} jaar lang uitstekend — dat is ${name} voor je! 🎂`,
        `${entityAge} jaar in ${city} en ${name} gaat nog steeds sterk! 💪`,
        `Sinds ${entityMeta.createdYear} is ${name} een begrip in ${city} 🏛️`,
      ] : []),
      // Recency-aware
      ...(recencyYrs !== null && recencyYrs === 0 ? [
        `Net bij ${name} in ${city} geweest — zeker de moeite waard! ⭐`,
        `Verse beelden van ${name} in ${city} — wat een geweldige plek! 📸`,
      ] : recencyYrs !== null && recencyYrs === 1 ? [
        `Terug bij ${name} in ${city} — nog steeds even goed! 🔄`,
        `${name} in ${city} teleurstelt nooit 💯`,
      ] : []),
    ],
    fr: [
      `Avez-vous visité ${name}? 💬`,
      `Meilleur ${tLabel} à ${city}? ${name} vaut le détour! 🔥`,
      `Que pensez-vous de ${name}? 👇`,
      `Découvrez ${city}: ${name} ✨`,
      `Ne manquez pas ${name} à ${city}! 📍`,
      `Avez-vous essayé ${name}? 😍`,
      `${name} — l'une des meilleures adresses de ${city}! 🌟`,
      `À la recherche d'un bon ${tLabel} à ${city}? Direction ${name}! 👋`,
      `Taguez quelqu'un qui adorerait ${name}! 🏷️`,
      `Un incontournable à ${city}: ${name} 🙌`,
      `L'un des secrets les mieux gardés de ${city} — ${name} 🤩`,
      // Type-specific: restaurant
      ...(type === 'restaurant' ? [
        `La cuisine de ${name} est tout simplement remarquable 🍽️`,
        `Une carte qui est une véritable ode aux saveurs chez ${name} 🌶️`,
        `${city} ne serait pas pareille sans ${name} dans son paysage gastronomique 🍷`,
        `Le chef de ${name} apporte quelque chose d'unique à ${city} 👨‍🍳`,
        `De l'entrée au dessert — ${name} ne déçoit jamais! 🍴`,
      ] : []),
      // Type-specific: hotel
      ...(type === 'hotel' ? [
        `Hospitalité de luxe par excellence — bienvenue chez ${name} 🏨`,
        `${name} à ${city}: chaque séjour ressemble à la maison 🛎️`,
        `Votre base idéale pour explorer ${city}: ${name} 🗺️`,
        `Service impeccable, chambres superbes — ${name} à ${city} dépasse les attentes 🌟`,
      ] : []),
      // Type-specific: bar
      ...(type === 'bar' ? [
        `La sélection de bières chez ${name} est vraiment exceptionnelle 🍺`,
        `Bières artisanales, ambiance au top — ${name} à ${city} c'est LA place 🎶`,
        `La carte des boissons de ${name} est une œuvre d'art 🍹`,
        `Les amateurs de bière doivent absolument visiter ${name} à ${city}! 🚨`,
        `Les cocktails chez ${name} sont sérieusement sous-estimés 🍸`,
      ] : []),
      // Location-aware
      ...(area ? [
        `Meilleur ${tLabel} de ${area}? Notre vote va à ${name}! 🏅`,
        `La fierté de ${area}: ${name} 💪`,
        `Si vous êtes un jour à ${area}, ${name} doit figurer sur votre liste! 📋`,
      ] : []),
      // Age-aware
      ...(entityAge !== null && entityAge >= 2 ? [
        `${entityAge} ans d'excellence — c'est ${name} pour vous! 🎂`,
        `Depuis ${entityMeta.createdYear}, ${name} est un pilier de ${city} 🏛️`,
      ] : []),
      // Recency-aware
      ...(recencyYrs !== null && recencyYrs === 0 ? [
        `Je viens de visiter ${name} à ${city} — vraiment au top! ⭐`,
      ] : recencyYrs !== null && recencyYrs === 1 ? [
        `De retour chez ${name} à ${city} — toujours aussi bien! 🔄`,
      ] : []),
    ],
    de: [
      `Habt ihr ${name} besucht? 💬`,
      `Bestes ${tLabel} in ${city}? ${name} ist jeden Besuch wert! 🔥`,
      `Was denkt ihr über ${name}? 👇`,
      `Entdeckt das Juwel von ${city}: ${name} ✨`,
      `Verpasst ${name} in ${city} nicht! 📍`,
      `Habt ihr ${name} probiert? 😍`,
      `${name} — eine der besten Adressen in ${city}! 🌟`,
      `Auf der Suche nach einem guten ${tLabel} in ${city}? ${name} ist die Antwort! 👋`,
      `Markiert jemanden, der ${name} lieben würde! 🏷️`,
      `Ein Muss für euren ${city}-Besuch: ${name} 🙌`,
      `Eines von ${city}'s bestgehüteten Geheimnissen — ${name} 🤩`,
      // Type-specific: restaurant
      ...(type === 'restaurant' ? [
        `Die Küche von ${name} ist wirklich außergewöhnlich 🍽️`,
        `Unglaubliche Küche bei ${name} in ${city} — unbedingt probieren! 🥂`,
        `Die Speisekarte von ${name} ist eine Hymne an den Geschmack 🌶️`,
        `${city}'s Gastronomie wäre ohne ${name} nicht dieselbe 🍷`,
        `Der Koch bei ${name} bringt etwas Einzigartiges nach ${city} 👨‍🍳`,
        `Von Vorspeise bis Dessert — ${name} enttäuscht nie! 🍴`,
      ] : []),
      // Type-specific: hotel
      ...(type === 'hotel' ? [
        `Luxuriöse Gastfreundschaft at its finest — willkommen bei ${name} 🏨`,
        `${name} in ${city}: wo jeder Aufenthalt wie zuhause fühlt 🛎️`,
        `Eure perfekte Basis zum Entdecken von ${city}: ${name} 🗺️`,
        `Top Service, traumhafte Zimmer — ${name} in ${city} übertrifft alle Erwartungen 🌟`,
      ] : []),
      // Type-specific: bar
      ...(type === 'bar' ? [
        `Die Bierauswahl bei ${name} ist einfach unglaublich 🍺`,
        `Craft Biere, tolle Atmosphäre — ${name} in ${city} ist der Ort schlechthin 🎶`,
        `Die Getränkekarte von ${name} ist ein Kunstwerk 🍹`,
        `Bierliebhaber müssen ${name} in ${city} unbedingt besuchen! 🚨`,
        `Die Cocktails bei ${name} sind ernsthaft unterschätzt 🍸`,
      ] : []),
      // Location-aware
      ...(area ? [
        `Bestes ${tLabel} von ${area}? Unsere Stimme geht an ${name}! 🏅`,
        `Stolz auf ${area}: ${name} 💪`,
        `Wenn ihr jemals in ${area} seid, muss ${name} auf eurer Liste stehen! 📋`,
      ] : []),
      // Age-aware
      ...(entityAge !== null && entityAge >= 2 ? [
        `${entityAge} Jahre Exzellenz — das ist ${name} für euch! 🎂`,
        `Seit ${entityMeta.createdYear} ist ${name} ein Wahrzeichen in ${city} 🏛️`,
      ] : []),
      // Recency-aware
      ...(recencyYrs !== null && recencyYrs === 0 ? [
        `Gerade bei ${name} in ${city} gewesen — absolut empfehlenswert! ⭐`,
      ] : recencyYrs !== null && recencyYrs === 1 ? [
        `Zurück bei ${name} in ${city} — immer noch genauso gut! 🔄`,
      ] : []),
    ],
  };

  const pool = TEMPLATES[language] || TEMPLATES.en;
  const opener = pool[seed % pool.length];

  const cityTag = city.replace(/\s+/g,"");
  const parts  = [];
  if (captionOpts.catchy)  { parts.push(opener); parts.push(""); }
  if (captionOpts.name && name)       parts.push(`📍 ${name}`);
  if (captionOpts.address && address) parts.push(`📌 ${address}`);
  if ((captionOpts.name||captionOpts.address) && (captionOpts.song||captionOpts.hashtags)) parts.push("");
  if (captionOpts.song && songInfo)   parts.push(`🎵 ${songInfo.name} – ${songInfo.artist}`);
  if (captionOpts.hashtags) {
    const tc = tLabel.charAt(0).toUpperCase() + tLabel.slice(1);
    parts.push(`\n#${cityTag} #FoodFluencer #${tc}Photography #Foodie #Belgium`);
  }
  return parts.join("\n").trim();
}

// platforms param: pass explicitly from autoPostNow so we don't depend on
// re-reading the schedule (which may have changed since the run started).
async function updateRunLogStatus(postIndex, status, platforms = null) {
  // 1. Update the per-schedule run log
  const d = await chrome.storage.local.get({ autoBotRunLog:[], autoBotSchedule:null });
  const log = d.autoBotRunLog;
  const entry = log.find(e => e.postIndex === postIndex);
  if (entry) entry.status = status; else log.push({ postIndex, status, ts:new Date().toISOString() });
  await chrome.storage.local.set({ autoBotRunLog: log });

  // 2. On completion, append to the persistent activityLog (survives deactivation)
  if (status === "done") {
    // Use the platforms passed directly — avoids stale schedule re-read
    const resolvedPlatforms = platforms
      || d.autoBotSchedule?.posts?.[postIndex]?.platforms
      || [];

    if (resolvedPlatforms.length) {
      const newEntries = resolvedPlatforms.map(platform => ({
        id:       `al-${Date.now()}-${platform}`,
        ts:       new Date().toISOString(),
        platform, postIndex, status: "done",
      }));
      const al = await chrome.storage.local.get({ activityLog:[] });
      await chrome.storage.local.set({
        activityLog: [...al.activityLog, ...newEntries].slice(-2000),
      });
      TechLog.info("LOG", "activity_log_written", { postIndex, platforms: resolvedPlatforms });
      TechLog._flush(); // flush immediately so it survives even if worker is killed
    } else {
      TechLog.warn("LOG", "activity_log_skipped", { postIndex,
        reason: "no platforms resolved — schedule may have been regenerated" });
      TechLog._flush();
    }
  }

  chrome.runtime.sendMessage({ type:"AUTO_BOT_STATUS_UPDATE", postIndex, status }).catch(() => {});
}

// ── Main auto-posting function ────────────────────────────────────────────────
async function autoPostNow(postIndex) {
  const data = await chrome.storage.local.get(["autoBotActive","autoBotSchedule","autoBotConfig"]);
  if (!data.autoBotActive) return;

  const post   = data.autoBotSchedule?.posts?.[postIndex];
  const config = data.autoBotConfig;
  if (!post || !config) return;

  // API key is optional — used only as a last-resort photo source in the
  // waterfall. Discovery and the first three photo sources work without one.
  const apiKey = await getApiKey();
  const { foursquareApiKey = null } = await chrome.storage.local.get({ foursquareApiKey: null });

  await updateRunLogStatus(postIndex, "triggered");

  const runId    = `auto-${postIndex}-${Date.now()}`;
  const runStart = Date.now();
  TechLog.info("POST", "run_start", { run_id: runId, run_type: "auto", postIndex, platforms: post.platforms });

  try {
    // 1 ── Find an entity ─────────────────────────────────────────────────────
    const t_search = Date.now();
    TechLog.info("SEARCH", "search_start", { run_id: runId, run_type: "auto",
      type: config.type, country: config.country, region: config.region || "all" });
    bgLog("info", `Auto Bot post ${postIndex}: searching for ${config.type||"restaurant"}…`);

    const place   = await searchAutoPlaceBG(config, apiKey);
    const name    = place.displayName?.text || "";
    const address = place.formattedAddress  || "";
    TechLog.info("SEARCH", "search_done", { run_id: runId, run_type: "auto",
      name, address, duration_ms: Date.now()-t_search });
    bgLog("info", `Auto Bot: found "${name}"`);

    // 2 ── Resolve photos via waterfall ───────────────────────────────────────
    const t_photos = Date.now();
    TechLog.info("MEDIA", "photos_start", { run_id: runId, run_type: "auto", name });
    const allPhotos = (place.photos||[]).sort((a,b)=>(b.width||0)-(a.width||0));
    const minPics   = Math.max(parseInt(config.minPics||"3",10), 3);

    const photoResult = await fetchPhotosWaterfall(name, address, config.type||"restaurant", minPics, apiKey, allPhotos, foursquareApiKey);
    const photoDataUrls = photoResult.dataUrls;

    if (photoDataUrls.length === 0) {
      bgLog("warn", `Auto Bot post ${postIndex}: no photos found for "${name}" — skipping post`);
      TechLog.warn("POST", "post_skipped_no_photos", { run_id: runId, postIndex, name, total_duration_ms: Date.now()-runStart });
      TechLog._flush();
      await updateRunLogStatus(postIndex, "failed", post.platforms);
      return;
    }

    // Tally how many photos came from each source
    const sourceBreakdown = (photoResult.photoLog||[]).reduce((acc,p) => {
      acc[p.source] = (acc[p.source]||0)+1; return acc;
    }, {});
    TechLog.info("MEDIA", "photos_done", { run_id: runId, run_type: "auto",
      photo_source: photoResult.source, photo_count: photoDataUrls.length,
      source_breakdown: sourceBreakdown, duration_ms: Date.now()-t_photos });

    // 3 ── Pick a song ────────────────────────────────────────────────────────
    const t_song = Date.now();
    const songInfo = await getAutoSongBG(config.songGenre||"top100", config.country||"BE").catch(() => null);
    TechLog.info("SONG", songInfo ? "song_found" : "song_skipped", { run_id: runId, run_type: "auto",
      song: songInfo?.name, artist: songInfo?.artist, duration_ms: Date.now()-t_song });

    // 4 ── Build caption ──────────────────────────────────────────────────────
    const captionOpts = { catchy: config.capCatchy ?? true, name: config.capName ?? true,
      address: config.capAddr ?? true, hashtags: config.capHash ?? true, song: config.capSong ?? true };
    const caption = getAutoCaptionBG(name, address, config.type||"restaurant",
                                      config.language||"nl", captionOpts, songInfo);
    TechLog.info("CAPTION", "caption_built", { run_id: runId, run_type: "auto",
      language: config.language, length: caption.length });

    // 5 ── Fetch audio for TikTok ─────────────────────────────────────────────
    let tiktokAudioDataUrl = null;
    if (post.platforms.includes("tiktok") && songInfo?.previewUrl) {
      const t_audio = Date.now();
      tiktokAudioDataUrl = await fetchAsDataUrl(songInfo.previewUrl).catch(e => {
        TechLog.warn("MEDIA", "audio_fetch_failed", { run_id: runId, run_type: "auto", error: e.message }); return null;
      });
      if (tiktokAudioDataUrl) TechLog.info("MEDIA", "audio_fetch_done", { run_id: runId, run_type: "auto",
        sizeKB: Math.round(tiktokAudioDataUrl.length*0.75/1024), duration_ms: Date.now()-t_audio });
    }

    // 6 ── Post to each platform ──────────────────────────────────────────────
    let anyFailed = false;
    for (const platform of post.platforms) {
      const t_platform = Date.now();
      TechLog.info("POST", "platform_start", { run_id: runId, run_type: "auto",
        platform, step: post.platforms.indexOf(platform)+1, total_platforms: post.platforms.length });
      bgLog("info", `Auto Bot: posting to ${platform}…`);

      const result = await handleSocialPost({
        platform, photoDataUrls, caption,
        songName:           songInfo?.name || "",
        location:           address,
        restaurantName:     name,
        tiktokAudioDataUrl: platform === "tiktok" ? tiktokAudioDataUrl : null,
        autoPost:           true,
      });

      if (result?.failed) {
        anyFailed = true;
        TechLog.error("POST", "platform_failed", { run_id: runId, run_type: "auto",
          platform, error: result.error, duration_ms: Date.now()-t_platform });
        bgLog("error", `Auto Bot: ${platform} failed — ${result.error}`);
      } else {
        TechLog.info("POST", "platform_success", { run_id: runId, run_type: "auto",
          platform, duration_ms: Date.now()-t_platform });
      }
      if (post.platforms.indexOf(platform) < post.platforms.length - 1)
        await new Promise(r => setTimeout(r, 4000));
    }

    const finalStatus       = anyFailed ? "failed" : "done";
    const total_duration_ms = Date.now()-runStart;
    // Pass post.platforms directly — prevents silent skip when schedule is stale
    await updateRunLogStatus(postIndex, finalStatus, post.platforms);
    TechLog.info("POST", "run_complete", { run_id: runId, run_type: "auto",
      postIndex, name, platforms: post.platforms, status: finalStatus, total_duration_ms });
    TechLog._flush();
    bgLog("info", `Auto Bot post ${postIndex} ${finalStatus} (${total_duration_ms}ms)`, { name });

  } catch(err) {
    TechLog.error("POST", "run_failed", { run_id: runId, run_type: "auto",
      postIndex, error: err.message, total_duration_ms: Date.now()-runStart });
    TechLog._flush();
    bgLog("error", `Auto Bot post ${postIndex} failed`, err.message);
    await updateRunLogStatus(postIndex, "failed");
  }
}

// ── Technical logger (background context) ────────────────────────────────────
const TechLog = {
  _buf: [],
  _MAX: 25,
  _entry(level, cat, action, details = {}) {
    const e = { id:`${Date.now()}-${Math.random().toString(36).slice(2,5)}`, ts:new Date().toISOString(), level, source:"background", category:cat, action, ...details };
    this._buf.push(e);
    if (this._buf.length >= this._MAX || level === "error") this._flush();
    return e;
  },
  info:  (c,a,d) => TechLog._entry("info",  c,a,d||{}),
  warn:  (c,a,d) => TechLog._entry("warn",  c,a,d||{}),
  error: (c,a,d) => TechLog._entry("error", c,a,d||{}),
  _flush() {
    if (!this._buf.length) return;
    const toFlush = [...this._buf]; this._buf = [];
    chrome.storage.local.get({ techLog:[] }, ({techLog}) => {
      chrome.storage.local.set({ techLog:[...techLog,...toFlush].slice(-1000) });
    });
  },
};

// ── Background logger ─────────────────────────────────────────────────────────

function bgLog(level, message, data) {
  const entry = {
    ts: new Date().toISOString(), source: 'background', level, message,
    data: data !== undefined ? (typeof data === 'string' ? data : JSON.stringify(data)) : null,
  };
  chrome.storage.local.get({ appLog: [] }, ({ appLog }) => {
    appLog.push(entry);
    if (appLog.length > 800) appLog = appLog.slice(-600);
    chrome.storage.local.set({ appLog });
  });
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "TIKTOK_VIDEO_SPECS") {
    TechLog.info("POST", "tiktok_video_injected", { sizeMB: msg.sizeMB, mimeType: msg.mimeType, hasAudio: msg.hasAudio });
    return;
  }
  if (msg.type === "TIKTOK_ENCODE_START") {
    TechLog.info("ENCODE", "video_encode_start", { codec: msg.codec, width: msg.width, height: msg.height, slides: msg.slides, fps: msg.fps });
    return;
  }
  if (msg.type === "TIKTOK_ENCODE_DONE") {
    TechLog.info("ENCODE", "video_encode_done", { chunks: msg.chunks, duration_ms: msg.duration_ms });
    return;
  }
  if (msg.type === "TIKTOK_READY_TO_MINIMIZE") {
    TechLog.info("POST", "tiktok_minimise_triggered", { note: "checkUpload accepted — window minimised" });
    return;
  }
  if (msg.type === "TIKTOK_UPLOAD_ERROR") {
    TechLog.error("POST", "tiktok_upload_rejected", {
      matched:     msg.matched,
      context:     msg.context,
      pageSnippet: msg.pageSnippet,
      autoPost:    msg.autoPost,
    });
    bgLog("error", "TikTok upload rejected", msg.matched);
    return;
  }
  // Granular step tracker — logged for every notable action the TikTok
  // injector performs, so the technical log shows exactly how far the
  // posting flow progressed (and where it stalled/failed).
  if (msg.type === "TIKTOK_STEP") {
    TechLog.info("POST", "tiktok_step", { step: msg.step, detail: msg.detail });
    return;
  }
  // TikTok's generic "Something went wrong. Please try again." error screen.
  // We record which step the bot had just performed right before this screen
  // appeared, so we can pinpoint exactly where the flow broke.
  if (msg.type === "TIKTOK_ERROR_PAGE") {
    TechLog.error("POST", "tiktok_error_page", {
      lastStep:       msg.lastStep,
      lastStepDetail: msg.lastStepDetail,
      pageSnippet:    msg.pageSnippet,
    });
    bgLog("error", "TikTok 'Something went wrong' page detected", `last step: ${msg.lastStep}`);
    return;
  }
  if (msg.type === "DOWNLOAD") {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename, conflictAction: "uniquify" },
      id => sendResponse({ id })
    );
    return true;
  }
  if (msg.type === "OPEN_SOCIAL") {
    handleSocialPost(msg).then(() => sendResponse({ ok: true })).catch(console.error);
    return true;
  }
  if (msg.type === "TEST_SILENT_IG") {
    testSilentInstagram().then(r => sendResponse(r)).catch(e => {
      persistDiagnosticProgress('instagram', { error: e.message, running: false });
      sendResponse({ error: e.message });
    });
    return true;
  }
  if (msg.type === "TEST_SILENT_TT") {
    testSilentTikTok().then(r => sendResponse(r)).catch(e => {
      persistDiagnosticProgress('tiktok', { error: e.message, running: false });
      sendResponse({ error: e.message });
    });
    return true;
  }
  // Runs both silent probes back-to-back. Fire-and-forget from the popup's
  // perspective — opening each platform's window steals focus and closes the
  // popup, so the response callback below is best-effort; the popup instead
  // watches `silentTestResults` in storage (see persistDiagnosticProgress)
  // for live, reopen-safe progress.
  if (msg.type === "RUN_DIAGNOSTICS") {
    (async () => {
      try { await testSilentInstagram(); }
      catch (e) { await persistDiagnosticProgress('instagram', { error: e.message, running: false }); }
      try { await testSilentTikTok(); }
      catch (e) { await persistDiagnosticProgress('tiktok', { error: e.message, running: false }); }
    })().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "GET_SILENT_RESULTS") {
    chrome.storage.local.get({ silentTestResults: {} }, d => sendResponse(d.silentTestResults));
    return true;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Silent-mode diagnostic tests
// Opens the platform in a minimised window (no visible tab), probes whether
// key DOM elements are reachable, and returns a step-by-step log.
// These are read-only — nothing is posted.
// ═══════════════════════════════════════════════════════════════════════════════

// Persists live progress to storage as each probe step completes, so the
// Settings → Diagnostics panel can render the checklist in real time even
// though opening the platform window steals focus and closes the popup
// (the message-response callback never arrives in that case — storage is
// the only channel that survives).
async function persistDiagnosticProgress(platform, patch) {
  const d = await chrome.storage.local.get({ silentTestResults: {} });
  // `reset: true` replaces the platform's entry outright instead of merging —
  // used at the start of a run so stale `error`/`verdict`/`probe` fields from
  // a previous run can't leak through into the new one.
  const { reset, ...rest } = patch;
  const base = reset ? {} : (d.silentTestResults[platform] || {});
  const merged = { ...base, ...rest, platform, ts: new Date().toISOString() };
  await chrome.storage.local.set({ silentTestResults: { ...d.silentTestResults, [platform]: merged } });
  return merged;
}

// Returns an async `pushStep` bound to a given platform/steps array — pushes
// the entry locally AND persists a live snapshot in the same breath.
function makeStepPusher(platform, steps) {
  return async (entry) => {
    steps.push(entry);
    // Log every actual test-case result (entries carrying a pass/fail flag — progress
    // markers without `ok` are skipped) to the technical log, so diagnostic runs can
    // be exported and reviewed/monitored later alongside the rest of the activity.
    if (typeof entry.ok === 'boolean') {
      TechLog[entry.ok ? 'info' : 'warn']('DIAGNOSTIC', 'test_case_result',
        { platform, step: entry.step, label: entry.label, ok: entry.ok, detail: entry.detail });
    }
    await persistDiagnosticProgress(platform, { running: true, steps: [...steps] });
    return entry;
  };
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise(resolve => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); resolve('timeout'); }, timeoutMs);
    function fn(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(fn);
      clearTimeout(t);
      resolve('complete');
    }
    chrome.tabs.onUpdated.addListener(fn);
    // Also check if already complete
    chrome.tabs.get(tabId, t => { if (t?.status === 'complete') { chrome.tabs.onUpdated.removeListener(fn); clearTimeout(t); resolve('complete'); } });
  });
}

// ── Test 1: Instagram in a minimised window ───────────────────────────────────
async function testSilentInstagram() {
  const steps = [];
  const pushStep = makeStepPusher('instagram', steps);
  await persistDiagnosticProgress('instagram', { reset: true, running: true, steps: [] });
  const ts = () => new Date().toISOString();
  const t0 = Date.now();

  // Step 1 — Create minimised window
  // chrome.windows.create does not accept width/height when state is minimized.
  // Create as normal first, then immediately minimize via update().
  await pushStep({ step: 1, ts: ts(), label: 'Opening Instagram in a hidden background window…' });
  const win = await chrome.windows.create({
    url: 'https://www.instagram.com/',
    focused: false,
  });
  await chrome.windows.update(win.id, { state: 'minimized' });
  const tabId = win.tabs[0].id;
  await pushStep({ step: 1, ts: ts(), label: 'Opening Instagram', detail: 'Instagram opened in a hidden background window', ok: true });

  // Step 2 — Wait for page load
  await pushStep({ step: 2, ts: ts(), label: 'Loading the page…' });
  const loadResult = await waitForTabComplete(tabId, 15000);
  const loadSecs = ((Date.now()-t0)/1000).toFixed(1);
  await pushStep({ step: 2, ts: ts(), label: 'Loading the page',
    detail: loadResult === 'complete' ? `Page loaded successfully in ${loadSecs}s` : `Page did not finish loading (${loadSecs}s)`,
    ok: loadResult === 'complete' });

  // Extra hydration buffer (SPA)
  await new Promise(r => setTimeout(r, 4000));
  await pushStep({ step: 2, ts: ts(), label: 'Waiting for the page to finish settling…' });

  // Step 3 — Inject relay + probe
  await pushStep({ step: 3, ts: ts(), label: 'Login & New post button…' });
  let probe;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const nav        = document.querySelector('nav, [role="navigation"]');
        const createBtn  = document.querySelector('[aria-label="New post"],[aria-label="Create"]')
                        || [...document.querySelectorAll('[role="button"],a')]
                             .find(el => /^create$/i.test((el.innerText||'').trim()));
        const loginForm  = document.querySelector('input[name="username"],input[type="email"]');
        const storyBtn   = document.querySelector('[aria-label*="story" i]');

        return {
          url:          window.location.href,
          title:        document.title,
          loggedIn:     !loginForm,
          hasNav:       !!nav,
          hasCreateBtn: !!createBtn,
          createBtnTag: createBtn ? `<${createBtn.tagName}> aria="${createBtn.getAttribute('aria-label')}" text="${(createBtn.innerText||'').trim().slice(0,30)}"` : null,
          hasStoryBtn:  !!storyBtn,
          domSize:      document.body?.innerHTML?.length || 0,
        };
      },
    });
    probe = res[0]?.result || {};
    const loginText = probe.loggedIn ? 'Logged in' : 'Not logged in';
    const btnText   = probe.hasCreateBtn ? '"New post" button found' : '"New post" button not found';
    await pushStep({ step: 3, ts: ts(), label: 'Login & New post button',
      detail: `${loginText} • ${btnText}`, ok: probe.hasNav && probe.loggedIn });
  } catch(e) {
    await pushStep({ step: 3, ts: ts(), label: 'Login & New post button',
      detail: `Could not check the page — ${e.message}`, ok: false });
    probe = { error: e.message };
  }

  // Step 4 — Photo retrieval (real pipeline call — read-only)
  await pushStep({ step: 4, ts: ts(), label: 'Photo retrieval…' });
  let testPhotos = { dataUrls: [], source: 'none' };
  try {
    const apiKey = await getApiKey().catch(() => null);
    testPhotos = await fetchPhotosWaterfall('Test Restaurant', '1000 Brussels, Belgium', 'restaurant', 1, apiKey, []);
    if (testPhotos.dataUrls.length) {
      await pushStep({ step: 4, ts: ts(), label: 'Photo retrieval',
        detail: `Found ${testPhotos.dataUrls.length} photo(s) via ${testPhotos.source}`, ok: true });
    } else {
      // The live waterfall (Google Maps / DuckDuckGo / Yelp) is a flaky, rate-limited
      // third-party dependency — an empty result there is unrelated to whether
      // Instagram's composer can actually be driven. Fall back to a small image
      // generated locally (no network) so test cases #6-8 can still genuinely
      // exercise the composer flow — exactly mirroring how the TikTok probe
      // generates its own synthetic test clip rather than depending on retrieval.
      const synthetic = await generateSyntheticTestPhotoDataUrl().catch(() => null);
      if (synthetic) {
        testPhotos = { dataUrls: [synthetic], source: 'generated locally (scrape sources unavailable)' };
        await pushStep({ step: 4, ts: ts(), label: 'Photo retrieval',
          detail: 'Live photo sources returned nothing right now (scraping is rate-limited/flaky) — using a locally generated test image instead, so the composer flow below can still be verified',
          ok: true });
      } else {
        await pushStep({ step: 4, ts: ts(), label: 'Photo retrieval',
          detail: 'No photos could be retrieved from any source, and a local fallback image could not be generated', ok: false });
      }
    }
  } catch(e) {
    await pushStep({ step: 4, ts: ts(), label: 'Photo retrieval',
      detail: `Retrieval failed — ${e.message}`, ok: false });
  }

  // Step 5 — Music retrieval (real pipeline call — read-only)
  await pushStep({ step: 5, ts: ts(), label: 'Music retrieval…' });
  let testSong = null;
  try {
    testSong = await getAutoSongBG('top100', 'BE');
    await pushStep({ step: 5, ts: ts(), label: 'Music retrieval',
      detail: testSong ? `Found "${testSong.name}" by ${testSong.artist}` : 'No song could be retrieved',
      ok: !!testSong });
  } catch(e) {
    await pushStep({ step: 5, ts: ts(), label: 'Music retrieval',
      detail: `Retrieval failed — ${e.message}`, ok: false });
  }

  // Steps 6-8 — Drive through the real composer flow (using a real retrieved photo,
  // when available) up to — but never including — clicking Share. Nothing is ever
  // posted: the window/tab is destroyed at the end of this test (see "Clean up"
  // below), which discards any in-progress draft exactly like closing the tab on
  // an unfinished post normally would.
  const testCaption  = 'FoodFluencer diagnostic test — please ignore (this post is never shared).';
  const testLocation = 'Brussels, Belgium';
  let flow = { composerOpened: false, photoAttached: false, captionFieldFound: false,
    locationFieldFound: false, shareBtnFound: false, shareBtnEnabled: false, error: null };
  try {
    await pushStep({ step: 6, ts: ts(), label: 'Creating the post…' });
    const flowRes = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [testPhotos.dataUrls[0] || null, testCaption, testLocation],
      func: async (testPhotoDataUrl, caption, location) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const out = { composerOpened: false, photoAttached: false, captionFieldFound: false,
          locationFieldFound: false, shareBtnFound: false, shareBtnEnabled: false, error: null };
        function findByText(re, root) {
          return [...(root||document).querySelectorAll('[role="button"],button,[tabindex="0"],a')]
            .find(el => re.test((el.innerText||el.getAttribute('aria-label')||'').trim()));
        }
        // Instagram's composer is locale-aware — "Next" renders as "Volgende" (nl),
        // "Suivant" (fr), "Weiter" (de), etc. A bare /^next$/i regex only matches
        // the English UI and silently fails to find the button on every other
        // locale (the same reasoning already applied to SHARE_RE below, which
        // includes "delen" — Dutch for "Share").
        const NEXT_RE = /^(next|volgende|suivant|weiter|avanti|siguiente|seguinte|dalej|next>|próximo|napred|nästa|ileri)$/i;
        // aria-label="New post" is often on an inner <svg>/<span>, which has no
        // .click() (only HTMLElement does) — climb to the nearest clickable ancestor
        // and dispatch a real click event so it works on any element type.
        function clickEl(el) {
          const target = (el.closest && el.closest('[role="button"],button,a,[tabindex]')) || el;
          if (typeof target.click === 'function') target.click();
          else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }
        async function waitFor(fn, timeout=12000, interval=300) {
          const t0 = Date.now();
          while (Date.now()-t0 < timeout) { const v = fn(); if (v) return v; await sleep(interval); }
          return null;
        }
        // Instagram's page CSP (connect-src) blocks `fetch()` of `data:` URIs from
        // the MAIN world — it fails with a generic "Failed to fetch" with no useful
        // detail. Decode the base64 payload by hand instead; no network involved.
        function dataUrlToBlob(dataUrl) {
          const comma = dataUrl.indexOf(',');
          const header = dataUrl.slice(0, comma);
          const mimeMatch = header.match(/data:(.*?);base64/i);
          const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
          const binary = atob(dataUrl.slice(comma + 1));
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return new Blob([bytes], { type: mime });
        }
        try {
          // 1. Open the composer
          const createBtn = document.querySelector('[aria-label="New post"],[aria-label="Create"],[aria-label="Create a post"],[aria-label="Create Post"]')
                         || findByText(/^create$/i);
          if (!createBtn) throw new Error('Create button not found');
          clickEl(createBtn);
          const dialog = await waitFor(() => document.querySelector('[role="dialog"]'));
          if (!dialog) throw new Error('Composer dialog did not open');
          out.composerOpened = true;
          await sleep(800);

          // 2. Attach a real (test) photo — required to reach the caption/location/share screens
          //    React-controlled file inputs ignore a plain `input.files = ...` assignment
          //    (React keeps its own shadow value), so we must go through the native
          //    property setter on HTMLInputElement.prototype and fire BOTH `change`
          //    AND `input` — exactly like the production injector (setFilesOnInput).
          if (testPhotoDataUrl) {
            const fileInput = await waitFor(() => dialog.querySelector('input[type="file"]') || document.querySelector('input[type="file"]'));
            if (fileInput) {
              const blob = dataUrlToBlob(testPhotoDataUrl);
              const file = new File([blob], 'ffbot-diagnostic-test.jpg', { type: blob.type || 'image/jpeg' });
              const dt = new DataTransfer();
              dt.items.add(file);
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
              if (setter) setter.call(fileInput, dt.files); else fileInput.files = dt.files;
              fileInput.dispatchEvent(new Event('change', { bubbles: true }));
              fileInput.dispatchEvent(new Event('input',  { bubbles: true }));
              // Confirm React/Instagram actually picked it up — wait for visible
              // proof that the composer advanced to the crop/preview screen.
              // IMPORTANT: don't gate this on finding a "Next" button by English
              // text alone — Instagram's UI is locale-aware ("Volgende", "Suivant",
              // "Weiter", …) and a strict /^next$/i match silently never fires on
              // non-English accounts, producing a false "not attached" verdict even
              // though the photo loaded fine (it would then go on to reach the
              // caption/share screen regardless — exactly what we saw: #6 reported
              // failure yet #7/#8 found their fields).
              //
              // SECOND GOTCHA — and the actual remaining cause: Instagram's
              // composer often TEARS DOWN and RE-MOUNTS the dialog element when
              // transitioning from "select photo" to "crop/edit", so the `dialog`
              // node captured at open-time goes stale/detached. Querying it (or
              // measuring its innerHTML) afterwards always returns the same frozen
              // snapshot — never proving anything — while a *fresh*
              // `document.querySelector('[role="dialog"]')` would show the new,
              // populated screen. Re-query live on every poll instead of trusting
              // the captured reference, and check known post-attach signals
              // (preview image/canvas, a localized Next button, or a localized
              // Share button — using the same multi-language patterns as below).
              const SHARE_RE_LOCAL = /^(share|delen|partager|teilen|condividi|compartir|публикувам|dela)$/i;
              const attached = await waitFor(() => {
                if (!(fileInput.files && fileInput.files.length > 0)) return false;
                const liveDialog = document.querySelector('[role="dialog"]');
                if (!liveDialog) return false;
                return liveDialog.querySelector('img[src^="blob:"],canvas,[style*="background-image"]')
                  || findByText(NEXT_RE, liveDialog)
                  || findByText(SHARE_RE_LOCAL, liveDialog);
              }, 10000);
              out.photoAttached = !!attached;
            }
          }
          await sleep(1500);

          // 3. Click through "Next" (crop → filters) to reach the caption/share screen
          for (let i = 0; i < 2; i++) {
            const nextBtn = await waitFor(() => findByText(NEXT_RE, dialog) || findByText(NEXT_RE), 6000);
            if (!nextBtn) break;
            clickEl(nextBtn);
            await sleep(1200);
          }

          // 4. Caption & location fields
          const captionField = await waitFor(() => document.querySelector('.public-DraftEditor-content,[aria-label*="caption" i],[data-placeholder*="caption" i],[data-placeholder*="description" i]'), 8000);
          if (captionField) {
            out.captionFieldFound = true;
            captionField.focus();
            document.execCommand('insertText', false, caption);
            captionField.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const locationField = document.querySelector('input[name="creation-location-input"],[aria-label*="location" i] input,input[placeholder*="location" i]');
          if (locationField) {
            out.locationFieldFound = true;
            locationField.focus();
            locationField.value = location;
            locationField.dispatchEvent(new Event('input', { bubbles: true }));
          }
          await sleep(1000);

          // 5. Locate the Share button — verify it's visible & clickable, but NEVER click it
          const SHARE_RE = /^(share|delen|partager|teilen|condividi|compartir|публикувам|dela)$/i;
          const shareBtn = [...document.querySelectorAll('[role="dialog"] [role="button"],[role="dialog"] button,[role="dialog"] [tabindex="0"],[role="dialog"] a')]
            .find(el => SHARE_RE.test((el.innerText||'').trim()) || SHARE_RE.test((el.getAttribute('aria-label')||'').trim()));
          if (shareBtn) {
            out.shareBtnFound = true;
            const style = window.getComputedStyle(shareBtn);
            out.shareBtnEnabled = style.visibility !== 'hidden' && style.display !== 'none'
              && shareBtn.getAttribute('aria-disabled') !== 'true' && !shareBtn.disabled;
          }
        } catch(e) { out.error = e.message; }
        return out;
      },
    });
    flow = flowRes[0]?.result || flow;
  } catch(e) {
    flow.error = e.message;
  }

  await pushStep({ step: 6, ts: ts(), label: 'Creating the post',
    detail: !flow.composerOpened
      ? `Composer did not open${flow.error ? ` — ${flow.error}` : ''}`
      : (flow.photoAttached
          ? 'Composer opened and test photo attached successfully'
          : `Composer opened, but the test photo could not be attached${flow.error ? ` — ${flow.error}` : ''}`),
    ok: flow.composerOpened && flow.photoAttached });

  await pushStep({ step: 7, ts: ts(), label: 'Caption & location…' });
  await pushStep({ step: 7, ts: ts(), label: 'Caption & location',
    detail: `Caption field: ${flow.captionFieldFound ? 'found' : 'not found'} • Location field: ${flow.locationFieldFound ? 'found' : 'not found'}`,
    ok: flow.captionFieldFound && flow.locationFieldFound });

  await pushStep({ step: 8, ts: ts(), label: 'Share button check…' });
  await pushStep({ step: 8, ts: ts(), label: 'Share button check',
    detail: !flow.shareBtnFound ? 'Share button not found on the confirmation screen'
      : (flow.shareBtnEnabled ? 'Share button is visible and clickable (not clicked — test only)' : 'Share button found but not yet clickable'),
    ok: flow.shareBtnFound && flow.shareBtnEnabled });

  // Step 9 — Summary
  const verdict = probe.loggedIn && probe.hasCreateBtn
    ? 'FEASIBLE — logged in and Create button found in minimised window'
    : probe.loggedIn && probe.hasNav
    ? 'LIKELY FEASIBLE — logged in, nav found; Create button not yet visible (may need scroll/wait)'
    : !probe.loggedIn
    ? 'NOT READY — user is logged out; login required before silent posting'
    : 'UNCERTAIN — see probe details above';

  await pushStep({ step: 9, ts: ts(), label: 'Final result', detail: verdict });

  // Clean up
  chrome.tabs.remove(tabId).catch(() => {});

  const result = { platform: 'instagram', total_ms: Date.now()-t0, steps, probe, verdict, running: false, ts: new Date().toISOString() };
  const passedCount = steps.filter(s => typeof s.ok === 'boolean' && s.ok).length;
  const totalCount  = steps.filter(s => typeof s.ok === 'boolean').length;
  TechLog.info('DIAGNOSTIC', 'run_complete', { platform: 'instagram', passed: passedCount, total: totalCount, verdict, total_ms: result.total_ms });
  TechLog._flush();
  // Persist so results can be read back even after the popup closes (it does —
  // chrome.windows.create steals focus and Chrome auto-closes the popup).
  await persistDiagnosticProgress('instagram', result);
  return result;
}

// ── Test 2: TikTok in a minimised window (with focus trick) ───────────────────
async function testSilentTikTok() {
  const steps = [];
  const pushStep = makeStepPusher('tiktok', steps);
  await persistDiagnosticProgress('tiktok', { reset: true, running: true, steps: [] });
  const ts = () => new Date().toISOString();
  const t0 = Date.now();
  const testCaption  = 'FoodFluencer diagnostic test — please ignore (this post is never shared).';
  const testLocation = 'Brussels, Belgium';

  // Step 1 — Create minimised window
  // chrome.windows.create does not accept width/height when state is minimized.
  // Create as normal first, then immediately minimize via update().
  await pushStep({ step: 1, ts: ts(), label: 'Opening TikTok in a hidden background window…' });
  const win = await chrome.windows.create({
    url: 'https://www.tiktok.com/upload',
    focused: false,
  });
  await chrome.windows.update(win.id, { state: 'minimized' });
  const tabId  = win.tabs[0].id;
  const winId  = win.id;
  await pushStep({ step: 1, ts: ts(), label: 'Opening TikTok', detail: 'TikTok opened in a hidden background window', ok: true });

  // Step 2 — Wait for page load
  await pushStep({ step: 2, ts: ts(), label: 'Loading the page…' });
  const loadResult = await waitForTabComplete(tabId, 15000);
  const loadSecs = ((Date.now()-t0)/1000).toFixed(1);
  await pushStep({ step: 2, ts: ts(), label: 'Loading the page',
    detail: loadResult === 'complete' ? `Page loaded successfully in ${loadSecs}s` : `Page did not finish loading (${loadSecs}s)`,
    ok: loadResult === 'complete' });
  await new Promise(r => setTimeout(r, 2000));

  // Step 3 — Probe BEFORE focus (upload handler likely not initialised — this is
  // an expected baseline reading, not a pass/fail test, so it carries no `ok` flag)
  await pushStep({ step: 3, ts: ts(), label: 'Taking a baseline reading of the upload page…' });
  let before = {};
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => {
        const inp    = document.querySelector('input[type="file"]');
        const dropEl = document.querySelector('[class*="upload" i],[class*="drag" i]');
        return {
          url:            window.location.href,
          hasFileInput:   !!inp,
          fileInputAccept: inp?.accept || null,
          hasDropZone:    !!dropEl,
          loginRequired:  /login|sign.in/i.test(window.location.href) || !!document.querySelector('[href*="login"]'),
          domSize:        document.body?.innerHTML?.length || 0,
        };
      },
    });
    before = r[0]?.result || {};
    await pushStep({ step: 3, ts: ts(), label: 'Baseline reading of the upload page',
      detail: 'Initial check before activating the window — the upload button typically isn\'t ready yet at this point, that\'s expected' });
  } catch(e) {
    before = { error: e.message };
  }

  // Step 4 — Briefly focus the window to let TikTok initialise upload handlers
  await pushStep({ step: 4, ts: ts(), label: 'Briefly activating the window so TikTok can finish preparing the upload page…' });
  await chrome.windows.update(winId, { focused: true });
  await new Promise(r => setTimeout(r, 2500)); // allow TikTok to initialise
  await chrome.windows.update(winId, { state: 'minimized' });
  await new Promise(r => setTimeout(r, 500));

  // Step 5 — Probe AFTER focus (upload handler should now be present). Extended to
  // also gather everything needed for the business-facing checks below: caption &
  // location fields, the Post button, and H.264/MP4 encoding support — all
  // read-only DOM/feature queries, nothing is uploaded, typed, or clicked.
  await pushStep({ step: 5, ts: ts(), label: 'Upload page ready…' });
  let after = {};
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: async () => {
        const inp      = document.querySelector('input[type="file"]');
        const dropEl   = document.querySelector('[class*="upload" i],[class*="drag" i]');
        const caption  = document.querySelector('.public-DraftEditor-content,[data-placeholder*="caption" i],[data-placeholder*="description" i]');
        const location = document.querySelector('[placeholder*="location" i],[aria-label*="location" i] input,input[name*="location" i]');
        const postBtn  = document.querySelector('[data-e2e="btn-post"]')
                      || document.querySelector('button[type="submit"]:not([disabled])')
                      || [...document.querySelectorAll('button,[role="button"]')].find(el => /^post$/i.test((el.innerText||'').trim()));

        // Try DataTransfer injection test (non-destructive — just checks if it throws)
        let dataTransferWorks = false;
        try {
          const dt  = new DataTransfer();
          const f   = new File(['test'], 'test.mp4', { type:'video/mp4' });
          dt.items.add(f);
          dataTransferWorks = dt.files.length === 1;
        } catch(_) {}

        // H.264/MP4 encoding capability — mirrors the exact codec probe buildH264MP4
        // uses in the real TikTok injector (read-only feature detection, encodes nothing)
        let videoEncoderSupported = false, supportedCodec = null;
        if (window.VideoEncoder) {
          for (const c of ['avc1.4d0028','avc1.42001f','avc1.42001e','avc1.420014']) {
            try {
              const s = await VideoEncoder.isConfigSupported({ codec: c, width: 720, height: 1280, bitrate: 2_000_000, framerate: 25 });
              if (s.supported) { videoEncoderSupported = true; supportedCodec = c; break; }
            } catch(_) {}
          }
        }

        let postBtnEnabled = false;
        if (postBtn) {
          const style = window.getComputedStyle(postBtn);
          postBtnEnabled = style.visibility !== 'hidden' && style.display !== 'none'
            && postBtn.getAttribute('aria-disabled') !== 'true' && !postBtn.disabled;
        }

        return {
          url:               window.location.href,
          hasFileInput:      !!inp,
          fileInputAccept:   inp?.accept || null,
          fileInputActive:   inp ? !inp.disabled : false,
          hasDropZone:       !!dropEl,
          hasCaptionField:   !!caption,
          hasLocationField:  !!location,
          hasPostBtn:        !!postBtn,
          postBtnEnabled,
          dataTransferWorks,
          videoEncoderSupported,
          supportedCodec,
          loginRequired:     /login|sign.in/i.test(window.location.href),
          domSize:           document.body?.innerHTML?.length || 0,
        };
      },
    });
    after = r[0]?.result || {};
    const btnText = after.hasFileInput
      ? (after.fileInputActive ? 'Upload page is ready' : 'Upload page found, but not yet active')
      : (after.loginRequired ? 'Upload page not reachable — login required' : 'Upload page not reachable yet');
    await pushStep({ step: 5, ts: ts(), label: 'Upload page ready', detail: btnText,
      ok: after.hasFileInput && !after.loginRequired });
  } catch(e) {
    await pushStep({ step: 5, ts: ts(), label: 'Upload page ready',
      detail: `Could not check the page — ${e.message}`, ok: false });
    after = { error: e.message };
  }

  // Step 6 — Photo retrieval (real pipeline call — read-only)
  await pushStep({ step: 6, ts: ts(), label: 'Photo retrieval…' });
  let testPhotos = { dataUrls: [], source: 'none' };
  try {
    const apiKey = await getApiKey().catch(() => null);
    testPhotos = await fetchPhotosWaterfall('Test Restaurant', '1000 Brussels, Belgium', 'restaurant', 1, apiKey, []);
    await pushStep({ step: 6, ts: ts(), label: 'Photo retrieval',
      detail: testPhotos.dataUrls.length ? `Found ${testPhotos.dataUrls.length} photo(s) via ${testPhotos.source}` : 'No photos could be retrieved from any source',
      ok: testPhotos.dataUrls.length > 0 });
  } catch(e) {
    await pushStep({ step: 6, ts: ts(), label: 'Photo retrieval',
      detail: `Retrieval failed — ${e.message}`, ok: false });
  }

  // Step 7 — Music retrieval (real pipeline call — read-only)
  await pushStep({ step: 7, ts: ts(), label: 'Music retrieval…' });
  let testSong = null;
  try {
    testSong = await getAutoSongBG('top100', 'BE');
    await pushStep({ step: 7, ts: ts(), label: 'Music retrieval',
      detail: testSong ? `Found "${testSong.name}" by ${testSong.artist}` : 'No song could be retrieved',
      ok: !!testSong });
  } catch(e) {
    await pushStep({ step: 7, ts: ts(), label: 'Music retrieval',
      detail: `Retrieval failed — ${e.message}`, ok: false });
  }

  // Step 8 — MP4 creation: real H.264/WebCodecs capability check (same codec probe
  // the production injector runs before encoding — encodes nothing itself)
  await pushStep({ step: 8, ts: ts(), label: 'MP4 creation', detail: after.videoEncoderSupported
      ? `Supported — browser can encode H.264 video (codec ${after.supportedCodec})`
      : 'Not supported — no compatible H.264 encoder available in this browser',
    ok: !!after.videoEncoderSupported });

  // Steps 9-11 — Caption/location fields and the Post button only appear AFTER a
  // video has been selected, so a static page check (like the one above) can never
  // find them. To genuinely test these, attach a tiny (~1 s, blank-frame) generated
  // test clip — proving the upload mechanism really accepts a file — then check the
  // screen it reveals. The Post button is located and verified, but NEVER clicked;
  // the tab is destroyed at the end (see "Clean up"), abandoning the upload exactly
  // as closing the browser mid-upload normally would — nothing is ever posted.
  const uploadReady = after.hasFileInput && after.fileInputActive && after.dataTransferWorks;
  let ttFlow = { videoAttached: false, captionFieldFound: false, locationFieldFound: false,
    postBtnFound: false, postBtnEnabled: false, error: null };
  try {
    await pushStep({ step: 9, ts: ts(), label: 'Video upload…' });

    // "Frame with ID 0 was removed" means the tab's main frame was torn down
    // mid-script — Chrome can discard/reload minimised background tabs that sit
    // idle too long, and this probe (clip generation + upload + UI settle) takes
    // well over a minute. Re-run the same focus trick from step 4 immediately
    // before injecting, to keep the tab alive and active for the duration.
    await chrome.windows.update(winId, { focused: true });
    await new Promise(r => setTimeout(r, 600));
    await chrome.windows.update(winId, { state: 'minimized' });
    await new Promise(r => setTimeout(r, 300));

    async function runFlow() {
      return chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      args: [testCaption, testLocation],
      func: async (caption, location) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const out = { videoAttached: false, captionFieldFound: false, locationFieldFound: false,
          postBtnFound: false, postBtnEnabled: false, error: null };
        async function waitFor(fn, timeout=45000, interval=400) {
          const t0 = Date.now();
          while (Date.now()-t0 < timeout) { const v = fn(); if (v) return v; await sleep(interval); }
          return null;
        }
        try {
          // Generate a tiny blank test clip (~0.9 s) — real video data, nothing reused
          const canvas = document.createElement('canvas');
          canvas.width = 576; canvas.height = 1024;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          const stream = canvas.captureStream(15);
          const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
            .find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || 'video/webm';
          const rec = new MediaRecorder(stream, { mimeType: mime });
          const chunks = [];
          rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
          const stopped = new Promise(res => rec.onstop = res);
          rec.start();
          await sleep(900);
          rec.stop();
          await stopped;
          stream.getTracks().forEach(t => t.stop());
          const blob = new Blob(chunks, { type: mime });
          const ext  = mime.includes('mp4') ? 'mp4' : 'webm';
          const file = new File([blob], `ffbot-diagnostic-test.${ext}`, { type: mime });

          const fileInput = document.querySelector('input[type="file"]');
          if (!fileInput) throw new Error('Upload input not found');
          const dt = new DataTransfer();
          dt.items.add(file);
          // Bypass React's shadow value via the native setter, and fire both
          // `change` AND `input` — same `setFilesOnInput` pattern as production.
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
          if (setter) setter.call(fileInput, dt.files); else fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          fileInput.dispatchEvent(new Event('input',  { bubbles: true }));
          out.videoAttached = true;

          // Wait for TikTok to process the clip and reveal the caption/location/Post UI
          const captionField = await waitFor(() => document.querySelector('.public-DraftEditor-content,[data-placeholder*="caption" i],[data-placeholder*="description" i]'));
          if (captionField) {
            out.captionFieldFound = true;
            captionField.focus();
            document.execCommand('insertText', false, caption);
            captionField.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const locationField = document.querySelector('[placeholder*="location" i],[aria-label*="location" i] input,input[name*="location" i]');
          if (locationField) {
            out.locationFieldFound = true;
            locationField.focus();
            locationField.value = location;
            locationField.dispatchEvent(new Event('input', { bubbles: true }));
          }

          // Locate the Post button — verify it's visible & clickable, but NEVER click it.
          // TikTok keeps it disabled until the clip finishes server-side processing,
          // which can take well past the moment it first appears in the DOM — so
          // poll for *enabled*, not just *present* (up to ~30s), before judging it.
          function findPostBtn() {
            return document.querySelector('[data-e2e="btn-post"]')
                || document.querySelector('button[type="submit"]:not([disabled])')
                || [...document.querySelectorAll('button,[role="button"]')].find(el => /^post$/i.test((el.innerText||'').trim()));
          }
          function isEnabled(btn) {
            const style = window.getComputedStyle(btn);
            return style.visibility !== 'hidden' && style.display !== 'none'
              && btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled;
          }
          const postBtn = await waitFor(findPostBtn, 10000);
          if (postBtn) {
            out.postBtnFound = true;
            out.postBtnEnabled = isEnabled(postBtn)
              || !!(await waitFor(() => { const b = findPostBtn(); return b && isEnabled(b) ? b : null; }, 30000, 500));
          }
        } catch(e) { out.error = e.message; }
        return out;
      },
      });
    }

    let flowRes;
    try {
      flowRes = await runFlow();
    } catch(e) {
      // One retry: if the frame was torn down (tab discarded/reloaded while
      // minimised), re-assert focus and try again rather than failing outright.
      if (/frame with id .* was removed/i.test(e.message || '')) {
        await chrome.windows.update(winId, { focused: true });
        await new Promise(r => setTimeout(r, 1000));
        await chrome.windows.update(winId, { state: 'minimized' });
        await new Promise(r => setTimeout(r, 300));
        flowRes = await runFlow();
      } else {
        throw e;
      }
    }
    ttFlow = flowRes[0]?.result || ttFlow;
  } catch(e) {
    ttFlow.error = e.message;
  }

  await pushStep({ step: 9, ts: ts(), label: 'Video upload', detail: ttFlow.error && !ttFlow.videoAttached
      ? `Could not attach a test clip — ${ttFlow.error}`
      : (ttFlow.videoAttached ? 'Test clip generated and accepted by the upload mechanism' : 'Upload could not be started'),
    ok: ttFlow.videoAttached });

  await pushStep({ step: 10, ts: ts(), label: 'Caption & location',
    detail: `Caption field: ${ttFlow.captionFieldFound ? 'found' : 'not found'} • Location field: ${ttFlow.locationFieldFound ? 'found' : 'not found'}`,
    ok: ttFlow.captionFieldFound && ttFlow.locationFieldFound });

  await pushStep({ step: 11, ts: ts(), label: 'Post button check',
    detail: !ttFlow.postBtnFound ? 'Post button not found on the confirmation screen'
      : (ttFlow.postBtnEnabled
          ? 'Post button is visible and clickable (not clicked — test only)'
          : 'Post button found, but stayed disabled after waiting ~40s for TikTok to finish processing the test clip'),
    ok: ttFlow.postBtnFound && ttFlow.postBtnEnabled });

  // Step 12 — Verdict
  const verdict = after.loginRequired
    ? 'NOT READY — TikTok login required before silent posting'
    : uploadReady
    ? 'FEASIBLE — file input found & active after focus trick; DataTransfer works'
    : after.hasFileInput
    ? 'PARTIAL — file input found but may need more init time (increase focus duration)'
    : 'UNCERTAIN — upload zone not found; page may still be loading or login required';

  await pushStep({ step: 12, ts: ts(), label: 'Final result', detail: verdict });

  // Clean up
  chrome.tabs.remove(tabId).catch(() => {});

  const result = { platform: 'tiktok', total_ms: Date.now()-t0, steps,
    before_focus: before, after_focus: after, verdict, running: false, ts: new Date().toISOString() };
  const passedCount = steps.filter(s => typeof s.ok === 'boolean' && s.ok).length;
  const totalCount  = steps.filter(s => typeof s.ok === 'boolean').length;
  TechLog.info('DIAGNOSTIC', 'run_complete', { platform: 'tiktok', passed: passedCount, total: totalCount, verdict, total_ms: result.total_ms });
  TechLog._flush();
  await persistDiagnosticProgress('tiktok', result);
  return result;
}

// ── Social post handler ───────────────────────────────────────────────────────

const PLATFORM_URLS = {
  instagram: "https://www.instagram.com/",
  facebook:  "https://www.facebook.com/",
  tiktok:    "https://www.tiktok.com/upload",
};

const INJECTORS = {
  facebook:  injectFacebook,
  instagram: injectInstagram,
  tiktok:    injectTikTok,
};

async function handleSocialPost(opts, _attempt = 1) {
  const { platform, photoDataUrls, caption, songName, location, restaurantName, tiktokAudioDataUrl, autoPost = false } = opts;
  bgLog('info', `Opening ${platform} (silent/minimised) [attempt ${_attempt}/2]`, { photos: photoDataUrls.length, song: songName, location, autoPost });

  // ── Silent window: create unfocused, immediately minimise ────────────────────
  const win = await chrome.windows.create({
    url:     PLATFORM_URLS[platform],
    focused: false,
  });
  const winId = win.id;
  const tab   = win.tabs[0];
  await chrome.windows.update(winId, { state: 'minimized' });

  // Flush TechLog immediately — service workers can be killed at any time and
  // buffered entries are lost. Flushing here ensures the window-open event
  // survives even if the run is cut short.
  TechLog.info('POST', 'window_created', { platform, winId, tabId: tab.id, autoPost });
  TechLog._flush();
  bgLog('info', `${platform} window created & minimised (winId=${winId} tabId=${tab.id})`);

  // Wait for page load (with 15s safety timeout)
  await new Promise(resolve => {
    const safety = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 15000);
    function listener(tabId, info) {
      if (tabId !== tab.id || info.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(safety);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
  TechLog.info('POST', 'window_page_loaded', { platform, winId });
  TechLog._flush();

  // ── TikTok: restore window to NORMAL state so VideoEncoder runs unthrottled ──
  // chrome.windows.update({ focused:true }) on a minimised window sets focus
  // but does NOT restore it — Chrome still throttles VideoEncoder in a minimised
  // window regardless of focus state. Must explicitly set state:'normal'.
  // Window stays visible until TIKTOK_READY_TO_MINIMIZE (dispatched after
  // checkUpload succeeds), then minimises for the caption/post steps.
  if (platform === 'tiktok') {
    const restored = await chrome.windows.update(winId, { state: 'normal', focused: true });
    TechLog.info('POST', 'tiktok_window_restored', { state: restored.state, winId });
    TechLog._flush();
    bgLog('info', `TikTok: window restored (state=${restored.state}) — VideoEncoder will run at full speed`);
  }

  // SPA hydration buffer
  await new Promise(r => setTimeout(r, platform === 'tiktok' ? 2000 : 4000));

  try {
    // ── Relay script (ISOLATED world) ───────────────────────────────────────
    // Injectors run in MAIN world where chrome.runtime is unavailable.
    // This relay runs in ISOLATED world, listens for custom DOM events
    // dispatched by the MAIN injector, and forwards them as real messages.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function ffbotRelay() {
        if (window.__ffbotRelayActive) return;
        window.__ffbotRelayActive = true;
        document.addEventListener('__ffbot_complete', e =>
          chrome.runtime.sendMessage({ type:'PLATFORM_POST_COMPLETE', ...(e.detail||{}) }));
        document.addEventListener('__ffbot_failed', e =>
          chrome.runtime.sendMessage({ type:'PLATFORM_POST_FAILED',   ...(e.detail||{}) }));
        document.addEventListener('__ffbot_event', e =>
          chrome.runtime.sendMessage(e.detail || {}));
      },
      world: "ISOLATED",
    });

    // ── Main injector (MAIN world) ───────────────────────────────────────────
    // Guard against "Unserializable argument passed" — can happen if a data URL
    // is malformed or the structured-clone fails transiently. On failure we
    // retry once without the audio URL (video-only fallback).
    const injectorArgs = [photoDataUrls, caption, songName || "", location || "",
      { restaurantName: restaurantName || "", tiktokAudioDataUrl: tiktokAudioDataUrl || null, autoPost }];
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: INJECTORS[platform], args: injectorArgs, world: "MAIN" });
    } catch(injectErr) {
      if (String(injectErr).includes('Unserializable') && tiktokAudioDataUrl) {
        bgLog('warn', `${platform} inject failed (Unserializable) — retrying without audio`, injectErr.message);
        TechLog.warn('POST', 'inject_retry_no_audio', { platform, error: injectErr.message });
        injectorArgs[4] = { ...injectorArgs[4], tiktokAudioDataUrl: null };
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: INJECTORS[platform], args: injectorArgs, world: "MAIN" });
      } else {
        throw injectErr;
      }
    }
    TechLog.info('POST', 'injector_fired', { platform, winId, autoPost });
    TechLog._flush(); // flush immediately — long TikTok run may outlive buffer
    bgLog('info', `Injected script on ${platform}`);

    // ── Manual mode: restore window so user can see the platform UI ──────────
    // In auto mode the window stays minimised throughout.
    // In manual mode the user needs to see the banner and click Share/Post.
    if (!autoPost) {
      await chrome.windows.update(winId, { state: 'normal', focused: true });
      // Auto-close 4 s after the post confirms so the tab doesn't linger.
      // 4 s gives the user enough time to read the ✅ success banner.
      const closeOnDone = (msg, sender) => {
        if (sender.tab?.id !== tab.id) return;
        if (msg.type === "PLATFORM_POST_COMPLETE" || msg.type === "PLATFORM_POST_FAILED") {
          chrome.runtime.onMessage.removeListener(closeOnDone);
          setTimeout(() => chrome.windows.remove(winId).catch(() => {}), 4000);
        }
      };
      chrome.runtime.onMessage.addListener(closeOnDone);
      // Safety: remove listener after 10 min in case user navigates away without posting
      setTimeout(() => chrome.runtime.onMessage.removeListener(closeOnDone), 600000);
    }

    // ── Wait for completion signal (60 s fallback) ───────────────────────────
    if (autoPost) {
      const result = await new Promise(resolve => {
        const timeout = setTimeout(() => { cleanup(); resolve({ failed: false }); }, 60000);
        function cleanup() { clearTimeout(timeout); chrome.runtime.onMessage.removeListener(listener); }
        function listener(msg, sender) {
          if (sender.tab?.id !== tab.id) return;
          // TikTok signals "safe to minimise" once checkUpload succeeds:
          // VideoEncoder + file injection are done, remaining work is caption/post
          if (msg.type === "TIKTOK_READY_TO_MINIMIZE") {
            chrome.windows.update(winId, { state: 'minimized' }).catch(() => {});
            bgLog('info', 'TikTok: upload accepted — window minimised, posting continues silently');
          }
          if (msg.type === "PLATFORM_POST_COMPLETE") { cleanup(); resolve({ failed: false }); }
          if (msg.type === "PLATFORM_POST_FAILED")   { cleanup(); resolve({ failed: true, error: msg.error }); }
        }
        chrome.runtime.onMessage.addListener(listener);
      });
      // Close the whole window (not just the tab) so no minimised window lingers
      setTimeout(() => chrome.windows.remove(winId).catch(() => {}), 3000);

      // Auto-retry once on failure (autoPost only)
      if (result.failed && _attempt < 2) {
        bgLog('warn', `${platform} post failed — retrying after 12s (attempt ${_attempt}/2)`, result.error);
        TechLog.warn('POST', 'injection_retry', { platform, attempt: _attempt, error: result.error });
        TechLog._flush();
        await new Promise(r => setTimeout(r, 12000));
        return handleSocialPost(opts, _attempt + 1);
      }

      return result;
    }

  } catch (err) {
    bgLog('error', `Inject failed on ${platform}`, String(err));
    if (autoPost) chrome.windows.remove(winId).catch(() => {});
    const errResult = { failed: true, error: String(err) };

    // Auto-retry once on inject-level error (autoPost only)
    if (autoPost && _attempt < 2) {
      bgLog('warn', `${platform} inject error — retrying after 12s (attempt ${_attempt}/2)`, String(err));
      TechLog.warn('POST', 'injection_retry', { platform, attempt: _attempt, error: String(err) });
      TechLog._flush();
      await new Promise(r => setTimeout(r, 12000));
      return handleSocialPost(opts, _attempt + 1);
    }

    return errResult;
  }
  return { failed: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared utilities — inlined in every injector (each runs serialised/isolated)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Facebook ─────────────────────────────────────────────────────────────────

function injectFacebook(photoDataUrls, caption, songName, location, opts) {
  /* ── helpers ── */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const waitFor = (sel, ms = 8000) => new Promise(res => {
    if (document.querySelector(sel)) return res(document.querySelector(sel));
    const t = Date.now();
    const iv = setInterval(() => {
      const el = document.querySelector(sel);
      if (el) { clearInterval(iv); return res(el); }
      if (Date.now() - t > ms) { clearInterval(iv); return res(null); }
    }, 250);
  });

  function dataUrlToFile(url, name) {
    const [hdr, b64] = url.split(',');
    const mime = hdr.match(/:(.*?);/)[1];
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: mime });
  }

  function setFilesOnInput(input, files) {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
    if (setter) setter.call(input, dt.files); else input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input',  { bubbles: true }));
  }

  function step(n, total, html, type = 'info') {
    const existing = document.getElementById('ffbot-banner');
    if (existing) existing.remove();
    const b = document.createElement('div');
    b.id = 'ffbot-banner';
    const bg = { info: '#e8490f', success: '#16a34a', warn: '#d97706' }[type] || '#e8490f';
    b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;
      background:${bg};color:#fff;font-family:-apple-system,sans-serif;font-size:13px;
      font-weight:500;padding:10px 16px;display:flex;align-items:center;gap:10px;
      box-shadow:0 3px 14px rgba(0,0,0,.28);`;
    b.innerHTML = `
      <strong style="white-space:nowrap">🍽️ FoodFluencer</strong>
      <span style="background:rgba(255,255,255,.22);border-radius:20px;padding:1px 8px;font-size:.75rem;white-space:nowrap">
        ${n}/${total}
      </span>
      <span style="font-weight:400;flex:1">${html}</span>
      <button id="ffbot-close-btn"
        style="background:rgba(255,255,255,.22);border:none;color:#fff;border-radius:5px;
        padding:3px 9px;cursor:pointer;white-space:nowrap;flex-shrink:0">✕ Close</button>`;
    document.body.prepend(b);
    b.querySelector('#ffbot-close-btn')?.addEventListener('click', () => b.remove());
  }

  /* ── main flow ── */
  (async () => {
    const total = songName ? 5 : 4;

    // ①  Find and open post composer (multiple strategies + retry)
    step(1, total, 'Opening post composer…');

    function findComposerTrigger() {
      // 1. Direct aria/placeholder attributes
      const attrSels = [
        '[aria-label="Create a post"]',
        '[aria-label="Create Post"]',
        '[aria-placeholder*="mind" i]',
        '[placeholder*="mind" i]',
        '[aria-placeholder*="What" i]',
      ];
      for (const s of attrSels) {
        const el = document.querySelector(s); if (el) return el;
      }
      // 2. Scan all interactive elements for "What's on your mind" text
      const interactive = document.querySelectorAll(
        '[role="button"], [role="textbox"], [tabindex="0"], input, [contenteditable]'
      );
      for (const el of interactive) {
        const combined = [
          el.textContent,
          el.getAttribute('aria-label'),
          el.getAttribute('aria-placeholder'),
          el.getAttribute('placeholder'),
        ].join(' ').toLowerCase();
        if (combined.includes("what") && combined.includes("mind")) return el;
      }
      // 3. Fallback: find the first large prominent button in the main feed area
      const main = document.querySelector('[role="main"]') || document.body;
      const bigBtns = [...main.querySelectorAll('[role="button"]')]
        .filter(el => el.offsetWidth > 180 && el.offsetHeight > 28);
      // Pick the one nearest the top of the page
      bigBtns.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      if (bigBtns[0]) return bigBtns[0];
      return null;
    }

    // Retry up to 5 times with 1-second gaps (Facebook hydrates slowly)
    let trigger = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      trigger = findComposerTrigger();
      if (trigger) break;
      await sleep(1000);
    }

    if (!trigger) {
      step(1, total,
        'Could not open composer automatically. Please click <strong>"What\'s on your mind?"</strong> in Facebook, then click <strong>Photo/Video</strong> and select photos from <strong>Downloads/FoodFluencer</strong>.',
        'warn'
      );
      return;
    }
    trigger.click();
    await sleep(1600);

    // ②  Click Photo/Video button
    step(2, total, 'Clicking <strong>Photo/Video</strong>…');
    let photoBtn = document.querySelector('[aria-label="Photo/video"]');
    if (!photoBtn) photoBtn = [...document.querySelectorAll('[role="button"]')]
      .find(el => /photo.*video|video.*photo/i.test(el.getAttribute('aria-label') || '') ||
                  el.textContent.trim() === 'Photo/video');
    if (photoBtn) { photoBtn.click(); await sleep(900); }

    // ③  Inject ALL photos into the file input
    const fileInput = await waitFor('input[type="file"]', 6000);
    if (!fileInput) {
      step(3, total, 'Photo input not found — click <strong>Photo/Video</strong> and select from Downloads/FoodFluencer.', 'warn');
      return;
    }
    const files = photoDataUrls.map((url, i) => dataUrlToFile(url, `restaurant-${i + 1}.jpg`));
    step(3, total, `Uploading <strong>${files.length} photo${files.length > 1 ? 's' : ''}</strong>…`);
    setFilesOnInput(fileInput, files);
    await sleep(2200);

    // ④  Fill caption
    step(4, total, 'Filling caption…');
    const captionSels = [
      '[contenteditable="true"][aria-placeholder]',
      '[contenteditable="true"][role="textbox"]',
      '[data-testid="status-attachment-mentions-input"]',
    ];
    let captionBox = null;
    for (const s of captionSels) {
      const boxes = document.querySelectorAll(s);
      for (const box of boxes) {
        if (box.closest('[role="dialog"]') || box.closest('[aria-modal]')) { captionBox = box; break; }
      }
      if (!captionBox) captionBox = document.querySelector(s);
      if (captionBox) break;
    }
    if (captionBox) {
      captionBox.focus(); await sleep(200);
      const range = document.createRange();
      range.selectNodeContents(captionBox);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      document.execCommand('insertText', false, caption);
    }
    await sleep(400);

    // ⑤  Song hint / auto-post
    const { autoPost: fbAutoPost = false } = opts || {};
    if (fbAutoPost) {
      step(4, total, '🤖 Auto-posting…');
      await sleep(800);
      // Find Facebook's blue "Post" button inside the open dialog
      const postBtn = document.querySelector('[aria-label="Post"]') ||
        [...document.querySelectorAll('[role="button"]')]
          .find(el => /^post$/i.test((el.innerText||'').trim()));
      if (postBtn) {
        postBtn.click();
        step(4, total, '✅ Posted to Facebook!', 'success');
        document.dispatchEvent(new CustomEvent('__ffbot_complete', { detail:{ platform:'facebook' } }));
      } else {
        step(4, total, '⚠️ Could not find Post button', 'warn');
        document.dispatchEvent(new CustomEvent('__ffbot_failed', { detail:{ platform:'facebook', error:'Post button not found' } }));
      }
    } else if (songName) {
      step(5, total, `Add <em>"${songName}"</em> via <strong>Feeling/Activity → Music</strong>, then click <strong>Post</strong>.`, 'success');
    } else {
      step(4, total, `✅ ${files.length} photo${files.length > 1 ? 's' : ''} &amp; caption ready — click <strong>Post</strong> to publish.`, 'success');
    }
  })();
}

// ─── Instagram ────────────────────────────────────────────────────────────────

function injectInstagram(photoDataUrls, caption, songName, location, opts) {
  const { restaurantName = '' } = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const waitFor = (sel, ms = 12000) => new Promise(res => {
    const el = document.querySelector(sel); if (el) return res(el);
    const t = Date.now(); const iv = setInterval(() => {
      const e = document.querySelector(sel);
      if (e) { clearInterval(iv); return res(e); }
      if (Date.now() - t > ms) { clearInterval(iv); return res(null); }
    }, 300);
  });

  // Wait for an interactive element whose innerText / aria-label matches
  const waitForBtn = (match, ms = 12000) => new Promise(res => {
    const find = () => [...document.querySelectorAll(
      '[role="button"], button, a, [tabindex="0"]'
    )].find(el => {
      const txt = (el.innerText || el.textContent || '').trim();
      const lbl = el.getAttribute('aria-label') || '';
      return typeof match === 'string'
        ? txt === match || lbl === match
        : match.test(txt) || match.test(lbl);
    });
    const el = find(); if (el) return res(el);
    const t = Date.now(); const iv = setInterval(() => {
      const e = find();
      if (e) { clearInterval(iv); return res(e); }
      if (Date.now() - t > ms) { clearInterval(iv); return res(null); }
    }, 300);
  });

  function dataUrlToFile(url, name) {
    const [hdr, b64] = url.split(',');
    const mime = hdr.match(/:(.*?);/)[1];
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: mime });
  }

  function dropFilesOn(zone, files) {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    ['dragenter', 'dragover'].forEach(ev =>
      zone.dispatchEvent(new DragEvent(ev, { bubbles: true, cancelable: true, dataTransfer: dt })));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }

  // ── Banner with inline debug log ─────────────────────────────────────────────
  // The banner always stays visible; a small log area below the main message
  // shows the last few actions so you can see exactly what the bot did.

  function ensureBanner(n, total, html, type = 'info') {
    let b = document.getElementById('ffbot-banner');
    if (!b) {
      b = document.createElement('div'); b.id = 'ffbot-banner';
      const bg = { info: '#e8490f', success: '#16a34a', warn: '#d97706' }[type] || '#e8490f';
      b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;
        background:${bg};color:#fff;font-family:-apple-system,sans-serif;
        font-size:13px;font-weight:500;padding:10px 16px;
        box-shadow:0 3px 14px rgba(0,0,0,.28);`;
      b.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <strong>🍽️ FoodFluencer</strong>
          <span id="ffbot-step" style="background:rgba(255,255,255,.22);border-radius:20px;
            padding:1px 8px;font-size:.72rem"></span>
          <span id="ffbot-msg" style="font-weight:400;flex:1"></span>
          <button id="ffbot-close-btn"
            style="background:rgba(255,255,255,.22);border:none;color:#fff;
            border-radius:5px;padding:3px 9px;cursor:pointer;flex-shrink:0">✕</button>
        </div>
        <div id="ffbot-log" style="font-size:.7rem;opacity:.8;line-height:1.5;
          max-height:60px;overflow:hidden"></div>`;
      document.body.prepend(b);
      b.querySelector('#ffbot-close-btn')?.addEventListener('click', () => b.remove());
    }
    const bg = { info: '#e8490f', success: '#16a34a', warn: '#d97706' }[type] || '#e8490f';
    b.style.background = bg;
    document.getElementById('ffbot-step').textContent = `${n}/${total}`;
    document.getElementById('ffbot-msg').innerHTML = html;
  }

  function dbg(msg) {
    ensureBanner.__last_n = ensureBanner.__last_n || 1;
    ensureBanner.__last_total = ensureBanner.__last_total || 5;
    const logEl = document.getElementById('ffbot-log');
    if (!logEl) return;
    const ts = new Date().toTimeString().slice(0, 8);
    const row = document.createElement('div');
    row.innerHTML = `<span style="opacity:.6">${ts}</span> ${msg}`;
    logEl.prepend(row);
    // Keep last 4 entries
    while (logEl.children.length > 4) logEl.lastChild.remove();
    console.log(`[FoodFluencer] ${msg}`); // also log to DevTools console
  }

  function step(n, total, html, type = 'info') {
    ensureBanner.__last_n = n;
    ensureBanner.__last_total = total;
    ensureBanner(n, total, html, type);
    dbg(`Step ${n}/${total}: ${html.replace(/<[^>]+>/g, '')}`);
  }

  (async () => {
    // Steps: create+post(1) upload(2) crop-Next(3) edit-Next(4) caption(5) location(6) collab(7) [+1 if song]
    const total = songName ? 8 : 7;
    step(1, total, 'Loading Instagram…');
    await sleep(1500); // wait for SPA hydration

    // ══ STEP 1a: Find and click the Create "+" button ══════════════════════════
    step(1, total, 'Looking for Create (+) button…');

    function findCreateBtn() {
      // Check explicit aria-labels first
      for (const sel of ['[aria-label="New post"]', '[aria-label="Create"]']) {
        const el = document.querySelector(sel);
        if (el) { dbg(`Found create btn via aria-label: ${sel}`); return el.closest('a,[role="button"],button') || el; }
      }
      // SVG with aria-label
      const svg = [...document.querySelectorAll('svg[aria-label]')]
        .find(s => /new post|create/i.test(s.getAttribute('aria-label')));
      if (svg) { dbg(`Found create btn via SVG: ${svg.getAttribute('aria-label')}`); return svg.closest('a,[role="button"],button') || svg; }
      // Nav anchor/button with text "Create"
      const byText = [...document.querySelectorAll('a,[role="button"],button')]
        .find(el => /^create$/i.test((el.innerText || '').trim()));
      if (byText) { dbg('Found create btn by text "Create"'); return byText; }
      dbg('Create button not found yet…');
      return null;
    }

    let createBtn = null;
    for (let i = 0; i < 8 && !createBtn; i++) {
      createBtn = findCreateBtn();
      if (!createBtn) await sleep(600);
    }

    if (!createBtn) {
      step(1, total, 'Could not find the <strong>+</strong> Create button. Please click it manually.', 'warn');
      dbg('FAILED: create button not found after 8s');
      // Don't overwrite the guidance banner — fall through to waitFor('[role="dialog"]')
      // so the bot resumes automatically once the user navigates to the upload dialog.
    } else {
      dbg(`Clicking create button: ${createBtn.tagName} aria="${createBtn.getAttribute('aria-label')}"`);
      createBtn.click();

      // ══ STEP 1b: Snapshot pre-existing "Post" elements, then find the NEW one ═══
      // Snapshot taken IMMEDIATELY after clicking — before the menu animates in.
      // We record every element whose visible text is exactly "Post" so we can
      // distinguish the new menu item (added by Instagram) from anything pre-existing.
      const prePostEls = new Set(
        [...document.querySelectorAll('*')]
          .filter(el => (el.innerText || el.textContent || '').trim() === 'Post')
      );
      dbg(`Snapshot: ${prePostEls.size} existing elements with text "Post"`);

      step(1, total, 'Waiting for Post/Story/Reel menu to appear…');
      await sleep(700);

      async function findAndClickPostOption() {
        // Find NEW elements with text exactly "Post" — exclude pre-existing ones AND
        // exclude container ancestors whose textContent equals "Post" only because a
        // CHILD element does (innerText is not implemented in jsdom, so we can't use
        // it; instead we filter to the innermost match: an element is "innermost" if
        // none of its direct children also has textContent === "Post").
        const newPostEls = [...document.querySelectorAll('*')]
          .filter(el => {
            const txt = (el.innerText || el.textContent || '').trim();
            if (txt !== 'Post') return false;
            if (prePostEls.has(el)) return false;
            // Exclude containers — only keep leaf / innermost matches
            return ![...el.children].some(
              child => (child.innerText || child.textContent || '').trim() === 'Post'
            );
          });

        dbg(`Found ${newPostEls.length} new "Post" element(s) after clicking Create`);

        if (newPostEls.length > 0) {
          // Pick the first one and find its nearest clickable ancestor (or itself)
          const target = newPostEls[0].closest('a,[role="button"],button,[tabindex]') || newPostEls[0];
          dbg(`Clicking: ${target.tagName} class="${target.className.toString().slice(0,40)}"`);
          target.click();
          return true;
        }
        return false;
      }

      let postClicked = false;
      for (let i = 0; i < 10 && !postClicked; i++) {
        postClicked = await findAndClickPostOption();
        if (!postClicked) { dbg(`Retry ${i + 1}/10 — post option not visible yet`); await sleep(350); }
      }

      if (!postClicked) {
        step(1, total, 'Please click <strong>Post</strong> from the menu — bot will continue when the upload dialog appears.', 'warn');
        dbg('FAILED: Post option not found — waiting for dialog manually');
      } else {
        step(1, total, '"Post" clicked — waiting for upload dialog…');
      }
    }

    // Wait for the upload dialog to appear (has a file input or drag-drop area)
    await waitFor('[role="dialog"]', 10000);
    await sleep(500);
    dbg('Upload dialog appeared');

    // ══ STEP 2: Inject photos ═════════════════════════════════════════════════
    // Apply cover overlay to the first photo (restaurant name + tagline on darkest zone)
    // Mirrors the popup.js createCoverOverlay logic — runs here in MAIN world (Canvas access).
    async function applyCoverOverlay(dataUrl, name, addr) {
      return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
          try {
            // ── Canvas: cap at 1080px wide, render at 2× for crisp text ───
            // Rendering at double resolution prevents blurry text on
            // high-DPI displays — the JPEG export captures the full
            // 2× pixels, so Instagram sees a sharp image regardless of device.
            const MAX_W = 1080;
            const srcW = img.naturalWidth  || 1080;
            const srcH = img.naturalHeight || 1080;
            const sc   = Math.min(1, MAX_W / srcW);
            const W = Math.round(srcW * sc);   // logical size (used for all coordinates)
            const H = Math.round(srcH * sc);
            const DPR = 2;                     // render at 2× for sharp text
            const cv = document.createElement('canvas');
            cv.width  = W * DPR;
            cv.height = H * DPR;
            const cx = cv.getContext('2d');
            cx.scale(DPR, DPR);               // all drawing coords stay in logical pixels
            cx.drawImage(img, 0, 0, W, H);

            // ── Luminance: pick darkest of 3 horizontal zones ──────────────
            // getImageData reads physical canvas pixels, so multiply by DPR.
            function sampleLum(y0, h0) {
              try {
                const d = cx.getImageData(0, Math.round(y0*DPR), W*DPR, Math.max(1, Math.round(h0*DPR))).data;
                let s = 0, n = 0;
                for (let i = 0; i < d.length; i += 16) { s += 0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]; n++; }
                return n ? s/n : 128;
              } catch(_) { return 128; }
            }
            const zones = [
              { lum: sampleLum(0,       H*0.37), centerY: H*0.22 },
              { lum: sampleLum(H*0.30,  H*0.40), centerY: H*0.50 },
              { lum: sampleLum(H*0.63,  H*0.37), centerY: H*0.80 },
            ];
            const best = zones.reduce((a, b) => a.lum <= b.lum ? a : b);

            // ── Text sizes: use SMALLER dimension as reference ─────────────
            // Using Math.min(W,H) keeps text proportional regardless of
            // aspect ratio — landscape photos get smaller text than squares.
            const ref        = Math.min(W, H);
            const nameSize   = Math.max(24, Math.round(ref * 0.058));
            const tagSize    = Math.max(12, Math.round(ref * 0.022));
            const cornerSize = Math.max(9,  Math.round(ref * 0.013));
            const gap        = Math.round(nameSize * 0.38);
            const maxTW      = W * 0.78;  // max text width — prevents overflow

            // ── City + tagline ─────────────────────────────────────────────
            const cityM = (addr||'').match(/\d{4}\s+([A-Za-zÀ-ÿ\s-]+),\s*Belgium/i);
            const city  = (cityM?.[1] || (addr||'').split(',')[0] || '').trim();
            const taglines = [
              `Discover ${city}'s hidden gem ✨`,
              `Best kept secret in ${city} 🍽`,
              `A must-visit in ${city} 📍`,
              `Taste the best of ${city} 🔥`,
            ];
            const tagline = city
              ? taglines[Math.abs([...(name||'')].reduce((a,c)=>a+c.charCodeAt(0),0)) % taglines.length]
              : 'Discover this hidden gem ✨';

            // ── Measure name width; split into two lines if too wide ───────
            cx.font = `400 ${nameSize}px "Cormorant Garamond",Georgia,Palatino,serif`;
            const nameLines = (() => {
              if (!name) return [''];
              if (cx.measureText(name).width <= maxTW) return [name];
              // Split at the middle space closest to centre
              const words = name.split(' ');
              let best2 = [name, ''];
              let bestDiff = Infinity;
              for (let i = 1; i < words.length; i++) {
                const l1 = words.slice(0, i).join(' ');
                const l2 = words.slice(i).join(' ');
                const diff = Math.abs(cx.measureText(l1).width - cx.measureText(l2).width);
                if (diff < bestDiff) { bestDiff = diff; best2 = [l1, l2]; }
              }
              return best2;
            })();

            // ── Total text block height (for centring and vignette) ────────
            const nameBlockH = nameLines.length > 1
              ? nameSize * 2 + gap * 0.5
              : nameSize;
            const blockH = tagSize + gap + nameBlockH;
            const padV  = nameSize * 0.9;  // vertical padding around text block

            // ── Vignette: sized to exactly fit the text block + padding ────
            const vigTop = best.centerY - blockH / 2 - padV;
            const vigBot = best.centerY + blockH / 2 + padV;
            const vl = cx.createLinearGradient(0, vigTop, 0, vigBot);
            vl.addColorStop(0,   'rgba(0,0,0,0.00)');
            vl.addColorStop(0.3, 'rgba(0,0,0,0.42)');
            vl.addColorStop(0.7, 'rgba(0,0,0,0.42)');
            vl.addColorStop(1,   'rgba(0,0,0,0.00)');
            cx.fillStyle = vl; cx.fillRect(0, 0, W, H);

            // Subtle edge vignette using image diagonal (works for any aspect ratio)
            const diag = Math.sqrt(W*W + H*H) / 2;
            const ve = cx.createRadialGradient(W/2, H/2, diag*0.40, W/2, H/2, diag*0.95);
            ve.addColorStop(0, 'rgba(0,0,0,0.00)');
            ve.addColorStop(1, 'rgba(0,0,0,0.20)');
            cx.fillStyle = ve; cx.fillRect(0, 0, W, H);

            // ── Draw text ──────────────────────────────────────────────────
            cx.fillStyle = '#fff'; cx.textAlign = 'center'; cx.textBaseline = 'top';
            cx.shadowColor = 'rgba(0,0,0,0.65)'; cx.shadowOffsetX = 0;

            let ty = best.centerY - blockH / 2;

            // Tagline
            cx.font = `300 italic ${tagSize}px "Cormorant Garamond",Georgia,Palatino,serif`;
            cx.shadowBlur = Math.round(tagSize * 0.5); cx.shadowOffsetY = 1;
            cx.fillText(tagline, W/2, ty, maxTW);
            ty += tagSize + gap;

            // Restaurant name (one or two lines)
            cx.font = `400 ${nameSize}px "Cormorant Garamond",Georgia,Palatino,serif`;
            cx.shadowBlur = Math.round(nameSize * 0.22); cx.shadowOffsetY = 2;
            if (nameLines.length > 1) {
              cx.fillText(nameLines[0], W/2, ty, maxTW);
              ty += nameSize + Math.round(gap * 0.5);
              cx.fillText(nameLines[1], W/2, ty, maxTW);
            } else {
              cx.fillText(nameLines[0], W/2, ty, maxTW);
            }

            // Corner label
            if (city) {
              cx.font = `300 ${cornerSize}px "Cormorant Garamond",Georgia,Palatino,serif`;
              cx.textAlign = 'right'; cx.textBaseline = 'bottom';
              cx.shadowBlur = 2; cx.shadowOffsetY = 0;
              cx.fillText(`${city}, Belgium`, W - Math.round(W*0.030), H - Math.round(H*0.022));
            }

            resolve(cv.toDataURL('image/jpeg', 0.93));
          } catch(e) {
            dbg(`Cover overlay failed: ${e.message} — using original`);
            resolve(dataUrl);
          }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      });
    }

    // Build files array — apply cover overlay to first photo only
    step(2, total, `Applying cover overlay…`);
    const coveredFirst = (restaurantName && photoDataUrls.length > 0)
      ? await applyCoverOverlay(photoDataUrls[0], restaurantName, location || '')
      : photoDataUrls[0];
    const allUrls = [coveredFirst, ...photoDataUrls.slice(1)];
    const files = allUrls.map((url, i) => dataUrlToFile(url, `restaurant-${i + 1}.jpg`));
    step(2, total, `Uploading ${files.length} photo${files.length > 1 ? 's' : ''}…`);

    let fileInput = null;
    for (let attempt = 0; attempt < 10 && !fileInput; attempt++) {
      fileInput = document.querySelector('input[type="file"]');
      if (fileInput) { dbg(`File input found on attempt ${attempt + 1}`); break; }
      const selBtn = [...document.querySelectorAll('[role="button"], button')]
        .find(el => /select.*computer|from.*computer/i.test(el.innerText || el.textContent || ''));
      if (selBtn) { selBtn.click(); dbg('Clicked "Select from computer"'); }
      await sleep(500);
    }

    if (fileInput) {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
      if (setter) setter.call(fileInput, dt.files); else fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.dispatchEvent(new Event('input',  { bubbles: true }));
      dbg('Files injected into input');
    } else {
      dbg('File input not found — trying drag-and-drop fallback');
      const zone = document.querySelector('[role="dialog"] *') || document.querySelector('[role="dialog"]');
      if (zone) dropFilesOn(zone, files);
    }

    // Wait for the crop/arrange screen — editor ready when "Next" appears in the dialog
    step(2, total, 'Waiting for Instagram to process photos…');

    // ── Visibility check using getBoundingClientRect (works through animations) ─
    function isVisible(el) {
      if (!el || !document.contains(el)) return false;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      // Accept if element has size and is somewhere in the viewport
      return r.width > 0 && r.height > 0;
    }

    const NEXT_RE = /^(next|volgende|suivant|weiter|siguiente|næste|neste|seuraava)$/i;

    // Find the STEP "Next" button (header, top-right) — NOT the carousel arrow.
    // The header Next has visible TEXT "Next"; the carousel arrow is icon-only (empty text).
    // Priority: text match first, then aria-label match sorted by position in dialog.
    function findVisibleNextBtn() {
      const dialog = document.querySelector('[role="dialog"]');
      const roots  = [dialog, document.body].filter(Boolean);

      // ① Prefer elements whose visible text IS "Next" (header step button)
      for (const root of roots) {
        const btn = [...root.querySelectorAll('[role="button"],button,[tabindex="0"],a')]
          .find(el => {
            const txt = (el.innerText || el.textContent || '').trim();
            return NEXT_RE.test(txt) && isVisible(el);
          });
        if (btn) {
          dbg(`Next by text: "${(btn.innerText||btn.textContent||'').trim()}" top=${Math.round(btn.getBoundingClientRect().top)}`);
          return btn;
        }
      }

      // ② Fall back to aria-label — but pick the TOPMOST one inside the dialog
      //    (header Next is at the top; carousel arrows are mid-screen)
      if (dialog) {
        const dlgTop = dialog.getBoundingClientRect().top;
        const ariaNexts = [...dialog.querySelectorAll('[role="button"],button,[tabindex="0"],a')]
          .filter(el => NEXT_RE.test(el.getAttribute('aria-label') || '') && isVisible(el))
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

        if (ariaNexts.length > 0) {
          const picked = ariaNexts[0];
          dbg(`Next by aria-label (topmost, rel-top=${Math.round(picked.getBoundingClientRect().top - dlgTop)}px): aria="${picked.getAttribute('aria-label')}"`);
          return picked;
        }
      }

      return null;
    }

    // Fire mouse + keyboard events — keyboard (Enter) bypasses pointer-events:none
    // and React's synthetic event delegation handles both equally well.
    function reactClick(el) {
      el.focus();
      // Mouse sequence
      ['mouseenter', 'mouseover', 'mousedown', 'mouseup', 'click'].forEach(type =>
        el.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, view: window,
          buttons: 1, detail: type === 'click' ? 1 : 0,
        }))
      );
      // Also native click (sometimes React needs this too)
      el.click();
      // Keyboard Enter — works even if pointer-events:none is set on the element
      ['keydown', 'keypress', 'keyup'].forEach(type =>
        el.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13,
          bubbles: true, cancelable: true, view: window,
        }))
      );
    }

    // Check if we're on the caption/details screen (final step before Share).
    // IMPORTANT: must be specific and require visibility — the filter screen also
    // has contenteditable/textbox elements that cause false positives.
    function onCaptionScreen() {
      const specific = [
        'textarea[aria-label="Write a caption..."]',
        'div[aria-label="Write a caption..."]',
        'textarea[placeholder*="Write a caption" i]',
      ];
      return specific.some(sel => {
        const el = document.querySelector(sel);
        return el && isVisible(el);
      });
    }

    // Wait until a specific button is no longer visible OR removed from DOM.
    // Instagram often hides (CSS) rather than removes buttons during transitions.
    async function waitForBtnToDisappear(btn, ms = 6000) {
      const start = Date.now();
      while (Date.now() - start < ms) {
        await sleep(150);
        if (!document.contains(btn) || !isVisible(btn)) {
          dbg('Previous Next hidden/removed — transition confirmed');
          return true;
        }
      }
      dbg('waitForBtnToDisappear: timed out (button still visible)');
      return false;
    }

    // ══ STEP 2 → 3: Two "Next" clicks to reach the caption/Share screen ════════
    step(2, total, 'Waiting for editor to load…');

    for (let clickNum = 1; clickNum <= 2; clickNum++) {
      const label = clickNum === 1 ? 'crop' : 'filter/edit';
      step(clickNum + 1, total, `Advancing past ${label} step…`);

      // Wait for a VISIBLE Next button — 18s for first (photo processing), 12s for second
      const timeout = clickNum === 1 ? 18000 : 12000;
      let preClickBtn = null;
      const pollStart = Date.now();
      while (Date.now() - pollStart < timeout && !preClickBtn) {
        preClickBtn = findVisibleNextBtn();
        if (!preClickBtn) await sleep(200);
      }

      if (!preClickBtn) {
        // Fallback: log ALL elements with "Next" text (visible or not) and try each
        const allNext = [...document.querySelectorAll('[role="button"],button,[tabindex="0"],a')]
          .filter(el => NEXT_RE.test((el.innerText || el.textContent || '').trim()) ||
                        NEXT_RE.test(el.getAttribute('aria-label') || ''));
        dbg(`No visible Next found. All Next candidates (${allNext.length}):`);
        allNext.forEach((el, i) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          dbg(`  [${i}] <${el.tagName}> display=${s.display} vis=${s.visibility} op=${s.opacity} size=${Math.round(r.width)}x${Math.round(r.height)} top=${Math.round(r.top)}`);
        });

        // Try clicking all candidates, starting with any that have non-zero size
        let triedAny = false;
        for (const candidate of allNext) {
          const r = candidate.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) {
            dbg(`Trying fallback click on candidate`);
            reactClick(candidate);
            candidate.click();
            triedAny = true;
            await sleep(1500);
            // Check if we advanced (caption area should now be visible)
            if (document.querySelector('textarea[aria-label*="caption" i], div[aria-label*="caption" i]')) {
              dbg('Caption screen detected — fallback click worked!');
              break;
            }
          }
        }

        if (!triedAny) {
          step(clickNum + 1, total,
            `Please click <strong>Next</strong> at the top-right of the popup (step ${clickNum}/2).`, 'warn');
          dbg(`All fallbacks failed — waiting 12s for manual click`);
          await sleep(12000);
        }
        continue;
      }

      const btnTxt  = (preClickBtn.innerText || preClickBtn.textContent || '').trim();
      const btnRect  = preClickBtn.getBoundingClientRect();
      const btnPtr   = window.getComputedStyle(preClickBtn).pointerEvents;
      dbg(`Click ${clickNum}/2 (${label}): <${preClickBtn.tagName}> "${btnTxt}" ${Math.round(btnRect.width)}x${Math.round(btnRect.height)}@top${Math.round(btnRect.top)} pointer-events=${btnPtr}`);

      // Try up to 4 times — exit only when the BUTTON IS GONE (not a caption check,
      // which gives false positives on the filter screen).
      let btnGone = false;
      for (let attempt = 1; attempt <= 4 && !btnGone; attempt++) {
        await sleep(attempt === 1 ? 200 : 700);
        reactClick(preClickBtn);
        dbg(`Attempt ${attempt}/4: fired mouse+keyboard on "${btnTxt}"`);

        // Wait up to 4s for this specific button to disappear/hide
        const t0 = Date.now();
        while (Date.now() - t0 < 4000) {
          await sleep(200);
          if (!document.contains(preClickBtn) || !isVisible(preClickBtn)) {
            dbg(`Button gone on attempt ${attempt} — transition confirmed`);
            btnGone = true;
            break;
          }
        }
        if (!btnGone) dbg(`Attempt ${attempt} — button still visible after 4s`);
      }

      if (!btnGone) {
        dbg(`4 attempts exhausted for ${label} Next — waiting up to 20s for manual click`);
        step(clickNum + 1, total,
          `Please click <strong>Next</strong> at the top-right to continue past the ${label} step.`, 'warn');
        const t1 = Date.now();
        while (Date.now() - t1 < 20000) {
          await sleep(500);
          if (!document.contains(preClickBtn) || !isVisible(preClickBtn)) {
            dbg('Manual advance detected (button gone)'); break;
          }
        }
      }

      await sleep(1000); // let the next screen fully render
    }

    // Wait for the caption screen to actually appear before proceeding
    dbg('Both Next clicks done — waiting for caption screen…');
    step(4, total, 'Waiting for caption screen…');
    const captionWait = Date.now();
    while (Date.now() - captionWait < 10000 && !onCaptionScreen()) {
      await sleep(300);
    }
    if (onCaptionScreen()) { dbg('Caption screen confirmed'); }
    else { dbg('Caption screen not detected after 10s — proceeding anyway'); }

    // ══ STEP 4: Fill caption ══════════════════════════════════════════════════════
    step(4, total, 'Filling caption…');
    const captionSels = [
      'textarea[aria-label="Write a caption..."]',
      'div[aria-label="Write a caption..."]',
      'textarea[placeholder*="caption" i]',
      '[contenteditable="true"][aria-multiline="true"]',
      '[contenteditable="true"][aria-required]',
      '[role="textbox"]',
    ];
    let captionEl = null;
    for (let att = 0; att < 10 && !captionEl; att++) {
      for (const s of captionSels) { captionEl = document.querySelector(s); if (captionEl) { dbg(`Caption found: ${s}`); break; } }
      if (!captionEl) await sleep(400);
    }
    if (captionEl) {
      captionEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      captionEl.click(); await sleep(400);
      if (captionEl.tagName === 'TEXTAREA') {
        const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (s) s.call(captionEl, caption); else captionEl.value = caption;
        captionEl.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        captionEl.focus(); await sleep(200);
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, caption);
      }
      dbg('Caption filled');
    } else { dbg('WARNING: caption field not found'); }

    // ══ STEP 5 (if location): Add location ════════════════════════════════════
    if (location) {
      await sleep(600);
      step(5, total, 'Adding location…');

      // Extract the city name from address like "1000 Brussels, Belgium" → "Brussels"
      const cityMatch = location.match(/\d{4}\s+([A-Za-zÀ-ÿ\s-]+),\s*Belgium/i);
      const searchTerm = (cityMatch?.[1] || location.split(',')[0] || location).trim();
      dbg(`Location search term: "${searchTerm}"`);

      // Find the "Add location" trigger — Instagram renders it as a row button
      const locTrigger = [...document.querySelectorAll('[role="button"],button,div[tabindex="0"],a')]
        .find(el => /add\s+(a\s+)?location/i.test(
          el.getAttribute('aria-label') || el.innerText || el.textContent || ''));

      if (locTrigger) {
        dbg(`Location trigger: <${locTrigger.tagName}> "${(locTrigger.innerText||'').trim()}"`);
        reactClick(locTrigger);
        await sleep(800);

        // Wait for the location search input to appear
        const locInput = await waitFor(
          'input[placeholder*="Search" i], input[aria-label*="location" i], input[name*="location" i]',
          5000
        );
        if (locInput) {
          reactClick(locInput);
          await sleep(300);
          // Type the search term character by character (triggers Instagram's autocomplete)
          for (const ch of searchTerm) {
            document.execCommand('insertText', false, ch);
            await sleep(60);
          }
          dbg(`Typed location: "${searchTerm}"`);
          await sleep(2500); // wait for results to load

          // Click the first result using reactClick
          const firstResult = [...document.querySelectorAll(
            '[role="option"], [role="listitem"], [class*="Location"] [role="button"]'
          )].find(el => isVisible(el));
          if (firstResult) {
            dbg(`Location result: "${(firstResult.innerText||'').trim().slice(0,50)}"`);
            reactClick(firstResult);
            await sleep(700);
            step(5, total, `📍 Location set`);
          } else {
            dbg('No location results — skipping');
          }
        } else {
          dbg('Location input not found after trigger click');
        }
      } else {
        dbg('Location trigger not found on page');
      }
    }

    // ══ STEP 7: Search for restaurant as collaborator ════════════════════════
    const collabStep = total - (songName ? 1 : 0);
    step(collabStep, total, 'Searching for restaurant collaborator…');
    await sleep(500);

    if (restaurantName) {
      const collabTrigger = [...document.querySelectorAll('[role="button"],button,div[tabindex="0"]')]
        .find(el => /invite.*collab|add.*collab|collab/i.test(
          el.innerText || el.textContent || el.getAttribute('aria-label') || ''));

      if (collabTrigger) {
        dbg(`Collab trigger found: "${collabTrigger.innerText?.trim()}"`);
        collabTrigger.click(); await sleep(1000);

        const searchInput = await waitFor('input[placeholder*="Search" i],input[type="text"]', 3000);
        if (searchInput) {
          searchInput.focus(); await sleep(200);
          const searchTerm = restaurantName.replace(/[^\w\s]/g, ' ').trim().slice(0, 25);
          for (const ch of searchTerm) { document.execCommand('insertText', false, ch); await sleep(45); }
          dbg(`Searching collaborator: "${searchTerm}"`);
          await sleep(2000);

          const results = [...document.querySelectorAll('[role="option"], [class*="user"], [class*="account"]')]
            .filter(el => isVisible(el));
          if (results.length > 0) {
            const firstResult = results[0];
            const resultText = (firstResult.innerText || firstResult.textContent || '').toLowerCase();
            const searchLower = searchTerm.toLowerCase().replace(/\s+/g, '');
            const resultNorm  = resultText.replace(/\s+/g, '');
            const isMatch = resultNorm.includes(searchLower.slice(0, 5)) ||
                            searchLower.includes(resultNorm.slice(0, 5));

            if (isMatch) {
              firstResult.click(); await sleep(500);
              dbg(`Collaborator added: ${firstResult.innerText?.trim()}`);
              step(collabStep, total, `✅ Collaborator <strong>${firstResult.innerText?.trim()}</strong> added.`);
            } else {
              dbg(`No close match for "${restaurantName}" — top result: "${firstResult.innerText?.trim()}" — skipping`);
              step(collabStep, total, `No matching collaborator found for <em>"${restaurantName}"</em> — skipping.`);
              const backBtn = document.querySelector('[aria-label="Back"],[aria-label="Close"]');
              if (backBtn) { backBtn.click(); await sleep(400); }
            }
          } else {
            dbg('No collaborator search results');
            step(collabStep, total, `No Instagram account found for <em>"${restaurantName}"</em> — skipping.`);
            const backBtn = document.querySelector('[aria-label="Back"],[aria-label="Close"]');
            if (backBtn) { backBtn.click(); await sleep(400); }
          }
        }
      } else {
        dbg('Collab button not found on page');
        step(collabStep, total, 'Collaborator section not found — skipping.');
      }
    }

    // ══ Final: auto-click Share (auto mode) or wait for user (manual mode) ═══
    const { autoPost = false } = opts || {};
    if (autoPost) {
      step(total, total, '🤖 Finding Share button…');
      await sleep(600);

      // Share sits in the same top-right header position as the Next buttons.
      // Use the same strategy: text match first, then aria-label, always topmost.
      const SHARE_RE = /^(share|delen|partager|teilen|condividi|compartir|публикувам|dela)$/i;

      function findVisibleShareBtn() {
        const dialog = document.querySelector('[role="dialog"]');
        const roots  = [dialog, document.body].filter(Boolean);

        // ① Text match — exact "Share" visible inside the dialog header
        for (const root of roots) {
          const btn = [...root.querySelectorAll('[role="button"],button,[tabindex="0"],a')]
            .find(el => {
              const txt = (el.innerText || el.textContent || '').trim();
              return SHARE_RE.test(txt) && isVisible(el);
            });
          if (btn) {
            dbg(`Share btn by text: "${(btn.innerText||btn.textContent||'').trim()}"`);
            return btn;
          }
        }

        // ② aria-label fallback — pick topmost inside dialog
        if (dialog) {
          const candidates = [...dialog.querySelectorAll('[role="button"],button,[tabindex="0"],a')]
            .filter(el => SHARE_RE.test(el.getAttribute('aria-label') || '') && isVisible(el))
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
          if (candidates.length) {
            dbg(`Share btn by aria-label: "${candidates[0].getAttribute('aria-label')}"`);
            return candidates[0];
          }
        }
        return null;
      }

      // Poll up to 15 s — location/collab steps may still be animating
      let shareBtn = null;
      const shareDeadline = Date.now() + 15000;
      while (!shareBtn && Date.now() < shareDeadline) {
        shareBtn = findVisibleShareBtn();
        if (!shareBtn) await sleep(400);
      }

      if (shareBtn) {
        step(total, total, '🤖 Auto-clicking Share…');
        reactClick(shareBtn);
        dbg('Fired reactClick on Share button');

        // Poll for Instagram's success confirmation message (up to 20 s).
        // Instagram shows "Your post has been shared" in the dialog after posting.
        // If we see it → confirmed success.  If we time out → optimistic success.
        step(total, total, '⏳ Waiting for post confirmation…');
        const SUCCESS_RE = /your post has been shared|post.*shared|shared.*successfully|je bericht is gedeeld|bericht.*gedeeld/i;
        let postConfirmed = false;
        const confirmDeadline = Date.now() + 20000;
        while (Date.now() < confirmDeadline) {
          await sleep(500);
          const pageText = document.body.innerText || '';
          if (SUCCESS_RE.test(pageText)) {
            postConfirmed = true;
            dbg('Instagram confirmed: "Your post has been shared"');
            break;
          }
        }

        if (postConfirmed) {
          step(total, total, '✅ Instagram confirmed: post shared!', 'success');
        } else {
          dbg('Confirmation text not found within 20 s — assuming success');
          step(total, total, '✅ Posted to Instagram!', 'success');
        }
        document.dispatchEvent(new CustomEvent('__ffbot_complete', { detail:{ platform:'instagram' } }));
      } else {
        step(total, total, '⚠️ Share button not found — click it manually.', 'warn');
        document.dispatchEvent(new CustomEvent('__ffbot_failed', { detail:{ platform:'instagram', error:'Share button not found' } }));
      }
    } else {
      const songHint = songName ? ` &nbsp;🎵 Tap <strong>Add music</strong> → <em>"${songName}"</em>.` : '';
      step(total, total,
        `✅ All ready! Review caption, location &amp; collaborator.${songHint} Click <strong>Share</strong> to publish.`,
        'success');
      dbg('Bot stopped — waiting for user to click Share');
    }
  })();
}

// ─── TikTok ───────────────────────────────────────────────────────────────────
// Tries 3 upload approaches in sequence until TikTok accepts one.

function injectTikTok(photoDataUrls, caption, songName, location, opts) {
  const { tiktokAudioDataUrl = null } = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = (sel, ms = 12000) => new Promise(res => {
    const el = document.querySelector(sel); if (el) return res(el);
    const t = Date.now(); const iv = setInterval(() => {
      const e = document.querySelector(sel);
      if (e) { clearInterval(iv); return res(e); }
      if (Date.now() - t > ms) { clearInterval(iv); return res(null); }
    }, 300);
  });

  const TOTAL = 5;
  function banner(n, html, type = 'info') {
    document.getElementById('ffbot-banner')?.remove();
    const b = document.createElement('div'); b.id = 'ffbot-banner';
    const bg = { info: '#e8490f', success: '#16a34a', warn: '#d97706' }[type] || '#e8490f';
    b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;
      background:${bg};color:#fff;font-family:-apple-system,sans-serif;font-size:13px;
      font-weight:500;padding:12px 16px;box-shadow:0 4px 16px rgba(0,0,0,.3);`;
    b.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <strong>🍽️ FoodFluencer</strong>
        <span style="background:rgba(255,255,255,.22);border-radius:20px;padding:1px 8px;font-size:.72rem">${n}/${TOTAL}</span>
        <span style="font-weight:400;flex:1">${html}</span>
        <button id="ffbot-close-btn"
          style="background:rgba(255,255,255,.22);border:none;color:#fff;border-radius:5px;padding:3px 9px;cursor:pointer">✕</button>
      </div>
      <div id="ffbot-log" style="font-size:.68rem;opacity:.78;max-height:30px;overflow:hidden"></div>`;
    document.body.prepend(b);
    b.querySelector('#ffbot-close-btn')?.addEventListener('click', () => b.remove());
  }
  function dbg(msg) {
    const l = document.getElementById('ffbot-log');
    if (l) { const d = document.createElement('span'); d.textContent = `→ ${msg}  `; l.prepend(d); }
    console.log(`[FoodFluencer TikTok] ${msg}`);
  }

  // ── Step tracker — every notable action is recorded so TechLog always knows
  // exactly which step the bot was performing, including the step right before
  // any "Something went wrong" error page appears ──────────────────────────
  let lastStep = { name: 'init', detail: null };
  function step(name, detail) {
    lastStep = { name, detail: detail || null };
    dbg(`STEP: ${name}${detail ? ' — ' + detail : ''}`);
    document.dispatchEvent(new CustomEvent('__ffbot_event', { detail: {
      type: 'TIKTOK_STEP', step: name, detail: detail || null,
    }}));
  }

  // ── "Something went wrong" error-page detector ───────────────────────────
  // TikTok shows a generic "Something went wrong Please try again." screen on
  // certain failures. When seen, report which step preceded it so we can
  // pinpoint exactly where the flow broke.
  const ERROR_PAGE_RE = /something\s+went\s+wrong[.\s]*please\s+try\s+again/i;
  let errorPageReported = false;
  function checkForErrorPage() {
    if (errorPageReported) return false;
    const text = document.body.innerText || '';
    if (ERROR_PAGE_RE.test(text)) {
      errorPageReported = true;
      dbg(`"Something went wrong" page detected — last step was "${lastStep.name}"${lastStep.detail ? ' (' + lastStep.detail + ')' : ''}`);
      document.dispatchEvent(new CustomEvent('__ffbot_event', { detail: {
        type: 'TIKTOK_ERROR_PAGE',
        lastStep: lastStep.name,
        lastStepDetail: lastStep.detail,
        pageSnippet: text.slice(0, 600),
      }}));
      return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Build H.264 MP4 (+ optional AAC audio) entirely inside TikTok's page context
  // ═══════════════════════════════════════════════════════════════════════════
  async function buildH264MP4(imgDataUrls, audioDataUrl, restaurantName, address) {
    const W = 720, H = 1280, FPS = 25, BITRATE = 2_000_000, SEC = 1.2;

    const images = [];
    for (const src of imgDataUrls) {
      await new Promise(res => {
        const img = new Image();
        img.onload = () => { images.push(img); res(); };
        img.onerror = res;
        img.src = src;
      });
    }
    if (!images.length) throw new Error('No images loaded');

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // ── Plain slide (photos 2-N) ─────────────────────────────────────────────
    function drawSlide(img) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      ctx.drawImage(img, (W - img.naturalWidth * s) / 2, (H - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
    }

    // ── Cover slide (first frame) — restaurant name + location overlay ───────
    // Mirrors popup.js createCoverOverlay logic, adapted for 720×1280 portrait.
    function drawCoverSlide(img) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      const ox = (W - img.naturalWidth * s) / 2, oy = (H - img.naturalHeight * s) / 2;
      ctx.drawImage(img, ox, oy, img.naturalWidth * s, img.naturalHeight * s);

      // Sample luminance of 3 vertical zones → choose darkest for text placement
      function sampleLum(y0, h0) {
        try {
          const d = ctx.getImageData(0, Math.round(y0), W, Math.max(1, Math.round(h0))).data;
          let sum = 0, n = 0;
          for (let i = 0; i < d.length; i += 16) { sum += 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]; n++; }
          return n > 0 ? sum / n : 128;
        } catch(_) { return 128; }
      }
      const zones = [
        { lum: sampleLum(0,      H*0.37), centerY: H*0.22 },
        { lum: sampleLum(H*0.30, H*0.40), centerY: H*0.50 },
        { lum: sampleLum(H*0.63, H*0.37), centerY: H*0.80 },
      ];
      const best = zones.reduce((a, b) => a.lum <= b.lum ? a : b);

      // Vignette centred on the chosen zone
      const vlin = ctx.createLinearGradient(0, best.centerY - H*0.22, 0, best.centerY + H*0.22);
      vlin.addColorStop(0,   'rgba(0,0,0,0.00)');
      vlin.addColorStop(0.5, 'rgba(0,0,0,0.52)');
      vlin.addColorStop(1,   'rgba(0,0,0,0.00)');
      ctx.fillStyle = vlin; ctx.fillRect(0, 0, W, H);
      const vedge = ctx.createRadialGradient(W/2, H/2, H*0.18, W/2, H/2, H*0.82);
      vedge.addColorStop(0, 'rgba(0,0,0,0.00)');
      vedge.addColorStop(1, 'rgba(0,0,0,0.28)');
      ctx.fillStyle = vedge; ctx.fillRect(0, 0, W, H);

      // TikTok canvas is always 720×1280 — use W as reference (portrait, width is the constraint)
      const nameSize   = Math.max(32, Math.round(W * 0.062));
      const tagSize    = Math.max(16, Math.round(W * 0.024));
      const cornerSize = Math.max(11, Math.round(W * 0.015));
      const gap        = Math.round(nameSize * 0.38);
      const maxTW      = W * 0.82;  // hard limit — prevents text bleeding past the frame edges

      const cityM = (address || '').match(/\d{4}\s+([A-Za-zÀ-ÿ\s-]+),\s*Belgium/i);
      const city  = (cityM?.[1] || (address || '').split(',')[0] || '').trim();
      const taglines = [`Discover ${city}'s hidden gem ✨`, `Best kept secret in ${city} 🍽`, `A must-visit in ${city} 📍`, `Taste the best of ${city} 🔥`];
      const tagline = city
        ? taglines[Math.abs([...(restaurantName||'')].reduce((a,c)=>a+c.charCodeAt(0),0)) % taglines.length]
        : 'Discover this hidden gem ✨';

      // Split long names into two balanced lines so no text overflows the frame
      ctx.font = `400 ${nameSize}px "Cormorant Garamond",Georgia,Palatino,serif`;
      const nameLines = (() => {
        const n = restaurantName || '';
        if (!n || ctx.measureText(n).width <= maxTW) return [n];
        const words = n.split(' ');
        let best2 = [n, ''], bestDiff = Infinity;
        for (let i = 1; i < words.length; i++) {
          const l1 = words.slice(0,i).join(' '), l2 = words.slice(i).join(' ');
          const diff = Math.abs(ctx.measureText(l1).width - ctx.measureText(l2).width);
          if (diff < bestDiff) { bestDiff = diff; best2 = [l1, l2]; }
        }
        return best2;
      })();

      const nameBlockH = nameLines.length > 1 ? nameSize * 2 + Math.round(gap * 0.5) : nameSize;
      const blockH     = tagSize + gap + nameBlockH;

      let ty = best.centerY - blockH / 2;
      ctx.fillStyle = '#FFF'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.68)'; ctx.shadowOffsetX = 0;

      ctx.font = `300 italic ${tagSize}px "Cormorant Garamond",Georgia,Palatino,serif`;
      ctx.shadowBlur = Math.round(tagSize * 0.5); ctx.shadowOffsetY = 1;
      ctx.fillText(tagline, W/2, ty, maxTW);
      ty += tagSize + gap;

      ctx.font = `400 ${nameSize}px "Cormorant Garamond",Georgia,Palatino,serif`;
      ctx.shadowBlur = Math.round(nameSize * 0.22); ctx.shadowOffsetY = 2;
      if (nameLines.length > 1) {
        ctx.fillText(nameLines[0], W/2, ty, maxTW);
        ty += nameSize + Math.round(gap * 0.5);
        ctx.fillText(nameLines[1], W/2, ty, maxTW);
      } else {
        ctx.fillText(nameLines[0], W/2, ty, maxTW);
      }

      if (city) {
        ctx.font = `300 ${cornerSize}px "Cormorant Garamond",Georgia,Palatino,serif`;
        ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.shadowBlur = 2; ctx.shadowOffsetY = 0;
        ctx.fillText(`${city}, Belgium`, W - Math.round(W*0.030), H - Math.round(H*0.022));
      }
    }

    // ── Encode video with WebCodecs ──────────────────────────────────────────
    if (!window.VideoEncoder) throw new Error('VideoEncoder not available');

    const codecs = ['avc1.4d0028','avc1.42001f','avc1.42001e','avc1.420014'];
    let codec = null;
    for (const c of codecs) {
      try {
        const s = await VideoEncoder.isConfigSupported({ codec: c, width: W, height: H, bitrate: BITRATE, framerate: FPS });
        if (s.supported) { codec = c; break; }
      } catch(_) {}
    }
    if (!codec) throw new Error('No H.264 codec supported');
    dbg(`Video codec: ${codec} | canvas: ${W}×${H} | ${FPS}fps | ${images.length} slides`);
    document.dispatchEvent(new CustomEvent('__ffbot_event', { detail: {
      type: 'TIKTOK_ENCODE_START', codec, width: W, height: H, slides: images.length, fps: FPS,
    }}));

    const vChunks = []; let vDcfg = null; let vErr = null;
    const tEncStart = Date.now();
    const vEnc = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig) vDcfg = meta.decoderConfig;
        const buf = new ArrayBuffer(chunk.byteLength); chunk.copyTo(buf);
        vChunks.push({ data: new Uint8Array(buf), isKey: chunk.type === 'key' });
      },
      error: e => { vErr = e; },
    });
    vEnc.configure({ codec, width: W, height: H, bitrate: BITRATE, framerate: FPS, avc: { format: 'avc' } });

    const framesPerSlide = Math.ceil(SEC * FPS);
    let fi = 0;
    for (let i = 0; i < images.length; i++) {
      if (i === 0 && restaurantName) drawCoverSlide(images[i]);
      else drawSlide(images[i]);
      for (let f = 0; f < framesPerSlide; f++) {
        if (vErr) throw new Error('VideoEncoder: ' + vErr.message);
        const ts = Math.round(fi * 1_000_000 / FPS);
        const frame = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1_000_000 / FPS) });
        vEnc.encode(frame, { keyFrame: fi === 0 || f === 0 });
        frame.close(); fi++;
      }
      banner(1, `Encoding video: slide ${i+1}/${images.length}${audioDataUrl ? ' + 🎵' : ''}…`);
    }
    await vEnc.flush(); vEnc.close();
    if (vErr) throw new Error('VideoEncoder: ' + vErr.message);
    const encMs = Date.now() - tEncStart;
    dbg(`Video encoded: ${vChunks.length} chunks in ${encMs}ms`);
    document.dispatchEvent(new CustomEvent('__ffbot_event', { detail: {
      type: 'TIKTOK_ENCODE_DONE', chunks: vChunks.length, duration_ms: encMs,
    }}));

    // ── Encode audio with WebCodecs (AAC-LC) ────────────────────────────────
    let aChunks = [];
    const AUDIO_SAMPLE_RATE = 44100;
    const AUDIO_CHANNELS    = 2;
    const videoSec = images.length * SEC;

    if (audioDataUrl && window.AudioEncoder && window.AudioData) {
      banner(1, `Encoding audio (${Math.round(videoSec)}s)…`);

      // Three-layer protection:
      //  1. No AudioContext.resume() — it hangs forever without a user gesture
      //     (TikTok tab is active so AudioContext won't be suspended anyway).
      //  2. Per-operation timeouts on isConfigSupported() and flush().
      //  3. 20s master timeout: bot always falls back to video-only rather than blocking.
      const audioResult = await Promise.race([

        (async () => {
          try {
            // ── Decode MP3 → AudioBuffer ─────────────────────────────────────
            // decodeAudioData works in any AudioContext state — no resume() needed.
            const b64    = audioDataUrl.split(',')[1];
            const bytes  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const tmpCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: AUDIO_SAMPLE_RATE });
            const audioBuf = await tmpCtx.decodeAudioData(bytes.buffer.slice(0));
            tmpCtx.close().catch(() => {});   // fire-and-forget — no await

            const totalAudioFrames = Math.min(Math.ceil(videoSec * AUDIO_SAMPLE_RATE), audioBuf.length);
            const numCh = Math.min(audioBuf.numberOfChannels, AUDIO_CHANNELS);

            // ── Check codec support (5 s guard) ─────────────────────────────
            const aSupport = await Promise.race([
              AudioEncoder.isConfigSupported({ codec:'mp4a.40.2', sampleRate:AUDIO_SAMPLE_RATE, numberOfChannels:numCh, bitrate:128000 }),
              new Promise(res => setTimeout(() => res({ supported: false }), 5000)),
            ]);
            if (!aSupport.supported) { dbg('AAC not supported — video-only'); return []; }

            // ── Encode PCM → AAC-LC ──────────────────────────────────────────
            const chunks = [];
            let aErr = null;
            const aEnc = new AudioEncoder({
              output: (chunk) => {
                const buf = new ArrayBuffer(chunk.byteLength); chunk.copyTo(buf);
                chunks.push({ data: new Uint8Array(buf), timestamp: chunk.timestamp });
              },
              error: e => { aErr = e; },
            });
            aEnc.configure({ codec:'mp4a.40.2', sampleRate:AUDIO_SAMPLE_RATE, numberOfChannels:numCh, bitrate:128000 });

            const FRAME_SIZE = 1024;
            const ch = [];
            for (let c = 0; c < numCh; c++) ch.push(audioBuf.getChannelData(c));
            let processed = 0;
            while (processed < totalAudioFrames) {
              if (aErr) throw new Error('AudioEncoder: ' + aErr.message);
              const frames = Math.min(FRAME_SIZE, totalAudioFrames - processed);
              const planar = new Float32Array(frames * numCh);
              for (let c = 0; c < numCh; c++)
                planar.set(ch[c].slice(processed, processed + frames), c * frames);
              const ad = new AudioData({ format:'f32-planar', sampleRate:AUDIO_SAMPLE_RATE, numberOfFrames:frames, numberOfChannels:numCh, timestamp:Math.round(processed*1_000_000/AUDIO_SAMPLE_RATE), data:planar });
              aEnc.encode(ad); ad.close();
              processed += frames;
            }

            // ── Flush (10 s guard) ───────────────────────────────────────────
            await Promise.race([
              aEnc.flush().then(() => aEnc.close()),
              new Promise((_, rej) => setTimeout(() => rej(new Error('flush timeout')), 10000)),
            ]);
            if (aErr) throw new Error('AudioEncoder: ' + aErr.message);
            dbg(`Audio: ${chunks.length} AAC chunks (${numCh}ch)`);
            return chunks;

          } catch(e) {
            dbg(`Audio encoding failed: ${e.message} — video-only`);
            return [];
          }
        })(),

        // ── Master timeout (20 s) ──────────────────────────────────────────
        new Promise(res => setTimeout(() => {
          dbg('Audio encoding timed out (20 s) — video-only');
          res([]);
        }, 20000)),
      ]);

      aChunks = audioResult;
    }

    const blob = muxMP4(vChunks, vDcfg, aChunks, W, H, FPS, fi, AUDIO_SAMPLE_RATE);
    dbg(`MP4 ready: ${(blob.size/1024/1024).toFixed(1)}MB`);
    return blob;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MP4 muxer — video track + optional AAC audio track
  // ═══════════════════════════════════════════════════════════════════════════
  function muxMP4(vChunks, vDcfg, aChunks, W, H, fps, totalVideoFrames, aSampleRate) {
    const u8  = v => [v & 0xFF];
    const u16 = v => [(v >> 8) & 0xFF, v & 0xFF];
    const u32 = v => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
    const s4  = s => [...new TextEncoder().encode(s).slice(0, 4)];
    const z   = n => Array(n).fill(0);
    function box(t, ...c) { const d = c.flat(Infinity); return [...u32(8+d.length), ...s4(t.padEnd(4,' ')), ...d]; }
    function fb(t, v, f, ...c) { return box(t, u8(v), [(f>>16)&0xFF,(f>>8)&0xFF,f&0xFF], ...c); }

    // ── Video track ────────────────────────────────────────────────────────
    const VTS = 90000, VSD = Math.round(VTS / fps), VDUR = totalVideoFrames * VSD;
    let sps = new Uint8Array([0x67,0x4d,0x00,0x28]); let pps = new Uint8Array([0x68,0xee,0x31,0xb2]);
    if (vDcfg?.description) {
      const d = new Uint8Array(vDcfg.description); let i = 5;
      const ns = d[i++] & 0x1F;
      for (let j=0;j<ns;j++) { const l=(d[i]<<8)|d[i+1];i+=2; sps=d.slice(i,i+l);i+=l; }
      const np = d[i++];
      for (let j=0;j<np;j++) { const l=(d[i]<<8)|d[i+1];i+=2; pps=d.slice(i,i+l);i+=l; }
    }
    const avcC = box('avcC', u8(1),[sps[1]||0x4d,sps[2]||0,sps[3]||0x28],[0xFF],[0xE1],u16(sps.length),[...sps],u8(1),u16(pps.length),[...pps]);
    const avc1 = box('avc1', z(6),u16(1),z(16),u16(W),u16(H),[0,72,0,0,0,72,0,0],u32(0),u16(1),z(32),u16(0x18),u16(0xFFFF),avcC);
    const mat  = [0x00,0x01,0x00,0x00,0,0,0,0,0,0,0,0,0,0,0,0,0x00,0x01,0x00,0x00,0,0,0,0,0,0,0,0,0,0,0,0,0x40,0x00,0x00,0x00];

    const vstsd = fb('stsd',0,0,u32(1),avc1);
    const vstts = fb('stts',0,0,u32(1),u32(vChunks.length),u32(VSD));
    const vkeys = vChunks.map((c,i)=>c.isKey?i+1:null).filter(Boolean);
    const vstss = fb('stss',0,0,u32(vkeys.length),...vkeys.flatMap(i=>u32(i)));
    const vstsz = fb('stsz',0,0,u32(0),u32(vChunks.length),...vChunks.flatMap(c=>u32(c.data.length)));
    const vstsc = fb('stsc',0,0,u32(1),u32(1),u32(1),u32(1));
    const vstco_ph = fb('stco',0,0,u32(vChunks.length),...vChunks.flatMap(()=>u32(0)));
    const vstbl_ph = box('stbl',vstsd,vstts,vstss,vstsc,vstsz,vstco_ph);
    const vmhd   = fb('vmhd',0,1,u16(0),z(6));
    const dinf   = box('dinf',fb('dref',0,0,u32(1),fb('url ',0,1)));
    const vminf_ph = box('minf',vmhd,dinf,vstbl_ph);
    const vmdhd  = fb('mdhd',0,0,u32(0),u32(0),u32(VTS),u32(VDUR),u16(0x55C4),u16(0));
    const vhdlr  = fb('hdlr',0,0,u32(0),s4('vide'),z(12),[...s4('Vide'),0]);
    const vmdia_ph = box('mdia',vmdhd,vhdlr,vminf_ph);
    const vtkhd  = fb('tkhd',0,3,u32(0),u32(0),u32(1),u32(0),u32(VDUR),z(8),u16(0),u16(0),u16(0),u16(0),mat,u32(W<<16),u32(H<<16));
    const vtrak_ph = box('trak',vtkhd,vmdia_ph);

    // ── Audio track (AAC-LC) ────────────────────────────────────────────────
    const hasAudio = aChunks.length > 0;
    let atrak_ph = [];
    if (hasAudio) {
      const ATS  = aSampleRate;
      const AFPF = 1024; // AAC frames per chunk
      const ADUR = aChunks.length * AFPF;

      // AAC-LC AudioSpecificConfig for 44100Hz stereo
      // audioObjectType=2 (5 bits), freqIndex=4 (4 bits), channels=2 (4 bits)
      // = 00010 0100 0010 → 0001 0010 0001 0000 = 0x12, 0x10
      const asc = [0x12, 0x10];
      const esdsData = [
        0x03, 0x19, 0x00, 0x01, 0x00,                // ES_Descriptor (tag, size, ES_ID, flags)
        0x04, 0x11, 0x40, 0x15,                       // DecoderConfig (tag, size, objectType, streamType)
        0x00, 0x00, 0x00,                             // bufferSizeDB
        0x00, 0x01, 0xF4, 0x00,                       // maxBitrate = 128000
        0x00, 0x01, 0xF4, 0x00,                       // avgBitrate = 128000
        0x05, 0x02, ...asc,                           // DecoderSpecificInfo
        0x06, 0x01, 0x02,                             // SLConfig predefined
      ];
      const esds = fb('esds', 0, 0, esdsData);
      const mp4a = box('mp4a', z(6),u16(1), z(8), u16(2),u16(16),u16(0),u16(0),
        u32(ATS * 65536), // samplerate as 16.16 fixed point
        esds);

      const astsd = fb('stsd',0,0,u32(1),mp4a);
      const astts = fb('stts',0,0,u32(1),u32(aChunks.length),u32(AFPF));
      const astsz = fb('stsz',0,0,u32(0),u32(aChunks.length),...aChunks.flatMap(c=>u32(c.data.length)));
      const astsc = fb('stsc',0,0,u32(1),u32(1),u32(1),u32(1));
      const astco_ph = fb('stco',0,0,u32(aChunks.length),...aChunks.flatMap(()=>u32(0)));
      const astbl_ph = box('stbl',astsd,astts,astsc,astsz,astco_ph);
      const smhd   = fb('smhd',0,0,u16(0),u16(0));
      const aminf_ph = box('minf',smhd,dinf,astbl_ph);
      const amdhd  = fb('mdhd',0,0,u32(0),u32(0),u32(ATS),u32(ADUR),u16(0x55C4),u16(0));
      const ahdlr  = fb('hdlr',0,0,u32(0),s4('soun'),z(12),[...s4('Soun'),0]);
      const amdia_ph = box('mdia',amdhd,ahdlr,aminf_ph);
      const atkhd  = fb('tkhd',0,3,u32(0),u32(0),u32(2),u32(0),u32(ADUR),z(8),u16(0),u16(0),u16(0x0100),u16(0),mat,u32(0),u32(0));
      atrak_ph = box('trak',atkhd,amdia_ph);
    }

    const mvhd = fb('mvhd',0,0,u32(0),u32(0),u32(VTS),u32(VDUR),u32(0x10000),u16(0x100),z(10),mat,z(24),u32(hasAudio?3:2));
    const moov_ph = box('moov', mvhd, vtrak_ph, ...(hasAudio ? [atrak_ph] : []));
    const ftyp    = box('ftyp',s4('isom'),u32(0x200),s4('isom'),s4('iso2'),s4('avc1'),s4('mp41'));

    // Compute real chunk offsets (video then audio in mdat)
    const mdatStart = ftyp.length + moov_ph.length + 8;
    let off = mdatStart;
    const vRealOff = vChunks.map(c => { const o=off; off+=c.data.length; return o; });
    const aRealOff = aChunks.map(c => { const o=off; off+=c.data.length; return o; });

    // Rebuild with real offsets
    const vstco_r  = fb('stco',0,0,u32(vChunks.length),...vRealOff.flatMap(o=>u32(o)));
    const vstbl_r  = box('stbl',vstsd,vstts,vstss,vstsc,vstsz,vstco_r);
    const vminf_r  = box('minf',vmhd,dinf,vstbl_r);
    const vmdia_r  = box('mdia',vmdhd,vhdlr,vminf_r);
    const vtrak_r  = box('trak',vtkhd,vmdia_r);

    let atrak_r = [];
    if (hasAudio) {
      const ATS  = aSampleRate, AFPF = 1024, ADUR = aChunks.length * AFPF;
      const asc  = [0x12, 0x10];
      const esdsData = [0x03,0x19,0x00,0x01,0x00,0x04,0x11,0x40,0x15,0x00,0x00,0x00,0x00,0x01,0xF4,0x00,0x00,0x01,0xF4,0x00,0x05,0x02,...asc,0x06,0x01,0x02];
      const esds  = fb('esds',0,0,esdsData);
      const mp4a  = box('mp4a',z(6),u16(1),z(8),u16(2),u16(16),u16(0),u16(0),u32(ATS*65536),esds);
      const astsd = fb('stsd',0,0,u32(1),mp4a);
      const astts = fb('stts',0,0,u32(1),u32(aChunks.length),u32(AFPF));
      const astsz = fb('stsz',0,0,u32(0),u32(aChunks.length),...aChunks.flatMap(c=>u32(c.data.length)));
      const astsc = fb('stsc',0,0,u32(1),u32(1),u32(1),u32(1));
      const astco_r = fb('stco',0,0,u32(aChunks.length),...aRealOff.flatMap(o=>u32(o)));
      const astbl_r = box('stbl',astsd,astts,astsc,astsz,astco_r);
      const smhd   = fb('smhd',0,0,u16(0),u16(0));
      const aminf_r = box('minf',smhd,dinf,astbl_r);
      const amdhd  = fb('mdhd',0,0,u32(0),u32(0),u32(ATS),u32(ADUR),u16(0x55C4),u16(0));
      const ahdlr  = fb('hdlr',0,0,u32(0),s4('soun'),z(12),[...s4('Soun'),0]);
      const amdia_r = box('mdia',amdhd,ahdlr,aminf_r);
      const atkhd  = fb('tkhd',0,3,u32(0),u32(0),u32(2),u32(0),u32(ADUR),z(8),u16(0),u16(0),u16(0x0100),u16(0),mat,u32(0),u32(0));
      atrak_r = box('trak',atkhd,amdia_r);
    }

    const moov_r = box('moov', mvhd, vtrak_r, ...(hasAudio ? [atrak_r] : []));
    const mdatBodySize = [...vChunks, ...aChunks].reduce((a,c)=>a+c.data.length, 0);
    const mdatHdr = new Uint8Array([...u32(mdatBodySize+8), ...s4('mdat')]);

    const total = ftyp.length + moov_r.length + mdatHdr.length + mdatBodySize;
    const out   = new Uint8Array(total);
    let p = 0;
    for (const part of [new Uint8Array(ftyp), new Uint8Array(moov_r), mdatHdr,
                        ...vChunks.map(c=>c.data), ...aChunks.map(c=>c.data)]) {
      out.set(part, p); p += part.length;
    }
    return new Blob([out], { type: 'video/mp4' });
  }

  // ── Inject file ───────────────────────────────────────────────────────────
  function injectFile(input, file) {
    const dt = new DataTransfer(); dt.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
    if (setter) setter.call(input, dt.files); else input.files = dt.files;
    ['change','input'].forEach(ev => input.dispatchEvent(new Event(ev, { bubbles: true })));
  }

  // ── Upload detection — captures full error text for logging ──────────────
  // NOTE: "maximum.*size" is intentionally excluded — TikTok shows
  // "Maximum size: 30 GB, video…" as INSTRUCTIONAL text on the upload page
  // before any file is processed. Matching it causes a false positive.
  const ERR_RE = /over.*\d+.?min|minute.*limit|size.*too.*large|too.*large.*file|size.*exceed|exceed.*size|not.*support.*format|unsupport|invalid.*file.*format|upload.*fail|failed.*upload/i;

  async function checkUpload(ms = 25000) {
    // Wait for TikTok to clear the upload-zone instructional text and start
    // processing the injected file before we begin scanning for errors.
    await sleep(4000);

    const start = Date.now();
    while (Date.now() - start < ms) {
      await sleep(700);
      const text = document.body.innerText || '';
      if (ERROR_PAGE_RE.test(text)) { checkForErrorPage(); return 'rejected'; }
      const errMatch = text.match(ERR_RE);
      if (errMatch) {
        // Extract a wider context around the error for logging
        const errIdx  = text.toLowerCase().indexOf(errMatch[0].toLowerCase());
        const context = text.slice(Math.max(0, errIdx - 40), errIdx + 120).trim();
        dbg(`TikTok error detected: "${errMatch[0]}" | context: "${context}"`);
        document.dispatchEvent(new CustomEvent('__ffbot_event', { detail:{
          type:'TIKTOK_UPLOAD_ERROR', matched:errMatch[0], context, pageSnippet:text.slice(0,600),
        }}));
        return 'rejected';
      }
      if (document.querySelector('[class*="DraftEditor"],[data-placeholder*="description" i],[data-placeholder*="caption" i]')) return 'accepted';
    }
    // Final check on timeout
    const finalText = document.body.innerText || '';
    const finalErr  = finalText.match(ERR_RE);
    if (finalErr) {
      document.dispatchEvent(new CustomEvent('__ffbot_event', { detail:{ type:'TIKTOK_UPLOAD_ERROR', matched:finalErr[0], context:'timeout-check', pageSnippet:finalText.slice(0,600) }}));
      return 'rejected';
    }
    return 'timeout';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN FLOW
  // ═══════════════════════════════════════════════════════════════════════════
  (async () => {
    step('injector_started', `url=${window.location.href}`);
    await sleep(2000);
    if (checkForErrorPage()) return;

    // ── Step 1: Build the MP4 ────────────────────────────────────────────
    step('build_video_start', `${photoDataUrls.length} photos, audio=${!!tiktokAudioDataUrl}`);
    const hasAudio = !!tiktokAudioDataUrl;
    banner(1, `Building ${photoDataUrls.length}-photo slideshow${hasAudio ? ' 🎵 with song' : ''}…`);

    let videoFile = null;
    try {
      const blob = await buildH264MP4(photoDataUrls, tiktokAudioDataUrl, opts.restaurantName || '', location || '');
      const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
      videoFile = new File([blob], 'tiktok-post.mp4', { type: 'video/mp4' });
      banner(1, `Video ready: ${sizeMB}MB H.264${hasAudio ? ' + AAC 🎵' : ''} — uploading…`);
      dbg(`Video: ${sizeMB}MB`);
      step('build_video_done', `${sizeMB}MB`);
    } catch(e) {
      dbg(`Build failed: ${e.message}`);
      banner(1, `⚠️ Build failed: ${e.message}`, 'warn');
      step('build_video_failed', e.message);
      return;
    }

    // ── Step 2: Inject into TikTok file input ────────────────────────────
    banner(2, 'Finding upload area…');
    step('find_file_input');
    const fileInput = await waitFor('input[type="file"]', 12000);
    if (!fileInput) {
      banner(2, '⚠️ Upload area not found. Refresh and retry.', 'warn');
      step('find_file_input_failed', 'no input[type=file] within 12s');
      checkForErrorPage();
      return;
    }

    const sizeMB = (videoFile.size / 1024 / 1024).toFixed(2);
    dbg(`Injecting ${sizeMB}MB MP4 (type=${videoFile.type})…`);
    step('inject_file', `${sizeMB}MB ${videoFile.type}`);
    // Log video specs before injection so we have this in TechLog for debugging
    document.dispatchEvent(new CustomEvent('__ffbot_event', { detail:{ type:'TIKTOK_VIDEO_SPECS', sizeMB, mimeType:videoFile.type, hasAudio }}));
    injectFile(fileInput, videoFile);

    // ── Step 3: Wait for TikTok to process ──────────────────────────────
    banner(3, 'Processing video…');
    step('wait_video_processing');
    const result = await checkUpload(30000);
    if (result === 'rejected') {
      // Capture visible error text for the banner
      const visibleErr = (document.body.innerText || '').match(ERR_RE)?.[0] || 'unknown error';
      banner(3, `⚠️ TikTok rejected: "<em>${visibleErr}</em>". Check the page for details.`, 'warn');
      step('upload_rejected', visibleErr);
      document.dispatchEvent(new CustomEvent('__ffbot_event', { detail:{ type:'TIKTOK_UPLOAD_ERROR', matched:visibleErr, context:'post-check', autoPost:opts?.autoPost }}));
      document.dispatchEvent(new CustomEvent('__ffbot_failed', { detail:{ platform:'tiktok', error:'Upload rejected: '+visibleErr }}));
      return;
    }
    if (result === 'timeout') {
      step('upload_timeout', 'no acceptance/rejection signal within 30s');
      checkForErrorPage();
    } else {
      dbg('Upload accepted');
      step('upload_accepted');
    }
    // NOTE: We intentionally do NOT minimise the window here anymore.
    // TikTok Studio's redesigned caption/location editors appear to require the
    // tab to be visible & focused for `.focus()` / `execCommand('insertText')`
    // to actually register (minimised/hidden windows report `document.hidden`
    // and TikTok's React-based editor silently ignores input in that state).
    // That is the most likely reason description/location were silently failing
    // to fill — the window was minimised right before those steps ran.
    // We now only minimise once description + location are filled & VALIDATED,
    // immediately before clicking Post.
    await sleep(2000);

    // ── Step 4: Fill Description ─────────────────────────────────────────
    banner(4, 'Filling description…');
    step('find_description_box');
    // TikTok Studio's redesign moved away from the old Draft.js editor markup,
    // so we cast a wide net: data-e2e hooks, aria/placeholder hints, role=textbox,
    // and finally fall back to scanning every contenteditable on the page for
    // the one that looks like the caption editor (large, near top of form).
    const descSels = [
      '[data-e2e*="caption" i] [contenteditable="true"]',
      '[data-e2e*="description" i] [contenteditable="true"]',
      '[data-e2e="caption-edit"]',
      '[data-e2e*="caption" i]',
      '.public-DraftEditor-content',
      '[contenteditable="true"][class*="editor" i]',
      '[contenteditable="true"][aria-label*="description" i]',
      '[contenteditable="true"][aria-label*="caption" i]',
      '[aria-label*="description" i][contenteditable="true"]',
      '[data-placeholder*="description" i]',
      '[data-placeholder*="caption" i]',
      '[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"]',
    ];
    let descBox = null;
    for (let att = 0; att < 10 && !descBox; att++) {
      for (const s of descSels) {
        const el = document.querySelector(s);
        if (el) { descBox = el; break; }
      }
      if (!descBox) {
        // Last-resort: scan all contenteditable elements and pick the largest visible one
        const candidates = [...document.querySelectorAll('[contenteditable="true"]')]
          .map(el => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 100 && r.height > 20)
          .sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
        if (candidates.length) descBox = candidates[0].el;
      }
      if (!descBox) await sleep(500);
    }
    // ── Text-injection strategies for React/Lexical-style contenteditable
    // editors ────────────────────────────────────────────────────────────────
    // TikTok Studio's caption editor is a modern controlled rich-text editor
    // (Lexical/Slate-style). Bulk `execCommand('insertText', false, longString)`
    // mutates the DOM directly in one shot — the editor's internal model can
    // desync from that DOM mutation, and a render/reconciliation exception a
    // few hundred ms later gets caught by React's error boundary, replacing the
    // whole upload form with "Something went wrong. Please try again." This is
    // the most likely explanation for why the location/post controls vanish
    // right after the caption appears to fill successfully. To avoid that we
    // try gentler, more "native" input simulations first and only fall back to
    // the risky bulk execCommand as a last resort.

    // Strategy A: simulate a real clipboard paste — paste handlers are a
    // standard, well-supported path for external content in rich editors and
    // correctly route through the editor's normal state-update pipeline.
    function pasteText(el, text) {
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        return el.dispatchEvent(evt);
      } catch (e) { dbg(`pasteText failed: ${e.message}`); return false; }
    }
    // Strategy B: dispatch native beforeinput/input InputEvents carrying the
    // text as `data` with inputType 'insertText' — this is what the browser
    // itself fires for real typed/pasted input, so controlled editors that
    // listen for these (rather than relying on execCommand's legacy DOM
    // mutation path) pick it up through their normal flow.
    function dispatchInsertText(el, text) {
      try {
        const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text });
        el.dispatchEvent(before);
        const input = new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text });
        el.dispatchEvent(input);
        return true;
      } catch (e) { dbg(`dispatchInsertText failed: ${e.message}`); return false; }
    }

    // Whitespace-/line-break-tolerant text comparison. Different injection
    // methods (paste vs. native execCommand) get reformatted differently by
    // the editor — e.g. a "📍 Hotel\n📌 Street" caption can come back as
    // "📍 Hotel \n 📌 Street" (extra spaces around the line break) after a
    // paste-event insert, even though the content is effectively identical.
    // A naive `actual.includes(rawSnippet)` then reports a false failure,
    // which made us discard a perfectly good fill and re-type the same text —
    // exactly the visible "fills, empties, refills" behaviour reported.
    // Collapsing all whitespace runs to a single space before comparing (and
    // building the snippet via `Array.from` so we never slice a surrogate
    // pair / emoji ZWJ sequence in half) makes the match format-agnostic.
    const normWS = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const snippetOf = s => Array.from(s || '').slice(0, 20).join('');
    function textMatches(actual, want) {
      if (!actual || !want) return false;
      return normWS(actual).includes(normWS(want));
    }

    let descriptionFilled = false;
    if (descBox && caption) {
      // Try up to 3 times, escalating through gentler → more invasive fill
      // strategies, re-checking the actual rendered text after each attempt.
      const wantSnippet = snippetOf(caption);
      const strategies = [
        { name: 'paste',   run: () => pasteText(descBox, caption) },
        { name: 'inputevt',run: () => dispatchInsertText(descBox, caption) },
        { name: 'execcmd', run: () => { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, caption); return true; } },
      ];
      const readBox = () => (descBox.innerText || descBox.textContent || '').trim();
      // Poll for the snippet to show up rather than checking once — these
      // editors render asynchronously, and a single too-early read was making
      // us think a perfectly good fill had failed, which then made us clear
      // the (correctly-filled) box and re-type the SAME caption with the next
      // strategy — the visible "fills then empties then refills" the user saw.
      async function pollForSnippet(timeoutMs) {
        const until = Date.now() + timeoutMs;
        let last = '';
        while (Date.now() < until) {
          last = readBox();
          if (textMatches(last, wantSnippet)) return last;
          await sleep(250);
        }
        return textMatches(last, wantSnippet) ? last : null;
      }
      for (let fillAtt = 0; fillAtt < strategies.length && !descriptionFilled; fillAtt++) {
        // Re-check first: a prior strategy may already have landed correctly
        // and we just need to confirm it — never blindly clear good content.
        const already = readBox();
        if (textMatches(already, wantSnippet)) {
          descriptionFilled = true;
          dbg('Description already present & verified — skipping further fill attempts');
          step('fill_description_done', `${already.length} chars (already present, pre-attempt ${fillAtt + 1})`);
          break;
        }
        const strat = strategies[fillAtt];
        descBox.focus(); await sleep(300);
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await sleep(150);
        strat.run();
        const actual = await pollForSnippet(1800);
        if (actual) {
          descriptionFilled = true;
          dbg(`Description filled & verified via "${strat.name}"`);
          step('fill_description_done', `${actual.length} chars via ${strat.name}`);
        } else {
          dbg(`Description fill via "${strat.name}" verify failed: got "${readBox().slice(0, 40)}"`);
          step('fill_description_verify_failed', `${strat.name}: got "${readBox().slice(0, 40)}"`);
          await sleep(300);
        }
      }
      if (!descriptionFilled) {
        dbg('⚠️ Description could not be verified after all strategies — aborting before Post');
        step('fill_description_failed_final', 'gave up after all fill strategies');
        checkForErrorPage();
      } else {
        // The page has been observed to crash to "Something went wrong" a few
        // hundred ms AFTER a description fill verifies successfully — poll
        // briefly right here so the technical log conclusively shows whether
        // the crash is caused by the fill itself (vs. something later, e.g.
        // the location step). This directly informs which strategy is safe.
        let crashedAfterFill = false;
        for (let c = 0; c < 6; c++) {
          await sleep(250);
          if (checkForErrorPage()) {
            crashedAfterFill = true;
            step('page_crashed_after_description_fill', `~${(c + 1) * 250}ms after fill (strategy used)`);
            break;
          }
        }
        if (!crashedAfterFill) step('page_stable_after_description_fill', '~1500ms post-fill check passed');
      }
    } else {
      dbg('Description box not found');
      step('find_description_box_failed', caption ? 'no editor element matched' : 'no caption provided');
      checkForErrorPage();
    }

    // ── Step 5: Add Location ─────────────────────────────────────────────
    if (location) {
      await sleep(600);
      banner(4, 'Adding location…');
      step('find_location_trigger');

      const cityMatch = location.match(/\d{4}\s+([A-Za-zÀ-ÿ\s-]+),\s*Belgium/i);
      const city      = (cityMatch?.[1] || location.split(',')[0] || '').trim();
      // Search by restaurant name first (finds the actual TikTok venue tag).
      // Fall back to city name if restaurant name produces no results.
      const { restaurantName: rName = '' } = opts || {};
      const searchTerm = rName || city || location.split(',')[0].trim();
      dbg(`Location search: "${searchTerm}" (${rName ? 'venue' : 'city'})`);

      // Find the "Location" button/field — TikTok Studio renamed/restyled this
      // control, so try data-e2e hooks first, then aria/placeholder, then a
      // broad text-based scan over interactive elements.
      let locTrigger =
        document.querySelector('[data-e2e*="location" i]') ||
        document.querySelector('[aria-label*="location" i],[placeholder*="location" i]');
      if (!locTrigger) {
        locTrigger = [...document.querySelectorAll('[role="button"],button,div[tabindex],span,div')]
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 10; })
          .find(el => /add\s*(a\s+)?location|^location$|where\s+was\s+this/i.test(
            (el.innerText || el.getAttribute('aria-label') || '').trim()));
      }
      let locationVerified = false;
      if (locTrigger) {
        const triggerTextBefore = (locTrigger.innerText || locTrigger.getAttribute('aria-label') || '').trim();
        step('open_location_search', triggerTextBefore.slice(0, 60));
        locTrigger.click(); await sleep(700);
        const locInput = await waitFor(
          'input[placeholder*="Search" i],input[placeholder*="Location" i],[data-e2e*="location" i] input,input[aria-label*="location" i]',
          4000);
        if (!locInput) { step('location_search_input_not_found'); checkForErrorPage(); }
        if (locInput) {
          // Helper: type a term, wait for results, click the first, and verify
          // it actually got applied (a chip/tag with that name appears, or the
          // trigger's label changes away from the "Add location" placeholder).
          // A location chip is "attached" once the trigger's label changes away
          // from its original placeholder text — that alone is solid proof,
          // independent of whatever text the result item happened to show.
          const triggerChanged = () => {
            const now = (locTrigger.innerText || locTrigger.getAttribute('aria-label') || '').trim();
            return now && now !== triggerTextBefore ? now : null;
          };
          async function typeSelectAndVerify(term) {
            // Already attached? Don't clear/retype — that's exactly what was
            // producing the visible "fills, empties, refills with the same
            // value" behaviour for location too.
            const already = triggerChanged();
            if (already) return { picked: already, verified: true, skipped: true };

            locInput.focus(); await sleep(200);
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, '');
            await sleep(100);
            for (const ch of term) { document.execCommand('insertText', false, ch); await sleep(55); }
            await sleep(2000);
            const first = document.querySelector(
              '[role="option"]:first-child,[class*="location-item"]:first-child,[class*="LocationItem"]:first-child,[data-e2e*="location"] [role="option"]:first-child,li[role="option"]:first-child'
            );
            if (!first) return { picked: null, verified: false };
            const pickedName = first.innerText?.trim() || term;
            first.click();
            dbg(`Location candidate clicked: ${pickedName}`);

            // Verify: poll up to ~5s. The strongest signal is simply that the
            // trigger's label changed away from its pre-search placeholder —
            // TikTok may render the chip with different text/formatting than
            // the search-result item showed, so don't over-rely on snippet match.
            const nameSnippet = pickedName.split(',')[0].trim().slice(0, 12).toLowerCase();
            let verified = false, picked2 = pickedName;
            for (let v = 0; v < 10 && !verified; v++) {
              await sleep(500);
              const changed = triggerChanged();
              if (changed) { verified = true; picked2 = changed; break; }
              const bodyText = (document.body.innerText || '').toLowerCase();
              if (nameSnippet && bodyText.includes(nameSnippet)) { verified = true; picked2 = pickedName; break; }
            }
            return { picked: picked2, verified };
          }

          // Try restaurant name first, fall back to city — but only if the
          // first attempt genuinely produced nothing (re-check trigger state
          // immediately before falling back, in case verification merely
          // lagged behind a successful attach).
          step('search_location', searchTerm);
          let { picked, verified } = await typeSelectAndVerify(searchTerm);
          if (!verified) {
            const lateCheck = triggerChanged();
            if (lateCheck) { verified = true; picked = lateCheck; }
          }
          if (!verified && rName && city && city.toLowerCase() !== searchTerm.toLowerCase()) {
            dbg(`"${picked || searchTerm}" not verified — retrying with city "${city}"`);
            step('search_location_fallback_city', city);
            ({ picked, verified } = await typeSelectAndVerify(city));
          }
          locationVerified = verified;
          if (verified) {
            dbg(`Location verified on page: ${picked}`);
            step('select_location_done', `verified: ${picked}`);
          } else if (picked) {
            dbg(`⚠️ Location "${picked}" clicked but could not be verified on page`);
            step('select_location_verify_failed', `clicked "${picked}" but not visible afterwards`);
            checkForErrorPage();
          } else {
            dbg('No location results found');
            step('select_location_failed', `no results for "${searchTerm}"${rName && city ? ` or "${city}"` : ''}`);
            checkForErrorPage();
          }
        }
      } else {
        dbg('Location button not found');
        step('find_location_trigger_failed');
        checkForErrorPage();
      }
      if (!locationVerified) {
        dbg('⚠️ Location could not be confirmed — continuing, but the post may be missing its location tag');
        step('location_unverified_continuing');
      }
    }

    // ── Final pre-post validation: re-check description is still present ────
    // (TikTok occasionally clears the editor when a location is attached).
    // If it's gone, try to refill it once more before we commit to posting.
    if (caption && descBox) {
      const wantSnippet = snippetOf(caption);
      // Poll rather than single-read — give the editor time to settle after
      // the location step before concluding the caption is actually gone.
      // A premature "it's gone" read here was triggering needless clear+refill
      // cycles on perfectly intact captions (visible as the box emptying and
      // then being retyped with the same text).
      let stillThere = '';
      for (let p = 0; p < 5; p++) {
        stillThere = (descBox.innerText || descBox.textContent || '').trim();
        if (textMatches(stillThere, wantSnippet)) break;
        await sleep(300);
      }
      if (!textMatches(stillThere, wantSnippet)) {
        dbg('Description missing after location step — refilling…');
        step('refill_description_after_location');
        let refilled = false;
        for (const strat of [
          { name: 'paste',    run: () => pasteText(descBox, caption) },
          { name: 'inputevt', run: () => dispatchInsertText(descBox, caption) },
          { name: 'execcmd',  run: () => { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, caption); return true; } },
        ]) {
          if (refilled) break;
          descBox.focus(); await sleep(300);
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          await sleep(150);
          strat.run();
          await sleep(500);
          const recheck = (descBox.innerText || descBox.textContent || '').trim();
          if (textMatches(recheck, wantSnippet)) {
            refilled = true;
            step('refill_description_done', `${recheck.length} chars via ${strat.name}`);
          } else {
            step('refill_description_attempt_failed', `${strat.name}: got "${recheck.slice(0, 40)}"`);
          }
        }
        if (!refilled) { step('refill_description_failed', 'all strategies exhausted'); checkForErrorPage(); }
      }
    }

    // Now that description + location are filled & validated, it's safe to
    // minimise the window — only the Post click remains, which doesn't need
    // the editor to be focused/visible.
    dbg('Description & location steps complete — minimising window');
    step('ready_to_minimize');
    document.dispatchEvent(new CustomEvent('__ffbot_event', { detail: { type: 'TIKTOK_READY_TO_MINIMIZE' } }));
    await sleep(800);

    // ── Done: auto-click Post (auto mode) or wait for user (manual mode) ────
    const { autoPost: ttAutoPost = false } = opts || {};
    const note = hasAudio ? ` 🎵 Song baked in.` : '';

    if (ttAutoPost) {
      banner(5, '🤖 Locating Post button…');
      step('find_post_button');
      await sleep(2000); // TikTok may still be enabling the button

      // Full React-compatible click — same sequence that works for the Next button
      function reactClickEl(el) {
        el.focus();
        ['mouseenter','mouseover','mousedown','mouseup','click'].forEach(type =>
          el.dispatchEvent(new MouseEvent(type, {
            bubbles:true, cancelable:true, view:window, buttons:1, detail:type==='click'?1:0
          }))
        );
        el.click(); // native click as backup
      }

      // Try multiple selectors with retries (TikTok may need time to enable the button)
      let postBtn = null;
      for (let attempt = 0; attempt < 12 && !postBtn; attempt++) {
        // Priority: data-e2e attribute → button text → submit type
        postBtn = document.querySelector('[data-e2e="btn-post"]') ||
          document.querySelector('button[type="submit"]:not([disabled])') ||
          [...document.querySelectorAll('button, [role="button"]')]
            .filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 40 && r.height > 20; // must be visible
            })
            .find(el => /^post$/i.test((el.innerText||el.textContent||'').trim()));

        if (!postBtn) {
          dbg(`Post button not found (attempt ${attempt + 1}/12) — retrying…`);
          if (checkForErrorPage()) break;
          await sleep(800);
        }
      }

      if (postBtn) {
        banner(5, '🤖 Auto-clicking Post…');
        dbg(`Post button found: <${postBtn.tagName}> text="${(postBtn.innerText||'').trim()}"`);
        step('click_post_button', `<${postBtn.tagName}> "${(postBtn.innerText||'').trim()}"`);
        reactClickEl(postBtn);

        // TikTok sometimes shows a "Continue to post?" confirmation modal while
        // still checking the video. Poll for it and click "Post Now" if it appears.
        let confirmClicked = false;
        for (let i = 0; i < 16; i++) {
          await sleep(500);
          if (checkForErrorPage()) break;
          const confirmBtn = Array.from(document.querySelectorAll('button,[role="button"],div[class*="btn"],div[class*="button"]'))
            .find(el => /post\s*now/i.test((el.innerText || el.textContent || '').trim()));
          if (confirmBtn) {
            dbg('"Continue to post?" modal — clicking Post Now');
            banner(5, '🤖 Confirming post (video still being reviewed)…');
            step('confirm_post_modal', (confirmBtn.innerText || '').trim());
            reactClickEl(confirmBtn);
            confirmClicked = true;
            await sleep(3000);
            break;
          }
        }

        // Detect actual success or failure after posting (poll up to 20 s)
        // Success signals: URL leaves /upload, or TikTok shows "Video published" banner
        // Failure signals: explicit error text on page
        step('await_post_result');
        const TIKTOK_SUCCESS_RE = /video\s+published|video\s+posted|post\s+published|erfolgreich.*ver.ffentlicht|vid.o.*publi./i;
        let postSuccess = false, postError = null;
        for (let i = 0; i < 40; i++) {
          await sleep(500);
          const bodyText = document.body.innerText || '';
          if (!window.location.href.includes('/upload')) { postSuccess = true; dbg('TikTok success: URL left /upload'); break; }
          if (TIKTOK_SUCCESS_RE.test(bodyText)) { postSuccess = true; dbg('TikTok success: "Video published" detected'); break; }
          if (ERROR_PAGE_RE.test(bodyText)) { postError = 'Something went wrong — please try again'; checkForErrorPage(); break; }
          const err = bodyText.match(/upload.*fail|post.*fail|violat|prohibited|not.*allow|content.*removed/i);
          if (err) { postError = err[0]; break; }
        }
        if (!postSuccess && !postError) { postSuccess = true; dbg('TikTok post: detection timed out — assuming success'); }

        if (postError) {
          banner(5, `⚠️ TikTok post failed: ${postError}`, 'warn');
          step('post_failed', postError);
          document.dispatchEvent(new CustomEvent('__ffbot_event', { detail:{ type:'TIKTOK_UPLOAD_ERROR', matched:postError, context:'post-completion' }}));
          document.dispatchEvent(new CustomEvent('__ffbot_failed', { detail:{ platform:'tiktok', error:postError }}));
        } else {
          banner(5, `✅ Posted to TikTok!${note}`, 'success');
          step('post_success');
          document.dispatchEvent(new CustomEvent('__ffbot_complete', { detail:{ platform:'tiktok' }}));
        }
      } else {
        banner(5, '⚠️ Post button not found — please click Post manually.', 'warn');
        step('find_post_button_failed', 'no matching button after 12 attempts');
        checkForErrorPage();
        document.dispatchEvent(new CustomEvent('__ffbot_failed', { detail:{ platform:'tiktok', error:'Post button not found' }}));
      }
    } else {
      banner(5, `✅ All set!${note} Review &amp; click <strong>Post</strong>.`, 'success');
      dbg('Bot complete');
    }
  })();
}

// Exposed for the Jest suite (test/injectors/*) — `module` is undefined in the
// extension's service-worker context so this is a no-op at runtime.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { injectFacebook, injectInstagram, injectTikTok, INJECTORS };
}


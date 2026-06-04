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
const AB_ITUNES_CC_BG = { BE:"be", FR:"fr", DE:"de", LU:"be", NL:"nl" };

async function getApiKey() {
  return new Promise(res => chrome.storage.local.get({ googleApiKey:"" }, d => res(d.googleApiKey)));
}

async function searchAutoPlaceBG(config, apiKey) {
  const typeQ   = AB_TYPE_QUERY_BG[config.type] || "restaurant";
  const country = AB_COUNTRY_NAMES_BG[config.country] || "Belgium";
  const bounds  = AB_BOUNDS_BG[config.country] || AB_BOUNDS_BG.BE;
  const region  = config.region || "";
  const locPart = region ? `${region}, ${country}` : country;

  const res = await fetch(AB_PLACES_SEARCH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri,places.photos",
    },
    body: JSON.stringify({
      textQuery: `${typeQ} in ${locPart}`,
      maxResultCount: 20,
      minRating: parseFloat(config.minStars || "4"),
      locationRestriction: { rectangle: bounds },
    }),
  });
  const data = await res.json();
  if (!data.places?.length) throw new Error(`No ${typeQ}s found in ${locPart}`);

  const minRatings = parseInt(config.minRatings || "100", 10);
  const minPics    = parseInt(config.minPics    || "3",   10);
  const filtered   = data.places.filter(p =>
    (p.userRatingCount || 0) >= minRatings && (p.photos || []).length >= minPics
  );
  const pool = filtered.length ? filtered : data.places;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function resolvePhotoUriBG(photoName, maxWidth, apiKey) {
  const res  = await fetch(`${AB_PLACES_PHOTO}/${photoName}/media?maxWidthPx=${maxWidth}&key=${apiKey}&skipHttpRedirect=true`);
  const data = await res.json();
  return data.photoUri;
}

async function fetchAsDataUrl(url) {
  const res  = await fetch(url);
  const blob = await res.blob();
  const ab   = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.slice(i, i + 8192));
  return `data:${blob.type || "image/jpeg"};base64,${btoa(binary)}`;
}

async function getAutoSongBG(genre, country) {
  const cc = AB_ITUNES_CC_BG[country] || "be";
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
              if (track) return { name:track.trackName, artist:track.artistName, artwork:track.artworkUrl100, previewUrl:track.previewUrl||null, genre:"Top 100" };
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
  return { name:s.trackName, artist:s.artistName, artwork:s.artworkUrl100, previewUrl:s.previewUrl||null, genre:labels[genre]||genre };
}

function getAutoCaptionBG(name, address, type, language, captionOpts, songInfo) {
  const LANG = {
    en: { opener:(name,t,city,seed) => [`Have you visited ${name} yet? 💬`,`Best ${t} in ${city}? ${name} is worth a visit! 🔥`,`What do you think of ${name}? 👇`,`Discover ${city}'s hidden gem: ${name} ✨`,`Don't miss ${name} in ${city}! 📍`,`Have you tried ${name}? 😍`][seed%6] },
    nl: { opener:(name,t,city,seed) => [`Ben je al bij ${name}? Laat het weten! 💬`,`Beste ${t} in ${city}? ${name} is een bezoek waard! 🔥`,`Wat vind je van ${name}? 👇`,`Ontdek de parel van ${city}: ${name} ✨`,`Mis ${name} niet als je in ${city} bent! 📍`,`Heb je ${name} al geprobeerd? 😍`][seed%6] },
    fr: { opener:(name,t,city,seed) => [`Avez-vous visité ${name}? 💬`,`Meilleur ${t} à ${city}? ${name} vaut le détour! 🔥`,`Que pensez-vous de ${name}? 👇`,`Découvrez ${city}: ${name} ✨`,`Ne manquez pas ${name} à ${city}! 📍`,`Avez-vous essayé ${name}? 😍`][seed%6] },
    de: { opener:(name,t,city,seed) => [`Habt ihr ${name} besucht? 💬`,`Bestes ${t} in ${city}? ${name} ist jeden Besuch wert! 🔥`,`Was denkt ihr über ${name}? 👇`,`Entdeckt das Juwel von ${city}: ${name} ✨`,`Verpasst ${name} in ${city} nicht! 📍`,`Habt ihr ${name} probiert? 😍`][seed%6] },
  };
  const cityM  = address.match(/\d{4}\s+([A-Za-zÀ-ÿ\s-]+),/i);
  const city   = (cityM?.[1] || address.split(",")[0] || "").trim();
  const seed   = name.split("").reduce((a,c) => a+c.charCodeAt(0), 0);
  const tLabel = { restaurant:"restaurant", hotel:"hotel", bar:"bar" }[type] || type;
  const cityTag = city.replace(/\s+/g,"");
  const lang   = LANG[language] || LANG.en;
  const parts  = [];
  if (captionOpts.catchy)  { parts.push(lang.opener(name,tLabel,city,seed)); parts.push(""); }
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

async function updateRunLogStatus(postIndex, status) {
  // 1. Update the per-schedule run log
  const d = await chrome.storage.local.get({ autoBotRunLog:[], autoBotSchedule:null });
  const log = d.autoBotRunLog;
  const entry = log.find(e => e.postIndex === postIndex);
  if (entry) entry.status = status; else log.push({ postIndex, status, ts:new Date().toISOString() });
  await chrome.storage.local.set({ autoBotRunLog: log });

  // 2. On completion, append to the persistent activityLog (survives deactivation)
  if (status === "done") {
    const post = d.autoBotSchedule?.posts?.[postIndex];
    if (post?.platforms?.length) {
      const newEntries = post.platforms.map(platform => ({
        id:        `al-${Date.now()}-${platform}`,
        ts:        new Date().toISOString(),
        platform,
        postIndex,
        status:    "done",
      }));
      const al = await chrome.storage.local.get({ activityLog:[] });
      await chrome.storage.local.set({
        activityLog: [...al.activityLog, ...newEntries].slice(-2000),
      });
      TechLog.info("LOG", "activity_log_written", { postIndex, platforms: post.platforms });
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

  const apiKey = await getApiKey();
  if (!apiKey) { bgLog("error","Auto Bot: no API key configured"); return; }

  await updateRunLogStatus(postIndex, "triggered");
  TechLog.info("POST", "post_start", { postIndex, platforms: post.platforms });

  try {
    // 1 ── Find an entity
    TechLog.info("SEARCH", "search_start", { type: config.type, country: config.country, region: config.region });
    bgLog("info", `Auto Bot post ${postIndex}: searching for ${config.type||"restaurant"}…`);
    const t0    = Date.now();
    const place = await searchAutoPlaceBG(config, apiKey);
    const name    = place.displayName?.text || "";
    const address = place.formattedAddress  || "";
    TechLog.info("SEARCH", "search_done", { name, address, duration: Date.now()-t0 });
    bgLog("info", `Auto Bot: found "${name}"`);

    // 2 ── Resolve photos
    TechLog.info("MEDIA", "photos_start", { name });
    const allPhotos = (place.photos||[]).sort((a,b)=>(b.width||0)-(a.width||0));
    const minPics   = Math.max(parseInt(config.minPics||"3",10), 3);
    const numPhotos = Math.min(allPhotos.length, 5, Math.max(minPics, 3));
    const photoUris = await Promise.all(
      allPhotos.slice(0, numPhotos).map(p => resolvePhotoUriBG(p.name, 900, apiKey))
    );
    const photoDataUrls = await Promise.all(photoUris.map(fetchAsDataUrl));
    TechLog.info("MEDIA", "photos_done", { count: photoDataUrls.length });

    // 3 ── Pick a song
    TechLog.info("SONG", "song_start", { genre: config.songGenre });
    const songInfo = await getAutoSongBG(config.songGenre||"top100", config.country||"BE").catch(() => null);
    TechLog.info("SONG", songInfo ? "song_found" : "song_skipped", { song: songInfo?.name, artist: songInfo?.artist });

    // 4 ── Build caption
    const captionOpts = {
      catchy:   config.capCatchy   ?? true,
      name:     config.capName     ?? true,
      address:  config.capAddr     ?? true,
      hashtags: config.capHash     ?? true,
      song:     config.capSong     ?? true,
    };
    const caption = getAutoCaptionBG(name, address, config.type||"restaurant",
                                      config.language||"nl", captionOpts, songInfo);
    TechLog.info("CAPTION", "caption_built", { language: config.language, length: caption.length });

    // 5 ── Fetch audio for TikTok
    let tiktokAudioDataUrl = null;
    if (post.platforms.includes("tiktok") && songInfo?.previewUrl) {
      TechLog.info("MEDIA", "audio_fetch_start", { previewUrl: songInfo.previewUrl });
      tiktokAudioDataUrl = await fetchAsDataUrl(songInfo.previewUrl).catch(e => {
        TechLog.warn("MEDIA", "audio_fetch_failed", { error: e.message });
        return null;
      });
      if (tiktokAudioDataUrl) TechLog.info("MEDIA", "audio_fetch_done", { sizeKB: Math.round(tiktokAudioDataUrl.length * 0.75 / 1024) });
    }

    // 6 ── Post to each platform
    for (const platform of post.platforms) {
      TechLog.info("POST", "platform_start", { platform, postIndex });
      bgLog("info", `Auto Bot: posting to ${platform}…`);
      await handleSocialPost({
        platform, photoDataUrls, caption,
        songName:          songInfo?.name || "",
        location:          address,
        restaurantName:    name,
        tiktokAudioDataUrl: platform === "tiktok" ? tiktokAudioDataUrl : null,
        autoPost:          true,
      });
      TechLog.info("POST", "platform_injected", { platform });
      if (post.platforms.indexOf(platform) < post.platforms.length - 1)
        await new Promise(r => setTimeout(r, 4000));
    }

    await updateRunLogStatus(postIndex, "done");
    TechLog.info("POST", "post_complete", { postIndex, name, platforms: post.platforms });
    TechLog._flush();
    bgLog("info", `Auto Bot post ${postIndex} complete`, { name });

  } catch(err) {
    TechLog.error("POST", "post_failed", { postIndex, error: err.message });
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
});

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

async function handleSocialPost({ platform, photoDataUrls, caption, songName, location, restaurantName, tiktokAudioDataUrl, autoPost = false }) {
  bgLog('info', `Opening ${platform}`, { photos: photoDataUrls.length, song: songName, location, autoPost });
  // TikTok's upload page REQUIRES an active/focused tab to initialise its upload
  // handlers and process file input injection. Opening in the background (active:false)
  // throttles timers and prevents TikTok from processing the injected video file.
  // Always open as active — this was the V1.4 behaviour that worked correctly.
  const tab = await chrome.tabs.create({ url: PLATFORM_URLS[platform], active: true });

  await new Promise(resolve => {
    function listener(tabId, info) {
      if (tabId !== tab.id || info.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });

  // Extra buffer for SPA hydration (Facebook especially needs this)
  await new Promise(r => setTimeout(r, 3000));

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   INJECTORS[platform],
      args:   [photoDataUrls, caption, songName || "", location || "", { restaurantName: restaurantName || "", tiktokAudioDataUrl: tiktokAudioDataUrl || null, autoPost: autoPost }],
      world:  "MAIN",
    });
    bgLog('info', `Injected script on ${platform}`);

    // In auto mode: close the tab once the injector signals completion (or after timeout)
    if (autoPost) {
      await new Promise(resolve => {
        const timeout = setTimeout(() => { cleanup(); resolve(); }, 90000); // 90s max
        function cleanup() { clearTimeout(timeout); chrome.runtime.onMessage.removeListener(listener); }
        function listener(msg, sender) {
          if ((msg.type === "PLATFORM_POST_COMPLETE" || msg.type === "PLATFORM_POST_FAILED") && sender.tab?.id === tab.id) {
            cleanup(); resolve();
          }
        }
        chrome.runtime.onMessage.addListener(listener);
      });
      setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 3000);
    }

  } catch (err) {
    bgLog('error', `Inject failed on ${platform}`, String(err));
    if (autoPost) chrome.tabs.remove(tab.id).catch(() => {});
  }
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
      <button onclick="document.getElementById('ffbot-banner').remove()"
        style="background:rgba(255,255,255,.22);border:none;color:#fff;border-radius:5px;
        padding:3px 9px;cursor:pointer;white-space:nowrap;flex-shrink:0">✕ Close</button>`;
    document.body.prepend(b);
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
        try { chrome.runtime.sendMessage({ type:"PLATFORM_POST_COMPLETE", platform:"facebook" }); } catch(_) {}
      } else {
        step(4, total, '⚠️ Could not find Post button', 'warn');
        try { chrome.runtime.sendMessage({ type:"PLATFORM_POST_FAILED", platform:"facebook" }); } catch(_) {}
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
          <button onclick="document.getElementById('ffbot-banner').remove()"
            style="background:rgba(255,255,255,.22);border:none;color:#fff;
            border-radius:5px;padding:3px 9px;cursor:pointer;flex-shrink:0">✕</button>
        </div>
        <div id="ffbot-log" style="font-size:.7rem;opacity:.8;line-height:1.5;
          max-height:60px;overflow:hidden"></div>`;
      document.body.prepend(b);
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
    } else {
      dbg(`Clicking create button: ${createBtn.tagName} aria="${createBtn.getAttribute('aria-label')}"`);
      createBtn.click();
    }

    // ══ STEP 1b: Snapshot pre-existing "Post" elements, then find the NEW one ═══
    // Snapshot BEFORE the panel animates in
    const prePostEls = new Set(
      [...document.querySelectorAll('*')]
        .filter(el => (el.innerText || el.textContent || '').trim() === 'Post')
    );
    dbg(`Snapshot: ${prePostEls.size} existing elements with text "Post"`);

    step(1, total, 'Waiting for Post/Story/Reel menu to appear…');
    await sleep(700);

    async function findAndClickPostOption() {
      // Find elements with text "Post" that did NOT exist before we clicked Create
      const newPostEls = [...document.querySelectorAll('*')]
        .filter(el => (el.innerText || el.textContent || '').trim() === 'Post' && !prePostEls.has(el));

      dbg(`Found ${newPostEls.length} new "Post" element(s) after clicking Create`);

      if (newPostEls.length > 0) {
        // Pick the first one and find its clickable ancestor
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

    // Wait for the upload dialog to appear (has a file input or drag-drop area)
    await waitFor('[role="dialog"]', 10000);
    await sleep(500);
    dbg('Upload dialog appeared');

    // ══ STEP 2: Inject photos ═════════════════════════════════════════════════
    const files = photoDataUrls.map((url, i) => dataUrlToFile(url, `restaurant-${i + 1}.jpg`));
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
      await sleep(400);
      step(5, total, 'Adding location…');
      const cityMatch = location.match(/\d{4}\s+([A-Za-zÀ-ÿ\s-]+),\s*Belgium/i);
      const searchTerm = (cityMatch?.[1] || location.split(',')[0] || location).trim();
      dbg(`Location search term: "${searchTerm}"`);

      let locTrigger = document.querySelector('[aria-label="Add location"],[placeholder*="location" i]');
      if (!locTrigger) {
        locTrigger = [...document.querySelectorAll('[role="button"],button,a,input')]
          .find(el => /add.*(a\s+)?location/i.test(
            el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.textContent || ''));
      }
      if (locTrigger) {
        dbg(`Location trigger found: ${locTrigger.tagName}`);
        locTrigger.click(); await sleep(400);
        const locInput = await waitFor('input[placeholder*="Search" i],input[aria-label*="location" i]', 4000);
        if (locInput) {
          locInput.focus(); await sleep(200);
          for (const ch of searchTerm) { document.execCommand('insertText', false, ch); await sleep(55); }
          dbg(`Typed "${searchTerm}" in location field`);
          await sleep(2000);
          const firstResult = document.querySelector('[role="option"]:first-child,[role="listitem"]:first-child');
          if (firstResult) { firstResult.click(); dbg('Selected first location result'); await sleep(500); }
          else dbg('No location results appeared');
        }
      } else { dbg('Location trigger not found'); }
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
      step(total, total, '🤖 Auto-sharing…');
      await sleep(800);
      // Find the Share button (Instagram's final submit)
      const shareBtn = await waitForBtn(/^(share|delen|partager|teilen)$/i, 10000);
      if (shareBtn) {
        shareBtn.click();
        dbg('Auto-clicked Share on Instagram');
        await sleep(5000);
        step(total, total, '✅ Posted to Instagram!', 'success');
        try { chrome.runtime.sendMessage({ type:"PLATFORM_POST_COMPLETE", platform:"instagram" }); } catch(_) {}
      } else {
        step(total, total, '⚠️ Could not find Share button', 'warn');
        try { chrome.runtime.sendMessage({ type:"PLATFORM_POST_FAILED", platform:"instagram" }); } catch(_) {}
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
        <button onclick="document.getElementById('ffbot-banner').remove()"
          style="background:rgba(255,255,255,.22);border:none;color:#fff;border-radius:5px;padding:3px 9px;cursor:pointer">✕</button>
      </div>
      <div id="ffbot-log" style="font-size:.68rem;opacity:.78;max-height:30px;overflow:hidden"></div>`;
    document.body.prepend(b);
  }
  function dbg(msg) {
    const l = document.getElementById('ffbot-log');
    if (l) { const d = document.createElement('span'); d.textContent = `→ ${msg}  `; l.prepend(d); }
    console.log(`[FoodFluencer TikTok] ${msg}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Build H.264 MP4 (+ optional AAC audio) entirely inside TikTok's page context
  // ═══════════════════════════════════════════════════════════════════════════
  async function buildH264MP4(imgDataUrls, audioDataUrl) {
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

    function drawSlide(img) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      ctx.drawImage(img, (W - img.naturalWidth * s) / 2, (H - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
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
    dbg(`Video codec: ${codec}`);

    const vChunks = []; let vDcfg = null; let vErr = null;
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
      drawSlide(images[i]);
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
    dbg(`Video: ${vChunks.length} chunks`);

    // ── Encode audio with WebCodecs (AAC-LC) ────────────────────────────────
    let aChunks = [];
    const AUDIO_SAMPLE_RATE = 44100;
    const AUDIO_CHANNELS    = 2;
    const videoSec = images.length * SEC;

    if (audioDataUrl && window.AudioEncoder && window.AudioData) {
      try {
        banner(1, `Encoding audio (${Math.round(videoSec)}s)…`);
        // Decode audio data URL → AudioBuffer
        const b64   = audioDataUrl.split(',')[1];
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const tmpCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: AUDIO_SAMPLE_RATE });
        // Resume in case the tab was briefly backgrounded (Chrome suspends AudioContext in background tabs)
        if (tmpCtx.state === 'suspended') { try { await tmpCtx.resume(); } catch(_) {} }
        const audioBuf = await tmpCtx.decodeAudioData(bytes.buffer.slice(0));
        await tmpCtx.close();

        const totalAudioFrames = Math.min(
          Math.ceil(videoSec * AUDIO_SAMPLE_RATE),
          audioBuf.length
        );
        const numCh = Math.min(audioBuf.numberOfChannels, AUDIO_CHANNELS);

        const aSupport = await AudioEncoder.isConfigSupported({
          codec: 'mp4a.40.2', sampleRate: AUDIO_SAMPLE_RATE,
          numberOfChannels: numCh, bitrate: 128000,
        });

        if (aSupport.supported) {
          let aErr = null;
          const aEnc = new AudioEncoder({
            output: (chunk) => {
              const buf = new ArrayBuffer(chunk.byteLength); chunk.copyTo(buf);
              aChunks.push({ data: new Uint8Array(buf), timestamp: chunk.timestamp });
            },
            error: e => { aErr = e; },
          });
          aEnc.configure({ codec: 'mp4a.40.2', sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: numCh, bitrate: 128000 });

          const FRAME_SIZE = 1024;
          const ch = [];
          for (let c = 0; c < numCh; c++) ch.push(audioBuf.getChannelData(c));

          let processed = 0;
          while (processed < totalAudioFrames) {
            const frames = Math.min(FRAME_SIZE, totalAudioFrames - processed);
            const planar  = new Float32Array(frames * numCh);
            for (let c = 0; c < numCh; c++)
              planar.set(ch[c].slice(processed, processed + frames), c * frames);

            const ad = new AudioData({
              format: 'f32-planar',
              sampleRate: AUDIO_SAMPLE_RATE,
              numberOfFrames: frames,
              numberOfChannels: numCh,
              timestamp: Math.round(processed * 1_000_000 / AUDIO_SAMPLE_RATE),
              data: planar,
            });
            aEnc.encode(ad); ad.close();
            processed += frames;
          }
          await aEnc.flush(); aEnc.close();
          if (aErr) throw new Error('AudioEncoder: ' + aErr.message);
          dbg(`Audio: ${aChunks.length} AAC chunks (${numCh}ch)`);
        } else {
          dbg('AAC not supported — video-only');
        }
      } catch(e) {
        dbg(`Audio encoding failed: ${e.message} — video-only`);
        aChunks = [];
      }
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
      const errMatch = text.match(ERR_RE);
      if (errMatch) {
        // Extract a wider context around the error for logging
        const errIdx  = text.toLowerCase().indexOf(errMatch[0].toLowerCase());
        const context = text.slice(Math.max(0, errIdx - 40), errIdx + 120).trim();
        dbg(`TikTok error detected: "${errMatch[0]}" | context: "${context}"`);
        // Send full error details back to background service worker for persistent logging
        try {
          chrome.runtime.sendMessage({
            type:    'TIKTOK_UPLOAD_ERROR',
            matched: errMatch[0],
            context,
            pageSnippet: text.slice(0, 600),
          });
        } catch(_) {}
        return 'rejected';
      }
      if (document.querySelector('[class*="DraftEditor"],[data-placeholder*="description" i],[data-placeholder*="caption" i]')) return 'accepted';
    }
    // Final check on timeout
    const finalText = document.body.innerText || '';
    const finalErr  = finalText.match(ERR_RE);
    if (finalErr) {
      try { chrome.runtime.sendMessage({ type:'TIKTOK_UPLOAD_ERROR', matched:finalErr[0], context:'timeout-check', pageSnippet:finalText.slice(0,600) }); } catch(_) {}
      return 'rejected';
    }
    return 'timeout';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN FLOW
  // ═══════════════════════════════════════════════════════════════════════════
  (async () => {
    await sleep(2000);

    // ── Step 1: Build the MP4 ────────────────────────────────────────────
    const hasAudio = !!tiktokAudioDataUrl;
    banner(1, `Building ${photoDataUrls.length}-photo slideshow${hasAudio ? ' 🎵 with song' : ''}…`);

    let videoFile = null;
    try {
      const blob = await buildH264MP4(photoDataUrls, tiktokAudioDataUrl);
      const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
      videoFile = new File([blob], 'tiktok-post.mp4', { type: 'video/mp4' });
      banner(1, `Video ready: ${sizeMB}MB H.264${hasAudio ? ' + AAC 🎵' : ''} — uploading…`);
      dbg(`Video: ${sizeMB}MB`);
    } catch(e) {
      dbg(`Build failed: ${e.message}`);
      banner(1, `⚠️ Build failed: ${e.message}`, 'warn');
      return;
    }

    // ── Step 2: Inject into TikTok file input ────────────────────────────
    banner(2, 'Finding upload area…');
    const fileInput = await waitFor('input[type="file"]', 12000);
    if (!fileInput) { banner(2, '⚠️ Upload area not found. Refresh and retry.', 'warn'); return; }

    const sizeMB = (videoFile.size / 1024 / 1024).toFixed(2);
    dbg(`Injecting ${sizeMB}MB MP4 (type=${videoFile.type})…`);
    // Log video specs before injection so we have this in TechLog for debugging
    try { chrome.runtime.sendMessage({ type:'TIKTOK_VIDEO_SPECS', sizeMB, mimeType:videoFile.type, hasAudio }); } catch(_) {}
    injectFile(fileInput, videoFile);

    // ── Step 3: Wait for TikTok to process ──────────────────────────────
    banner(3, 'Processing video…');
    const result = await checkUpload(30000);
    if (result === 'rejected') {
      // Capture visible error text for the banner
      const visibleErr = (document.body.innerText || '').match(ERR_RE)?.[0] || 'unknown error';
      banner(3, `⚠️ TikTok rejected: "<em>${visibleErr}</em>". Check the page for details.`, 'warn');
      try { chrome.runtime.sendMessage({ type:'TIKTOK_UPLOAD_ERROR', matched:visibleErr, context:'post-check', autoPost: opts?.autoPost }); } catch(_) {}
      return;
    }
    dbg('Upload accepted');
    await sleep(2000);

    // ── Step 4: Fill Description ─────────────────────────────────────────
    banner(4, 'Filling description…');
    const descSels = [
      '.public-DraftEditor-content',
      '[contenteditable="true"][class*="editor" i]',
      '[data-placeholder*="description" i]',
      'div[contenteditable="true"]',
    ];
    let descBox = null;
    for (let att = 0; att < 8 && !descBox; att++) {
      for (const s of descSels) { descBox = document.querySelector(s); if (descBox) break; }
      if (!descBox) await sleep(500);
    }
    if (descBox && caption) {
      descBox.focus(); await sleep(300);
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, caption);
      dbg('Description filled');
    } else { dbg('Description box not found'); }

    // ── Step 5: Add Location ─────────────────────────────────────────────
    if (location) {
      await sleep(600);
      banner(4, 'Adding location…');

      const cityMatch = location.match(/\d{4}\s+([A-Za-zÀ-ÿ\s-]+),\s*Belgium/i);
      const city      = (cityMatch?.[1] || location.split(',')[0] || '').trim();
      // Search by restaurant name first (finds the actual TikTok venue tag).
      // Fall back to city name if restaurant name produces no results.
      const { restaurantName: rName = '' } = opts || {};
      const searchTerm = rName || city || location.split(',')[0].trim();
      dbg(`Location search: "${searchTerm}" (${rName ? 'venue' : 'city'})`);

      // Find the "Location" button/field
      let locTrigger = document.querySelector('[aria-label*="location" i],[placeholder*="location" i]');
      if (!locTrigger) {
        locTrigger = [...document.querySelectorAll('[role="button"],button,div[tabindex]')]
          .find(el => /add\s*(a\s+)?location|^location$/i.test(el.innerText || el.getAttribute('aria-label') || ''));
      }
      if (locTrigger) {
        locTrigger.click(); await sleep(700);
        const locInput = await waitFor('input[placeholder*="Search" i],input[placeholder*="Location" i]', 4000);
        if (locInput) {
          // Helper: type a term and wait for results
          async function typeAndSelect(term) {
            locInput.focus(); await sleep(200);
            // Clear existing text
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, '');
            await sleep(100);
            for (const ch of term) { document.execCommand('insertText', false, ch); await sleep(55); }
            await sleep(2000);
            const first = document.querySelector(
              '[role="option"]:first-child,[class*="location-item"]:first-child,[class*="LocationItem"]:first-child'
            );
            if (first) { first.click(); dbg(`Location selected: ${first.innerText?.trim()}`); return true; }
            return false;
          }

          // Try restaurant name first, fall back to city
          const selected = await typeAndSelect(searchTerm);
          if (!selected && rName && city) {
            dbg(`No venue results for "${rName}" — retrying with city "${city}"`);
            await typeAndSelect(city);
          } else if (!selected) {
            dbg('No location results found');
          }
        }
      } else { dbg('Location button not found'); }
    }

    // ── Done: auto-click Post (auto mode) or wait for user (manual mode) ────
    const { autoPost: ttAutoPost = false } = opts || {};
    const note = hasAudio ? ` 🎵 Song baked in.` : '';

    if (ttAutoPost) {
      banner(5, '🤖 Locating Post button…');
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
          await sleep(800);
        }
      }

      if (postBtn) {
        banner(5, '🤖 Auto-clicking Post…');
        dbg(`Post button found: <${postBtn.tagName}> data-e2e="${postBtn.getAttribute('data-e2e')}" text="${(postBtn.innerText||'').trim()}"`);
        reactClickEl(postBtn);
        await sleep(8000); // TikTok processing + upload time
        banner(5, `✅ Posted to TikTok!${note}`, 'success');
        try { chrome.runtime.sendMessage({ type:"PLATFORM_POST_COMPLETE", platform:"tiktok" }); } catch(_) {}
      } else {
        banner(5, '⚠️ Post button not found — please click Post manually.', 'warn');
        try { chrome.runtime.sendMessage({ type:"PLATFORM_POST_FAILED", platform:"tiktok" }); } catch(_) {}
      }
    } else {
      banner(5, `✅ All set!${note} Review &amp; click <strong>Post</strong>.`, 'success');
      dbg('Bot complete');
    }
  })();
}


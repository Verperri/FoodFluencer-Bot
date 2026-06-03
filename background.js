// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
  instagram: "https://www.instagram.com/create/select/",
  facebook:  "https://www.facebook.com/",
  tiktok:    "https://www.tiktok.com/upload",
};

const INJECTORS = {
  facebook:  injectFacebook,
  instagram: injectInstagram,
  tiktok:    injectTikTok,
};

async function handleSocialPost({ platform, photoDataUrls, caption, songName }) {
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
      args:   [photoDataUrls, caption, songName || ""],
      world:  "MAIN",
    });
  } catch (err) {
    console.error(`[FoodFluencer] Inject failed on ${platform}:`, err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared utilities — inlined in every injector (each runs serialised/isolated)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Facebook ─────────────────────────────────────────────────────────────────

function injectFacebook(photoDataUrls, caption, songName) {
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

    // ⑤  Song hint (optional)
    if (songName) {
      step(5, total, `Add <em>"${songName}"</em> via <strong>Feeling/Activity → Music</strong>, then click <strong>Post</strong>.`, 'success');
    } else {
      step(4, total, `✅ ${files.length} photo${files.length > 1 ? 's' : ''} &amp; caption ready — click <strong>Post</strong> to publish.`, 'success');
    }
  })();
}

// ─── Instagram ────────────────────────────────────────────────────────────────

function injectInstagram(photoDataUrls, caption, songName) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const waitFor = (sel, ms = 8000) => new Promise(res => {
    if (document.querySelector(sel)) return res(document.querySelector(sel));
    const t = Date.now(); const iv = setInterval(() => {
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
    const b = document.createElement('div'); b.id = 'ffbot-banner';
    const bg = { info: '#e8490f', success: '#16a34a', warn: '#d97706' }[type] || '#e8490f';
    b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;
      background:${bg};color:#fff;font-family:-apple-system,sans-serif;font-size:13px;
      font-weight:500;padding:10px 16px;display:flex;align-items:center;gap:10px;
      box-shadow:0 3px 14px rgba(0,0,0,.28);`;
    b.innerHTML = `
      <strong style="white-space:nowrap">🍽️ FoodFluencer</strong>
      <span style="background:rgba(255,255,255,.22);border-radius:20px;padding:1px 8px;font-size:.75rem;white-space:nowrap">${n}/${total}</span>
      <span style="font-weight:400;flex:1">${html}</span>
      <button onclick="document.getElementById('ffbot-banner').remove()"
        style="background:rgba(255,255,255,.22);border:none;color:#fff;border-radius:5px;
        padding:3px 9px;cursor:pointer;white-space:nowrap;flex-shrink:0">✕ Close</button>`;
    document.body.prepend(b);
  }

  function clickNext() {
    const btn = [...document.querySelectorAll('[role="button"]')]
      .find(el => el.textContent.trim() === 'Next');
    if (btn) { btn.click(); return true; } return false;
  }

  (async () => {
    const total = songName ? 6 : 5;

    // ①  Wait for create page
    step(1, total, 'Loading create page…');
    await sleep(1800);

    // ②  Select photos via file input
    step(2, total, `Selecting <strong>${photoDataUrls.length} photo${photoDataUrls.length > 1 ? 's' : ''}</strong>…`);
    let fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) {
      const selBtn = [...document.querySelectorAll('[role="button"]')]
        .find(el => /select.*computer|from computer/i.test(el.textContent));
      if (selBtn) { selBtn.click(); await sleep(600); }
      fileInput = document.querySelector('input[type="file"]');
    }
    if (!fileInput) {
      step(2, total, 'Select your photos from <strong>Downloads/FoodFluencer</strong> in the dialog.', 'warn');
      return;
    }
    const files = photoDataUrls.map((url, i) => dataUrlToFile(url, `restaurant-${i + 1}.jpg`));
    setFilesOnInput(fileInput, files);
    await sleep(2500);

    // ③  Next through Crop
    step(3, total, 'Advancing through crop step…');
    clickNext(); await sleep(1600);

    // ④  Next through Filters
    step(4, total, 'Advancing through filters step…');
    clickNext(); await sleep(1600);

    // ⑤  Fill caption on Details screen
    step(5, total, 'Filling caption…');
    const captionArea = await waitFor(
      'textarea[aria-label="Write a caption..."], textarea[placeholder*="caption" i], textarea[placeholder*="Caption" i]',
      5000
    );
    if (captionArea) {
      captionArea.focus(); await sleep(200);
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(captionArea, caption); else captionArea.value = caption;
      captionArea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // ⑥  Try to add music
    if (songName) {
      await sleep(600);
      const musicBtn = [...document.querySelectorAll('[role="button"]')]
        .find(el => /add music|music/i.test(el.getAttribute('aria-label') || el.textContent));
      if (musicBtn) {
        musicBtn.click(); await sleep(1000);
        const searchInput = document.querySelector('input[placeholder*="Search" i], input[type="search"]');
        if (searchInput) {
          searchInput.focus(); searchInput.value = songName;
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(1500);
          const firstTrack = document.querySelector('[class*="MusicItem"], [class*="music_item"], [class*="track"]');
          if (firstTrack) firstTrack.click();
        }
        step(6, total, `🎵 <em>"${songName}"</em> searched — select it, then click <strong>Share</strong>.`, 'success');
      } else {
        step(6, total, `Caption filled — search for <em>"${songName}"</em> in Add Music, then click <strong>Share</strong>.`, 'success');
      }
    } else {
      step(5, total, `✅ ${files.length} photo${files.length > 1 ? 's' : ''} &amp; caption ready — click <strong>Share</strong> to publish.`, 'success');
    }
  })();
}

// ─── TikTok ───────────────────────────────────────────────────────────────────

function injectTikTok(photoDataUrls, caption, songName) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const waitFor = (sel, ms = 10000) => new Promise(res => {
    if (document.querySelector(sel)) return res(document.querySelector(sel));
    const t = Date.now(); const iv = setInterval(() => {
      const el = document.querySelector(sel);
      if (el) { clearInterval(iv); return res(el); }
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
    const b = document.createElement('div'); b.id = 'ffbot-banner';
    const bg = { info: '#e8490f', success: '#16a34a', warn: '#d97706' }[type] || '#e8490f';
    b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;
      background:${bg};color:#fff;font-family:-apple-system,sans-serif;font-size:13px;
      font-weight:500;padding:10px 16px;display:flex;align-items:center;gap:10px;
      box-shadow:0 3px 14px rgba(0,0,0,.28);`;
    b.innerHTML = `
      <strong style="white-space:nowrap">🍽️ FoodFluencer</strong>
      <span style="background:rgba(255,255,255,.22);border-radius:20px;padding:1px 8px;font-size:.75rem;white-space:nowrap">${n}/${total}</span>
      <span style="font-weight:400;flex:1">${html}</span>
      <button onclick="document.getElementById('ffbot-banner').remove()"
        style="background:rgba(255,255,255,.22);border:none;color:#fff;border-radius:5px;
        padding:3px 9px;cursor:pointer;white-space:nowrap;flex-shrink:0">✕ Close</button>`;
    document.body.prepend(b);
  }

  (async () => {
    const total = songName ? 4 : 3;

    // ①  Find file input on upload page
    step(1, total, 'Locating upload area…');
    const fileInput = await waitFor('input[type="file"]', 10000);
    if (!fileInput) {
      step(1, total, 'Upload area not found — refresh TikTok and try again.', 'warn');
      return;
    }

    // ②  Upload all photos (TikTok creates a photo slideshow)
    const files = photoDataUrls.map((url, i) => dataUrlToFile(url, `restaurant-${i + 1}.jpg`));
    step(2, total, `Uploading <strong>${files.length} photo${files.length > 1 ? 's' : ''}</strong> as slideshow…`);
    setFilesOnInput(fileInput, files);
    await sleep(3500);

    // ③  Fill description
    step(3, total, 'Filling description…');
    const descSels = [
      '.public-DraftEditor-content',
      '[contenteditable="true"][data-text]',
      '[class*="editor"][contenteditable="true"]',
      'div[contenteditable="true"]',
    ];
    let descBox = null;
    for (const s of descSels) { descBox = document.querySelector(s); if (descBox) break; }
    if (descBox) {
      descBox.focus(); await sleep(200);
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, caption);
    }

    // ④  Add sound
    if (songName) {
      await sleep(800);
      let soundBtn = null;
      const soundSels = ['button[class*="sound"]', '[class*="add-sound"]',
        'button[aria-label*="sound" i]', 'button[aria-label*="music" i]'];
      for (const s of soundSels) { soundBtn = document.querySelector(s); if (soundBtn) break; }
      if (!soundBtn) soundBtn = [...document.querySelectorAll('button,[role="button"]')]
        .find(el => /add sound|add music/i.test(el.textContent || el.getAttribute('aria-label') || ''));

      if (soundBtn) {
        soundBtn.click(); await sleep(1200);
        const musicInput = document.querySelector('input[placeholder*="Search" i], input[type="search"]');
        if (musicInput) {
          musicInput.focus(); musicInput.value = songName;
          musicInput.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(1800);
          const first = document.querySelector('[class*="music-item"]:first-child, [class*="sound-item"]:first-child, [class*="MusicItem"]:first-child');
          if (first) { first.click(); await sleep(500); }
        }
        step(4, total, `🎵 <em>"${songName}"</em> searched — confirm selection, then click <strong>Post</strong>.`, 'success');
      } else {
        step(4, total, `Description filled — add <em>"${songName}"</em> via Add Sound, then click <strong>Post</strong>.`, 'success');
      }
    } else {
      step(3, total, `✅ ${files.length} photo${files.length > 1 ? 's' : ''} &amp; description ready — click <strong>Post</strong> to publish.`, 'success');
    }
  })();
}

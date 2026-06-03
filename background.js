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

async function handleSocialPost({ platform, photoDataUrls, caption, songName, location, restaurantName, audioDataUrl }) {
  bgLog('info', `Opening ${platform}`, { photos: photoDataUrls.length, song: songName, location, restaurantName });
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
      args:   [photoDataUrls, caption, songName || "", location || "", { restaurantName: restaurantName || "", audioDataUrl: audioDataUrl || null }],
      world:  "MAIN",
    });
    bgLog('info', `Injected script on ${platform}`);
  } catch (err) {
    bgLog('error', `Inject failed on ${platform}`, String(err));
    console.error(`[FoodFluencer] Inject failed on ${platform}:`, err);
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

    // ⑤  Song hint (optional)
    if (songName) {
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

    // ══ Final: stop here, user clicks Share ══════════════════════════════════
    const songHint = songName ? ` &nbsp;🎵 Tap <strong>Add music</strong> → <em>"${songName}"</em>.` : '';
    step(total, total,
      `✅ All ready! Review caption, location &amp; collaborator.${songHint} Click <strong>Share</strong> to publish.`,
      'success');
    dbg('Bot stopped — waiting for user to click Share');
  })();
}

// ─── TikTok ───────────────────────────────────────────────────────────────────
// Tries 3 upload approaches in sequence until TikTok accepts one.

function injectTikTok(photoDataUrls, caption, songName, location, opts) {
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
  function step(n, html, type = 'info') {
    document.getElementById('ffbot-banner')?.remove();
    const b = document.createElement('div'); b.id = 'ffbot-banner';
    const bg = { info: '#e8490f', success: '#16a34a', warn: '#d97706' }[type] || '#e8490f';
    b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;
      background:${bg};color:#fff;font-family:-apple-system,sans-serif;font-size:13px;
      font-weight:500;padding:10px 16px;box-shadow:0 3px 14px rgba(0,0,0,.28);`;
    b.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
        <strong>🍽️ FoodFluencer</strong>
        <span style="background:rgba(255,255,255,.22);border-radius:20px;padding:1px 8px;font-size:.72rem">${n}/${TOTAL}</span>
        <span style="font-weight:400;flex:1">${html}</span>
        <button onclick="document.getElementById('ffbot-banner').remove()"
          style="background:rgba(255,255,255,.22);border:none;color:#fff;border-radius:5px;padding:3px 9px;cursor:pointer">✕</button>
      </div>
      <div id="ffbot-log" style="font-size:.68rem;opacity:.8;max-height:36px;overflow:hidden"></div>`;
    document.body.prepend(b);
  }
  function dbg(msg) {
    const l = document.getElementById('ffbot-log');
    if (l) { const d = document.createElement('div'); d.textContent = `→ ${msg}`; l.prepend(d); while(l.children.length > 3) l.lastChild.remove(); }
    console.log(`[FoodFluencer TikTok] ${msg}`);
  }

  // ── Load all images ────────────────────────────────────────────────────────
  async function loadImages(urls) {
    const imgs = [];
    for (const src of urls) {
      await new Promise(res => {
        const img = new Image();
        img.onload = () => { imgs.push(img); res(); };
        img.onerror = res;
        img.src = src;
      });
    }
    return imgs;
  }

  function drawFrame(ctx, img, W, H) {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, W, H);
    const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
    ctx.drawImage(img, (W - img.naturalWidth * s) / 2, (H - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
  }

  // ── Inject files into TikTok's file input ─────────────────────────────────
  function injectFiles(input, files) {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
    if (setter) setter.call(input, dt.files); else input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input',  { bubbles: true }));
  }

  // ── Check if TikTok accepted the upload (video appears / no "minute" error) ─
  async function uploadAccepted(waitMs = 7000) {
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      await sleep(600);
      const pageText = (document.body.innerText || '').toLowerCase();
      if (/over.*\d+.?min|minute.*limit|\d+.?min.*limit/i.test(pageText)) {
        dbg('TikTok rejected: duration error in page text');
        return false;
      }
      // Success: video player appeared or editor loaded
      if (document.querySelector('video[src], video[blob], [class*="DraftEditor"], [class*="caption" i] textarea, div[contenteditable]')) {
        dbg('Upload accepted: editor elements visible');
        return true;
      }
    }
    // If no explicit error after waitMs, assume it might have worked (or is processing)
    const pageText = (document.body.innerText || '').toLowerCase();
    return !/over.*\d+.?min|minute.*limit/i.test(pageText);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // APPROACH 1 — WebM via MediaRecorder + aggressive WebM duration patch
  // ═══════════════════════════════════════════════════════════════════════════
  async function approach1(imgs, secPerSlide) {
    dbg('Approach 1: WebM MediaRecorder…');
    const W = 1080, H = 1080, fps = 25;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
    dbg(`Codec: ${mimeType}`);

    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_000_000 });
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.start(50);

    for (let i = 0; i < imgs.length; i++) {
      drawFrame(ctx, imgs[i], W, H);
      dbg(`Slide ${i+1}/${imgs.length}`);
      await sleep(secPerSlide * 1000);
    }
    recorder.stop();

    const rawBlob = await new Promise(res => { recorder.onstop = () => res(new Blob(chunks, { type: 'video/webm' })); });
    dbg(`Raw WebM: ${(rawBlob.size/1024).toFixed(0)}KB — patching duration…`);

    // Patch duration in WebM binary
    const totalMs = imgs.length * secPerSlide * 1000;
    const fixed = await patchWebMDuration(rawBlob, totalMs);
    return new File([fixed], 'slideshow.webm', { type: 'video/webm' });
  }

  async function patchWebMDuration(blob, totalMs) {
    const buf = await blob.arrayBuffer();
    const data = new Uint8Array(buf);
    const view = new DataView(buf);
    let patched = false;

    // Scan for EBML Duration element: ID = 0x4489
    for (let i = 0; i < data.length - 12 && !patched; i++) {
      if (data[i] !== 0x44 || data[i+1] !== 0x89) continue;
      const sizeCode = data[i+2];
      let dataOff, dataLen;
      if      (sizeCode >= 0x80) { dataLen = sizeCode & 0x7F;                              dataOff = i + 3; }
      else if (sizeCode >= 0x40) { dataLen = ((sizeCode & 0x3F) << 8) | data[i+3];         dataOff = i + 4; }
      else if (sizeCode >= 0x20) { dataLen = ((sizeCode & 0x1F) << 16) | (data[i+3] << 8) | data[i+4]; dataOff = i + 5; }
      else continue;
      if (dataLen === 8) { view.setFloat64(dataOff, totalMs, false); patched = true; dbg(`Duration patched at byte ${i}`); }
      else if (dataLen === 4) { view.setFloat32(dataOff, totalMs, false); patched = true; dbg(`Duration patched (f32) at byte ${i}`); }
    }
    if (!patched) dbg('Duration element not found in WebM — uploading without patch');
    return new Blob([buf], { type: blob.type });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // APPROACH 2 — Real H.264 MP4 via WebCodecs API
  // ═══════════════════════════════════════════════════════════════════════════
  async function approach2(imgs, secPerSlide) {
    if (!window.VideoEncoder) throw new Error('WebCodecs VideoEncoder not available');
    dbg('Approach 2: H.264 MP4 via WebCodecs…');

    const W = 1080, H = 1080, fps = 25;
    const framesPerSlide = Math.ceil(secPerSlide * fps);
    const totalFrames    = imgs.length * framesPerSlide;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    const videoChunks = [];
    let decoderConfig = null;

    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
        const buf = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(buf);
        videoChunks.push({ data: new Uint8Array(buf), ts: chunk.timestamp, isKey: chunk.type === 'key' });
      },
      error: e => { throw e; },
    });

    encoder.configure({
      codec: 'avc1.42001f', // H.264 Baseline Level 3.1
      width: W, height: H,
      bitrate: 2_000_000,
      framerate: fps,
      avc: { format: 'avcC' },
    });

    let frameIdx = 0;
    for (let i = 0; i < imgs.length; i++) {
      drawFrame(ctx, imgs[i], W, H);
      for (let f = 0; f < framesPerSlide; f++) {
        const ts = Math.round((frameIdx / fps) * 1_000_000);
        const frame = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1_000_000 / fps) });
        encoder.encode(frame, { keyFrame: frameIdx === 0 || f === 0 });
        frame.close();
        frameIdx++;
      }
      dbg(`Encoded slide ${i+1}/${imgs.length}`);
    }
    await encoder.flush();
    encoder.close();
    dbg(`Encoded ${videoChunks.length} chunks — muxing MP4…`);

    const mp4Blob = muxMP4(videoChunks, decoderConfig, W, H, fps, totalFrames);
    return new File([mp4Blob], 'slideshow.mp4', { type: 'video/mp4' });
  }

  function muxMP4(chunks, decoderConfig, W, H, fps, totalFrames) {
    const u8  = v => [v & 0xFF];
    const u16 = v => [(v >> 8) & 0xFF, v & 0xFF];
    const u32 = v => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
    const str = s => [...new TextEncoder().encode(s).slice(0, 4)];
    const zeros = n => Array(n).fill(0);

    function box(type, ...children) {
      const data = children.flat(Infinity);
      const size = 8 + data.length;
      return [...u32(size), ...str(type.padEnd(4, ' ')), ...data];
    }
    function fb(type, ver, flags, ...children) {
      return box(type, u8(ver), [(flags >> 16) & 0xFF, (flags >> 8) & 0xFF, flags & 0xFF], ...children);
    }

    // SPS/PPS from decoderConfig
    let sps = new Uint8Array([0x67, 0x42, 0x00, 0x1f, 0xda, 0x0d, 0xa8]);
    let pps = new Uint8Array([0x68, 0xce, 0x38, 0x80]);
    if (decoderConfig?.description) {
      const d = new Uint8Array(decoderConfig.description);
      let i = 5;
      const ns = d[i++] & 0x1F;
      for (let j = 0; j < ns; j++) { const l = (d[i] << 8) | d[i+1]; i += 2; sps = d.slice(i, i+l); i += l; }
      const np = d[i++];
      for (let j = 0; j < np; j++) { const l = (d[i] << 8) | d[i+1]; i += 2; pps = d.slice(i, i+l); i += l; }
    }

    const avcC = box('avcC', u8(1), [sps[1], sps[2], sps[3]], [0xFF], [0xE1], u16(sps.length), [...sps], u8(1), u16(pps.length), [...pps]);
    const avc1 = box('avc1', zeros(6), u16(1), zeros(16), u16(W), u16(H), [0,72,0,0,0,72,0,0], u32(0), u16(1), zeros(32), u16(0x18), u16(0xFFFF), avcC);

    const ts = fps; // timescale = fps → 1 unit = 1/fps second
    const dur = totalFrames;

    const stts = fb('stts', 0, 0, u32(1), u32(chunks.length), u32(1));
    const keyIdxs = chunks.map((c,i) => c.isKey ? i+1 : null).filter(Boolean);
    const stss = fb('stss', 0, 0, u32(keyIdxs.length), ...keyIdxs.flatMap(i => u32(i)));
    const stsz = fb('stsz', 0, 0, u32(0), u32(chunks.length), ...chunks.flatMap(c => u32(c.data.length)));
    const stsc = fb('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1));
    const stsd = fb('stsd', 0, 0, u32(1), avc1);
    const stco_ph = fb('stco', 0, 0, u32(chunks.length), ...chunks.flatMap(() => u32(0)));
    const stbl_ph = box('stbl', stsd, stts, stss, stsc, stsz, stco_ph);
    const vmhd = fb('vmhd', 0, 1, u16(0), zeros(6));
    const url_ = fb('url ', 0, 1);
    const dinf = box('dinf', fb('dref', 0, 0, u32(1), url_));
    const minf_ph = box('minf', vmhd, dinf, stbl_ph);
    const mdhd = fb('mdhd', 0, 0, u32(0), u32(0), u32(ts), u32(dur), u16(0x55C4), u16(0));
    const hdlr = fb('hdlr', 0, 0, u32(0), str('vide'), zeros(12), [...str('Vide'), 0]);
    const mdia_ph = box('mdia', mdhd, hdlr, minf_ph);
    const mat = [0x00,0x01,0x00,0x00, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0x00,0x01,0x00,0x00, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0x40,0x00,0x00,0x00];
    const tkhd = fb('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(dur), zeros(8), u16(0), u16(0), u16(0), u16(0), mat, u32(W << 16), u32(H << 16));
    const trak_ph = box('trak', tkhd, mdia_ph);
    const mvhd = fb('mvhd', 0, 0, u32(0), u32(0), u32(ts), u32(dur), u32(0x10000), u16(0x100), zeros(10), mat, zeros(24), u32(2));
    const moov_ph = box('moov', mvhd, trak_ph);
    const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));

    // Compute real chunk offsets
    const mdatHdrSize = 8;
    const mdatStart = ftyp.length + moov_ph.length + mdatHdrSize;
    let off = mdatStart;
    const realOffsets = chunks.map(c => { const o = off; off += c.data.length; return o; });

    // Rebuild with real offsets (same size → offsets remain valid)
    const stco_r = fb('stco', 0, 0, u32(chunks.length), ...realOffsets.flatMap(o => u32(o)));
    const stbl_r = box('stbl', stsd, stts, stss, stsc, stsz, stco_r);
    const minf_r = box('minf', vmhd, dinf, stbl_r);
    const mdia_r = box('mdia', mdhd, hdlr, minf_r);
    const trak_r = box('trak', tkhd, mdia_r);
    const moov_r = box('moov', mvhd, trak_r);

    const mdatData = chunks.flatMap(c => [...c.data]);
    const mdat = box('mdat', mdatData);

    const all = new Uint8Array([...ftyp, ...moov_r, ...mdat]);
    return new Blob([all], { type: 'video/mp4' });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // APPROACH 3 — Upload JPEGs directly (TikTok photo carousel)
  // ═══════════════════════════════════════════════════════════════════════════
  function approach3(urls) {
    dbg('Approach 3: Direct JPEG upload…');
    return urls.map((url, i) => {
      const [hdr, b64] = url.split(',');
      const mime = hdr.match(/:(.*?);/)[1];
      const raw  = atob(b64);
      const arr  = new Uint8Array(raw.length);
      for (let j = 0; j < raw.length; j++) arr[j] = raw.charCodeAt(j);
      return new File([arr], `photo${i+1}.jpg`, { type: mime });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN FLOW
  // ═══════════════════════════════════════════════════════════════════════════
  (async () => {
    const SEC_PER_SLIDE = 1.2;

    step(1, 'Loading upload page…');
    await sleep(1500);
    const fileInput = await waitFor('input[type="file"]', 12000);
    if (!fileInput) { step(1, 'Upload area not found — refresh TikTok.', 'warn'); return; }
    dbg('File input found');

    // ── Pre-load images ────────────────────────────────────────────────────
    step(1, 'Loading images…');
    const imgs = await loadImages(photoDataUrls);
    if (!imgs.length) { step(1, 'No images loaded.', 'warn'); return; }
    dbg(`Loaded ${imgs.length} images`);

    let uploadedAs = null;

    // ── Approach 1: WebM ──────────────────────────────────────────────────
    step(2, 'Approach 1/3 — WebM slideshow (MediaRecorder)…');
    try {
      const file = await approach1(imgs, SEC_PER_SLIDE);
      dbg(`Injecting WebM: ${(file.size/1024).toFixed(0)}KB`);
      injectFiles(fileInput, [file]);
      if (await uploadAccepted(8000)) { uploadedAs = 'WebM'; }
      else { dbg('Approach 1 rejected by TikTok'); }
    } catch(e) { dbg(`Approach 1 error: ${e.message}`); }

    // ── Approach 2: H.264 MP4 ─────────────────────────────────────────────
    if (!uploadedAs) {
      step(2, 'Approach 2/3 — H.264 MP4 (WebCodecs)…');
      try {
        const file = await approach2(imgs, SEC_PER_SLIDE);
        dbg(`Injecting MP4: ${(file.size/1024).toFixed(0)}KB`);
        injectFiles(fileInput, [file]);
        if (await uploadAccepted(10000)) { uploadedAs = 'MP4'; }
        else { dbg('Approach 2 rejected by TikTok'); }
      } catch(e) { dbg(`Approach 2 error: ${e.message}`); }
    }

    // ── Approach 3: JPEG files ─────────────────────────────────────────────
    if (!uploadedAs) {
      step(2, 'Approach 3/3 — Direct JPEG upload (photo carousel)…');
      try {
        const files = approach3(photoDataUrls);
        dbg(`Injecting ${files.length} JPEGs`);
        injectFiles(fileInput, files);
        await sleep(5000);
        uploadedAs = 'Photos'; // assume accepted — no easy error check for photos
      } catch(e) { dbg(`Approach 3 error: ${e.message}`); }
    }

    if (!uploadedAs) {
      step(2, '⚠️ All 3 approaches failed. Please upload manually from <strong>Downloads/FoodFluencer</strong>.', 'warn');
      return;
    }

    dbg(`Upload accepted as: ${uploadedAs}`);
    step(3, `Uploaded as <strong>${uploadedAs}</strong> ✓ — filling description…`);
    await sleep(3000);

    // ── Fill description ──────────────────────────────────────────────────
    const descSels = ['.public-DraftEditor-content', '[contenteditable="true"][data-text]',
      '[class*="editor"][contenteditable="true"]', 'div[contenteditable="true"]'];
    let descBox = null;
    for (const s of descSels) { descBox = document.querySelector(s); if (descBox) break; }
    if (descBox) {
      descBox.focus(); await sleep(200);
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, caption);
      dbg('Description filled');
    }

    // ── Add sound via TikTok's native panel ───────────────────────────────
    if (songName) {
      await sleep(1000);
      step(4, `Searching TikTok sound: <em>"${songName}"</em>…`);
      let soundBtn = [...document.querySelectorAll('button,[role="button"]')]
        .find(el => /add\s*(sound|music)/i.test(el.textContent || el.getAttribute('aria-label') || ''));
      if (soundBtn) {
        soundBtn.click(); await sleep(1200);
        const musicInput = document.querySelector('input[placeholder*="Search" i], input[type="search"]');
        if (musicInput) {
          musicInput.focus(); await sleep(200);
          musicInput.value = songName;
          musicInput.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(2000);
          const firstResult = document.querySelector('[class*="music-item"]:first-child, [class*="MusicItem"]:first-child, [class*="sound-item"]:first-child');
          if (firstResult) { firstResult.click(); dbg('Sound selected'); await sleep(500); }
        }
      } else { dbg('Add Sound button not found'); }
    }

    // ── Done ──────────────────────────────────────────────────────────────
    const songNote = songName ? ` 🎵 Verify "<em>${songName}</em>" is added.` : '';
    step(5, `✅ Uploaded as <strong>${uploadedAs}</strong>. Review &amp; click <strong>Post</strong>.${songNote}`, 'success');
    dbg('Bot complete');
  })();
}


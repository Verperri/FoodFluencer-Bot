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

async function handleSocialPost({ platform, photoDataUrls, caption, songName, location, restaurantName, tiktokVideoDataUrl }) {
  bgLog('info', `Opening ${platform}`, { photos: photoDataUrls.length, song: songName, location, tiktokVideoKB: tiktokVideoDataUrl ? Math.round(tiktokVideoDataUrl.length * 0.75 / 1024) : 0 });
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
      args:   [photoDataUrls, caption, songName || "", location || "", { restaurantName: restaurantName || "", tiktokVideoDataUrl: tiktokVideoDataUrl || null }],
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
  // Video is built INSIDE the injector from the photoDataUrls that are already passed.
  // This avoids the 2-3MB base64 string arg that chrome.scripting silently drops.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = (sel, ms = 12000) => new Promise(res => {
    const el = document.querySelector(sel); if (el) return res(el);
    const t = Date.now(); const iv = setInterval(() => {
      const e = document.querySelector(sel);
      if (e) { clearInterval(iv); return res(e); }
      if (Date.now() - t > ms) { clearInterval(iv); return res(null); }
    }, 300);
  });

  const TOTAL = 4;
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

  // ════════════════════════════════════════════════════════════════════════════
  // Create H.264 MP4 entirely inside TikTok's page context using WebCodecs.
  // The photoDataUrls (~200KB each × 5) are already passed as normal args.
  // ════════════════════════════════════════════════════════════════════════════
  async function buildH264MP4(imgDataUrls) {
    const W = 720, H = 1280, FPS = 25, BITRATE = 2_000_000, SEC = 1.2;

    // Load images
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

    // ── Try WebCodecs H.264 ──────────────────────────────────────────────────
    if (window.VideoEncoder) {
      const codecs = ['avc1.4d0028','avc1.42001f','avc1.42001e','avc1.420014'];
      let codec = null;
      for (const c of codecs) {
        try {
          const s = await VideoEncoder.isConfigSupported({ codec: c, width: W, height: H, bitrate: BITRATE, framerate: FPS });
          if (s.supported) { codec = c; break; }
        } catch(_) {}
      }

      if (codec) {
        dbg(`Encoding H.264 (${codec})…`);
        const chunks = []; let dcfg = null; let encErr = null;
        const enc = new VideoEncoder({
          output: (chunk, meta) => {
            if (meta?.decoderConfig) dcfg = meta.decoderConfig;
            const buf = new ArrayBuffer(chunk.byteLength);
            chunk.copyTo(buf);
            chunks.push({ data: new Uint8Array(buf), isKey: chunk.type === 'key' });
          },
          error: e => { encErr = e; },
        });
        enc.configure({ codec, width: W, height: H, bitrate: BITRATE, framerate: FPS, avc: { format: 'avc' } });

        const framesPerSlide = Math.ceil(SEC * FPS);
        let fi = 0;
        for (let i = 0; i < images.length; i++) {
          drawSlide(images[i]);
          for (let f = 0; f < framesPerSlide; f++) {
            if (encErr) throw new Error(`VideoEncoder: ${encErr.message}`);
            const ts = Math.round(fi * 1_000_000 / FPS);
            const frame = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1_000_000 / FPS) });
            enc.encode(frame, { keyFrame: fi === 0 || f === 0 });
            frame.close(); fi++;
          }
        }
        await enc.flush(); enc.close();
        if (encErr) throw new Error(`VideoEncoder: ${encErr.message}`);
        dbg(`Encoded ${chunks.length} H.264 chunks — muxing MP4…`);
        return { blob: muxMP4(chunks, dcfg, W, H, FPS, fi), type: 'video/mp4', ext: 'mp4' };
      }
    }

    // ── Fallback: WebM via MediaRecorder ────────────────────────────────────
    dbg('WebCodecs unavailable — using MediaRecorder WebM…');
    const mt = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm']
      .find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
    const stream = canvas.captureStream(FPS);
    const rec = new MediaRecorder(stream, { mimeType: mt, videoBitsPerSecond: BITRATE });
    const ch = [];
    rec.ondataavailable = e => { if (e.data.size > 0) ch.push(e.data); };
    rec.start(100);
    for (const img of images) { drawSlide(img); await sleep(SEC * 1000); }
    rec.stop();
    const blob = await new Promise(res => { rec.onstop = () => res(new Blob(ch, { type: mt })); });
    return { blob, type: mt, ext: 'webm' };
  }

  // ── Minimal MP4 muxer (self-contained, identical to popup.js version) ─────
  function muxMP4(chunks, dcfg, W, H, fps, totalFrames) {
    const u8  = v => [v & 0xFF];
    const u16 = v => [(v >> 8) & 0xFF, v & 0xFF];
    const u32 = v => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
    const s4  = s => [...new TextEncoder().encode(s).slice(0, 4)];
    const z   = n => Array(n).fill(0);
    function box(t, ...c) { const d = c.flat(Infinity); return [...u32(8+d.length), ...s4(t.padEnd(4,' ')), ...d]; }
    function fb(t, v, f, ...c) { return box(t, u8(v), [(f>>16)&0xFF,(f>>8)&0xFF,f&0xFF], ...c); }

    const TS = 90000, SD = Math.round(TS / fps), DUR = totalFrames * SD;
    let sps = new Uint8Array([0x67,0x4d,0x00,0x28]);
    let pps = new Uint8Array([0x68,0xee,0x31,0xb2,0x8b]);
    if (dcfg?.description) {
      const d = new Uint8Array(dcfg.description); let i = 5;
      const ns = d[i++] & 0x1F;
      for (let j=0;j<ns;j++) { const l=(d[i]<<8)|d[i+1];i+=2; sps=d.slice(i,i+l);i+=l; }
      const np = d[i++];
      for (let j=0;j<np;j++) { const l=(d[i]<<8)|d[i+1];i+=2; pps=d.slice(i,i+l);i+=l; }
    }

    const avcC = box('avcC', u8(1),[sps[1]||0x4d,sps[2]||0x00,sps[3]||0x28],[0xFF],[0xE1],u16(sps.length),[...sps],u8(1),u16(pps.length),[...pps]);
    const avc1 = box('avc1', z(6),u16(1),z(16),u16(W),u16(H),[0,72,0,0,0,72,0,0],u32(0),u16(1),z(32),u16(0x18),u16(0xFFFF),avcC);
    const mat  = [0x00,0x01,0x00,0x00,0,0,0,0,0,0,0,0,0,0,0,0,0x00,0x01,0x00,0x00,0,0,0,0,0,0,0,0,0,0,0,0,0x40,0x00,0x00,0x00];

    const stsd = fb('stsd',0,0, u32(1),avc1);
    const stts = fb('stts',0,0, u32(1),u32(chunks.length),u32(SD));
    const keys = chunks.map((c,i)=>c.isKey?i+1:null).filter(Boolean);
    const stss = fb('stss',0,0, u32(keys.length),...keys.flatMap(i=>u32(i)));
    const stsz = fb('stsz',0,0, u32(0),u32(chunks.length),...chunks.flatMap(c=>u32(c.data.length)));
    const stsc = fb('stsc',0,0, u32(1),u32(1),u32(1),u32(1));
    const stco_ph = fb('stco',0,0, u32(chunks.length),...chunks.flatMap(()=>u32(0)));
    const stbl_ph = box('stbl',stsd,stts,stss,stsc,stsz,stco_ph);
    const vmhd = fb('vmhd',0,1,u16(0),z(6));
    const dinf = box('dinf',fb('dref',0,0,u32(1),fb('url ',0,1)));
    const minf_ph = box('minf',vmhd,dinf,stbl_ph);
    const mdhd = fb('mdhd',0,0,u32(0),u32(0),u32(TS),u32(DUR),u16(0x55C4),u16(0));
    const hdlr = fb('hdlr',0,0,u32(0),s4('vide'),z(12),[...s4('Vide'),0]);
    const mdia_ph = box('mdia',mdhd,hdlr,minf_ph);
    const tkhd = fb('tkhd',0,3,u32(0),u32(0),u32(1),u32(0),u32(DUR),z(8),u16(0),u16(0),u16(0),u16(0),mat,u32(W<<16),u32(H<<16));
    const trak_ph = box('trak',tkhd,mdia_ph);
    const mvhd = fb('mvhd',0,0,u32(0),u32(0),u32(TS),u32(DUR),u32(0x10000),u16(0x100),z(10),mat,z(24),u32(2));
    const moov_ph = box('moov',mvhd,trak_ph);
    const ftyp = box('ftyp',s4('isom'),u32(0x200),s4('isom'),s4('iso2'),s4('avc1'),s4('mp41'));

    const mdatStart = ftyp.length + moov_ph.length + 8;
    let off = mdatStart;
    const realOff = chunks.map(c => { const o=off; off+=c.data.length; return o; });
    const stco_r  = fb('stco',0,0,u32(chunks.length),...realOff.flatMap(o=>u32(o)));
    const stbl_r  = box('stbl',stsd,stts,stss,stsc,stsz,stco_r);
    const minf_r  = box('minf',vmhd,dinf,stbl_r);
    const mdia_r  = box('mdia',mdhd,hdlr,minf_r);
    const trak_r  = box('trak',tkhd,mdia_r);
    const moov_r  = box('moov',mvhd,trak_r);

    const mdatBodySize = chunks.reduce((a,c)=>a+c.data.length,0);
    const mdatHdr = new Uint8Array([...u32(mdatBodySize+8),...s4('mdat')]);
    const total   = ftyp.length + moov_r.length + mdatHdr.length + mdatBodySize;
    const out     = new Uint8Array(total);
    let p = 0;
    for (const part of [new Uint8Array(ftyp), new Uint8Array(moov_r), mdatHdr, ...chunks.map(c=>c.data)]) {
      out.set(part, p); p += part.length;
    }
    return new Blob([out], { type: 'video/mp4' });
  }

  // ── Inject file into TikTok's upload input ────────────────────────────────
  function injectFile(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
    if (setter) setter.call(input, dt.files); else input.files = dt.files;
    ['change', 'input'].forEach(ev =>
      input.dispatchEvent(new Event(ev, { bubbles: true, cancelable: true }))
    );
  }

  // ── Detect upload result ──────────────────────────────────────────────────
  const ERROR_RE = /over.*\d+.?min|minute.*limit|size.*too|too.*large|file.*too|maximum.*size|not.*support|unsupport|invalid.*file|upload.*fail/i;
  const SUCCESS_SEL = '[class*="DraftEditor"],[data-placeholder*="description" i],[data-placeholder*="caption" i],div[contenteditable][class*="editor"]';

  async function checkUpload(ms = 20000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      await sleep(700);
      const text = document.body.innerText || '';
      if (ERROR_RE.test(text)) { dbg(`TikTok error: "${text.match(ERROR_RE)?.[0]}"`); return 'rejected'; }
      if (document.querySelector(SUCCESS_SEL)) { dbg('Upload accepted — editor visible'); return 'accepted'; }
    }
    return ERROR_RE.test(document.body.innerText) ? 'rejected' : 'timeout';
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MAIN FLOW
  // ════════════════════════════════════════════════════════════════════════════
  (async () => {
    await sleep(2000);

    // ── Step 1: Build video from images ───────────────────────────────────
    banner(1, `Building ${photoDataUrls.length}-photo slideshow (H.264 720×1280)…`);
    dbg(`Building video from ${photoDataUrls.length} photos…`);

    let videoFile = null;
    try {
      const { blob, type, ext } = await buildH264MP4(photoDataUrls);
      const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
      dbg(`Video ready: ${sizeMB}MB ${type}`);
      videoFile = new File([blob], `tiktok-post.${ext}`, { type });
      banner(1, `Video ready (${sizeMB}MB, ${type}) — uploading…`);
    } catch(e) {
      dbg(`Video build failed: ${e.message}`);
      banner(1, `⚠️ Video build failed: ${e.message}. Retrying with simpler format…`, 'warn');
      // Ultimate fallback: single-frame JPEG as "video"
      try {
        const fallback = await buildH264MP4([photoDataUrls[0]]);
        videoFile = new File([fallback.blob], `tiktok-post.${fallback.ext}`, { type: fallback.type });
        dbg('Fallback single-photo video created');
      } catch(e2) {
        banner(1, `⚠️ Could not create video: ${e2.message}`, 'warn');
        return;
      }
    }

    // ── Step 2: Find file input and inject ────────────────────────────────
    banner(2, 'Locating TikTok upload area…');
    const fileInput = await waitFor('input[type="file"]', 12000);
    if (!fileInput) { banner(2, '⚠️ Upload area not found. Refresh TikTok and retry.', 'warn'); return; }

    dbg(`Injecting ${(videoFile.size/1024/1024).toFixed(1)}MB into file input…`);
    injectFile(fileInput, videoFile);

    // ── Step 3: Wait for TikTok to process ───────────────────────────────
    banner(3, 'Waiting for TikTok to process video…');
    const result = await checkUpload(25000);

    if (result === 'rejected') {
      banner(3, '⚠️ TikTok rejected the video. Check the error message on the page.', 'warn');
      dbg('Upload rejected — TikTok showed an error');
      return;
    }

    if (result === 'timeout') {
      dbg('Timeout — proceeding to caption anyway');
    }

    // ── Step 4: Ready — add caption & sound manually / via bot ───────────
    await sleep(2000);

    // Fill description if box is visible
    const descSels = ['.public-DraftEditor-content','[contenteditable="true"][class*="editor" i]',
      '[data-placeholder*="description" i]','div[contenteditable="true"]'];
    let descBox = null;
    for (let att=0; att<6&&!descBox; att++) {
      for (const s of descSels) { descBox=document.querySelector(s); if(descBox) break; }
      if (!descBox) await sleep(500);
    }
    if (descBox && caption) {
      descBox.focus(); await sleep(200);
      document.execCommand('selectAll',false,null);
      document.execCommand('insertText',false,caption);
      dbg('Caption filled');
    }

    if (songName) {
      await sleep(600);
      const soundBtn = [...document.querySelectorAll('button,[role="button"]')]
        .find(el => /add\s*(sound|music)/i.test(el.textContent||el.getAttribute('aria-label')||''));
      if (soundBtn) {
        soundBtn.click(); await sleep(1200);
        const mi = document.querySelector('input[placeholder*="Search" i],input[type="search"]');
        if (mi) {
          mi.focus(); await sleep(200); mi.value=songName;
          mi.dispatchEvent(new Event('input',{bubbles:true}));
          await sleep(2000);
          const fr = document.querySelector('[class*="music-item"]:first-child,[class*="MusicItem"]:first-child');
          if (fr) { fr.click(); dbg(`Sound: ${songName}`); }
        }
      }
    }

    const note = songName ? ` 🎵 Verify "<em>${songName}</em>" is set.` : '';
    banner(4, `✅ Video uploaded! Review &amp; click <strong>Post</strong>.${note}`, 'success');
    dbg('Bot complete');
  })();
}


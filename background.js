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

async function handleSocialPost({ platform, photoDataUrls, caption, songName, location }) {
  bgLog('info', `Opening ${platform}`, { photos: photoDataUrls.length, song: songName, location });
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
      args:   [photoDataUrls, caption, songName || "", location || ""],
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

function injectInstagram(photoDataUrls, caption, songName, location) {
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
    const total = location ? (songName ? 6 : 5) : (songName ? 5 : 4);
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

    // Find the VISIBLE "Next" button inside the modal (ignores hidden/transitioning ones)
    function findVisibleNextBtn() {
      const roots = [document.querySelector('[role="dialog"]'), document.body].filter(Boolean);
      for (const root of roots) {
        const btn = [...root.querySelectorAll('[role="button"],button,[tabindex="0"],a')]
          .find(el => {
            const txt = (el.innerText || el.textContent || '').trim();
            const lbl = el.getAttribute('aria-label') || '';
            return (NEXT_RE.test(txt) || NEXT_RE.test(lbl)) && isVisible(el);
          });
        if (btn) return btn;
      }
      return null;
    }

    // Fire the full React-compatible mouse event sequence on an element
    function reactClick(el) {
      el.focus();
      ['mouseenter', 'mouseover', 'mousedown', 'mouseup', 'click'].forEach(type =>
        el.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, view: window,
          buttons: 1, detail: type === 'click' ? 1 : 0,
        }))
      );
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

      const btnTxt = (preClickBtn.innerText || preClickBtn.textContent || '').trim();
      dbg(`Click ${clickNum}/2 (${label}): <${preClickBtn.tagName}> visible=${isVisible(preClickBtn)} "${btnTxt}"`);

      await sleep(150);
      reactClick(preClickBtn);
      dbg(`Fired mouse events on ${label} Next — waiting for it to hide/disappear`);

      // Wait until THIS SPECIFIC BUTTON is no longer visible (CSS hidden or removed).
      // Instagram often hides buttons via CSS during transitions — must check isVisible().
      const transitioned = await waitForBtnToDisappear(preClickBtn, 6000);
      dbg(`${label} transition: ${transitioned ? 'confirmed (button gone)' : 'uncertain — proceeding anyway'}`);

      // If transition not confirmed, retry the click once more
      if (!transitioned) {
        dbg('Button still visible after 6s — retrying click');
        reactClick(preClickBtn);
        await sleep(1000);
      }

      // Give the next screen time to animate in before we search for its Next button
      await sleep(1200);
    }

    // ══ STEP 4: Fill caption — now on Details screen (Share button visible) ════
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

    // ══ Final: stop here, user clicks Share ══════════════════════════════════
    const songHint = songName ? ` &nbsp;🎵 Tap <strong>Add music</strong> → <em>"${songName}"</em>.` : '';
    step(total, total,
      `✅ All ready! Review your post${location ? ', location' : ''}.${songHint} Click <strong>Share</strong> to publish.`,
      'success');
    dbg('Bot stopped — waiting for user to click Share');
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

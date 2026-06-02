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

async function handleSocialPost({ platform, photoDataUrl, caption, songName }) {
  const tab = await chrome.tabs.create({ url: PLATFORM_URLS[platform], active: true });

  // Wait for the page to fully load
  await new Promise(resolve => {
    function listener(tabId, info) {
      if (tabId !== tab.id || info.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });

  // Extra buffer for SPA hydration
  await new Promise(r => setTimeout(r, 1500));

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   INJECTORS[platform],
      args:   [photoDataUrl, caption, songName || ""],
      world:  "MAIN",
    });
  } catch (err) {
    console.error(`[FoodFluencer] Inject failed on ${platform}:`, err);
  }
}

// ── Shared helpers (inlined into every injector because each runs isolated) ───
// NOTE: These functions are serialised and injected — keep them self-contained.

// ─── Facebook ─────────────────────────────────────────────────────────────────

function injectFacebook(photoDataUrl, caption, songName) {
  const sleep   = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = (sel, ms = 8000) => new Promise(res => {
    const el = document.querySelector(sel);
    if (el) return res(el);
    const t  = Date.now();
    const iv = setInterval(() => {
      const e = document.querySelector(sel);
      if (e)              { clearInterval(iv); res(e); }
      else if (Date.now() - t > ms) { clearInterval(iv); res(null); }
    }, 250);
  });

  function dataUrlToFile(url, name) {
    const [hdr, b64] = url.split(',');
    const mime = hdr.match(/:(.*?);/)[1];
    const bin  = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: mime });
  }

  function setFileOnInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
    if (setter) setter.call(input, dt.files); else input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input',  { bubbles: true }));
  }

  function banner(html, type = 'info') {
    document.getElementById('ffbot-banner')?.remove();
    const b = document.createElement('div');
    b.id = 'ffbot-banner';
    const bg = { info:'#e8490f', success:'#16a34a', warn:'#d97706' }[type] || '#e8490f';
    b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;background:${bg};
      color:#fff;font-family:-apple-system,sans-serif;font-size:13px;font-weight:500;
      padding:10px 16px;display:flex;align-items:center;gap:10px;
      box-shadow:0 3px 12px rgba(0,0,0,.25);`;
    b.innerHTML = `🍽️ <strong>FoodFluencer</strong> &nbsp;·&nbsp; ${html}
      <button onclick="this.parentNode.remove()" style="margin-left:auto;background:rgba(255,255,255,.25);
      border:none;color:#fff;border-radius:5px;padding:3px 9px;cursor:pointer;">✕</button>`;
    document.body.prepend(b);
  }

  (async () => {
    banner('Opening post composer…');

    // 1 ── Click "What's on your mind?" to open the composer
    const triggerSelectors = [
      '[aria-placeholder="What\'s on your mind?"]',
      '[placeholder="What\'s on your mind?"]',
      '[role="button"][tabindex="0"] span',
    ];
    let trigger = null;
    for (const sel of triggerSelectors) {
      trigger = document.querySelector(sel); if (trigger) break;
    }
    // Fallback: find by text
    if (!trigger) {
      trigger = [...document.querySelectorAll('[role="button"]')]
        .find(el => el.textContent.includes("What's on your mind"));
    }
    if (trigger) { trigger.click(); await sleep(1200); }
    else { banner('Could not open post composer — click <strong>"What\'s on your mind?"</strong> manually.', 'warn'); return; }

    // 2 ── Click the Photo/Video button inside the composer dialog
    await sleep(600);
    let photoBtn = document.querySelector('[aria-label="Photo/video"]');
    if (!photoBtn) {
      photoBtn = [...document.querySelectorAll('[role="button"]')]
        .find(el => /photo.*video|video.*photo/i.test(el.getAttribute('aria-label') || el.textContent));
    }
    if (photoBtn) { photoBtn.click(); await sleep(900); }

    // 3 ── Inject the file into the file input that Facebook reveals
    const fileInput = await waitFor('input[type="file"]', 6000);
    if (!fileInput) { banner('Photo input not found — click <strong>Photo/Video</strong> and select from Downloads/FoodFluencer.', 'warn'); return; }
    setFileOnInput(fileInput, dataUrlToFile(photoDataUrl, 'restaurant.jpg'));
    banner('Photo uploaded — filling caption…');
    await sleep(2000);

    // 4 ── Fill the caption / "What's on your mind?" text area inside the open dialog
    const captionSelectors = [
      '[contenteditable="true"][aria-placeholder]',
      '[contenteditable="true"][role="textbox"]',
      '[data-testid="status-attachment-mentions-input"]',
    ];
    let captionBox = null;
    for (const sel of captionSelectors) {
      // Prefer the one inside the modal/dialog
      const boxes = document.querySelectorAll(sel);
      for (const box of boxes) {
        if (box.closest('[role="dialog"]') || box.closest('[aria-modal]')) {
          captionBox = box; break;
        }
      }
      if (!captionBox) captionBox = document.querySelector(sel);
      if (captionBox) break;
    }
    if (captionBox) {
      captionBox.focus(); await sleep(200);
      // Select all existing placeholder text and replace
      const range = document.createRange();
      range.selectNodeContents(captionBox);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      document.execCommand('insertText', false, caption);
    }

    await sleep(400);
    const songHint = songName ? `&nbsp; 🎵 Add <em>"${songName}"</em> via <strong>Feeling/Activity → Music</strong>.` : '';
    banner(`✅ Photo &amp; caption ready!${songHint} &nbsp; Click <strong>Post</strong> to publish.`, 'success');
  })();
}

// ─── Instagram ────────────────────────────────────────────────────────────────

function injectInstagram(photoDataUrl, caption, songName) {
  const sleep   = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = (sel, ms = 8000) => new Promise(res => {
    const el = document.querySelector(sel); if (el) return res(el);
    const t  = Date.now();
    const iv = setInterval(() => {
      const e = document.querySelector(sel);
      if (e)              { clearInterval(iv); res(e); }
      else if (Date.now() - t > ms) { clearInterval(iv); res(null); }
    }, 250);
  });

  function dataUrlToFile(url, name) {
    const [hdr, b64] = url.split(',');
    const mime = hdr.match(/:(.*?);/)[1];
    const bin  = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: mime });
  }

  function setFileOnInput(input, file) {
    const dt = new DataTransfer(); dt.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
    if (setter) setter.call(input, dt.files); else input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input',  { bubbles: true }));
  }

  function banner(html, type = 'info') {
    document.getElementById('ffbot-banner')?.remove();
    const b = document.createElement('div'); b.id = 'ffbot-banner';
    const bg = { info:'#e8490f', success:'#16a34a', warn:'#d97706' }[type] || '#e8490f';
    b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;background:${bg};
      color:#fff;font-family:-apple-system,sans-serif;font-size:13px;font-weight:500;
      padding:10px 16px;display:flex;align-items:center;gap:10px;
      box-shadow:0 3px 12px rgba(0,0,0,.25);`;
    b.innerHTML = `🍽️ <strong>FoodFluencer</strong> &nbsp;·&nbsp; ${html}
      <button onclick="this.parentNode.remove()" style="margin-left:auto;background:rgba(255,255,255,.25);
      border:none;color:#fff;border-radius:5px;padding:3px 9px;cursor:pointer;">✕</button>`;
    document.body.prepend(b);
  }

  function clickNext() {
    const btn = [...document.querySelectorAll('[role="button"]')]
      .find(el => el.textContent.trim() === 'Next');
    if (btn) { btn.click(); return true; }
    return false;
  }

  (async () => {
    banner('Opening Instagram post creator…');
    await sleep(2000);

    // 1 ── Find the file input (Instagram's /create/select/ page exposes one)
    let fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) {
      // Try clicking "Select from computer" button
      const selBtn = [...document.querySelectorAll('[role="button"]')]
        .find(el => /select.*computer|from computer/i.test(el.textContent));
      if (selBtn) { selBtn.click(); await sleep(600); }
      fileInput = document.querySelector('input[type="file"]');
    }

    if (!fileInput) {
      banner('Select your photo from <strong>Downloads/FoodFluencer</strong> in the dialog.', 'warn');
      return;
    }

    setFileOnInput(fileInput, dataUrlToFile(photoDataUrl, 'restaurant.jpg'));
    banner('Photo selected — advancing through editor…');
    await sleep(2200);

    // 2 ── Click through Crop step → Next
    clickNext(); await sleep(1400);

    // 3 ── Click through Filter/Edit step → Next
    clickNext(); await sleep(1400);

    // 4 ── We should now be on the Caption / Details screen
    const captionArea = await waitFor(
      'textarea[aria-label="Write a caption..."], textarea[placeholder*="caption" i], textarea[placeholder*="Caption" i]',
      5000
    );
    if (captionArea) {
      captionArea.focus(); await sleep(200);
      // Use native setter so React picks it up
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(captionArea, caption);
      else captionArea.value = caption;
      captionArea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // 5 ── Try to open the music picker for Reels if a song was selected
    if (songName) {
      await sleep(600);
      const musicBtn = [...document.querySelectorAll('[role="button"]')]
        .find(el => /add music|music/i.test(el.getAttribute('aria-label') || el.textContent));
      if (musicBtn) {
        musicBtn.click(); await sleep(1000);
        const searchInput = document.querySelector('input[placeholder*="Search" i], input[type="search"]');
        if (searchInput) {
          searchInput.focus();
          searchInput.value = songName;
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(1500);
          // Select the first result
          const firstTrack = document.querySelector('[class*="MusicItem"], [class*="music_item"], [class*="track"]');
          if (firstTrack) firstTrack.click();
        }
      }
    }

    await sleep(400);
    const songHint = songName
      ? `&nbsp; 🎵 Search for <em>"${songName}"</em> in <strong>Add music</strong> if not auto-selected.`
      : '';
    banner(`✅ Caption filled!${songHint} &nbsp; Click <strong>Share</strong> to publish.`, 'success');
  })();
}

// ─── TikTok ───────────────────────────────────────────────────────────────────

function injectTikTok(photoDataUrl, caption, songName) {
  const sleep   = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = (sel, ms = 10000) => new Promise(res => {
    const el = document.querySelector(sel); if (el) return res(el);
    const t  = Date.now();
    const iv = setInterval(() => {
      const e = document.querySelector(sel);
      if (e)              { clearInterval(iv); res(e); }
      else if (Date.now() - t > ms) { clearInterval(iv); res(null); }
    }, 300);
  });

  function dataUrlToFile(url, name) {
    const [hdr, b64] = url.split(',');
    const mime = hdr.match(/:(.*?);/)[1];
    const bin  = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: mime });
  }

  function setFileOnInput(input, file) {
    const dt = new DataTransfer(); dt.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
    if (setter) setter.call(input, dt.files); else input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input',  { bubbles: true }));
  }

  function banner(html, type = 'info') {
    document.getElementById('ffbot-banner')?.remove();
    const b = document.createElement('div'); b.id = 'ffbot-banner';
    const bg = { info:'#e8490f', success:'#16a34a', warn:'#d97706' }[type] || '#e8490f';
    b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;background:${bg};
      color:#fff;font-family:-apple-system,sans-serif;font-size:13px;font-weight:500;
      padding:10px 16px;display:flex;align-items:center;gap:10px;
      box-shadow:0 3px 12px rgba(0,0,0,.25);`;
    b.innerHTML = `🍽️ <strong>FoodFluencer</strong> &nbsp;·&nbsp; ${html}
      <button onclick="this.parentNode.remove()" style="margin-left:auto;background:rgba(255,255,255,.25);
      border:none;color:#fff;border-radius:5px;padding:3px 9px;cursor:pointer;">✕</button>`;
    document.body.prepend(b);
  }

  (async () => {
    banner('Opening TikTok upload…');

    // 1 ── Wait for file input on the upload page
    const fileInput = await waitFor('input[type="file"]', 10000);
    if (!fileInput) { banner('Upload area not found — refresh TikTok and try again.', 'warn'); return; }

    setFileOnInput(fileInput, dataUrlToFile(photoDataUrl, 'restaurant.jpg'));
    banner('Photo uploading…');
    await sleep(3500);  // TikTok needs time to process the upload

    // 2 ── Fill the description / caption
    const descSelectors = [
      '.public-DraftEditor-content',
      '[contenteditable="true"][data-text]',
      '[class*="editor"][contenteditable="true"]',
      'div[contenteditable="true"]',
    ];
    let descBox = null;
    for (const sel of descSelectors) {
      descBox = document.querySelector(sel);
      if (descBox) break;
    }
    if (descBox) {
      descBox.focus(); await sleep(200);
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, caption);
    }

    // 3 ── Add sound / music
    if (songName) {
      await sleep(800);
      const soundBtnSelectors = [
        'button[class*="sound"]',
        '[class*="add-sound"]',
        'button[aria-label*="sound" i]',
        'button[aria-label*="music" i]',
      ];
      let soundBtn = null;
      for (const sel of soundBtnSelectors) {
        soundBtn = document.querySelector(sel); if (soundBtn) break;
      }
      // Text-based fallback
      if (!soundBtn) {
        soundBtn = [...document.querySelectorAll('button, [role="button"]')]
          .find(el => /add sound|add music/i.test(el.textContent || el.getAttribute('aria-label')));
      }
      if (soundBtn) {
        soundBtn.click(); await sleep(1200);
        const musicSearch = document.querySelector('input[placeholder*="Search" i], input[type="search"]');
        if (musicSearch) {
          musicSearch.focus();
          musicSearch.value = songName;
          musicSearch.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(1800);
          // Click first search result
          const firstResult = document.querySelector(
            '[class*="music-item"]:first-child, [class*="sound-item"]:first-child, [class*="MusicItem"]:first-child'
          );
          if (firstResult) { firstResult.click(); await sleep(500); }
        }
      }
    }

    const songHint = songName
      ? `&nbsp; 🎵 <em>"${songName}"</em> searched in Add Sound.`
      : '';
    banner(`✅ Photo &amp; caption ready!${songHint} &nbsp; Click <strong>Post</strong> to publish.`, 'success');
  })();
}

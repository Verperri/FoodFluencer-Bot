// Validates each step of the Instagram posting injector (`injectInstagram` in
// background.js, run in MAIN world on instagram.com by `handleSocialPost`).
//
// Instagram's real upload flow is a multi-screen SPA (create menu → upload →
// crop → filter → caption/details → share), so the fixture below wires click
// handlers that swap in the next screen's markup, mirroring that progression
// closely enough for the injector's element-finding/retry logic to drive itself
// all the way through. Each `describe` block then asserts on the artifact that
// step is responsible for (button clicked, files injected, text filled, …).

const { INJECTORS } = require('../../background');
const { photoDataUrls, runTimersInSteps } = require('../helpers/fixtures');

const injectInstagram = INJECTORS.instagram;

function bannerMsg() {
  return document.getElementById('ffbot-msg')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
}

function clickable(el, onClick) {
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.addEventListener('click', onClick);
  return el;
}

function makeNextBtn(label = 'Next') {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.getBoundingClientRect = () => ({ top: 40, width: 80, height: 32 });
  return btn;
}

// Builds the Instagram SPA fixture. `omit` lets individual tests strip out the
// element a given step depends on, to exercise that step's failure/guidance path.
function buildFixture({ omit = new Set(), restaurantName = '', withLocation = true, withCollab = true, withSong = false, autoPost = false } = {}) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('role', 'main');
  document.body.appendChild(root);

  // ── Screen 1: feed with the "+" Create button ─────────────────────────────
  if (!omit.has('create')) {
    const createBtn = document.createElement('a');
    createBtn.setAttribute('aria-label', 'New post');
    clickable(createBtn, () => showCreateMenu());
    root.appendChild(createBtn);
  }

  function showCreateMenu() {
    if (omit.has('postOption')) return;
    const menu = document.createElement('div');
    menu.setAttribute('role', 'dialog');
    const postItem = document.createElement('span');
    postItem.textContent = 'Post';
    clickable(postItem, () => { menu.remove(); showUploadDialog(); });
    menu.appendChild(postItem);
    root.appendChild(menu);
  }

  let dialog;
  function showUploadDialog() {
    dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    if (!omit.has('fileInput')) {
      const input = document.createElement('input');
      input.type = 'file';
      input.addEventListener('change', () => showCropScreen());
      dialog.appendChild(input);
    }
    root.appendChild(dialog);
  }

  // `reactClick()` fires both synthetic mouse events AND a native `.click()`,
  // so the listener below would otherwise run twice per "press" — guard it.
  function onceClickable(el, onClick) {
    let fired = false;
    clickable(el, () => { if (fired) return; fired = true; onClick(); });
    return el;
  }

  function showCropScreen() {
    if (omit.has('cropNext')) return;
    const next = makeNextBtn();
    onceClickable(next, () => { next.remove(); showFilterScreen(); });
    dialog.appendChild(next);
  }
  function showFilterScreen() {
    if (omit.has('filterNext')) return;
    const next = makeNextBtn();
    onceClickable(next, () => { next.remove(); showCaptionScreen(); });
    dialog.appendChild(next);
  }

  function showCaptionScreen() {
    if (!omit.has('captionBox')) {
      const ta = document.createElement('textarea');
      ta.setAttribute('aria-label', 'Write a caption...');
      ta.getBoundingClientRect = () => ({ top: 100, width: 300, height: 100 });
      dialog.appendChild(ta);
    }
    if (withLocation && !omit.has('locationTrigger')) {
      const loc = document.createElement('div');
      loc.setAttribute('aria-label', 'Add location');
      clickable(loc, () => showLocationSearch());
      dialog.appendChild(loc);
    }
    if (withCollab && !omit.has('collabTrigger')) {
      const collab = document.createElement('div');
      collab.textContent = 'Invite collaborators';
      clickable(collab, () => showCollabSearch());
      dialog.appendChild(collab);
    }
    if (autoPost && !omit.has('shareBtn')) {
      const share = makeNextBtn('Share');
      share.shareClickCount = 0;
      // `reactClick()` fires synthetic mouse events AND a native `.click()` —
      // count rather than assert "called once" so both are tolerated.
      share.addEventListener('click', () => { share.shareClickCount += 1; });
      dialog.appendChild(share);
    }
  }

  function showLocationSearch() {
    const input = document.createElement('input');
    input.placeholder = 'Search';
    input.addEventListener('input', () => {
      if (input.value.length >= 3 && !omit.has('locationResult')) showLocationResults();
    });
    dialog.appendChild(input);
  }
  function showLocationResults() {
    if (document.querySelector('[role="option"].location-result')) return;
    const opt = document.createElement('div');
    opt.setAttribute('role', 'option');
    opt.className = 'location-result';
    opt.textContent = 'Brussels, Belgium';
    opt.getBoundingClientRect = () => ({ top: 200, width: 200, height: 40 });
    clickable(opt, () => {});
    dialog.appendChild(opt);
  }

  function showCollabSearch() {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search';
    input.addEventListener('input', () => {
      if (input.value.length >= 3 && !omit.has('collabResult')) showCollabResults();
    });
    dialog.appendChild(input);
  }
  function showCollabResults() {
    if (document.querySelector('[role="option"].collab-result')) return;
    const opt = document.createElement('div');
    opt.setAttribute('role', 'option');
    opt.className = 'collab-result';
    // Matches the slugified `restaurantName` so the injector treats it as a hit.
    opt.textContent = restaurantName.replace(/[^\w\s]/g, ' ').trim().slice(0, 25);
    opt.getBoundingClientRect = () => ({ top: 220, width: 200, height: 40 });
    clickable(opt, () => {});
    dialog.appendChild(opt);
  }

  return { get dialog() { return dialog; } };
}

beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = '';
  // The injector types into location/collaborator search inputs (and fills
  // contenteditable captions) via `execCommand('insertText', …)`. jsdom's stub
  // is a no-op, so mirror real browser behaviour by mutating the focused
  // element — input/textarea get their `.value` updated, contenteditable gets
  // its `textContent` appended (collapsing on selectAll/delete first).
  jest.spyOn(document, 'execCommand').mockImplementation((cmd, _ui, value) => {
    const el = document.activeElement;
    if (!el) return true;
    if (cmd === 'selectAll' || cmd === 'delete') {
      if ('value' in el) el.value = '';
      else if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') el.textContent = '';
      return true;
    }
    if (cmd === 'insertText') {
      if ('value' in el) {
        el.value = value === '' ? '' : (el.value || '') + value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') {
        el.textContent = (el.textContent || '') + value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    return true;
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('Instagram injector — step 1: open the upload dialog from the Create menu', () => {
  test('clicks the "+" Create button, then "Post" from the menu, and waits for the dialog', async () => {
    buildFixture();
    injectInstagram(photoDataUrls(2), 'caption', null, null, { restaurantName: 'Chez Test' });
    await runTimersInSteps(8000);

    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });

  test('shows manual guidance when the Create button cannot be found', async () => {
    buildFixture({ omit: new Set(['create']) });
    injectInstagram(photoDataUrls(1), 'caption', null, null, {});
    await runTimersInSteps(9000);

    expect(bannerMsg()).toMatch(/could not find the.*create button/i);
  });
});

describe('Instagram injector — step 2: apply cover overlay & inject photos', () => {
  test('uploads one File per photo, naming them sequentially', async () => {
    buildFixture({ restaurantName: 'Chez Test' });
    injectInstagram(photoDataUrls(3), 'caption', null, null, { restaurantName: 'Chez Test' });
    await runTimersInSteps(15000);

    const input = document.querySelector('input[type="file"]');
    expect(input.files).toHaveLength(3);
    expect([...input.files].map((f) => f.name)).toEqual([
      'restaurant-1.jpg', 'restaurant-2.jpg', 'restaurant-3.jpg',
    ]);
  });
});

describe('Instagram injector — steps 3 & 4: advance past crop and filter screens', () => {
  test('clicks through both "Next" steps to reach the caption screen', async () => {
    buildFixture({ restaurantName: 'Chez Test' });
    injectInstagram(photoDataUrls(1), 'caption', null, null, { restaurantName: 'Chez Test' });
    await runTimersInSteps(20000);

    // Both transitional "Next" buttons are gone and the caption textarea is present.
    expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Next')).toBe(false);
    expect(document.querySelector('textarea[aria-label="Write a caption..."]')).not.toBeNull();
  });
});

describe('Instagram injector — step 5: fill the caption', () => {
  test('writes the caption into the textarea', async () => {
    buildFixture({ restaurantName: 'Chez Test', withLocation: false, withCollab: false });
    injectInstagram(photoDataUrls(1), 'A delicious caption 🍝', null, null, { restaurantName: 'Chez Test' });
    await runTimersInSteps(25000);

    const ta = document.querySelector('textarea[aria-label="Write a caption..."]');
    expect(ta.value).toBe('A delicious caption 🍝');
  });
});

describe('Instagram injector — step 6: add location', () => {
  test('opens the location picker, searches the city, and selects the first result', async () => {
    buildFixture({ restaurantName: 'Chez Test', withCollab: false });
    injectInstagram(photoDataUrls(1), 'caption', null, '1000 Brussels, Belgium', { restaurantName: 'Chez Test' });
    await runTimersInSteps(35000);

    expect(document.querySelector('[aria-label="Add location"]')).not.toBeNull(); // trigger was found & opened
    expect(document.querySelector('[role="option"].location-result')).not.toBeNull();
    expect(bannerMsg()).toMatch(/location set/i);
  });

  test('skips gracefully and logs when no location results are found', async () => {
    buildFixture({ restaurantName: 'Chez Test', withCollab: false, omit: new Set(['locationResult']) });
    injectInstagram(photoDataUrls(1), 'caption', null, '1000 Brussels, Belgium', { restaurantName: 'Chez Test' });
    await runTimersInSteps(35000);

    expect(document.querySelector('[role="option"].location-result')).toBeNull();
    expect(bannerMsg()).not.toMatch(/location set/i);
  });
});

describe('Instagram injector — step 7: tag the restaurant as a collaborator', () => {
  test('searches for the restaurant and selects a matching account', async () => {
    buildFixture({ restaurantName: 'Chez Test', withLocation: false });
    injectInstagram(photoDataUrls(1), 'caption', null, null, { restaurantName: 'Chez Test' });
    await runTimersInSteps(40000);

    expect(bannerMsg()).toMatch(/collaborator.*chez test.*added/i);
  });

  test('reports no match when the search returns nothing relevant', async () => {
    buildFixture({ restaurantName: 'Chez Test', withLocation: false, omit: new Set(['collabResult']) });
    injectInstagram(photoDataUrls(1), 'caption', null, null, { restaurantName: 'Chez Test' });
    await runTimersInSteps(40000);

    expect(bannerMsg()).toMatch(/no instagram account found for.*chez test/i);
  });
});

describe('Instagram injector — step 8: finalize (auto-post vs. manual hand-off)', () => {
  test('auto mode finds and clicks Share, then dispatches __ffbot_complete', async () => {
    const fixture = buildFixture({ restaurantName: 'Chez Test', withLocation: false, withCollab: false, autoPost: true });
    const onComplete = jest.fn();
    document.addEventListener('__ffbot_complete', onComplete);

    injectInstagram(photoDataUrls(1), 'caption', null, null, { restaurantName: 'Chez Test', autoPost: true });
    await runTimersInSteps(75000);

    const shareBtn = fixture.dialog.querySelector('button');
    expect(shareBtn.shareClickCount).toBeGreaterThan(0);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].detail).toEqual({ platform: 'instagram' });
    // jsdom doesn't implement `innerText`, so the page-text confirmation check
    // always misses and the injector falls back to its "optimistic success" banner.
    expect(bannerMsg()).toMatch(/posted to instagram/i);
  });

  test('auto mode dispatches __ffbot_failed when the Share button is missing', async () => {
    buildFixture({ restaurantName: 'Chez Test', withLocation: false, withCollab: false, autoPost: true, omit: new Set(['shareBtn']) });
    const onFailed = jest.fn();
    document.addEventListener('__ffbot_failed', onFailed);

    injectInstagram(photoDataUrls(1), 'caption', null, null, { restaurantName: 'Chez Test', autoPost: true });
    await runTimersInSteps(60000);

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0][0].detail).toEqual({ platform: 'instagram', error: 'Share button not found' });
  });

  test('manual mode hands off to the user with a song hint and does not auto-share', async () => {
    buildFixture({ restaurantName: 'Chez Test', withLocation: false, withCollab: false });
    const onComplete = jest.fn();
    document.addEventListener('__ffbot_complete', onComplete);

    injectInstagram(photoDataUrls(1), 'caption', 'Some Song', null, { restaurantName: 'Chez Test', autoPost: false });
    await runTimersInSteps(60000);

    expect(onComplete).not.toHaveBeenCalled();
    expect(bannerMsg()).toMatch(/add music.*some song/i);
    expect(bannerMsg()).toMatch(/click.*share.*to publish/i);
  });
});

// Validates each step of the TikTok posting injector (`injectTikTok` in
// background.js, run in MAIN world on tiktok.com/upload by `handleSocialPost`).
//
// TikTok's flow is the most involved of the three (it builds an H.264 MP4
// client-side via WebCodecs before uploading), so `test/setup/webcodecs-mock.js`
// stubs the encoder/canvas APIs to let the build step finish quickly. The
// fixture below then mirrors TikTok Studio's screens closely enough for the
// injector's selectors and verification heuristics to drive themselves through
// upload → description → location → post.

const { INJECTORS } = require('../../background');
const { photoDataUrls, runTimersInSteps } = require('../helpers/fixtures');

const injectTikTok = INJECTORS.tiktok;

function tiktokSteps(events) {
  return events.filter((e) => e.detail.type === 'TIKTOK_STEP').map((e) => e.detail.step);
}

function clickable(el, onClick) {
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.getBoundingClientRect = () => ({ top: 50, width: 120, height: 36 });
  el.addEventListener('click', onClick);
  return el;
}

function buildFixture({ omit = new Set(), withLocationResult = true } = {}) {
  document.body.innerHTML = '';

  const input = document.createElement('input');
  input.type = 'file';
  document.body.appendChild(input);

  let descBox;
  let postBtn;

  function showProcessedScreen() {
    descBox = document.createElement('div');
    descBox.setAttribute('contenteditable', 'true');
    descBox.setAttribute('data-e2e', 'caption-edit');
    descBox.setAttribute('data-placeholder', 'Add a description...');
    descBox.getBoundingClientRect = () => ({ top: 80, width: 400, height: 120 });
    // Mirrors a Lexical/Slate-style editor: a real `paste` event lands the text.
    descBox.addEventListener('paste', (e) => {
      descBox.textContent = e.clipboardData.getData('text/plain');
    });
    document.body.appendChild(descBox);

    if (!omit.has('locationTrigger')) {
      const locTrigger = document.createElement('div');
      locTrigger.setAttribute('data-e2e', 'location-add');
      locTrigger.textContent = 'Add location';
      locTrigger.getBoundingClientRect = () => ({ top: 220, width: 200, height: 36 });
      clickable(locTrigger, () => showLocationSearch(locTrigger));
      document.body.appendChild(locTrigger);
    }

    postBtn = document.createElement('button');
    postBtn.setAttribute('data-e2e', 'btn-post');
    postBtn.textContent = 'Post';
    postBtn.clickCount = 0;
    postBtn.addEventListener('click', () => { postBtn.clickCount += 1; });
    postBtn.getBoundingClientRect = () => ({ top: 300, width: 100, height: 40 });
    document.body.appendChild(postBtn);
  }

  function showLocationSearch(trigger) {
    const input2 = document.createElement('input');
    input2.placeholder = 'Search for a location';
    input2.addEventListener('input', () => {
      if (input2.value.length >= 3 && withLocationResult && !document.querySelector('[role="option"].loc-result')) {
        const opt = document.createElement('div');
        opt.setAttribute('role', 'option');
        opt.className = 'loc-result';
        opt.textContent = 'Chez Test, Brussels';
        opt.getBoundingClientRect = () => ({ top: 260, width: 200, height: 36 });
        opt.addEventListener('click', () => {
          trigger.textContent = 'Chez Test, Brussels';
          trigger.setAttribute('data-e2e', 'location-selected');
        });
        // The injector's selector requires `:first-child`; insert at the front
        // of <body> rather than appending so it actually matches.
        document.body.insertBefore(opt, document.body.firstChild);
      }
    });
    document.body.appendChild(input2);
  }

  // Simulates TikTok swapping the upload zone for the editor once it has
  // "processed" the injected video.
  input.addEventListener('change', () => {
    if (!omit.has('processedScreen')) setTimeout(showProcessedScreen, 4500);
  });

  return {
    get descBox() { return descBox; },
    get postBtn() { return postBtn; },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = '';
  // `execCommand('insertText', …)` drives the location-search typing; mirror a
  // real text input by mutating `document.activeElement.value`.
  jest.spyOn(document, 'execCommand').mockImplementation((cmd, _ui, value) => {
    const el = document.activeElement;
    if (!el) return true;
    const editable = el.isContentEditable || el.getAttribute?.('contenteditable') === 'true';
    if (cmd === 'selectAll' || cmd === 'delete') {
      if ('value' in el) el.value = '';
      else if (editable) el.textContent = '';
      return true;
    }
    if (cmd === 'insertText') {
      if ('value' in el) {
        el.value = value === '' ? '' : (el.value || '') + value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (editable) {
        el.textContent = (el.textContent || '') + value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    return true;
  });

  // Simulates the background-side relay for requestBackground(). The CDP
  // file-injection strategy isn't reachable in this jsdom environment (no
  // chrome.debugger), so respond as background.js would if the debugger
  // permission/attach failed — letting the injector fall through to its
  // DataTransfer strategy, just as it would in a real browser without CDP.
  document.addEventListener('__ffbot_event', (e) => {
    const { requestId, type } = e.detail || {};
    if (!requestId) return;
    if (type === 'INJECT_FILE_CDP') {
      document.dispatchEvent(new CustomEvent(`__ffbot_response_${requestId}`, {
        detail: { ok: false, error: 'chrome.debugger unavailable in test environment' },
      }));
    }
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('TikTok injector — step 1: build the H.264 slideshow video', () => {
  test('produces an MP4 File and reports build_video_done', async () => {
    const events = [];
    document.addEventListener('__ffbot_event', (e) => events.push(e));
    buildFixture();

    injectTikTok(photoDataUrls(2), 'caption', null, null, { restaurantName: 'Chez Test', autoPost: false });
    await runTimersInSteps(15000);

    expect(tiktokSteps(events)).toEqual(expect.arrayContaining(['build_video_start', 'build_video_done']));
  });

  test('reports build_video_failed when WebCodecs is unavailable', async () => {
    const realEncoder = global.VideoEncoder;
    delete global.VideoEncoder; // simulates a browser without WebCodecs support
    const events = [];
    document.addEventListener('__ffbot_event', (e) => events.push(e));
    buildFixture();

    injectTikTok(photoDataUrls(1), 'caption', null, null, { restaurantName: 'Chez Test', autoPost: false });
    await runTimersInSteps(10000);

    expect(tiktokSteps(events)).toContain('build_video_failed');
    expect(document.querySelector('input[type="file"]').files).toHaveLength(0);
    global.VideoEncoder = realEncoder;
  });
});

describe('TikTok injector — step 2 & 3: inject the video and confirm TikTok accepted it', () => {
  test('injects the built MP4 into the upload input and detects acceptance', async () => {
    const events = [];
    document.addEventListener('__ffbot_event', (e) => events.push(e));
    buildFixture();

    injectTikTok(photoDataUrls(1), 'caption', null, null, { restaurantName: 'Chez Test', autoPost: false });
    await runTimersInSteps(25000);

    const input = document.querySelector('input[type="file"]');
    expect(input.files).toHaveLength(1);
    expect(input.files[0].type).toBe('video/mp4');
    expect(input.files[0].name).toBe('tiktok-post.mp4');
    expect(tiktokSteps(events)).toEqual(expect.arrayContaining(['inject_file', 'upload_accepted']));
  });

  test('reports find_file_input_failed when the upload zone never appears', async () => {
    document.body.innerHTML = ''; // no <input type="file">
    const events = [];
    document.addEventListener('__ffbot_event', (e) => events.push(e));

    injectTikTok(photoDataUrls(1), 'caption', null, null, { restaurantName: 'Chez Test', autoPost: false });
    await runTimersInSteps(20000);

    expect(tiktokSteps(events)).toContain('find_file_input_failed');
  });
});

describe('TikTok injector — step 4: fill the description', () => {
  test('lands the caption in the description editor via the paste strategy', async () => {
    const events = [];
    document.addEventListener('__ffbot_event', (e) => events.push(e));
    const fixture = buildFixture();

    injectTikTok(photoDataUrls(1), 'A delicious caption 🍝', null, null, { restaurantName: 'Chez Test', autoPost: false });
    await runTimersInSteps(25000);

    expect(fixture.descBox.textContent).toBe('A delicious caption 🍝');
    expect(tiktokSteps(events)).toEqual(expect.arrayContaining(['fill_description_done']));
    const doneEvent = events.find((e) => e.detail.step === 'fill_description_done');
    // Whichever fill strategy lands first wins (paste is tried first and our
    // fixture's `paste` handler mirrors a real rich-text editor, but the gentler
    // strategies fall through to `execCommand` if jsdom's event support differs).
    expect(doneEvent.detail.detail).toMatch(/via (paste|inputevt|execcmd)/);
  });
});

describe('TikTok injector — step 5: add location', () => {
  test('opens the location search, selects the first result, and verifies the chip attached', async () => {
    const events = [];
    document.addEventListener('__ffbot_event', (e) => events.push(e));
    buildFixture();

    injectTikTok(photoDataUrls(1), 'caption', null, '1000 Brussels, Belgium', { restaurantName: 'Chez Test', autoPost: false });
    await runTimersInSteps(40000);

    expect(document.querySelector('[data-e2e="location-selected"]')?.textContent).toBe('Chez Test, Brussels');
    expect(tiktokSteps(events)).toEqual(expect.arrayContaining(['open_location_search', 'search_location', 'select_location_done']));
  });

  test('reports select_location_failed when the search returns no results', async () => {
    const events = [];
    document.addEventListener('__ffbot_event', (e) => events.push(e));
    buildFixture({ withLocationResult: false });

    injectTikTok(photoDataUrls(1), 'caption', null, '1000 Brussels, Belgium', { restaurantName: 'Chez Test', autoPost: false });
    await runTimersInSteps(40000);

    expect(tiktokSteps(events)).toContain('select_location_failed');
    expect(tiktokSteps(events)).not.toContain('select_location_done');
  });
});

describe('TikTok injector — step 6: finalize (auto-post vs. manual hand-off)', () => {
  test('auto mode clicks Post and dispatches __ffbot_complete once TikTok leaves /upload', async () => {
    const onComplete = jest.fn();
    const onReadyToMinimize = jest.fn();
    document.addEventListener('__ffbot_complete', onComplete);
    document.addEventListener('__ffbot_event', (e) => {
      if (e.detail.type === 'TIKTOK_READY_TO_MINIMIZE') onReadyToMinimize();
    });
    const fixture = buildFixture();

    injectTikTok(photoDataUrls(1), 'caption', null, null, { restaurantName: 'Chez Test', autoPost: true });
    await runTimersInSteps(50000);

    expect(onReadyToMinimize).toHaveBeenCalledTimes(1);
    expect(fixture.postBtn.clickCount).toBeGreaterThan(0);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].detail).toEqual({ platform: 'tiktok' });
  });

  test('auto mode dispatches __ffbot_failed when no Post button can be found', async () => {
    const onFailed = jest.fn();
    document.addEventListener('__ffbot_failed', onFailed);
    document.body.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'file';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      setTimeout(() => {
        const descBox = document.createElement('div');
        descBox.setAttribute('data-e2e', 'caption-edit');
        descBox.setAttribute('data-placeholder', 'Add a description...');
        descBox.setAttribute('contenteditable', 'true');
        descBox.getBoundingClientRect = () => ({ top: 80, width: 400, height: 120 });
        descBox.addEventListener('paste', (e) => { descBox.textContent = e.clipboardData.getData('text/plain'); });
        document.body.appendChild(descBox);
        // Deliberately no Post button.
      }, 4500);
    });

    injectTikTok(photoDataUrls(1), 'caption', null, null, { restaurantName: 'Chez Test', autoPost: true });
    await runTimersInSteps(60000);

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0][0].detail).toMatchObject({ platform: 'tiktok', error: 'Post button not found' });
  });

  test('manual mode leaves the Post click to the user', async () => {
    const onComplete = jest.fn();
    document.addEventListener('__ffbot_complete', onComplete);
    buildFixture();

    injectTikTok(photoDataUrls(1), 'caption', null, null, { restaurantName: 'Chez Test', autoPost: false });
    await runTimersInSteps(30000);

    expect(onComplete).not.toHaveBeenCalled();
    expect(document.getElementById('ffbot-banner')?.textContent).toMatch(/all set.*review.*click.*post/i);
  });
});

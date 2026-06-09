// Validates each step of the Facebook posting injector (`injectFacebook` in
// background.js, run in MAIN world on facebook.com by `handleSocialPost`).
//
// The injector is a single async IIFE, so "steps" are validated by asserting
// on the DOM mutations / banner messages it produces as it progresses, and by
// supplying fixtures that are missing a given step's target element to confirm
// the step reports the right failure/guidance instead of silently continuing.

const { INJECTORS } = require('../../background');
const { photoDataUrls, runTimersInSteps, flushAsync } = require('../helpers/fixtures');

const injectFacebook = INJECTORS.facebook;

function banner() {
  return document.getElementById('ffbot-banner');
}
function bannerText() {
  return banner()?.textContent.replace(/\s+/g, ' ').trim() ?? '';
}

// Builds a fixture that mirrors Facebook's composer → dialog flow closely
// enough for the injector's selectors to find each element.
function buildFixture({ withComposer = true, withPhotoBtn = true, withFileInput = true, withCaptionBox = true, withPostBtn = true } = {}) {
  document.body.innerHTML = '';
  if (withComposer) {
    const composer = document.createElement('div');
    composer.setAttribute('role', 'button');
    composer.setAttribute('aria-placeholder', "What's on your mind?");
    composer.textContent = "What's on your mind?";
    composer.click = jest.fn(() => {
      // Clicking the composer opens the dialog — mirrors FB's real behaviour.
      document.body.appendChild(dialog);
    });
    document.body.appendChild(composer);
  }

  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');

  if (withPhotoBtn) {
    const photoBtn = document.createElement('div');
    photoBtn.setAttribute('role', 'button');
    photoBtn.setAttribute('aria-label', 'Photo/video');
    photoBtn.textContent = 'Photo/video';
    photoBtn.click = jest.fn();
    dialog.appendChild(photoBtn);
  }
  if (withFileInput) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    dialog.appendChild(input);
  }
  if (withCaptionBox) {
    const box = document.createElement('div');
    box.setAttribute('contenteditable', 'true');
    box.setAttribute('aria-placeholder', "What's on your mind?");
    box.setAttribute('role', 'textbox');
    dialog.appendChild(box);
  }
  if (withPostBtn) {
    const post = document.createElement('div');
    post.setAttribute('role', 'button');
    post.setAttribute('aria-label', 'Post');
    post.textContent = 'Post';
    post.click = jest.fn();
    dialog.appendChild(post);
  }
  return dialog;
}

beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = '';
});
afterEach(() => {
  jest.useRealTimers();
});

describe('Facebook injector — step 1: open post composer', () => {
  test('finds the "What\'s on your mind?" trigger and clicks it', async () => {
    const dialog = buildFixture();
    const composer = document.querySelector('[aria-placeholder*="mind" i]');

    injectFacebook(photoDataUrls(2), 'caption', null, null, { autoPost: false });
    await flushAsync();

    expect(composer.click).toHaveBeenCalled();
    expect(document.body.contains(dialog)).toBe(true);
  });

  test('shows manual guidance when no composer trigger can be found', async () => {
    buildFixture({ withComposer: false, withPhotoBtn: false, withFileInput: false, withCaptionBox: false, withPostBtn: false });

    injectFacebook(photoDataUrls(1), 'caption', null, null, { autoPost: false });
    // 5 retries × 1s apart
    await runTimersInSteps(6500);

    expect(bannerText()).toMatch(/could not open composer/i);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('Facebook injector — step 2: open Photo/Video picker', () => {
  test('clicks the Photo/video button after the composer opens', async () => {
    buildFixture();
    injectFacebook(photoDataUrls(2), 'caption', null, null, { autoPost: false });

    await runTimersInSteps(2000); // past the 1600ms post-composer-click sleep
    const photoBtn = document.querySelector('[aria-label="Photo/video"]');
    expect(photoBtn.click).toHaveBeenCalled();
  });
});

describe('Facebook injector — step 3: inject photos into the file input', () => {
  test('sets the expected number of File objects with sequential names', async () => {
    buildFixture();
    const urls = photoDataUrls(3);
    injectFacebook(urls, 'caption', null, null, { autoPost: false });

    await runTimersInSteps(6000);

    const input = document.querySelector('input[type="file"]');
    expect(input.files).toHaveLength(3);
    expect([...input.files].map((f) => f.name)).toEqual([
      'restaurant-1.jpg', 'restaurant-2.jpg', 'restaurant-3.jpg',
    ]);
    expect([...input.files].every((f) => f.type === 'image/jpeg')).toBe(true);
  });

  test('warns when no file input appears', async () => {
    buildFixture({ withFileInput: false, withCaptionBox: false, withPostBtn: false });
    injectFacebook(photoDataUrls(1), 'caption', null, null, { autoPost: false });

    await runTimersInSteps(12000);

    expect(bannerText()).toMatch(/photo input not found/i);
  });
});

describe('Facebook injector — step 4: fill the caption', () => {
  test('inserts the caption text into the contenteditable composer box', async () => {
    buildFixture();
    const execSpy = jest.spyOn(document, 'execCommand').mockReturnValue(true);

    injectFacebook(photoDataUrls(1), 'A delicious caption 🍝', null, null, { autoPost: false });
    await runTimersInSteps(8000);

    const box = document.querySelector('[contenteditable="true"][aria-placeholder]');
    expect(document.activeElement).toBe(box);
    expect(execSpy).toHaveBeenCalledWith('insertText', false, 'A delicious caption 🍝');
  });
});

describe('Facebook injector — step 5: finalize (auto-post vs. manual hand-off)', () => {
  test('auto mode clicks Post and dispatches __ffbot_complete', async () => {
    buildFixture();
    jest.spyOn(document, 'execCommand').mockReturnValue(true);
    const onComplete = jest.fn();
    document.addEventListener('__ffbot_complete', onComplete);

    injectFacebook(photoDataUrls(1), 'caption', null, null, { autoPost: true });
    await runTimersInSteps(11000);

    const postBtn = document.querySelector('[aria-label="Post"]');
    expect(postBtn.click).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].detail).toEqual({ platform: 'facebook' });
    expect(bannerText()).toMatch(/posted to facebook/i);
  });

  test('auto mode dispatches __ffbot_failed when the Post button is missing', async () => {
    buildFixture({ withPostBtn: false });
    jest.spyOn(document, 'execCommand').mockReturnValue(true);
    const onFailed = jest.fn();
    document.addEventListener('__ffbot_failed', onFailed);

    injectFacebook(photoDataUrls(1), 'caption', null, null, { autoPost: true });
    await runTimersInSteps(11000);

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0][0].detail).toEqual({ platform: 'facebook', error: 'Post button not found' });
  });

  test('manual mode with a song shows the "add via Feeling/Activity" hint instead of posting', async () => {
    buildFixture();
    jest.spyOn(document, 'execCommand').mockReturnValue(true);

    injectFacebook(photoDataUrls(1), 'caption', 'Some Song', null, { autoPost: false });
    await runTimersInSteps(8000);

    expect(bannerText()).toMatch(/some song/i);
    expect(bannerText()).toMatch(/feeling\/activity.*music/i);
    const postBtn = document.querySelector('[aria-label="Post"]');
    expect(postBtn.click).not.toHaveBeenCalled();
  });

  test('manual mode without a song tells the user the post is ready to publish', async () => {
    buildFixture();
    jest.spyOn(document, 'execCommand').mockReturnValue(true);

    injectFacebook(photoDataUrls(2), 'caption', null, null, { autoPost: false });
    await runTimersInSteps(8000);

    expect(bannerText()).toMatch(/2 photos & caption ready.*click.*post.*to publish/i);
  });
});

// Tests for the photo near-duplicate detection added to the waterfall
// (background.js): computePhash() builds an 8×8 average-hash from the
// luminance grid that scoreImageQuality already computes, and the waterfall
// rejects a candidate whose hash is within Hamming distance 5 of an
// already-collected photo. Also covers downscaleDataUrl()'s fail-open
// fallback (the waterfall must never lose a photo to a downscale error).
//
// Regression context (v3.0.13 → v3.0.14): the first phash implementation used
// fractional cell bounds (150/8 = 18.75) as array indices, which read
// `undefined`, made every cell mean NaN, and collapsed every photo's hash to
// all-zeros — so all photos after the first were rejected as "duplicates" and
// search results came back with a single, unswappable photo.

let bg;

beforeEach(() => {
  jest.resetModules();
  global.CONFIG = { REGION: 'be', MAX_PHOTOS: 5, TELEMETRY_ENDPOINT: '' };
  const store = { appLog: [] };
  chrome.storage.local.get.mockImplementation((keys, cb) => {
    const result = {};
    Object.keys(keys).forEach(k => { result[k] = store[k] !== undefined ? store[k] : keys[k]; });
    cb && cb(result);
  });
  chrome.storage.local.set.mockImplementation((items, cb) => {
    Object.assign(store, items);
    cb && cb();
  });
  bg = require('../background.js');
});

// Builds a size×size luminance grid from `lum(x, y)` — mirrors the `gray`
// array scoreImageQuality derives from its 150×150 analysis canvas.
function buildGray(size, lum) {
  const gray = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      gray[y * size + x] = lum(x, y);
  return gray;
}

// The exact analysis-canvas size used in production — deliberately NOT a
// multiple of 8, so these tests exercise the fractional-cell-bounds case
// that caused the v3.0.13 regression.
const SIZE = 150;

describe('computePhash', () => {
  test('produces a valid 64-bit binary hash at the production canvas size (150 is not divisible by 8)', () => {
    const gray = buildGray(SIZE, x => (x / SIZE) * 255); // horizontal gradient
    const hash = bg.computePhash(gray, SIZE);

    expect(hash).not.toBeNull();
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[01]+$/);
    // Regression: NaN-poisoned means produced an all-zeros hash.
    expect(hash).toContain('1');
    expect(hash).toContain('0');
  });

  test('two structurally different images hash far apart', () => {
    const gradient = buildGray(SIZE, x => (x / SIZE) * 255);
    const stripes  = buildGray(SIZE, (x, y) => ((x + y) % 30 < 15 ? 40 : 220));

    const d = bg.phashDistance(bg.computePhash(gradient, SIZE), bg.computePhash(stripes, SIZE));
    expect(d).toBeGreaterThan(5); // must NOT be treated as duplicates
  });

  test('the same image with mild recompression noise hashes within the duplicate threshold', () => {
    // Deterministic pseudo-noise (±3 luminance) — what a JPEG re-encode of the
    // same photo at a different quality/size looks like to the hash.
    const noise = (x, y) => ((x * 31 + y * 17) % 7) - 3;
    const original  = buildGray(SIZE, (x, y) => (x / SIZE) * 200 + (y / SIZE) * 55);
    const recompressed = buildGray(SIZE, (x, y) => (x / SIZE) * 200 + (y / SIZE) * 55 + noise(x, y));

    const d = bg.phashDistance(bg.computePhash(original, SIZE), bg.computePhash(recompressed, SIZE));
    expect(d).toBeLessThanOrEqual(5); // MUST be treated as duplicates
  });

  test('a flat (degenerate) image returns null so it can never reject the rest of the pool', () => {
    const flat = buildGray(SIZE, () => 128);
    expect(bg.computePhash(flat, SIZE)).toBeNull();
  });

  test('NaN-tainted luminance data returns null instead of an everything-matches hash', () => {
    const gray = buildGray(SIZE, x => (x / SIZE) * 255);
    gray[0] = NaN;
    expect(bg.computePhash(gray, SIZE)).toBeNull();
  });
});

describe('phashDistance', () => {
  test('counts differing bits', () => {
    expect(bg.phashDistance('0000', '0000')).toBe(0);
    expect(bg.phashDistance('0000', '1111')).toBe(4);
    expect(bg.phashDistance('1010', '1001')).toBe(2);
  });
});

describe('scoreImageQuality phash integration', () => {
  test('the scoring-failure fallback carries phash: null (photo passes, dedup disabled)', async () => {
    // jsdom has no OffscreenCanvas — scoreImageQuality's catch path must let
    // the photo through without a hash rather than rejecting it.
    expect(typeof OffscreenCanvas).toBe('undefined');

    const result = await bg.scoreImageQuality('data:image/png;base64,fake');
    expect(result.passed).toBe(true);
    expect(result.phash).toBeNull();
  });
});

describe('downscaleDataUrl', () => {
  test('fails open: returns the input unchanged when canvas decoding is unavailable', async () => {
    // In the service worker a failure mid-downscale (decode error, odd format)
    // must never cost us the photo — the original data URL is the fallback.
    const input = 'data:image/jpeg;base64,notreallyanimage';
    await expect(bg.downscaleDataUrl(input)).resolves.toBe(input);
  });
});

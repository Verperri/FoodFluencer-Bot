// Tests for the content-appeal heuristics added to the photo-quality pipeline
// (background.js): computeAppealMetrics() scores colorfulness, warmth and
// center-focus to proxy how engaging a candidate photo looks, and
// scoreImageQuality() blends that into `rankScore` alongside the existing
// technical-quality checks. The waterfall uses `rankScore` to keep the most
// engaging photos from an over-collected pool (see appeal-ranking notes in
// background.js around `poolTarget`).

let bg;

beforeEach(() => {
  jest.resetModules();
  global.CONFIG = { REGION: 'be', MAX_PHOTOS: 5, TELEMETRY_ENDPOINT: '' };
  // bgLog() (used on the scoreImageQuality error fallback path) reads/writes
  // appLog via chrome.storage.local — back it with an in-memory store so
  // `appLog.push(...)` doesn't blow up on the default `{}` mock result.
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

// Builds a synthetic W×H RGBA frame plus its greyscale luminance array.
// `pixel(x, y)` returns { r, g, b } for each pixel.
function buildFrame(W, H, pixel) {
  const data = new Uint8ClampedArray(W * H * 4);
  const gray = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const { r, g, b } = pixel(x, y);
      data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  return { data, gray };
}

describe('computeAppealMetrics', () => {
  test('a flat grey image scores neutral warmth/colorfulness and centerFocus = 1', () => {
    const { data, gray } = buildFrame(10, 10, () => ({ r: 128, g: 128, b: 128 }));
    const m = bg.computeAppealMetrics(data, gray, 10, 10);

    expect(m.colorfulness).toBe(0);
    expect(m.warmth).toBe(0);
    expect(m.centerFocus).toBe(1); // outerDensity is 0 → defaults to 1
    // warmthNorm = 50, centerFocusNorm = 50, colorfulnessNorm = 0
    expect(m.appeal).toBeCloseTo(0 * 0.4 + 50 * 0.3 + 50 * 0.3, 5);
  });

  test('a warm, colorful photo with a detailed center scores higher appeal than the flat baseline', () => {
    const isCenter = (x, y) => x >= 2 && x < 7 && y >= 2 && y < 7;

    // Warm tone (R > B by a constant offset) everywhere; large luminance
    // checkerboard in the center (sharp "subject"), tiny variation at the
    // edges (mostly flat background).
    const pixel = (x, y) => {
      const amp = isCenter(x, y) ? 100 : 5;
      const base = isCenter(x, y) ? 150 : 125;
      const g = base + (((x + y) % 2) ? amp : -amp);
      return { r: Math.min(255, g + 60), g, b: Math.max(0, g - 60) };
    };

    const flat = buildFrame(10, 10, () => ({ r: 128, g: 128, b: 128 }));
    const warm = buildFrame(10, 10, pixel);

    const flatMetrics = bg.computeAppealMetrics(flat.data, flat.gray, 10, 10);
    const warmMetrics = bg.computeAppealMetrics(warm.data, warm.gray, 10, 10);

    expect(warmMetrics.warmth).toBeGreaterThan(0);
    expect(warmMetrics.colorfulness).toBeGreaterThan(0);
    expect(warmMetrics.centerFocus).toBeGreaterThan(1);
    expect(warmMetrics.appeal).toBeGreaterThan(flatMetrics.appeal);
    expect(warmMetrics.appeal).toBeGreaterThanOrEqual(0);
    expect(warmMetrics.appeal).toBeLessThanOrEqual(100);
  });
});

describe('scoreImageQuality appeal/rankScore blending', () => {
  test('falls back to a neutral appeal/rankScore of 50 when scoring fails (e.g. no OffscreenCanvas)', async () => {
    // jsdom does not implement OffscreenCanvas — scoreImageQuality's try/catch
    // lets the photo through with neutral scores rather than dropping it.
    expect(typeof OffscreenCanvas).toBe('undefined');

    const result = await bg.scoreImageQuality('data:image/png;base64,fake');

    expect(result.passed).toBe(true);
    expect(result.appeal).toBe(50);
    expect(result.rankScore).toBe(50);
    expect(result.colorfulness).toBe(0);
    expect(result.warmth).toBe(0);
    expect(result.centerFocus).toBe(1);
  });
});

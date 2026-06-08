// Shared fixtures for injector tests.

// A minimal valid base64 payload — `dataUrlToFile()` only needs to `atob()` it
// and read the mime type out of the header, it never decodes real pixels.
const TINY_BASE64 = 'aGVsbG8=';
const PHOTO_DATA_URL = `data:image/jpeg;base64,${TINY_BASE64}`;

function photoDataUrls(n = 3) {
  return Array.from({ length: n }, () => PHOTO_DATA_URL);
}

// Resolves once all pending microtasks AND the macrotask queue (setTimeout 0)
// have drained — needed because injectors interleave `await sleep(ms)` with
// `setInterval`-based polling (`waitFor`).
async function flushAsync(times = 1) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

// Thin wrapper around modern fake timers' async advance — it fires due timers
// AND awaits the microtasks/promise chains they trigger (including
// `setInterval`-based `waitFor` polling loops) before moving on.
async function runTimersInSteps(ms) {
  await jest.advanceTimersByTimeAsync(ms);
}

module.exports = { PHOTO_DATA_URL, photoDataUrls, flushAsync, runTimersInSteps };

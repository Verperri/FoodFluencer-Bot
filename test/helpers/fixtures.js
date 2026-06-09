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
//
// Note: setImmediate is not available in jsdom (jest-environment-jsdom exposes
// jsdom globals, not Node.js globals). We fake the "macrotask flush" by
// queueing a zero-delay fake timer (which sits above the microtask queue),
// then running multiple microtask rounds to drain any deep async chains.
async function flushAsync(times = 1) {
  for (let i = 0; i < times; i++) {
    // Drain microtask queue several times (each round allows Promise .then
    // chains to progress one more level — keeps flushing until stable)
    for (let j = 0; j < 10; j++) await Promise.resolve();
    // Advance fake clock by 0ms to fire any setInterval/setTimeout(fn,0) that
    // are pending, then drain microtasks again
    await jest.advanceTimersByTimeAsync(0);
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
}

// Thin wrapper around modern fake timers' async advance — it fires due timers
// AND awaits the microtasks/promise chains they trigger (including
// `setInterval`-based `waitFor` polling loops) before moving on.
//
// After advancing, we do extra microtask-draining rounds so that async chains
// that don't use setTimeout (e.g. image-load via queueMicrotask, awaited
// VideoEncoder.isConfigSupported, etc.) also complete before the test
// asserts. Without this, jest.advanceTimersByTimeAsync sometimes returns while
// injector logic is still pending in the microtask queue.
async function runTimersInSteps(ms) {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

module.exports = { PHOTO_DATA_URL, photoDataUrls, flushAsync, runTimersInSteps };

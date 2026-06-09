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
// Problem: jest.advanceTimersByTimeAsync(ms) processes timers in ascending
// time order, but timers that are *scheduled during* the async-chain processing
// of an earlier timer (e.g. sleep(200) inside the crop-click loop that fires
// during sleep(500)'s chain) can be missed — they are added to the queue after
// advanceTimersByTimeAsync has already stepped past their due time.
//
// Fix: after the main advance, repeatedly run small advances + microtask rounds
// to drain any late-scheduled fake timers left in the queue.  We use 200ms
// steps (matching the smallest sleep interval in the injectors) and repeat
// enough times to cover the deepest nesting (crop + filter click loops =
// ~6 × 200ms rounds).  Extra microtask rounds after each advance ensure
// Promise-based chains (VideoEncoder, applyCoverOverlay) also complete.
async function runTimersInSteps(ms) {
  await jest.advanceTimersByTimeAsync(ms);
  for (let outer = 0; outer < 20; outer++) {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(200);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
}

module.exports = { PHOTO_DATA_URL, photoDataUrls, flushAsync, runTimersInSteps };

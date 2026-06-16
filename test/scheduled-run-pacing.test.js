// Tests for the scheduled-run pacing guards added after the 2026-06-15 wake
// burst (Chrome fired ~9 missed alarms at once on resume, all posting in
// parallel → every run unconfirmed):
//  - isRunStale: skip posts that only fired because the device was asleep.
//  - enqueueScheduledRun: serialize runs so a wake-burst processes one at a time.

let bg;

beforeEach(() => {
  jest.resetModules();
  global.CONFIG = { REGION: 'be', MAX_PHOTOS: 5, TELEMETRY_ENDPOINT: '' };
  bg = require('../background.js');
});

// Build a post whose scheduled slot is `msFromNow` relative to now, formatted
// in LOCAL time to match how isRunStale parses `${date}T${time}:00`.
function postAt(msFromNow) {
  const d = new Date(Date.now() + msFromNow);
  const pad = n => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

describe('isRunStale', () => {
  test('skips a post scheduled well beyond the grace window', () => {
    expect(bg.isRunStale(postAt(-3 * 60 * 60 * 1000))).toBe(true); // 3h late
  });

  test('keeps a post that is only slightly late (within grace)', () => {
    expect(bg.isRunStale(postAt(-30 * 60 * 1000))).toBe(false); // 30 min late
  });

  test('keeps a future post', () => {
    expect(bg.isRunStale(postAt(+60 * 60 * 1000))).toBe(false); // 1h ahead
  });

  test('grace window is 2 hours', () => {
    expect(bg.RUN_GRACE_MS).toBe(2 * 60 * 60 * 1000);
  });

  test('treats an unparseable slot as not stale (never silently skip)', () => {
    expect(bg.isRunStale({ date: 'not-a-date', time: '99:99' })).toBe(false);
  });
});

describe('enqueueScheduledRun (serialization)', () => {
  test('runs queued tasks one at a time, in order', async () => {
    jest.useFakeTimers();
    try {
      const order = [];
      let active = 0, peak = 0;
      const mk = id => async () => {
        active++; peak = Math.max(peak, active);
        order.push(id);
        await Promise.resolve();
        active--;
      };
      bg.enqueueScheduledRun('a', mk('a'));
      bg.enqueueScheduledRun('b', mk('b'));
      bg.enqueueScheduledRun('c', mk('c'));

      await jest.runAllTimersAsync();

      expect(order).toEqual(['a', 'b', 'c']);
      expect(peak).toBe(1); // never two posting flows at once
    } finally {
      jest.useRealTimers();
    }
  });

  test('a failing run does not abort the queue', async () => {
    jest.useFakeTimers();
    try {
      const order = [];
      // The chain includes a staggered sleep() after each run, so advance the
      // fake timers BEFORE awaiting — otherwise the await deadlocks on a timer
      // that never fires.
      const ran = bg.enqueueScheduledRun('boom', async () => { order.push('boom'); throw new Error('boom'); });
      bg.enqueueScheduledRun('next', async () => { order.push('next'); });

      await jest.runAllTimersAsync();
      await expect(ran).resolves.toBeUndefined(); // error swallowed, queue continued

      expect(order).toEqual(['boom', 'next']);
    } finally {
      jest.useRealTimers();
    }
  });
});

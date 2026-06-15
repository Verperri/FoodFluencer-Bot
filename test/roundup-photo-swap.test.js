// Tests for the Region Round-Up per-photo "dismiss → another photo of the same
// entity" logic (popup.js). The photo *rendering* (cover-overlay canvas work)
// can't run under jsdom, so these cover the pure candidate-selection helpers
// that drive the dismiss button and its visibility.

const { loadPopupDom } = require('./helpers/popup-dom');

function entity(overrides = {}) {
  return {
    name: 'Test Venue',
    candidates: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    idx: 0,
    dismissed: [],
    seenSourceUrls: [],
    ...overrides,
  };
}

describe('Region Round-Up — photo swap selection', () => {
  describe('pickNextRoundupIdx', () => {
    test('returns the first candidate that is neither current nor dismissed', async () => {
      const { popup } = await loadPopupDom();
      expect(popup.pickNextRoundupIdx(entity({ idx: 0, dismissed: [] }))).toBe(1);
    });

    test('skips already-dismissed candidates', async () => {
      const { popup } = await loadPopupDom();
      expect(popup.pickNextRoundupIdx(entity({ idx: 0, dismissed: ['b'] }))).toBe(2);
    });

    test('returns -1 when every other candidate is dismissed', async () => {
      const { popup } = await loadPopupDom();
      expect(popup.pickNextRoundupIdx(entity({ idx: 0, dismissed: ['b', 'c'] }))).toBe(-1);
    });

    test('never selects the currently-shown index', async () => {
      const { popup } = await loadPopupDom();
      expect(popup.pickNextRoundupIdx(entity({ idx: 1, dismissed: [] }))).toBe(0);
    });
  });

  describe('roundupHasAlternative (dismiss button visibility)', () => {
    test('true while un-dismissed local candidates remain', async () => {
      const { popup } = await loadPopupDom();
      expect(popup.roundupHasAlternative(entity({ idx: 0, dismissed: [] }))).toBe(true);
    });

    test('false once the local pool is exhausted and no keyless source exists', async () => {
      const { popup } = await loadPopupDom();
      expect(popup.roundupHasAlternative(
        entity({ idx: 0, dismissed: ['b', 'c'], seenSourceUrls: [] })
      )).toBe(false);
    });

    test('true when the local pool is exhausted but a keyless source can be topped up', async () => {
      const { popup } = await loadPopupDom();
      expect(popup.roundupHasAlternative(
        entity({ idx: 0, dismissed: ['b', 'c'], seenSourceUrls: ['https://example.com/x'] })
      )).toBe(true);
    });
  });
});

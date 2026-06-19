// Guards the photo-source list consolidation (V3.6): the onboarding "how photos
// work" list and the Settings feature status both derive from the single
// SHARED_PHOTO_SOURCES definition in config.js, so they can no longer drift
// from each other or from the waterfall.

const { loadPopupDom } = require('./helpers/popup-dom');

describe('SHARED_PHOTO_SOURCES (config.js)', () => {
  const { SHARED_PHOTO_SOURCES, SHARED_PHOTO_SOURCES_ACTIVE } = require('../config.js');

  test('the active list drops sources flagged enabled:false (Yelp)', () => {
    expect(SHARED_PHOTO_SOURCES.some(s => s.id === 'yelp' && s.enabled === false)).toBe(true);
    expect(SHARED_PHOTO_SOURCES_ACTIVE.some(s => s.id === 'yelp')).toBe(false);
  });

  test('every active source is well-formed (name, blurb, valid badge)', () => {
    for (const s of SHARED_PHOTO_SOURCES_ACTIVE) {
      expect(typeof s.name).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
      expect(typeof s.blurb).toBe('string');
      expect(['free', 'key']).toContain(s.badge);
    }
  });
});

describe('buildFeatureStatus', () => {
  const { SHARED_PHOTO_SOURCES_ACTIVE } = require('../config.js');

  test('lists every active source in order, numbered, and never Yelp', async () => {
    const { popup } = await loadPopupDom();
    const labels = popup.buildFeatureStatus(false, false).map(f => f.label);
    SHARED_PHOTO_SOURCES_ACTIVE.forEach((s, i) => {
      expect(labels).toContain(`Photo source ${i + 1} — ${s.name}`);
    });
    expect(labels.some(l => /Yelp/.test(l))).toBe(false);
  });

  test('keyed sources switch on only when their key is present', async () => {
    const { popup } = await loadPopupDom();
    const noKeys = popup.buildFeatureStatus(false, false);
    expect(noKeys.find(f => /Foursquare/.test(f.label)).on).toBe(false);
    expect(noKeys.find(f => /Google Places/.test(f.label)).on).toBe(false);

    const withKeys = popup.buildFeatureStatus(true, true);
    expect(withKeys.find(f => /Foursquare/.test(f.label)).on).toBe(true);
    expect(withKeys.find(f => /Google Places/.test(f.label)).on).toBe(true);
    // Keyless sources are always on.
    expect(withKeys.find(f => /Google Maps/.test(f.label)).on).toBe(true);
  });
});

describe('renderObSources', () => {
  const { SHARED_PHOTO_SOURCES_ACTIVE } = require('../config.js');

  test('fills the onboarding grid + count from the shared list', async () => {
    const { popup } = await loadPopupDom();
    popup.showOnboarding(); // triggers renderObSources()

    const cards = document.querySelectorAll('#obSources .ob-source');
    expect(cards.length).toBe(SHARED_PHOTO_SOURCES_ACTIVE.length);
    expect(document.getElementById('obSourceCount').textContent)
      .toBe(String(SHARED_PHOTO_SOURCES_ACTIVE.length));

    // Order is preserved and the first card is Google Maps.
    expect(cards[0].querySelector('strong').textContent).toBe('Google Maps');
    // Keyed sources carry the API-key badge + class.
    const placesCard = [...cards].find(c => c.querySelector('strong').textContent === 'Google Places API');
    expect(placesCard.classList.contains('ob-source--api')).toBe(true);
    expect(placesCard.querySelector('.ob-badge').textContent).toBe('API key');
  });
});

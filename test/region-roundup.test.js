// Tests for the Region Roundup backend (background.js):
//  - searchAutoPlacesCollectionBG: 3-source waterfall that returns the TOP N
//    candidates (sorted by rating or review count) instead of a single random pick.
//  - getAutoCaptionRoundupBG: "Top N {type}s in {region}" caption with a
//    numbered, ranked list and optional ratings/review counts/hashtags.

let bg;

beforeEach(() => {
  jest.resetModules();
  global.CONFIG = { REGION: 'be', MAX_PHOTOS: 5, TELEMETRY_ENDPOINT: '' };
  const store = { appLog: [] };
  chrome.storage.local.get.mockImplementation((keys, cb) => {
    const result = {};
    if (Array.isArray(keys)) {
      keys.forEach(k => { result[k] = store[k]; });
    } else {
      Object.keys(keys).forEach(k => { result[k] = store[k] !== undefined ? store[k] : keys[k]; });
    }
    cb && cb(result);
    return Promise.resolve(result);
  });
  chrome.storage.local.set.mockImplementation((items, cb) => {
    Object.assign(store, items);
    cb && cb();
    return Promise.resolve();
  });
  bg = require('../background.js');
});

function makePlace(name, rating, userRatingCount) {
  return {
    displayName: { text: name },
    formattedAddress: 'Antwerp, Belgium',
    rating, userRatingCount,
    photos: [],
  };
}

describe('searchAutoPlacesCollectionBG', () => {
  test('Maps source: ranks by rating desc and truncates to config.size', async () => {
    const html = `
      {"displayName":{"text":"Hotel A"}} {"formattedAddress":"Antwerp, Belgium"} {"rating":4.2} {"userRatingCount":150}
      {"displayName":{"text":"Hotel B"}} {"formattedAddress":"Antwerp, Belgium"} {"rating":4.8} {"userRatingCount":300}
      {"displayName":{"text":"Hotel C"}} {"formattedAddress":"Antwerp, Belgium"} {"rating":4.5} {"userRatingCount":500}
      {"displayName":{"text":"Hotel D"}} {"formattedAddress":"Antwerp, Belgium"} {"rating":3.0} {"userRatingCount":10}
    `;
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve(html) }));

    const config = { type: 'hotel', country: 'BE', region: 'Antwerp', size: '3', ranking: 'rating', minStars: '4', minRatings: '100' };
    const result = await bg.searchAutoPlacesCollectionBG(config, null);

    expect(result.source).toBe('maps_scrape');
    expect(result.places).toHaveLength(3);
    expect(result.places.map(p => p.displayName.text)).toEqual(['Hotel B', 'Hotel C', 'Hotel A']);
    // Hotel D fails the minStars/minRatings filter and should not appear
    expect(result.places.find(p => p.displayName.text === 'Hotel D')).toBeUndefined();
  });

  test('Maps source: ranks by review count desc when ranking="reviews"', async () => {
    const html = `
      {"displayName":{"text":"Bar A"}} {"formattedAddress":"Ghent, Belgium"} {"rating":4.5} {"userRatingCount":150}
      {"displayName":{"text":"Bar B"}} {"formattedAddress":"Ghent, Belgium"} {"rating":4.1} {"userRatingCount":900}
      {"displayName":{"text":"Bar C"}} {"formattedAddress":"Ghent, Belgium"} {"rating":4.9} {"userRatingCount":120}
    `;
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve(html) }));

    const config = { type: 'bar', country: 'BE', region: 'Ghent', size: '2', ranking: 'reviews', minStars: '4', minRatings: '100' };
    const result = await bg.searchAutoPlacesCollectionBG(config, null);

    expect(result.places).toHaveLength(2);
    expect(result.places.map(p => p.displayName.text)).toEqual(['Bar B', 'Bar A']);
  });

  test('relaxes filters and falls back to the unfiltered pool when too few candidates qualify', async () => {
    const html = `
      {"displayName":{"text":"Spot A"}} {"formattedAddress":"Liège, Belgium"} {"rating":3.2} {"userRatingCount":20}
      {"displayName":{"text":"Spot B"}} {"formattedAddress":"Liège, Belgium"} {"rating":3.8} {"userRatingCount":40}
    `;
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve(html) }));

    const config = { type: 'restaurant', country: 'BE', region: 'Liège', size: '5', ranking: 'rating', minStars: '4.5', minRatings: '500' };
    const result = await bg.searchAutoPlacesCollectionBG(config, null);

    // Neither candidate meets the strict filter — falls back to the full pool, ranked
    expect(result.places).toHaveLength(2);
    expect(result.places.map(p => p.displayName.text)).toEqual(['Spot B', 'Spot A']);
  });

  test('falls back to city placeholders when all sources fail and no API key is provided', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('network down')));

    const config = { type: 'restaurant', country: 'BE', region: 'Bruges', size: '3', ranking: 'rating', minStars: '4', minRatings: '100' };
    const result = await bg.searchAutoPlacesCollectionBG(config, null);

    expect(result.source).toBe('city_fallback');
    expect(result.places).toHaveLength(3);
    result.places.forEach(p => expect(p.displayName.text).toContain('Bruges'));
  });
});

describe('getAutoCaptionRoundupBG', () => {
  const places = [
    makePlace('Hotel B', 4.8, 300),
    makePlace('Hotel C', 4.5, 500),
    makePlace('Hotel A', 4.2, 150),
  ];

  test('builds a "Top N {type}s in {region}" header with a numbered ranked list', () => {
    const caption = bg.getAutoCaptionRoundupBG(places, 'hotel', 'Antwerp', 'en',
      { showRatings: true, showReviewCount: false, hashtags: false, song: false }, null);

    const lines = caption.split('\n');
    expect(lines[0]).toBe('🔝 Top 3 Hotels in Antwerp');
    expect(caption).toContain('1. Hotel B — ⭐4.8');
    expect(caption).toContain('2. Hotel C — ⭐4.5');
    expect(caption).toContain('3. Hotel A — ⭐4.2');
  });

  test('includes review counts when showReviewCount is enabled', () => {
    const caption = bg.getAutoCaptionRoundupBG(places, 'hotel', 'Antwerp', 'en',
      { showRatings: true, showReviewCount: true, hashtags: false, song: false }, null);

    expect(caption).toContain('1. Hotel B — ⭐4.8 (300 reviews)');
  });

  test('appends region/type hashtags when enabled', () => {
    const caption = bg.getAutoCaptionRoundupBG(places, 'hotel', 'Antwerp', 'en',
      { showRatings: true, showReviewCount: false, hashtags: true, song: false }, null);

    expect(caption).toMatch(/#Antwerp #Hotels #TopList #FoodFluencer/);
  });

  test('localizes the header for non-English languages', () => {
    const caption = bg.getAutoCaptionRoundupBG(places, 'restaurant', 'Brussel', 'nl',
      { showRatings: true, showReviewCount: false, hashtags: false, song: false }, null);

    expect(caption.split('\n')[0]).toBe('🔝 Top 3 Restaurants in Brussel');
  });

  test('includes an optional song line when provided', () => {
    const songInfo = { name: 'Test Song', artist: 'Test Artist' };
    const caption = bg.getAutoCaptionRoundupBG(places, 'hotel', 'Antwerp', 'en',
      { showRatings: true, showReviewCount: false, hashtags: false, song: true }, songInfo);

    expect(caption).toContain('🎵 Test Song – Test Artist');
  });
});

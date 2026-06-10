// Validates the Manual Post search/random/selection flow in popup.js:
//  - Manual Post has its own independent search filters (type, country,
//    region, min ratings/stars/pictures), separate from the Auto Bot config.
//  - Free-text search returns multiple candidates biased to the configured
//    country and renders them in a dropdown for disambiguation.
//  - Selecting a dropdown entry loads it as the active restaurant.
//  - The "random" button picks an entity using the Manual Post filters.

const { loadPopupDom } = require('./helpers/popup-dom');

// Resolves once pending microtasks (fetch/json promises) have settled.
const flush = () => new Promise(r => setTimeout(r, 0));

function makePlace({ name, address, rating = 4.5, userRatingCount = 200, photoCount = 5 }) {
  return {
    id: `place-${name}`,
    displayName: { text: name },
    formattedAddress: address,
    rating,
    userRatingCount,
    googleMapsUri: `https://maps.google.com/?q=${encodeURIComponent(name)}`,
    photos: Array.from({ length: photoCount }, (_, i) => ({ name: `photos/${name}-${i}`, width: 800, height: 600 })),
  };
}

function mockPlacesSearch(places, { ok = true, errorMessage = 'Bad request' } = {}) {
  global.fetch.mockImplementation((url, opts) => {
    if (String(url).includes('version.json')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ branch: 'test', commit: '' }) });
    }
    if (String(url).includes('places:searchText')) {
      if (!ok) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: { message: errorMessage } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ places }) });
    }
    if (String(url).includes('/media')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ photoUri: 'https://example.com/photo.jpg' }) });
    }
    return Promise.reject(new Error(`Unmocked fetch: ${url}`));
  });
}

describe('Manual Post — independent search filters', () => {
  test('reads Type/Country/Region/Min Ratings/Min Stars/Min Pictures from the saved Manual Post config', async () => {
    const { popup } = await loadPopupDom({
      manualPostConfig: {
        type: 'hotel', country: 'FR', allRegions: true, regions: [],
        minRatings: '200', minStars: '4.5', minPics: '3',
      },
    });

    const settings = popup.getManualSettings();
    expect(settings.type).toBe('hotel');
    expect(settings.country).toBe('FR');
    expect(settings.minRatings).toBe(200);
    expect(settings.minStars).toBe(4.5);
    expect(settings.minPics).toBe(3);
  });

  test('falls back to the documented defaults when no Manual Post config has been saved', async () => {
    const { popup } = await loadPopupDom();

    const settings = popup.getManualSettings();
    expect(settings.type).toBe('restaurant');
    expect(settings.country).toBe('BE');
    expect(settings.minRatings).toBe(100);
    expect(settings.minStars).toBe(4);
    expect(settings.minPics).toBe(5);
  });

  test('Manual Post filters are independent of the Auto Bot configuration', async () => {
    const { popup } = await loadPopupDom({
      autoBotConfig: { type: 'bar', country: 'DE', allRegions: true, regions: [], minRatings: '300', minStars: '4.5', minPics: '4' },
      manualPostConfig: { type: 'hotel', country: 'FR', allRegions: true, regions: [], minRatings: '200', minStars: '3.5', minPics: '3' },
    });

    const manual = popup.getManualSettings();
    const auto = popup.getAutoBotSettings();
    expect(manual.type).toBe('hotel');
    expect(manual.country).toBe('FR');
    expect(auto.type).toBe('bar');
    expect(auto.country).toBe('DE');
  });
});

describe('Manual Post — search with disambiguation dropdown', () => {
  test('searches biased to the configured country and lists every candidate in the dropdown', async () => {
    const { popup } = await loadPopupDom({
      manualPostConfig: { type: 'hotel', country: 'NL', allRegions: true, regions: [], minRatings: '0', minStars: '0', minPics: '0' },
    });

    const places = [
      makePlace({ name: 'Hilton Amsterdam', address: 'Apollolaan 138, Amsterdam' }),
      makePlace({ name: 'Hilton Amsterdam Airport Schiphol', address: 'Schiphol Boulevard 701' }),
      makePlace({ name: 'Hampton by Hilton Amsterdam Centre East', address: 'Wibautstraat 137, Amsterdam' }),
    ];
    mockPlacesSearch(places);

    await popup.doSearch('Hilton');
    await flush();

    // Biased to the configured country (NL → "The Netherlands")
    const [, options] = global.fetch.mock.calls.find(([url]) => String(url).includes('places:searchText'));
    const body = JSON.parse(options.body);
    expect(body.textQuery).toMatch(/The Netherlands/i);
    expect(body.locationRestriction.rectangle).toEqual(popup.AB_COUNTRY_BOUNDS.NL);

    // All candidates are shown so the user can pick the right one
    const items = document.querySelectorAll('#searchResultsDropdown .search-result-item');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Hilton Amsterdam');
    expect(items[1].textContent).toContain('Hilton Amsterdam Airport Schiphol');
    expect(items[2].textContent).toContain('Hampton by Hilton Amsterdam Centre East');
    expect(document.getElementById('searchResultsDropdown').classList.contains('hidden')).toBe(false);
  });

  test('clicking a dropdown entry loads it as the active restaurant and closes the dropdown', async () => {
    const { popup } = await loadPopupDom();

    const places = [
      makePlace({ name: 'Hilton Brussels Grand Place', address: 'Carrefour de l\'Europe 3, Brussels' }),
      makePlace({ name: 'Hilton Brussels City', address: 'Rue Royale 250, Brussels' }),
    ];
    mockPlacesSearch(places);

    await popup.doSearch('Hilton Brussels');
    await flush();

    const items = document.querySelectorAll('#searchResultsDropdown .search-result-item');
    expect(items).toHaveLength(2);

    items[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush();

    expect(popup.getCurrentRestaurant().name).toBe('Hilton Brussels City');
    expect(document.getElementById('query').value).toBe('Hilton Brussels City');
    expect(document.getElementById('searchResultsDropdown').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('searchResultsDropdown').innerHTML).toBe('');
  });

  test('surfaces Places API errors (e.g. quota exceeded) via the status banner', async () => {
    const { popup } = await loadPopupDom();
    mockPlacesSearch([], { ok: false, errorMessage: 'Quota exceeded for quota metric' });

    await popup.doSearch('Comme Chez Soi');
    await flush();

    const status = document.getElementById('status');
    expect(status.classList.contains('hidden')).toBe(false);
    expect(status.textContent).toMatch(/quota/i);
    expect(document.getElementById('searchResultsDropdown').classList.contains('hidden')).toBe(true);
  });

  test('reports a clear "no results" error when nothing matches', async () => {
    const { popup } = await loadPopupDom();
    mockPlacesSearch([]);

    await popup.doSearch('Some Nonexistent Place Xyz');
    await flush();

    const status = document.getElementById('status');
    expect(status.classList.contains('hidden')).toBe(false);
    expect(status.textContent).toMatch(/no results found/i);
  });
});

describe('Manual Post — random button uses the Manual Post filters', () => {
  test('picks a place honouring type/country/region/min-rating/min-stars/min-pics', async () => {
    const { popup } = await loadPopupDom({
      manualPostConfig: {
        type: 'hotel', country: 'NL', allRegions: true, regions: [],
        minRatings: '150', minStars: '4.5', minPics: '3',
      },
    });

    const places = [
      makePlace({ name: 'Conservatorium Hotel', address: 'Van Baerlestraat 27, Amsterdam', rating: 4.8, userRatingCount: 1500, photoCount: 5 }),
      makePlace({ name: 'Budget Inn', address: 'Somewhere, Amsterdam', rating: 4.6, userRatingCount: 50, photoCount: 1 }),
    ];
    mockPlacesSearch(places);

    document.getElementById('randomBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush();
    await flush();

    // Request used the configured filters
    const [, options] = global.fetch.mock.calls.find(([url]) => String(url).includes('places:searchText'));
    const body = JSON.parse(options.body);
    expect(body.textQuery).toMatch(/hotel/i);
    expect(body.textQuery).toMatch(/The Netherlands/i);
    expect(body.minRating).toBe(4.5);
    expect(body.locationRestriction.rectangle).toEqual(popup.AB_COUNTRY_BOUNDS.NL);

    // Only the place meeting minRatings (150) and minPics (3) is eligible
    expect(popup.getCurrentRestaurant().name).toBe('Conservatorium Hotel');
    expect(document.getElementById('query').value).toBe('Conservatorium Hotel');
  });

  test('surfaces a helpful error when no place meets the configured filters', async () => {
    const { popup } = await loadPopupDom({
      manualPostConfig: {
        type: 'restaurant', country: 'BE', allRegions: true, regions: [],
        minRatings: '5000', minStars: '4', minPics: '5',
      },
    });

    mockPlacesSearch([
      makePlace({ name: 'Small Bistro', address: 'Brussels', rating: 4.2, userRatingCount: 10, photoCount: 2 }),
    ]);

    document.getElementById('randomBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush();
    await flush();

    const status = document.getElementById('status');
    expect(status.classList.contains('hidden')).toBe(false);
    expect(status.textContent).toMatch(/ratings/i);
  });
});

// Tests for the direct venue-website image source added to the photo waterfall
// (background.js, V3.6):
//   - extractWebsiteFromHtml(): harvests the venue's own domain from an
//     already-fetched HTML blob (e.g. the Google Maps page), ignoring Google /
//     CDN / social / aggregator hosts.
//   - scrapeWebsiteImages(): fetches the venue homepage and extracts og:image /
//     twitter:image, schema.org JSON-LD `image`, and <img> src/srcset, dropping
//     logos/icons/SVGs, then proxies the image bytes through DuckDuckGo.
//
// These replace the old indirect `site:<domain>` DDG image search, which only
// surfaced images DDG had already crawled.

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

afterEach(() => { delete global.fetch; });

// The DDG image proxy wrapper scrapeWebsiteImages applies to every result —
// unwrap it back to the original URL so assertions read clearly.
function unwrapProxy(proxied) {
  const m = proxied.match(/[?&]u=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : proxied;
}

describe('extractWebsiteFromHtml', () => {
  test('returns the most-linked non-aggregator domain', () => {
    const html = `
      <a href="https://maps.google.com/foo">map</a>
      <a href="https://lh3.googleusercontent.com/p/x">photo</a>
      <a href="https://www.facebook.com/bistro">fb</a>
      <a href="https://bistro-leon.be/">home</a>
      <a href="https://bistro-leon.be/menu">menu</a>
      <link href="https://bistro-leon.be/style.css">
    `;
    expect(bg.extractWebsiteFromHtml(html)).toBe('https://bistro-leon.be/');
  });

  test('ignores Google, social, and aggregator hosts entirely', () => {
    const html = `
      <a href="https://www.google.com/maps">m</a>
      <a href="https://instagram.com/x">ig</a>
      <a href="https://www.tripadvisor.com/Restaurant">ta</a>
      <a href="https://www.yelp.com/biz">y</a>
    `;
    expect(bg.extractWebsiteFromHtml(html)).toBeNull();
  });

  test('strips a leading www. so the same site is not split across two tallies', () => {
    const html = `
      <a href="https://www.cafedumarche.fr/">a</a>
      <a href="https://cafedumarche.fr/contact">b</a>
    `;
    expect(bg.extractWebsiteFromHtml(html)).toBe('https://cafedumarche.fr/');
  });
});

describe('scrapeWebsiteImages', () => {
  function mockHtml(html) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(html),
    });
  }

  test('extracts og:image, JSON-LD image, and <img> src/srcset; drops logos and SVGs', async () => {
    mockHtml(`
      <head>
        <meta property="og:image" content="https://cdn.bistro.be/hero.jpg">
        <meta name="twitter:image" content="/img/terrace.jpg">
        <script type="application/ld+json">
          {"@type":"Restaurant","image":["https://cdn.bistro.be/dish1.jpg","https://cdn.bistro.be/dish2.jpg"]}
        </script>
        <link rel="icon" href="/favicon.ico">
      </head>
      <body>
        <img src="https://cdn.bistro.be/logo.png">
        <img src="/photos/interior.jpeg">
        <img srcset="/photos/small.webp 320w, https://cdn.bistro.be/photos/large.webp 1024w">
        <img src="https://cdn.bistro.be/icons/sprite.svg">
      </body>
    `);

    const result = await bg.scrapeWebsiteImages('https://www.bistro.be/');
    const urls = result.map(unwrapProxy);

    // Every result is routed through the already-permitted DDG image proxy.
    expect(result.every(u => u.startsWith('https://external-content.duckduckgo.com/iu/'))).toBe(true);

    // og:image + relative twitter:image (resolved against the base origin)
    expect(urls).toContain('https://cdn.bistro.be/hero.jpg');
    expect(urls).toContain('https://www.bistro.be/img/terrace.jpg');
    // JSON-LD image array
    expect(urls).toContain('https://cdn.bistro.be/dish1.jpg');
    expect(urls).toContain('https://cdn.bistro.be/dish2.jpg');
    // <img> src (relative) and srcset (largest candidate wins)
    expect(urls).toContain('https://www.bistro.be/photos/interior.jpeg');
    expect(urls).toContain('https://cdn.bistro.be/photos/large.webp');

    // Junk must be dropped: logo, favicon, SVG sprite.
    expect(urls).not.toContain('https://cdn.bistro.be/logo.png');
    expect(urls).not.toContain('https://cdn.bistro.be/icons/sprite.svg');
    expect(urls.some(u => /favicon/.test(u))).toBe(false);
  });

  test('parses JSON-LD with a nested @graph and an ImageObject', async () => {
    mockHtml(`
      <script type="application/ld+json">
        {"@graph":[
          {"@type":"WebPage"},
          {"@type":"ImageObject","url":"https://cdn.bistro.be/graph-hero.jpg"}
        ]}
      </script>
    `);
    const urls = (await bg.scrapeWebsiteImages('https://bistro.be/')).map(unwrapProxy);
    expect(urls).toContain('https://cdn.bistro.be/graph-hero.jpg');
  });

  test('returns [] on a non-OK response without throwing', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('') });
    await expect(bg.scrapeWebsiteImages('https://bistro.be/')).resolves.toEqual([]);
  });

  test('returns [] on a malformed website URL without fetching', async () => {
    global.fetch = jest.fn();
    await expect(bg.scrapeWebsiteImages('not a url')).resolves.toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('commonsFilePathUrl', () => {
  test('builds a keyless Special:FilePath URL from a "File:" tag', () => {
    expect(bg.commonsFilePathUrl('File:Grand Place Brussels.jpg'))
      .toBe('https://commons.wikimedia.org/wiki/Special:FilePath/Grand%20Place%20Brussels.jpg?width=2048');
  });

  test('accepts a bare filename and honours a custom width', () => {
    expect(bg.commonsFilePathUrl('Foo.png', 1024))
      .toBe('https://commons.wikimedia.org/wiki/Special:FilePath/Foo.png?width=1024');
  });

  test('rejects categories, non-image files, and empty input', () => {
    expect(bg.commonsFilePathUrl('Category:Restaurants in Belgium')).toBeNull();
    expect(bg.commonsFilePathUrl('File:Menu.pdf')).toBeNull();
    expect(bg.commonsFilePathUrl(null)).toBeNull();
  });
});

describe('formatCommonsAttribution', () => {
  test('strips HTML from the author and appends the licence + Commons suffix', () => {
    expect(bg.formatCommonsAttribution({
      Artist: { value: '<a href="/wiki/User:Jane">Jane Doe</a>' },
      LicenseShortName: { value: 'CC BY-SA 4.0' },
    })).toBe('Jane Doe (CC BY-SA 4.0) / Wikimedia Commons');
  });

  test('handles a missing author or licence gracefully', () => {
    expect(bg.formatCommonsAttribution({ LicenseShortName: { value: 'CC0' } }))
      .toBe('(CC0) / Wikimedia Commons');
    expect(bg.formatCommonsAttribution({ Artist: { value: 'John' } }))
      .toBe('John / Wikimedia Commons');
    expect(bg.formatCommonsAttribution(null)).toBe('Wikimedia Commons');
  });
});

describe('commonsPagesToImageUrls', () => {
  test('returns {url, attribution}, prefers thumburl, drops SVG/PDF and non-photo titles', () => {
    const pages = {
      '1': { imageinfo: [{ url: 'https://upload.wikimedia.org/full/Cafe.jpg', thumburl: 'https://upload.wikimedia.org/thumb/Cafe.jpg', mime: 'image/jpeg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Cafe.jpg', extmetadata: { Artist: { value: 'Jane' }, LicenseShortName: { value: 'CC BY 4.0' } } }] },
      '2': { imageinfo: [{ url: 'https://upload.wikimedia.org/Logo.svg', mime: 'image/svg+xml' }] },
      '3': { imageinfo: [{ url: 'https://upload.wikimedia.org/Map.png', mime: 'image/png', descriptionurl: 'https://commons.wikimedia.org/wiki/File:City_map.png' }] },
      '4': { imageinfo: [{ url: 'https://upload.wikimedia.org/Plate.webp', mime: 'image/webp' }] },
    };
    const out = bg.commonsPagesToImageUrls(pages, 10);
    const byUrl = Object.fromEntries(out.map(x => [x.url, x.attribution]));
    expect(byUrl['https://upload.wikimedia.org/thumb/Cafe.jpg']).toBe('Jane (CC BY 4.0) / Wikimedia Commons'); // thumburl preferred + attribution
    expect(out.some(x => x.url === 'https://upload.wikimedia.org/Plate.webp')).toBe(true);
    expect(out.some(x => /Logo\.svg/.test(x.url))).toBe(false); // svg mime dropped
    expect(out.some(x => /Map\.png/.test(x.url))).toBe(false);  // "map" title dropped
  });

  test('respects the limit and tolerates a missing pages object', () => {
    const pages = {};
    for (let i = 0; i < 20; i++) pages[i] = { imageinfo: [{ url: `https://upload.wikimedia.org/p${i}.jpg`, mime: 'image/jpeg' }] };
    expect(bg.commonsPagesToImageUrls(pages, 5)).toHaveLength(5);
    expect(bg.commonsPagesToImageUrls(undefined, 5)).toEqual([]);
  });
});

describe('resolveCommonsFile', () => {
  afterEach(() => { delete global.fetch; });

  test('resolves a File: title to its scaled url + attribution via the API', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ query: { pages: { '-1': { imageinfo: [{
        url: 'https://upload.wikimedia.org/full/Venue.jpg',
        thumburl: 'https://upload.wikimedia.org/thumb/Venue.jpg',
        mime: 'image/jpeg',
        extmetadata: { Artist: { value: 'Bob' }, LicenseShortName: { value: 'CC BY-SA 3.0' } },
      }] } } } }),
    });
    const out = await bg.resolveCommonsFile('File:Venue.jpg');
    expect(out).toEqual({
      url: 'https://upload.wikimedia.org/thumb/Venue.jpg',
      attribution: 'Bob (CC BY-SA 3.0) / Wikimedia Commons',
    });
    expect(global.fetch.mock.calls[0][0]).toContain('titles=File%3AVenue.jpg');
  });

  test('returns null for a non-image title without fetching', async () => {
    global.fetch = jest.fn();
    await expect(bg.resolveCommonsFile('Category:Foo')).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('fetchWikimediaPhotos', () => {
  afterEach(() => { delete global.fetch; });

  test('returns [] without fetching when coordinates are missing', async () => {
    global.fetch = jest.fn();
    await expect(bg.fetchWikimediaPhotos({ lat: null, lon: null })).resolves.toEqual([]);
    await expect(bg.fetchWikimediaPhotos(null)).resolves.toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('geosearches the venue coordinates and returns the photo URLs', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ query: { pages: {
        '1': { imageinfo: [{ url: 'https://upload.wikimedia.org/near1.jpg', thumburl: 'https://upload.wikimedia.org/near1-2048.jpg', mime: 'image/jpeg' }] },
      } } }),
    });
    const urls = await bg.fetchWikimediaPhotos({ lat: 50.85, lon: 4.35 });
    expect(urls).toEqual(['https://upload.wikimedia.org/near1-2048.jpg']);
    const calledUrl = global.fetch.mock.calls[0][0];
    expect(calledUrl).toContain('generator=geosearch');
    expect(calledUrl).toContain('ggscoord=50.85|4.35');
    expect(calledUrl).toContain('extmetadata');
  });

  test('returns [] when the geosearch request fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    await expect(bg.fetchWikimediaPhotos({ lat: 1, lon: 2 })).resolves.toEqual([]);
  });
});

describe('photo credits', () => {
  test('collectPhotoCredits dedupes attributions across photo sets', () => {
    const a = [{ attribution: 'Jane / Wikimedia Commons' }, { source: 'duckduckgo' }];
    const b = [{ attribution: 'Jane / Wikimedia Commons' }, { attribution: 'Bob / Wikimedia Commons' }];
    expect(bg.collectPhotoCredits(a, b)).toEqual(['Jane / Wikimedia Commons', 'Bob / Wikimedia Commons']);
    expect(bg.collectPhotoCredits()).toEqual([]);
  });

  test('buildPhotoCreditLine formats one vs many and caps at three', () => {
    expect(bg.buildPhotoCreditLine([])).toBe('');
    expect(bg.buildPhotoCreditLine(['Jane (CC BY 4.0) / Wikimedia Commons']))
      .toBe('📷 Photo: Jane (CC BY 4.0) / Wikimedia Commons');
    expect(bg.buildPhotoCreditLine(['A', 'B', 'C', 'D'])).toBe('📷 Photos: A; B; C');
  });

  test('getAutoCaptionBG appends a credit line only when there are credits', () => {
    const opts = { name: true, hashtags: false, song: false };
    const withCredit = bg.getAutoCaptionBG('Bistro', 'Brussels', 'restaurant', 'en', opts, null, {}, ['Jane / Wikimedia Commons']);
    expect(withCredit).toContain('📷 Photo: Jane / Wikimedia Commons');
    const noCredit = bg.getAutoCaptionBG('Bistro', 'Brussels', 'restaurant', 'en', opts, null, {}, []);
    expect(noCredit).not.toContain('📷');
  });
});

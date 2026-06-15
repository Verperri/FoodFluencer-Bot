// Tests for the Region Roundup "City as an independent location source"
// feature (popup.js): city dropdowns are populated from AB_CITY_POOL and are
// mutually exclusive with the region/province dropdown — selecting one greys
// (mutes) the other, and the effective search location resolves to whichever
// is active.

const { loadPopupDom } = require('./helpers/popup-dom');

describe('Region Roundup — City as an independent source', () => {
  describe('buildCitySelect', () => {
    test('populates both Manual and Auto Bot city dropdowns from AB_CITY_POOL', async () => {
      await loadPopupDom();
      ['mrCity', 'rrCity'].forEach(id => {
        const sel = document.getElementById(id);
        expect(sel).toBeTruthy();
        // First option is the neutral "use region instead" placeholder.
        expect(sel.options[0].value).toBe('');
        const cityValues = [...sel.options].map(o => o.value).filter(Boolean);
        expect(cityValues).toContain('Bruges');
        expect(cityValues).toContain('Ghent');
        // Sorted alphabetically.
        expect(cityValues).toEqual([...cityValues].sort((a, b) => a.localeCompare(b)));
      });
    });

    test('rebuilds the city list when the country changes', async () => {
      const { popup } = await loadPopupDom();
      popup.buildCitySelect('FR', 'rrCity');
      const cityValues = [...document.getElementById('rrCity').options].map(o => o.value).filter(Boolean);
      expect(cityValues).toContain('Paris');
      expect(cityValues).not.toContain('Bruges');
    });
  });

  describe('mutual exclusivity (grey-out)', () => {
    function group(selectId) {
      return document.getElementById(selectId).closest('.ab-group');
    }

    test('selecting a city greys the region group', async () => {
      const { popup } = await loadPopupDom();
      const region = document.getElementById('rrRegion');
      const city   = document.getElementById('rrCity');

      city.value = 'Bruges';
      city.dispatchEvent(new Event('change'));

      expect(group('rrRegion').classList.contains('rr-source-muted')).toBe(true);
      expect(group('rrCity').classList.contains('rr-source-muted')).toBe(false);
      // City wins → region is neutralized back to "Random Region".
      expect(region.value).toBe('__random__');
    });

    test('selecting a specific province greys the city group and clears the city', async () => {
      const { popup } = await loadPopupDom();
      const region = document.getElementById('rrRegion');
      const city   = document.getElementById('rrCity');

      // Start in city mode…
      city.value = 'Ghent';
      city.dispatchEvent(new Event('change'));
      // …then pick a province.
      region.value = 'Antwerp';
      region.dispatchEvent(new Event('change'));

      expect(group('rrCity').classList.contains('rr-source-muted')).toBe(true);
      expect(group('rrRegion').classList.contains('rr-source-muted')).toBe(false);
      expect(city.value).toBe('');
    });

    test('neither is greyed when region is random and no city is chosen', async () => {
      await loadPopupDom();
      const region = document.getElementById('rrRegion');
      region.value = '__random__';
      region.dispatchEvent(new Event('change'));

      expect(group('rrRegion').classList.contains('rr-source-muted')).toBe(false);
      expect(group('rrCity').classList.contains('rr-source-muted')).toBe(false);
    });
  });

  describe('resolveRoundupLocation', () => {
    test('city wins over region when both are set', async () => {
      const { popup } = await loadPopupDom();
      expect(popup.resolveRoundupLocation('Antwerp', 'Bruges', 'BE')).toBe('Bruges');
    });

    test('falls back to the province when no city is selected', async () => {
      const { popup } = await loadPopupDom();
      expect(popup.resolveRoundupLocation('Antwerp', '', 'BE')).toBe('Antwerp');
    });

    test('a random region resolves to one of the country\'s provinces', async () => {
      const { popup } = await loadPopupDom();
      const loc = popup.resolveRoundupLocation('__random__', '', 'BE');
      expect(popup.REGIONS.BE).toContain(loc);
    });
  });

  describe('getRegionRoundupSettings', () => {
    test('reports the city as the effective region when one is selected', async () => {
      const { popup } = await loadPopupDom();
      const city = document.getElementById('rrCity');
      city.value = 'Ghent';
      city.dispatchEvent(new Event('change'));

      expect(popup.getRegionRoundupSettings().region).toBe('Ghent');
    });
  });
});

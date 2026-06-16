// Regression tests for SHARED_CITY_FROM_ADDRESS_RE (config.js), the single
// city-extraction regex now shared by the popup and the service worker.
//
// Previously the popup used a country-anchored variant that required an English
// country name ("Belgium"), so it silently failed on the localized country names
// Google actually returns ("België", "Deutschland") and fell back to the street
// name. These tests pin the fixed, language-agnostic behavior.

const { SHARED_CITY_FROM_ADDRESS_RE } = require('../config.js');

function city(address) {
  const m = address.match(SHARED_CITY_FROM_ADDRESS_RE);
  return m ? m[1].trim() : null;
}

describe('SHARED_CITY_FROM_ADDRESS_RE', () => {
  test('extracts the city from a localized (Dutch) country suffix', () => {
    expect(city('Nationalestraat 1, 2000 Antwerpen, België')).toBe('Antwerpen');
  });

  test('extracts the city from a localized (German) country suffix', () => {
    expect(city('Marienplatz 1, 80331 München, Deutschland')).toBe('München');
  });

  test('still works with an English country suffix', () => {
    expect(city('Grand Place 1, 1000 Brussels, Belgium')).toBe('Brussels');
    expect(city('10 Rue de Rivoli, 75001 Paris, France')).toBe('Paris');
  });

  test('works when there is no country suffix at all', () => {
    expect(city('2000 Antwerpen')).toBe('Antwerpen');
  });

  test('does NOT return the street name (the old localized-address bug)', () => {
    expect(city('Nationalestraat 1, 2000 Antwerpen, België')).not.toBe('Nationalestraat 1');
  });

  test('returns null when there is no postcode-anchored city', () => {
    expect(city('Some Street, No Postcode Town')).toBeNull();
  });
});

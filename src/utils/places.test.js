import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_PLACES, HOME_BOUNDS, loadPlaces, makePlace, parseCoordinates, savePlaces } from './places';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DEFAULT_PLACES', () => {
  it('gives every place its own id, a name, a short label and a position', () => {
    expect(DEFAULT_PLACES.length).toBeGreaterThan(0);
    expect(new Set(DEFAULT_PLACES.map((p) => p.id)).size).toBe(DEFAULT_PLACES.length);
    for (const place of DEFAULT_PLACES) {
      expect(place.name.length, place.id).toBeGreaterThan(0);
      expect(place.label.length, place.id).toBeGreaterThan(0);
      expect(place.label.length, place.id).toBeLessThanOrEqual(place.name.length);
      expect(Math.abs(place.lat), place.id).toBeLessThanOrEqual(85);
      expect(Math.abs(place.lng), place.id).toBeLessThanOrEqual(180);
    }
  });

  it('only uses label anchors the map knows', () => {
    for (const place of DEFAULT_PLACES) {
      if ('anchor' in place) expect(['left', 'right']).toContain(place.anchor);
    }
  });
});

describe('HOME_BOUNDS', () => {
  it('holds every default place with some air around it', () => {
    for (const place of DEFAULT_PLACES) {
      expect(place.lat, place.id).toBeGreaterThan(HOME_BOUNDS.south);
      expect(place.lat, place.id).toBeLessThan(HOME_BOUNDS.north);
      expect(place.lng, place.id).toBeGreaterThan(HOME_BOUNDS.west);
      expect(place.lng, place.id).toBeLessThan(HOME_BOUNDS.east);
    }
  });

  it('is a view of a region, not of a country', () => {
    expect(HOME_BOUNDS.north - HOME_BOUNDS.south).toBeLessThan(1);
    expect(HOME_BOUNDS.east - HOME_BOUNDS.west).toBeLessThan(1);
  });
});

describe('loadPlaces and savePlaces', () => {
  it('starts from the default places when nothing was saved', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(loadPlaces()).toBe(DEFAULT_PLACES);
  });

  it('reads back what was saved, including an empty list', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const own = [...DEFAULT_PLACES.slice(0, 2), { id: 'place-x', name: 'Girona', label: 'Girona', lat: 41.98, lng: 2.82, region: 'Catalonia, Spain', zone: 'Europe/Madrid' }];
    savePlaces(own);
    expect(loadPlaces()).toEqual(own);

    savePlaces([]);
    expect(loadPlaces()).toEqual([]);
  });

  it('falls back on the default places when what was saved is not a list of places', () => {
    for (const bad of ['not json', '{"a":1}', '[{"id":"x","name":"No position"}]', '[{"id":1,"name":"Bad id","lat":1,"lng":2}]', '[null]']) {
      vi.stubGlobal('localStorage', fakeStorage({ 'wind-places-v1': bad }));
      expect(loadPlaces(), bad).toBe(DEFAULT_PLACES);
    }
  });

  it('works when storage is not available', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(loadPlaces()).toBe(DEFAULT_PLACES);
    expect(() => savePlaces(DEFAULT_PLACES)).not.toThrow();
  });
});

describe('makePlace', () => {
  it('makes a place whose label is its name, trimmed', () => {
    const place = makePlace('  Home  ', 38.7, -9.2);
    expect(place.name).toBe('Home');
    expect(place.label).toBe('Home');
    expect(place.lat).toBe(38.7);
    expect(place.lng).toBe(-9.2);
    expect(typeof place.id).toBe('string');
    expect('region' in place).toBe(false);
    expect('zone' in place).toBe(false);
  });

  it('keeps the region and the time zone when they are known', () => {
    const place = makePlace('Girona', 41.98, 2.82, { region: 'Catalonia, Spain', zone: 'Europe/Madrid' });
    expect(place.region).toBe('Catalonia, Spain');
    expect(place.zone).toBe('Europe/Madrid');
    expect('zone' in makePlace('Pin', 1, 2, { region: null, zone: null })).toBe(false);
  });

  it('does not reuse the id of a default place', () => {
    const ids = DEFAULT_PLACES.map((p) => p.id);
    expect(ids).not.toContain(makePlace('Lisbon', 38.73, -9.14).id);
  });

  it('gives places made at different moments different ids', () => {
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(1790985600000);
    const first = makePlace('A', 1, 2);
    clock.mockReturnValue(1790985600001);
    const second = makePlace('B', 1, 2);
    expect(first.id).not.toBe(second.id);
  });
});

describe('parseCoordinates', () => {
  it('reads a latitude and a longitude separated by a comma, a semicolon or a space', () => {
    expect(parseCoordinates('38.72, -9.14')).toEqual({ lat: 38.72, lng: -9.14 });
    expect(parseCoordinates('38.72,-9.14')).toEqual({ lat: 38.72, lng: -9.14 });
    expect(parseCoordinates('  -33.9 151.2  ')).toEqual({ lat: -33.9, lng: 151.2 });
    expect(parseCoordinates('4;-74')).toEqual({ lat: 4, lng: -74 });
  });

  it('is not fooled by place names and other text', () => {
    for (const text of ['Girona', 'Lisbon 1', '38.72', '38.72,', 'a, b', '', '38,7, -9,1', '1 2 3', 'N38.72 W9.14']) {
      expect(parseCoordinates(text), text).toBeNull();
    }
  });

  it('refuses positions the map cannot show', () => {
    expect(parseCoordinates('86, 10')).toBeNull();
    expect(parseCoordinates('-85.5, 10')).toBeNull();
    expect(parseCoordinates('10, 181')).toBeNull();
    expect(parseCoordinates('10, -200')).toBeNull();
    expect(parseCoordinates('85, 180')).toEqual({ lat: 85, lng: 180 });
  });
});

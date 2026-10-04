import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchPoints, searchPlaces } from './weatherApi';

// 2026-10-03 00:00 UTC, in unix seconds like Open-Meteo sends with timeformat=unixtime
const T0 = 1790985600;
const HOUR = 3600;

const LISBON = { lat: 38.75, lng: -9.125 };
const GIRONA = { lat: 42, lng: 2.875 };
const KATHMANDU = { lat: 27.75, lng: 85.375 };

/**
 * One location of an Open-Meteo answer with \`hours\` hourly values: at hour h the wind is
 * 12 + 2h km/h from 70 + 90h degrees, gusting 4.5 km/h more, at 16.75 - h degrees feeling 1.5 colder.
 */
function location(hours, extra = {}) {
  const series = (at) => Array.from({ length: hours }, (_, h) => at(h));
  return {
    latitude: 38.76,
    longitude: -9.13,
    utc_offset_seconds: 3600,
    timezone: 'Europe/Lisbon',
    timezone_abbreviation: 'GMT+1',
    elevation: 99,
    hourly: {
      time: series((h) => T0 + h * HOUR),
      temperature_2m: series((h) => 16.75 - h),
      apparent_temperature: series((h) => 15.25 - h),
      wind_speed_10m: series((h) => 12 + 2 * h),
      wind_direction_10m: series((h) => (70 + 90 * h) % 360),
      wind_gusts_10m: series((h) => 16.5 + 2 * h),
    },
    ...extra,
  };
}

/** A fetch that answers every request with \`body\`. */
function answering(body, { ok = true, status = 200 } = {}) {
  return vi.fn(async () => ({ ok, status, json: async () => body }));
}

const requestedUrl = (fetchMock, call = 0) => new URL(fetchMock.mock.calls[call][0]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchPoints', () => {
  it('asks Open-Meteo for every position in one request', async () => {
    const fetchMock = answering([location(4), location(4), location(4)]);
    vi.stubGlobal('fetch', fetchMock);

    await fetchPoints([LISBON, GIRONA, KATHMANDU]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = requestedUrl(fetchMock);
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(url.searchParams.get('latitude')).toBe('38.75,42,27.75');
    expect(url.searchParams.get('longitude')).toBe('-9.125,2.875,85.375');
  });

  it('asks for the five hourly series, as unix times, from three hours back to two days ahead', async () => {
    const fetchMock = answering(location(4));
    vi.stubGlobal('fetch', fetchMock);

    await fetchPoints([LISBON]);

    const url = requestedUrl(fetchMock);
    const hourly = url.searchParams.get('hourly').split(',');
    for (const name of ['temperature_2m', 'apparent_temperature', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m']) {
      expect(hourly).toContain(name);
    }
    expect(hourly).toHaveLength(5);
    expect(url.searchParams.get('timeformat')).toBe('unixtime');
    expect(url.searchParams.get('past_hours')).toBe('3');
    // 48 hours ahead plus the hour in progress
    expect(url.searchParams.get('forecast_hours')).toBe('49');
    expect(url.searchParams.has('forecast_days')).toBe(false);
    // km/h and Celsius are Open-Meteo's defaults; a unit override would change every number in the app
    expect(url.searchParams.get('wind_speed_unit') ?? 'kmh').toBe('kmh');
    expect(url.searchParams.get('temperature_unit') ?? 'celsius').toBe('celsius');
  });

  it('asks for the model cell each position sits in and for its time zone', async () => {
    const fetchMock = answering(location(4));
    vi.stubGlobal('fetch', fetchMock);

    await fetchPoints([LISBON]);

    const url = requestedUrl(fetchMock);
    // not Open-Meteo's default of the nearest land cell: much riding is along shores and estuaries
    expect(url.searchParams.get('cell_selection')).toBe('nearest');
    // every location then says which zone it is in, so times can be shown as local time there
    expect(url.searchParams.get('timezone')).toBe('auto');
  });

  it('gives the request a time limit', async () => {
    const fetchMock = answering(location(4));
    vi.stubGlobal('fetch', fetchMock);
    await fetchPoints([LISBON]);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('turns every location into a forecast point, in the order asked', async () => {
    const answer = [
      location(4),
      location(4, { timezone: 'Europe/Madrid' }),
      // Nepal runs 5 h 45 min ahead, and Open-Meteo starts its hours on the local hour
      location(4, { timezone: 'Asia/Kathmandu', hourly: { ...location(4).hourly, time: [0, 1, 2, 3].map((h) => T0 + 900 + h * HOUR) } }),
    ];
    vi.stubGlobal('fetch', answering(answer));
    vi.spyOn(Date, 'now').mockReturnValue(1234567890123);

    const points = await fetchPoints([LISBON, GIRONA, KATHMANDU]);

    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({
      t0: T0,
      n: 4,
      speed: [12, 14, 16, 18],
      dir: [70, 160, 250, 340],
      gust: [16.5, 18.5, 20.5, 22.5],
      temp: [16.75, 15.75, 14.75, 13.75],
      feels: [15.25, 14.25, 13.25, 12.25],
      zone: 'Europe/Lisbon',
      fetchedAt: 1234567890123,
    });
    expect(points[1].zone).toBe('Europe/Madrid');
    expect(points[2].zone).toBe('Asia/Kathmandu');
    expect(points[2].t0).toBe(T0 + 900);
  });

  it('accepts the bare object Open-Meteo sends for a single position', async () => {
    vi.stubGlobal('fetch', answering(location(3)));
    const points = await fetchPoints([LISBON]);
    expect(points).toHaveLength(1);
    expect(points[0].n).toBe(3);
    expect(points[0].speed).toEqual([12, 14, 16]);
  });

  it('keeps only the hours before the first one without wind, so a hole is never shown as calm', async () => {
    // Open-Meteo sends null where a model has no value: here the second location has no speed for hours 2 and 3
    const holed = location(4);
    holed.hourly.wind_speed_10m[2] = null;
    holed.hourly.wind_speed_10m[3] = null;
    vi.stubGlobal('fetch', answering([location(4), holed]));

    const [whole, cut] = await fetchPoints([LISBON, GIRONA]);

    expect(whole.n).toBe(4);
    expect(cut.n).toBe(2);
    for (const key of ['speed', 'dir', 'gust', 'temp', 'feels']) expect(cut[key], key).toHaveLength(2);
    expect(cut.speed).toEqual([12, 14]);
    expect(cut.dir).toEqual([70, 160]);
  });

  it('cuts at a missing direction or gust as well, and does not resume after the hole', async () => {
    const noDirection = location(5);
    noDirection.hourly.wind_direction_10m[1] = null;
    const noGust = location(5);
    noGust.hourly.wind_gusts_10m[3] = null;
    vi.stubGlobal('fetch', answering([noDirection, noGust]));

    const [a, b] = await fetchPoints([LISBON, GIRONA]);

    expect(a.n).toBe(1);
    expect(b.n).toBe(3);
  });

  it('returns a point without hours for a location whose very first hour has no wind', async () => {
    const empty = location(4);
    empty.hourly.wind_gusts_10m[0] = null;
    vi.stubGlobal('fetch', answering([location(4), empty]));

    const [whole, none] = await fetchPoints([LISBON, GIRONA]);

    expect(whole.n).toBe(4);
    expect(none.n).toBe(0);
    expect(none.speed).toEqual([]);
  });

  it('keeps the wind when only the temperature is missing', async () => {
    const noTemp = location(3);
    noTemp.hourly.temperature_2m[1] = null;
    noTemp.hourly.apparent_temperature[1] = null;
    vi.stubGlobal('fetch', answering(noTemp));

    const [point] = await fetchPoints([LISBON]);

    expect(point.n).toBe(3);
    expect(point.temp).toEqual([16.75, null, 14.75]);
  });

  it('has no zone for a location that comes without one', async () => {
    const noZone = location(2);
    delete noZone.timezone;
    vi.stubGlobal('fetch', answering(noZone));
    expect((await fetchPoints([LISBON]))[0].zone).toBeNull();
  });

  it('throws on an HTTP error instead of inventing weather, and says which', async () => {
    vi.stubGlobal('fetch', answering(null, { ok: false, status: 503 }));
    const error = await fetchPoints([LISBON]).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('503');
    expect(error.status).toBe(503);
    expect(error.limit).toBeUndefined();
  });

  it('says which allowance ran out when Open-Meteo answers 429', async () => {
    const reasons = {
      minute: 'Minutely API request limit exceeded. Please try again in one minute.',
      hour: 'Hourly API request limit exceeded. Please try again in the next hour.',
      day: 'Daily API request limit exceeded. Please try again tomorrow.',
    };
    for (const [limit, reason] of Object.entries(reasons)) {
      vi.stubGlobal('fetch', answering({ error: true, reason }, { ok: false, status: 429 }));
      const error = await fetchPoints([LISBON]).catch((e) => e);
      expect(error.status).toBe(429);
      expect(error.limit, reason).toBe(limit);
    }
  });

  it('assumes the shortest wait when a 429 comes without a readable reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    })));
    const error = await fetchPoints([LISBON]).catch((e) => e);
    expect(error.status).toBe(429);
    expect(error.limit).toBe('minute');
  });

  it('throws when the network is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(fetchPoints([LISBON])).rejects.toThrow('Failed to fetch');
  });

  it('rejects an answer with the wrong number of locations', async () => {
    vi.stubGlobal('fetch', answering([location(4), location(4)]));
    await expect(fetchPoints([LISBON, GIRONA, KATHMANDU])).rejects.toThrow('Unexpected forecast response');
    vi.stubGlobal('fetch', answering(location(4)));
    await expect(fetchPoints([LISBON, GIRONA])).rejects.toThrow('Unexpected forecast response');
  });

  it('rejects an answer that is not a forecast, such as an API error object', async () => {
    vi.stubGlobal('fetch', answering({ error: true, reason: 'Latitude must be in range of -90 to 90°.' }));
    await expect(fetchPoints([LISBON])).rejects.toThrow('Unexpected forecast response');
    vi.stubGlobal('fetch', answering([null]));
    await expect(fetchPoints([LISBON])).rejects.toThrow('Unexpected forecast response');
  });

  it('rejects an answer without hours', async () => {
    const empty = location(4);
    empty.hourly.time = [];
    vi.stubGlobal('fetch', answering(empty));
    await expect(fetchPoints([LISBON])).rejects.toThrow('Unexpected forecast response');
  });

  it('rejects an answer where a location misses a series or has a shorter one', async () => {
    const missing = location(4);
    delete missing.hourly.wind_gusts_10m;
    vi.stubGlobal('fetch', answering([location(4), missing]));
    await expect(fetchPoints([LISBON, GIRONA])).rejects.toThrow('Unexpected forecast response');

    const short = location(4);
    short.hourly.wind_speed_10m = [1, 2, 3];
    vi.stubGlobal('fetch', answering([location(4), short]));
    await expect(fetchPoints([LISBON, GIRONA])).rejects.toThrow('Unexpected forecast response');
  });

  it('rejects an answer whose times are not an hour apart', async () => {
    const daily = location(3);
    daily.hourly.time = [T0, T0 + 86400, T0 + 2 * 86400];
    vi.stubGlobal('fetch', answering(daily));
    await expect(fetchPoints([LISBON])).rejects.toThrow('Unexpected forecast response');
  });
});

describe('searchPlaces', () => {
  const girona = { id: 3121456, name: 'Girona', latitude: 41.98311, longitude: 2.82493, country: 'Spain', admin1: 'Catalonia', timezone: 'Europe/Madrid', population: 96188 };

  it('asks the Open-Meteo place search for the name, in English', async () => {
    const fetchMock = answering({ results: [girona] });
    vi.stubGlobal('fetch', fetchMock);

    await searchPlaces('São Brás de Alportel');

    const url = requestedUrl(fetchMock);
    expect(url.origin + url.pathname).toBe('https://geocoding-api.open-meteo.com/v1/search');
    expect(url.searchParams.get('name')).toBe('São Brás de Alportel');
    expect(url.searchParams.get('language')).toBe('en');
    expect(url.searchParams.get('format')).toBe('json');
    expect(Number(url.searchParams.get('count'))).toBeGreaterThan(1);
  });

  it('returns the matches with where they are and what tells them apart', async () => {
    const other = { id: 99, name: 'Girona', latitude: 10.5, longitude: -66.9, country: 'Venezuela', admin1: 'Miranda', timezone: 'America/Caracas' };
    vi.stubGlobal('fetch', answering({ results: [girona, other] }));

    const results = await searchPlaces('girona');

    expect(results).toEqual([
      { id: 3121456, name: 'Girona', region: 'Catalonia, Spain', lat: 41.98311, lng: 2.82493, zone: 'Europe/Madrid' },
      { id: 99, name: 'Girona', region: 'Miranda, Venezuela', lat: 10.5, lng: -66.9, zone: 'America/Caracas' },
    ]);
  });

  it('does not repeat the name in the region, and copes with a missing region or zone', async () => {
    vi.stubGlobal('fetch', answering({
      results: [
        { id: 1, name: 'Tokyo', latitude: 35.69, longitude: 139.69, country: 'Japan', admin1: 'Tokyo', timezone: 'Asia/Tokyo' },
        { id: 2, name: 'Singapore', latitude: 1.29, longitude: 103.85, country: 'Singapore' },
        { id: 3, name: 'Point Nemo', latitude: -48.88, longitude: -123.39 },
      ],
    }));

    const results = await searchPlaces('x');

    expect(results.map((r) => r.region)).toEqual(['Japan', '', '']);
    expect(results.map((r) => r.zone)).toEqual(['Asia/Tokyo', null, null]);
  });

  it('gives an empty list when nothing matches, which Open-Meteo answers without a results field', async () => {
    vi.stubGlobal('fetch', answering({ generationtime_ms: 0.5 }));
    expect(await searchPlaces('qqqqqq')).toEqual([]);
  });

  it('leaves out results without a name or a position', async () => {
    vi.stubGlobal('fetch', answering({ results: [null, { id: 1, name: 'Nowhere' }, { id: 2, latitude: 1, longitude: 2 }, girona] }));
    const results = await searchPlaces('x');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Girona');
  });

  it('gives every result an id, also when the service sends none', async () => {
    vi.stubGlobal('fetch', answering({ results: [{ name: 'A', latitude: 1, longitude: 2 }, { name: 'B', latitude: 3, longitude: 4 }] }));
    const ids = (await searchPlaces('x')).map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id !== undefined && id !== null)).toBe(true);
  });

  it('can be cancelled by the caller', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const search = searchPlaces('giro', controller.signal);
    controller.abort();

    await expect(search).rejects.toThrow('aborted');
  });

  it('throws on an HTTP error and when the network is down', async () => {
    vi.stubGlobal('fetch', answering(null, { ok: false, status: 500 }));
    const error = await searchPlaces('x').catch((e) => e);
    expect(error.status).toBe(500);

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(searchPlaces('x')).rejects.toThrow('Failed to fetch');
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { STATION_RANGE_KM, compareWithForecast, fetchObservations, inIpmaArea, loadObservations, nearestStation, parseObservations, saveObservations } from './ipma';

// One reading as IPMA's obs-surface.geojson lists them
const reading = (id, name, lat, lng, time, speed, sector, extra = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: {
    idEstacao: id,
    localEstacao: name,
    time,
    intensidadeVentoKM: speed,
    intensidadeVento: speed < 0 ? -99 : +(speed / 3.6).toFixed(1),
    idDireccVento: sector,
    descDirVento: '---',
    temperatura: 19.6,
    humidade: 80,
    pressao: 1021,
    precAcumulada: 0,
    radiacao: 0,
    ...extra,
  },
});
const file = (...features) => ({ type: 'FeatureCollection', features });

const GEOFISICO = [1200535, 'Lisboa (Geofísico)', 38.719, -9.1497];
const ROCA = [1210750, 'Cabo da Roca', 38.7817, -9.4975];

describe('inIpmaArea', () => {
  it('covers the mainland, Madeira and the Azores', () => {
    expect(inIpmaArea(38.72, -9.14)).toBe(true); // Lisboa
    expect(inIpmaArea(41.15, -8.61)).toBe(true); // Porto
    expect(inIpmaArea(37.02, -7.93)).toBe(true); // Faro
    expect(inIpmaArea(32.65, -16.91)).toBe(true); // Funchal
    expect(inIpmaArea(37.74, -25.67)).toBe(true); // Ponta Delgada
    expect(inIpmaArea(39.45, -31.13)).toBe(true); // Flores
  });

  it('leaves out the rest of the world', () => {
    expect(inIpmaArea(40.42, -3.7)).toBe(false); // Madrid
    expect(inIpmaArea(48.86, 2.35)).toBe(false); // Paris
    expect(inIpmaArea(28.47, -16.25)).toBe(false); // Tenerife
    expect(inIpmaArea(35, -20)).toBe(false); // open Atlantic between the islands
    expect(inIpmaArea(-38.72, -9.14)).toBe(false);
  });
});

describe('parseObservations', () => {
  it('reads a station with its wind in km/h, where it comes from and the hour in UTC', () => {
    const [station] = parseObservations(file(reading(...GEOFISICO, '2026-10-05T21:00:00', 11.9, 6)));
    expect(station).toEqual({
      id: 1200535,
      name: 'Lisboa (Geofísico)',
      lat: 38.719,
      lng: -9.1497,
      time: Date.UTC(2026, 9, 5, 21) / 1000,
      speed: 11.9,
      from: 225,
    });
  });

  it('turns the eight classes into degrees, north being 1 as well as 9', () => {
    const from = (sector) => parseObservations(file(reading(...GEOFISICO, '2026-10-05T21:00:00', 10, sector)))[0].from;
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(from)).toEqual([0, 45, 90, 135, 180, 225, 270, 315, 0]);
  });

  it('keeps a wind without a direction, as a speed alone', () => {
    const from = (sector) => parseObservations(file(reading(...GEOFISICO, '2026-10-05T21:00:00', 6.1, sector)))[0].from;
    expect(from(0)).toBeNull();
    expect(from(-99)).toBeNull();
    expect(from(12)).toBeNull();
    expect(from(undefined)).toBeNull();
  });

  it('takes the latest hour of each station that has a wind speed', () => {
    const stations = parseObservations(file(
      reading(...GEOFISICO, '2026-10-05T20:00:00', 11.9, 6),
      reading(...ROCA, '2026-10-05T20:00:00', 8.6, 5),
      reading(...GEOFISICO, '2026-10-05T22:00:00', -99, 0),
      reading(...ROCA, '2026-10-05T22:00:00', 12.2, 5),
      reading(...GEOFISICO, '2026-10-05T21:00:00', 9.4, 6),
      reading(...ROCA, '2026-10-05T21:00:00', 7.6, 5),
    ));
    expect(stations).toHaveLength(2);
    const byName = Object.fromEntries(stations.map((s) => [s.name, s]));
    // the newest hour of this one has no wind yet: the one before it stands
    expect(byName['Lisboa (Geofísico)'].speed).toBe(9.4);
    expect(byName['Lisboa (Geofísico)'].time).toBe(Date.UTC(2026, 9, 5, 21) / 1000);
    expect(byName['Cabo da Roca'].speed).toBe(12.2);
    expect(byName['Cabo da Roca'].time).toBe(Date.UTC(2026, 9, 5, 22) / 1000);
  });

  it('leaves out a station that measured no wind at all, and counts a calm as a reading', () => {
    const stations = parseObservations(file(
      reading(...GEOFISICO, '2026-10-05T21:00:00', -99, 0),
      reading(...GEOFISICO, '2026-10-05T22:00:00', -99, 0),
      reading(...ROCA, '2026-10-05T22:00:00', 0, 0),
    ));
    expect(stations.map((s) => [s.name, s.speed, s.from])).toEqual([['Cabo da Roca', 0, null]]);
  });

  it('skips what it cannot place in space or time, and survives an empty or broken file', () => {
    const good = reading(...ROCA, '2026-10-05T22:00:00', 12.2, 5);
    const noPlace = { ...reading(...GEOFISICO, '2026-10-05T22:00:00', 5, 5), geometry: null };
    const noTime = reading(...GEOFISICO, 'yesterday', 5, 5);
    const noSpeed = reading(...GEOFISICO, '2026-10-05T22:00:00', 5, 5, { intensidadeVentoKM: null });
    expect(parseObservations(file(noPlace, noTime, noSpeed, null, {}, good)).map((s) => s.name)).toEqual(['Cabo da Roca']);
    expect(parseObservations(file())).toEqual([]);
    expect(parseObservations(null)).toEqual([]);
    expect(parseObservations({ features: 'none' })).toEqual([]);
  });

  it('gives a station without a name one', () => {
    const [station] = parseObservations(file(reading(1, '  ', 38.7, -9.1, '2026-10-05T22:00:00', 5, 5)));
    expect(station.name).toBe('IPMA station');
  });
});

describe('nearestStation', () => {
  const stations = parseObservations(file(
    reading(...GEOFISICO, '2026-10-05T22:00:00', 9.4, 6),
    reading(...ROCA, '2026-10-05T22:00:00', 12.2, 5),
  ));

  it('finds the station closest to a position and says how far it is', () => {
    // Belém, 6 km west of the Geofísico and 26 km from Cabo da Roca
    const near = nearestStation(stations, 38.697, -9.206);
    expect(near.name).toBe('Lisboa (Geofísico)');
    expect(near.km).toBeGreaterThan(4);
    expect(near.km).toBeLessThan(7);
    expect(near.speed).toBe(9.4);
    // Cascais, on the other side
    expect(nearestStation(stations, 38.697, -9.42).name).toBe('Cabo da Roca');
  });

  it('has none when the nearest is too far to say much', () => {
    expect(STATION_RANGE_KM).toBe(30);
    // Setúbal, some 30 km south-east of Lisbon across the river
    expect(nearestStation(stations, 38.52, -8.89)).toBeNull();
    expect(nearestStation(stations, 38.52, -8.89, 60).name).toBe('Lisboa (Geofísico)');
    expect(nearestStation([], 38.7, -9.1)).toBeNull();
  });
});

describe('compareWithForecast', () => {
  it('calls the forecast right within 5 km/h, as the two numbers are shown', () => {
    expect(compareWithForecast(12, 12)).toBe('as forecast');
    expect(compareWithForecast(12, 8)).toBe('as forecast');
    expect(compareWithForecast(8, 12)).toBe('as forecast');
    // 12.4 and 7.6 are shown as 12 and 8
    expect(compareWithForecast(12.4, 7.6)).toBe('as forecast');
  });

  it('says which way the forecast was out from 5 km/h on', () => {
    expect(compareWithForecast(17, 12)).toBe('stronger than forecast');
    expect(compareWithForecast(30, 12)).toBe('stronger than forecast');
    expect(compareWithForecast(7, 12)).toBe('lighter than forecast');
    expect(compareWithForecast(0, 22)).toBe('lighter than forecast');
  });

  it('has nothing to say without a forecast or without a measurement', () => {
    expect(compareWithForecast(12, null)).toBeNull();
    expect(compareWithForecast(12, undefined)).toBeNull();
    expect(compareWithForecast(12, NaN)).toBeNull();
    expect(compareWithForecast(NaN, 12)).toBeNull();
  });
});

describe('fetchObservations', () => {
  afterEach(() => vi.unstubAllGlobals());

  const answer = (body, ok = true, status = 200) => vi.fn(async () => ({ ok, status, json: async () => body }));

  it('asks IPMA for the file of the last hours and returns its stations', async () => {
    const fetchMock = answer(file(reading(...ROCA, '2026-10-05T22:00:00', 12.2, 5)));
    vi.stubGlobal('fetch', fetchMock);
    const stations = await fetchObservations();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.ipma.pt/open-data/observation/meteorology/stations/obs-surface.geojson');
    expect(stations.map((s) => s.name)).toEqual(['Cabo da Roca']);
  });

  it('sends nothing about the place the user is looking at', async () => {
    const fetchMock = answer(file());
    vi.stubGlobal('fetch', fetchMock);
    await fetchObservations();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).not.toMatch(/[?&#]/);
    expect(options.body).toBeUndefined();
    expect(options.headers).toBeUndefined();
  });

  it('throws when IPMA does not answer with the file', async () => {
    vi.stubGlobal('fetch', answer({}, false, 503));
    await expect(fetchObservations()).rejects.toThrow('IPMA answered 503');
    vi.stubGlobal('fetch', answer({ message: 'maintenance' }));
    await expect(fetchObservations()).rejects.toThrow('Unexpected observations response');
  });
});

describe('saveObservations and loadObservations', () => {
  const memory = () => {
    const data = {};
    return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); } };
  };
  const station = { id: 1, name: 'Lisboa, Geofísico', lat: 38.72, lng: -9.15, time: 1790985600, speed: 12, from: 315 };

  it('keeps the last download, and when it was made', () => {
    const storage = memory();
    saveObservations([station], 1790985600000, storage);
    expect(loadObservations(storage)).toEqual({ stations: [station], at: 1790985600000 });
  });

  it('has nothing when nothing is kept, or what is kept is not usable', () => {
    const storage = memory();
    expect(loadObservations(storage)).toBeNull();
    storage.setItem('wind-ipma-v1', 'not json');
    expect(loadObservations(storage)).toBeNull();
    storage.setItem('wind-ipma-v1', JSON.stringify({ at: 'yesterday', stations: [] }));
    expect(loadObservations(storage)).toBeNull();
  });

  it('drops a kept station that is not whole', () => {
    const storage = memory();
    saveObservations([station, { ...station, speed: null }, { ...station, from: 'NW' }], 5, storage);
    expect(loadObservations(storage).stations).toEqual([station]);
  });

  it('goes without when the storage refuses', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
    expect(() => saveObservations([station], 5, broken)).not.toThrow();
    expect(loadObservations(broken)).toBeNull();
  });
});

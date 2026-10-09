// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ROUTE_MAX_KM, RoutingError, decodePolyline, fetchBikeRoute, reachKm, toGpx } from './routing';
import { parseGpxData } from './gpxParser';

const LISBON = { lat: 38.7223, lng: -9.1393 };
const ALVERCA = { lat: 38.8975, lng: -9.0344 };
const PORTO = { lat: 41.1496, lng: -8.611 };

// Google's own example of an encoded polyline, with five decimals
const GOOGLE_SAMPLE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const GOOGLE_POINTS = [{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }];

// a BRouter answer: a GPX track of three points with heights
const BROUTER_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<!-- track-length = 25628 filtered ascend = 200 -->
<gpx xmlns="http://www.topografix.com/GPX/1/1" creator="BRouter-1.7.10" version="1.1">
 <trk><name>brouter_fastbike_0</name><trkseg>
   <trkpt lon="-9.139302" lat="38.722305"><ele>61.25</ele></trkpt>
   <trkpt lon="-9.1" lat="38.8"><ele>40</ele></trkpt>
   <trkpt lon="-9.0344" lat="38.8975"><ele>12.5</ele></trkpt>
 </trkseg></trk>
</gpx>`;

// a Valhalla answer: one leg whose shape is the Google sample, and the heights of its three points
const VALHALLA_ROUTE = { trip: { legs: [{ shape: GOOGLE_SAMPLE }], summary: { length: 24.3 } } };
const VALHALLA_HEIGHTS = { height: [10, 20, 30] };

const answer = (status, body, type = 'application/json') => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  headers: { get: () => type },
});

/** A fetch that answers each service as told: { brouter, valhalla, height } are answers or errors to throw. */
function stubFetch({ brouter, valhalla, height }) {
  const calls = [];
  const fetchMock = vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const pick = String(url).includes('brouter.de') ? brouter : String(url).endsWith('/height') ? height : valhalla;
    if (pick instanceof Error) throw pick;
    return pick;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('decodePolyline', () => {
  it('reads an encoded polyline with the decimals it was written with', () => {
    expect(decodePolyline(GOOGLE_SAMPLE, 5)).toEqual(GOOGLE_POINTS);
    // Valhalla writes six: the same text then stands for points ten times closer to zero
    const six = decodePolyline(GOOGLE_SAMPLE);
    expect(six).toHaveLength(3);
    six.forEach((p, i) => {
      expect(p.lat).toBeCloseTo(GOOGLE_POINTS[i].lat / 10, 9);
      expect(p.lng).toBeCloseTo(GOOGLE_POINTS[i].lng / 10, 9);
    });
  });

  it('is empty for an empty text', () => {
    expect(decodePolyline('')).toEqual([]);
  });
});

describe('toGpx', () => {
  it('writes a track that parseGpxData reads back, heights included', () => {
    const route = parseGpxData(toGpx([{ lat: 38.7, lng: -9.2, ele: 10 }, { lat: 38.71, lng: -9.2, ele: 30 }, { lat: 38.72, lng: -9.2, ele: 25 }]), 'Made up');
    expect(route.name).toBe('Made up');
    expect(route.points).toHaveLength(3);
    expect(route.points[0]).toMatchObject({ lat: 38.7, lng: -9.2, ele: 10 });
    expect(route.totalDistance).toBeCloseTo(2.224, 2);
    expect(route.totalElevationGain).toBe(20);
  });

  it('leaves out the height of a point that has none', () => {
    const gpx = toGpx([{ lat: 38.7, lng: -9.2, ele: NaN }, { lat: 38.71, lng: -9.2 }]);
    expect(gpx).not.toContain('<ele>');
    expect(parseGpxData(gpx).points.map((p) => p.ele)).toEqual([0, 0]);
  });
});

describe('reachKm', () => {
  it('is how far the farthest point is from the start, as the crow flies', () => {
    // Lisbon to Alverca is about 21.5 km in a straight line
    expect(reachKm([LISBON, ALVERCA])).toBeGreaterThan(21);
    expect(reachKm([LISBON, ALVERCA])).toBeLessThan(22);
    // there and back: the start counts for nothing
    expect(reachKm([LISBON, ALVERCA, LISBON])).toBeCloseTo(reachKm([LISBON, ALVERCA]), 9);
    expect(reachKm([LISBON])).toBe(0);
  });
});

describe('fetchBikeRoute', () => {
  it('asks BRouter for a fastbike route through the points, as longitude and latitude, and hands its GPX on', async () => {
    const calls = stubFetch({ brouter: answer(200, BROUTER_GPX, 'application/gpx+xml') });
    const route = await fetchBikeRoute([LISBON, ALVERCA]);
    expect(route).toEqual({ gpx: BROUTER_GPX, by: 'BRouter' });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://brouter.de/brouter');
    expect(url.searchParams.get('lonlats')).toBe('-9.1393,38.7223|-9.0344,38.8975');
    expect(url.searchParams.get('profile')).toBe('fastbike');
    expect(url.searchParams.get('format')).toBe('gpx');
    expect(url.searchParams.get('alternativeidx')).toBe('0');
  });

  it('asks for a ride there and back as one route through the start twice', async () => {
    const calls = stubFetch({ brouter: answer(200, BROUTER_GPX) });
    await fetchBikeRoute([LISBON, ALVERCA, LISBON]);
    expect(new URL(calls[0].url).searchParams.get('lonlats')).toBe('-9.1393,38.7223|-9.0344,38.8975|-9.1393,38.7223');
  });

  it('turns to Valhalla when BRouter finds no way, and builds the GPX from its line and heights', async () => {
    const calls = stubFetch({ brouter: answer(400, 'datafile W15_N35.rd5 not found', 'text/plain'), valhalla: answer(200, VALHALLA_ROUTE), height: answer(200, VALHALLA_HEIGHTS) });
    const route = await fetchBikeRoute([LISBON, ALVERCA]);
    expect(route.by).toBe('Valhalla');
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/brouter', '/route', '/height']);
    const asked = JSON.parse(calls[1].options.body);
    expect(asked.costing).toBe('bicycle');
    expect(asked.costing_options.bicycle.bicycle_type).toBe('Road');
    expect(asked.locations).toEqual([{ lat: 38.7223, lon: -9.1393 }, { lat: 38.8975, lon: -9.0344 }]);
    expect(JSON.parse(calls[2].options.body)).toEqual({ encoded_polyline: GOOGLE_SAMPLE });
    const parsed = parseGpxData(route.gpx, 'Made up');
    expect(parsed.points).toHaveLength(3);
    parsed.points.forEach((p, i) => {
      expect(p.lat).toBeCloseTo(GOOGLE_POINTS[i].lat / 10, 6);
      expect(p.lng).toBeCloseTo(GOOGLE_POINTS[i].lng / 10, 6);
      expect(p.ele).toBe([10, 20, 30][i]);
    });
  });

  it('turns to Valhalla when BRouter is down or does not answer in time', async () => {
    for (const trouble of [answer(500, ''), answer(502, 'bad gateway', 'text/html'), Object.assign(new Error('timed out'), { name: 'TimeoutError' }), answer(200, 'operation killed', 'text/plain')]) {
      vi.unstubAllGlobals();
      stubFetch({ brouter: trouble, valhalla: answer(200, VALHALLA_ROUTE), height: answer(200, VALHALLA_HEIGHTS) });
      expect((await fetchBikeRoute([LISBON, ALVERCA])).by).toBe('Valhalla');
    }
  });

  it('does without the heights when Valhalla does not give them', async () => {
    stubFetch({ brouter: answer(500, ''), valhalla: answer(200, VALHALLA_ROUTE), height: new TypeError('Failed to fetch') });
    const route = await fetchBikeRoute([LISBON, ALVERCA]);
    expect(route.by).toBe('Valhalla');
    expect(route.gpx).not.toContain('<ele>');
    expect(parseGpxData(route.gpx).points).toHaveLength(3);
  });

  it('joins the legs of a ride there and back without doubling the turning point', async () => {
    stubFetch({ brouter: answer(500, ''), valhalla: answer(200, { trip: { legs: [{ shape: GOOGLE_SAMPLE }, { shape: GOOGLE_SAMPLE }] } }), height: answer(200, VALHALLA_HEIGHTS) });
    const route = await fetchBikeRoute([LISBON, ALVERCA, LISBON]);
    expect(parseGpxData(route.gpx).points).toHaveLength(5);
  });

  it('refuses a point too far away before asking anyone', async () => {
    const calls = stubFetch({});
    const error = await fetchBikeRoute([LISBON, PORTO]).catch((e) => e);
    expect(error).toBeInstanceOf(RoutingError);
    expect(error.kind).toBe('far');
    expect(error.message).toMatch(/^That point is 27\d km away as the crow flies: too far to ride to from here\.$/);
    expect(calls).toHaveLength(0);
    expect(ROUTE_MAX_KM).toBe(200);
  });

  it('says there is no way when either service says so, and both have been asked', async () => {
    stubFetch({ brouter: answer(400, 'no way', 'text/plain'), valhalla: answer(400, { error_code: 171, error: 'No suitable edges near location' }) });
    const error = await fetchBikeRoute([LISBON, ALVERCA]).catch((e) => e);
    expect(error.kind).toBe('none');
    expect(error.message).toBe('No bike route was found to that point.');
    vi.unstubAllGlobals();
    stubFetch({ brouter: answer(503, ''), valhalla: answer(400, {}) });
    expect((await fetchBikeRoute([LISBON, ALVERCA]).catch((e) => e)).kind).toBe('none');
  });

  it('tells a lost connection from services that are down', async () => {
    stubFetch({ brouter: new TypeError('Failed to fetch'), valhalla: new TypeError('Failed to fetch') });
    const offline = await fetchBikeRoute([LISBON, ALVERCA]).catch((e) => e);
    expect(offline.kind).toBe('offline');
    expect(offline.message).toBe('Could not reach the routing service. Check your connection.');
    vi.unstubAllGlobals();
    stubFetch({ brouter: answer(500, ''), valhalla: new TypeError('Failed to fetch') });
    const down = await fetchBikeRoute([LISBON, ALVERCA]).catch((e) => e);
    expect(down.kind).toBe('service');
    expect(down.message).toBe('The routing services are not answering right now. Try again in a while.');
  });

  it('is cancelled by its signal without turning to the next service', async () => {
    const controller = new AbortController();
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const calls = stubFetch({ brouter: aborted, valhalla: answer(200, VALHALLA_ROUTE) });
    controller.abort();
    await expect(fetchBikeRoute([LISBON, ALVERCA], { signal: controller.signal })).rejects.toThrow('aborted');
    expect(calls).toHaveLength(1);
  });
});

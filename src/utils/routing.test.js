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

// writes points the way decodePolyline reads them: the way back of a ride, for a test
function encodePolyline(points, precision = 6) {
  const scale = 10 ** precision;
  let out = '';
  let lastLat = 0;
  let lastLng = 0;
  const push = (value) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * scale);
    const lng = Math.round(p.lng * scale);
    push(lat - lastLat);
    push(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return out;
}

// what a real fetch rejects with once its signal is aborted
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
// an answer that never comes, until the request's own signal gives up on it
const SILENT = Symbol('silent');

/**
 * A fetch that answers each service as told: { brouter, valhalla, height } are answers, errors to throw, or
 * SILENT, which only ever rejects with an AbortError once the signal fetch was given is aborted (a
 * timeout, or the caller). `height` may also be a function of the request's body.
 */
function stubFetch({ brouter, valhalla, height }) {
  const calls = [];
  const fetchMock = vi.fn((url, options = {}) => {
    calls.push({ url: String(url), options });
    let pick = String(url).includes('brouter.de') ? brouter : String(url).endsWith('/height') ? height : valhalla;
    if (typeof pick === 'function') pick = pick(JSON.parse(options.body));
    if (pick === SILENT) {
      return new Promise((resolve, reject) => {
        const { signal } = options;
        if (signal?.aborted) reject(abortError());
        else signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    }
    if (pick instanceof Error) return Promise.reject(pick);
    return Promise.resolve(pick);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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
    // both are sent as JSON, which a GET could not carry
    for (const call of calls.slice(1)) {
      expect(call.options.method).toBe('POST');
      expect(call.options.headers['Content-Type']).toBe('application/json');
    }
    const parsed = parseGpxData(route.gpx, 'Made up');
    expect(parsed.points).toHaveLength(3);
    parsed.points.forEach((p, i) => {
      expect(p.lat).toBeCloseTo(GOOGLE_POINTS[i].lat / 10, 6);
      expect(p.lng).toBeCloseTo(GOOGLE_POINTS[i].lng / 10, 6);
      expect(p.ele).toBe([10, 20, 30][i]);
    });
  });

  it('turns to Valhalla when BRouter is down or answers with something else', async () => {
    for (const trouble of [answer(500, ''), answer(502, 'bad gateway', 'text/html'), answer(200, 'operation killed', 'text/plain')]) {
      vi.unstubAllGlobals();
      stubFetch({ brouter: trouble, valhalla: answer(200, VALHALLA_ROUTE), height: answer(200, VALHALLA_HEIGHTS) });
      expect((await fetchBikeRoute([LISBON, ALVERCA])).by).toBe('Valhalla');
    }
  });

  it('gives BRouter 30 seconds, then turns to Valhalla', async () => {
    vi.useFakeTimers();
    const calls = stubFetch({ brouter: SILENT, valhalla: answer(200, VALHALLA_ROUTE), height: answer(200, VALHALLA_HEIGHTS) });
    let settled = null;
    const route = fetchBikeRoute([LISBON, ALVERCA]).then((r) => { settled = r; return r; });
    await vi.advanceTimersByTimeAsync(29999);
    expect(calls).toHaveLength(1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect((await route).by).toBe('Valhalla');
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/brouter', '/route', '/height']);
  });

  it('gives Valhalla 15 seconds, and then says the services are not answering', async () => {
    vi.useFakeTimers();
    stubFetch({ brouter: answer(500, ''), valhalla: SILENT });
    const route = fetchBikeRoute([LISBON, ALVERCA]).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15000);
    const error = await route;
    expect(error).toBeInstanceOf(RoutingError);
    expect(error.kind).toBe('service');
  });

  it('does without the heights when they do not come in time', async () => {
    vi.useFakeTimers();
    stubFetch({ brouter: answer(500, ''), valhalla: answer(200, VALHALLA_ROUTE), height: SILENT });
    const route = fetchBikeRoute([LISBON, ALVERCA]);
    await vi.advanceTimersByTimeAsync(15000);
    expect((await route).gpx).not.toContain('<ele>');
  });

  it('does without the heights when Valhalla does not give them', async () => {
    stubFetch({ brouter: answer(500, ''), valhalla: answer(200, VALHALLA_ROUTE), height: new TypeError('Failed to fetch') });
    const route = await fetchBikeRoute([LISBON, ALVERCA]);
    expect(route.by).toBe('Valhalla');
    expect(route.gpx).not.toContain('<ele>');
    expect(parseGpxData(route.gpx).points).toHaveLength(3);
  });

  it('joins the legs of a ride there and back without doubling the turning point, each with its own heights', async () => {
    // the way back: the same line the other way round, written afresh
    const back = encodePolyline([...decodePolyline(GOOGLE_SAMPLE)].reverse());
    expect(back).not.toBe(GOOGLE_SAMPLE);
    const heights = { [GOOGLE_SAMPLE]: [1, 2, 3], [back]: [3, 40, 50] };
    stubFetch({
      brouter: answer(500, ''),
      valhalla: answer(200, { trip: { legs: [{ shape: GOOGLE_SAMPLE }, { shape: back }] } }),
      height: (body) => answer(200, { height: heights[body.encoded_polyline] }),
    });
    const route = await fetchBikeRoute([LISBON, ALVERCA, LISBON]);
    const points = parseGpxData(route.gpx).points;
    expect(points).toHaveLength(5);
    expect(points.map((p) => p.ele)).toEqual([1, 2, 3, 40, 50]);
    // the fourth and fifth points are the way back: the first two points of the line, the other way round
    expect(points[3].lat).toBeCloseTo(GOOGLE_POINTS[1].lat / 10, 6);
    expect(points[4].lat).toBeCloseTo(GOOGLE_POINTS[0].lat / 10, 6);
  });

  it('refuses a point too far away before asking anyone', async () => {
    const calls = stubFetch({});
    const error = await fetchBikeRoute([LISBON, PORTO]).catch((e) => e);
    expect(error).toBeInstanceOf(RoutingError);
    expect(error.kind).toBe('far');
    expect(error.message).toMatch(/^That point is 27\d km away as the crow flies: too far to ride to from here\.$/);
    expect(calls).toHaveLength(0);
    expect(ROUTE_MAX_KM).toBe(200);
    // a point just over the limit is not called 200 km away, which would be within it
    const just = { lat: LISBON.lat + 200.32 / 111.19492664455873, lng: LISBON.lng };
    expect((await fetchBikeRoute([LISBON, just]).catch((e) => e)).message).toMatch(/^That point is 201 km away/);
  });

  it('says there is no way when either service says so, and both have been asked', async () => {
    stubFetch({ brouter: answer(400, 'no way', 'text/plain'), valhalla: answer(400, { error_code: 171, error: 'No suitable edges near location' }) });
    const error = await fetchBikeRoute([LISBON, ALVERCA]).catch((e) => e);
    expect(error.kind).toBe('none');
    expect(error.message).toBe('No bike route was found to that point.');
    vi.unstubAllGlobals();
    stubFetch({ brouter: answer(503, ''), valhalla: answer(400, {}) });
    expect((await fetchBikeRoute([LISBON, ALVERCA]).catch((e) => e)).kind).toBe('none');
    // and the other way round: BRouter's 400 is "no way" even when Valhalla is down
    vi.unstubAllGlobals();
    stubFetch({ brouter: answer(400, 'datafile not found', 'text/plain'), valhalla: answer(500, '') });
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
    const calls = stubFetch({ brouter: SILENT, valhalla: answer(200, VALHALLA_ROUTE) });
    const route = fetchBikeRoute([LISBON, ALVERCA], { signal: controller.signal });
    controller.abort();
    await expect(route).rejects.toThrow('aborted');
    // the signal reached the request itself
    expect(calls).toHaveLength(1);
    expect(calls[0].options.signal.aborted).toBe(true);
  });

  it('is cancelled while Valhalla is asked, and while its heights are', async () => {
    const during = new AbortController();
    const calls = stubFetch({ brouter: answer(500, ''), valhalla: SILENT });
    const route = fetchBikeRoute([LISBON, ALVERCA], { signal: during.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    during.abort();
    await expect(route).rejects.toThrow('aborted');
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/brouter', '/route']);

    vi.unstubAllGlobals();
    const late = new AbortController();
    stubFetch({ brouter: answer(500, ''), valhalla: answer(200, VALHALLA_ROUTE), height: SILENT });
    const later = fetchBikeRoute([LISBON, ALVERCA], { signal: late.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    late.abort();
    await expect(later).rejects.toThrow('aborted');
  });
});

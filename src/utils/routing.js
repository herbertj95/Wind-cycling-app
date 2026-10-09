// A road-bike route between points, from a routing service: BRouter first, Valhalla when BRouter does not
// answer. Both run on OpenStreetMap data, need no key, and are public servers kept for fair use.
// Nothing here knows about the map or the wind: the route comes back as GPX, which the app reads like a file.
import { timeoutSignal } from './net';
import { calculateDistance } from './gpxParser';

const BROUTER_URL = 'https://brouter.de/brouter';
const VALHALLA_URL = 'https://valhalla1.openstreetmap.de';
// The way BRouter picks roads for a road bike: fast, on asphalt, off the big roads where it can
const BROUTER_PROFILE = 'fastbike';
// BRouter searches for close to a minute before it gives an impossible route up; a ride-length route is
// answered in a second or two
const BROUTER_TIMEOUT_MS = 30000;
const VALHALLA_TIMEOUT_MS = 15000;
// Valhalla writes its line with six decimals
const POLYLINE_PRECISION = 6;
/** A point further than this from the start, as the crow flies, is not routed to: too far for a ride. */
export const ROUTE_MAX_KM = 200;

const MESSAGES = {
  far: (km) => `That point is ${Math.round(km)} km away as the crow flies: too far to ride to from here.`,
  none: 'No bike route was found to that point.',
  offline: 'Could not reach the routing service. Check your connection.',
  service: 'The routing services are not answering right now. Try again in a while.',
};

/** Why a route could not be made: `kind` is 'far', 'none', 'offline' or 'service'. */
export class RoutingError extends Error {
  constructor(kind, km) {
    super(kind === 'far' ? MESSAGES.far(km) : MESSAGES[kind]);
    this.name = 'RoutingError';
    this.kind = kind;
  }
}

/** The number of km, as the crow flies, between the first point and the one farthest from it. */
export function reachKm(waypoints) {
  const [start] = waypoints;
  return Math.max(0, ...waypoints.slice(1).map((p) => calculateDistance(start.lat, start.lng, p.lat, p.lng)));
}

/**
 * The points of an encoded polyline, as [{ lat, lng }]. Google's encoding, with `precision` decimals
 * (5 in most places, 6 in Valhalla).
 */
export function decodePolyline(text, precision = POLYLINE_PRECISION) {
  const scale = 10 ** precision;
  const points = [];
  let lat = 0;
  let lng = 0;
  let at = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = text.charCodeAt(at++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (at < text.length) {
    lat += next();
    lng += next();
    points.push({ lat: lat / scale, lng: lng / scale });
  }
  return points;
}

/**
 * A GPX document with one track through `points` ([{ lat, lng, ele? }]), as parseGpxData reads it.
 * Points without an elevation are written without one.
 */
export function toGpx(points) {
  const trkpts = points
    .map((p) => `<trkpt lat="${p.lat}" lon="${p.lng}">${Number.isFinite(p.ele) ? `<ele>${p.ele}</ele>` : ''}</trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Wind Cycling" xmlns="http://www.topografix.com/GPX/1/1">
<trk><trkseg>
${trkpts}
</trkseg></trk>
</gpx>
`;
}

// what went wrong with a request, as the kind of RoutingError it would be
function kindOf(error) {
  if (error instanceof RoutingError) return error.kind;
  if (error instanceof TypeError) return 'offline';
  return 'service';
}

async function fromBRouter(waypoints, signal) {
  const params = new URLSearchParams({
    lonlats: waypoints.map((p) => `${p.lng},${p.lat}`).join('|'),
    profile: BROUTER_PROFILE,
    alternativeidx: '0',
    format: 'gpx',
  });
  const response = await fetch(`${BROUTER_URL}?${params}`, { signal: timeoutSignal(BROUTER_TIMEOUT_MS, signal) });
  // 400 is BRouter's word for "no way": a point off its maps, or a search it gave up on
  if (response.status === 400) throw new RoutingError('none');
  if (!response.ok) throw new Error(`BRouter answered ${response.status}`);
  const gpx = await response.text();
  if (!gpx.includes('<trkpt')) throw new Error('Unexpected BRouter response');
  return gpx;
}

async function fromValhalla(waypoints, signal) {
  const body = {
    locations: waypoints.map((p) => ({ lat: p.lat, lon: p.lng })),
    costing: 'bicycle',
    costing_options: { bicycle: { bicycle_type: 'Road' } },
  };
  const response = await fetch(`${VALHALLA_URL}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeoutSignal(VALHALLA_TIMEOUT_MS, signal),
  });
  // 400 is Valhalla's word for "no way": no road near a point, or a ride too long for it
  if (response.status === 400) throw new RoutingError('none');
  if (!response.ok) throw new Error(`Valhalla answered ${response.status}`);
  const json = await response.json();
  const legs = json?.trip?.legs;
  if (!Array.isArray(legs) || legs.length === 0) throw new Error('Unexpected Valhalla response');

  const points = [];
  for (const leg of legs) {
    const shape = decodePolyline(leg.shape);
    // the route comes without heights: they are asked for apart, and done without when they do not come
    let heights = [];
    try {
      const answer = await fetch(`${VALHALLA_URL}/height`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encoded_polyline: leg.shape }),
        signal: timeoutSignal(VALHALLA_TIMEOUT_MS, signal),
      });
      if (answer.ok) heights = (await answer.json()).height ?? [];
    } catch {
      // the profile of the ride will be flat, the wind along it is what matters
    }
    shape.forEach((p, i) => {
      // legs share their joining point
      if (points.length > 0 && i === 0) return;
      points.push({ ...p, ele: Number.isFinite(heights[i]) ? heights[i] : NaN });
    });
  }
  if (points.length < 2) throw new Error('Unexpected Valhalla response');
  return toGpx(points);
}

/**
 * A route for a road bike through `waypoints` ([{ lat, lng }], two or more; the start twice over for a
 * ride there and back), as { gpx, by } with `by` the service that made it, 'BRouter' or 'Valhalla'.
 * Throws a RoutingError that says why when none can be made: a point too far from the start, no way
 * between the points, no connection, or the services not answering. `signal` cancels the request.
 */
export async function fetchBikeRoute(waypoints, { signal } = {}) {
  const km = reachKm(waypoints);
  if (km > ROUTE_MAX_KM) throw new RoutingError('far', km);
  let first;
  try {
    return { gpx: await fromBRouter(waypoints, signal), by: 'BRouter' };
  } catch (error) {
    if (signal?.aborted) throw error;
    first = kindOf(error);
  }
  try {
    return { gpx: await fromValhalla(waypoints, signal), by: 'Valhalla' };
  } catch (error) {
    if (signal?.aborted) throw error;
    const second = kindOf(error);
    // one service saying "no way" is an answer; two services out of reach is a connection
    if (first === 'none' || second === 'none') throw new RoutingError('none');
    throw new RoutingError(first === 'offline' && second === 'offline' ? 'offline' : 'service');
  }
}

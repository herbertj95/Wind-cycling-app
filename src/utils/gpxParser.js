// GPX parsing and the geometry a route needs: distance, heading and climbing.

const RAD = Math.PI / 180;

/**
 * Calculates the spherical distance between two coordinates in kilometers (Haversine formula)
 */
export function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculates the bearing/heading from point A to point B in degrees (0 to 360)
 */
export function calculateBearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * RAD;
  const lat1Rad = lat1 * RAD;
  const lat2Rad = lat2 * RAD;

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

  const brng = Math.atan2(y, x) / RAD;
  return (brng + 360) % 360;
}

// Points kept for the wind analysis and the profile. Distance and climbing are measured on the full track
// first, so thinning never shortens the route.
const MAX_POINTS = 600;
// The line drawn on the map keeps far more points, so it follows the road when you zoom in.
const MAX_PATH_POINTS = 4000;
// Elevation has to move this far before it counts as climbing, which filters GPS and barometer noise.
const CLIMB_THRESHOLD_M = 2;
// Half-width of the elevation smoothing window, in km of track
const SMOOTHING_WINDOW_KM = 0.03;
// A jump far longer than the track's usual point spacing means the recording was paused (a ferry, a train).
// It was not ridden: it adds no distance, and the point after it is marked `gap` so nothing is drawn across it.
// The limit is relative, so a planned route with a point every kilometre is not mistaken for a string of gaps.
const GAP_MIN_KM = 0.5;
const GAP_SPACING_FACTOR = 20;

function readPoints(xmlDoc) {
  let nodes = xmlDoc.getElementsByTagNameNS('*', 'trkpt');
  if (nodes.length === 0) nodes = xmlDoc.getElementsByTagNameNS('*', 'rtept');

  const raw = [];
  let lastEle = null;
  for (const node of nodes) {
    const lat = parseFloat(node.getAttribute('lat'));
    const lng = parseFloat(node.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;

    const eleEl = node.getElementsByTagNameNS('*', 'ele')[0];
    const ele = eleEl ? parseFloat(eleEl.textContent) : NaN;
    if (Number.isFinite(ele)) lastEle = ele;
    raw.push({ lat, lng, ele: Number.isFinite(ele) ? ele : lastEle });
  }

  // Points before the first elevation reading take that first reading; a track with none sits at 0.
  const firstEle = raw.find((p) => p.ele !== null)?.ele ?? 0;
  raw.forEach((p) => {
    if (p.ele === null) p.ele = firstEle;
  });
  return raw;
}

/**
 * Total climbing in metres. `points` need `ele` and a cumulative `distance` in km.
 * Each stretch between recording gaps is counted on its own.
 */
function calculateElevationGain(points) {
  let gain = 0;
  let start = 0;
  for (let i = 1; i <= points.length; i++) {
    if (i === points.length || points[i].gap) {
      gain += climbIn(points.slice(start, i));
      start = i;
    }
  }
  return Math.round(gain);
}

function climbIn(points) {
  // Average each elevation with its neighbours within SMOOTHING_WINDOW_KM along the track. On a recorded
  // ride that irons out sensor jitter; on a sparse planned route the window holds one point, so hills survive.
  const smooth = new Array(points.length);
  let start = 0;
  let end = 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    while (end < points.length && points[end].distance <= points[i].distance + SMOOTHING_WINDOW_KM) {
      sum += points[end].ele;
      end++;
    }
    while (points[start].distance < points[i].distance - SMOOTHING_WINDOW_KM) {
      sum -= points[start].ele;
      start++;
    }
    smooth[i] = sum / (end - start);
  }

  // Count every climb from its lowest to its highest point. A change of direction only counts once it
  // exceeds the threshold, so wobble smaller than that neither starts nor ends a climb.
  let gain = 0;
  let climbing = false;
  let valley = smooth[0] ?? 0;
  let peak = valley;
  for (const ele of smooth) {
    if (climbing) {
      if (ele > peak) {
        peak = ele;
      } else if (peak - ele >= CLIMB_THRESHOLD_M) {
        gain += peak - valley;
        climbing = false;
        valley = ele;
      }
    } else if (ele < valley) {
      valley = ele;
    } else if (ele - valley >= CLIMB_THRESHOLD_M) {
      climbing = true;
      peak = ele;
    }
  }
  if (climbing) gain += peak - valley;
  return gain;
}

/**
 * The same track ridden the other way, for measuring: what was descent is climbing. A jump is marked on
 * the point after it, which the other way round is the point that came before it.
 */
function backwards(points, total) {
  return points.map((_, i) => {
    const pt = points[points.length - 1 - i];
    const turned = { ele: pt.ele, distance: total - pt.distance };
    if (points[points.length - i]?.gap) turned.gap = true;
    return turned;
  });
}

/**
 * Keeps the first and last point, both sides of every gap, and otherwise one point per `spacing` km travelled.
 */
function thinByDistance(items, spacing) {
  const kept = [];
  items.forEach((pt, i) => {
    const last = kept[kept.length - 1];
    const isEdge = i === items.length - 1 || pt.gap || items[i + 1]?.gap;
    if (!last || isEdge || pt.distance - last.distance >= spacing) kept.push(pt);
  });
  return kept;
}

/**
 * Parses GPX XML content string into a route:
 * - points: thinned trackpoints for analysis: { lat, lng, ele, distance (km ridden), bearing, pathKm, gap? }
 * - parts: the line to draw, as lists of [lng, lat], split where the recording jumps
 * - pathLength: km along that line, jumps included; a point's `pathKm` is where it sits on it
 * - totalDistance (km ridden), totalElevationGain (m) and totalElevationLoss (m), which is the climbing
 *   of the same route ridden the other way
 */
export function parseGpxData(gpxText, routeName = 'Imported Route') {
  const xmlDoc = new DOMParser().parseFromString(gpxText, 'text/xml');
  if (xmlDoc.getElementsByTagName('parsererror')[0]) {
    throw new Error('This file is not valid GPX.');
  }

  const raw = readPoints(xmlDoc);
  if (raw.length < 2) {
    throw new Error('No track found in this GPX file.');
  }

  const steps = raw.map((pt, i) => (i > 0 ? calculateDistance(raw[i - 1].lat, raw[i - 1].lng, pt.lat, pt.lng) : 0));
  // median distance between points that actually moved (a rider standing still records the same spot many times)
  const moving = steps.filter((step) => step > 0).sort((a, b) => a - b);
  const typicalStep = moving[Math.floor(moving.length / 2)] ?? 0;
  const gapLimit = Math.max(GAP_MIN_KM, typicalStep * GAP_SPACING_FACTOR);

  let cumulativeDistance = 0;
  raw.forEach((pt, i) => {
    if (steps[i] > gapLimit) pt.gap = true;
    else cumulativeDistance += steps[i];
    pt.distance = cumulativeDistance;
  });
  if (cumulativeDistance < 0.05) {
    throw new Error('This GPX track is too short to analyse.');
  }

  // The line for the map, and how far along it each of its points sits
  const path = thinByDistance(raw, cumulativeDistance / MAX_PATH_POINTS);
  let pathLength = 0;
  const parts = [];
  path.forEach((pt, i) => {
    if (i > 0) pathLength += calculateDistance(path[i - 1].lat, path[i - 1].lng, pt.lat, pt.lng);
    pt.pathKm = pathLength;
    if (pt.gap || parts.length === 0) parts.push([]);
    parts[parts.length - 1].push([pt.lng, pt.lat]);
  });

  // The points for the analysis are taken from that line, so each one knows its place on it
  const points = thinByDistance(path, cumulativeDistance / MAX_POINTS).map((pt) => {
    const kept = { lat: pt.lat, lng: pt.lng, ele: pt.ele, distance: pt.distance, bearing: 0, pathKm: pt.pathKm };
    if (pt.gap) kept.gap = true;
    return kept;
  });

  setBearings(points);

  return {
    name: routeName,
    points,
    parts,
    pathLength,
    totalDistance: cumulativeDistance,
    totalElevationGain: calculateElevationGain(raw),
    totalElevationLoss: calculateElevationGain(backwards(raw, cumulativeDistance)),
  };
}

/**
 * Gives every point the heading ridden there: from the previous kept point to the next one, which
 * smooths out GPS jitter. Neighbours on the far side of a gap are ignored.
 */
function setBearings(points) {
  points.forEach((pt, i) => {
    const before = i > 0 && !pt.gap ? points[i - 1] : pt;
    const after = i < points.length - 1 && !points[i + 1].gap ? points[i + 1] : pt;
    const moved = before.lat !== after.lat || before.lng !== after.lng;
    pt.bearing = moved ? calculateBearing(before.lat, before.lng, after.lat, after.lng) : null;
  });
  // Where the rider stood still there is no heading to measure: keep the one they arrived with
  // (or, at the very start, the one they leave with).
  points.forEach((pt, i) => {
    if (pt.bearing === null && i > 0) pt.bearing = points[i - 1].bearing;
  });
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].bearing === null) points[i].bearing = points[i + 1]?.bearing ?? 0;
  }
}

/**
 * Where on a route the rider is after `km`: { lat, lng }, between the two points around it.
 * - points: of a route from parseGpxData, in the order of their distance
 */
export function positionAt(points, km) {
  const last = points.length - 1;
  if (km <= points[0].distance) return points[0];
  if (km >= points[last].distance) return points[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].distance <= km) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const t = (km - a.distance) / (b.distance - a.distance);
  // the short way round: from 179.9 to -179.9 is a fifth of a degree, not a trip round the world
  let turn = b.lng - a.lng;
  if (turn > 180) turn -= 360;
  else if (turn < -180) turn += 360;
  const lng = a.lng + turn * t;
  return { lat: a.lat + (b.lat - a.lat) * t, lng: lng > 180 ? lng - 360 : lng < -180 ? lng + 360 : lng };
}

/**
 * The same route ridden the other way: the finish becomes the start. Distances count from the new
 * start, headings turn round, and the climbing is what used to be the descent. `reversed` says whether
 * the route now runs against the direction it was recorded or drawn in.
 * - route: from parseGpxData, or from this function (reversing twice gives the first direction back)
 */
export function reverseRoute(route) {
  const source = route.points;
  const points = source.map((_, i) => {
    const pt = source[source.length - 1 - i];
    const turned = {
      lat: pt.lat,
      lng: pt.lng,
      ele: pt.ele,
      distance: route.totalDistance - pt.distance,
      bearing: 0,
      pathKm: route.pathLength - pt.pathKm,
    };
    // a jump is marked on the point after it: the other way round, the point that came before it
    if (source[source.length - i]?.gap) turned.gap = true;
    return turned;
  });
  setBearings(points);

  return {
    ...route,
    points,
    parts: route.parts.map((part) => [...part].reverse()).reverse(),
    totalElevationGain: route.totalElevationLoss ?? route.totalElevationGain,
    totalElevationLoss: route.totalElevationGain,
    reversed: !route.reversed,
  };
}

// ==========================================
// PRE-CONFIGURED LISBON CYCLING ROUTES
// ==========================================

export const PRESET_ROUTES = [
  {
    id: 'alges-monsanto',
    name: 'Algés–Monsanto',
    filename: 'Alges-Monsanto.gpx',
    description: 'Hilly loop through Algés and up into Monsanto forest.'
  },
  {
    id: 'cacilhas-caparica',
    name: 'Cacilhas–Caparica',
    filename: 'Cacilhas-Caparica.gpx',
    description: 'Ferry to Cacilhas, then the south bank out to Costa da Caparica.'
  },
  {
    id: 'cascais-sintra',
    name: 'Cascais–Sintra',
    filename: 'Cascais-Sintra.gpx',
    description: 'Loop from Cascais along the coast and over the Sintra hills.'
  },
  {
    id: 'lisboa-alverca',
    name: 'Lisboa–Alverca',
    filename: 'Lisboa-Alverca.gpx',
    description: 'Flat ride up the north bank of the Tagus to Alverca.'
  },
  {
    id: 'lisboa-cascais',
    name: 'Lisboa–Cascais',
    filename: 'Lisboa-Cascais.gpx',
    description: 'The Marginal coast road from Lisbon to Cascais and back.'
  },
  {
    id: 'seixal-arrabida',
    name: 'Seixal–Arrábida',
    filename: 'Seixal-Arrabida.gpx',
    description: 'Ferry to Seixal, then south over the Arrábida climbs.'
  }
];

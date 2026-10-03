// Open-Meteo forecast for the Lisbon area, kept as an hourly grid of wind vectors.
// One request brings three days for every grid point, so changing the hour never hits the network.
import { windVector, windFromVector } from './wind';
import { timeoutSignal } from './net';

// Forecast grid: 6 x 6 points, 0.125° apart. It reaches south to Arrábida and east past Setúbal
// so every bundled route sits inside it.
export const GRID = { south: 38.375, west: -9.5, step: 0.125, rows: 6, cols: 6 };
export const COVERAGE = {
  south: GRID.south,
  west: GRID.west,
  north: GRID.south + GRID.step * (GRID.rows - 1),
  east: GRID.west + GRID.step * (GRID.cols - 1),
};

export const GRID_POINTS = (() => {
  const list = [];
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      list.push({ lat: GRID.south + r * GRID.step, lng: GRID.west + c * GRID.step });
    }
  }
  return list;
})();

// Riding spots around Lisbon. `label` is the short name drawn on the map.
export const SPOTS = [
  {
    id: 'lisbon',
    name: 'Lisbon Central',
    label: 'Lisboa',
    desc: 'The historic centre, partly sheltered by the hills but open along the waterfront.',
    lat: 38.73,
    lng: -9.14,
    anchor: 'left',
  },
  {
    id: 'guincho',
    name: 'Guincho / Cabo da Roca',
    label: 'Guincho',
    desc: 'Exposed Atlantic cliffs, known for strong headwinds.',
    lat: 38.73,
    lng: -9.47,
    anchor: 'left',
  },
  {
    id: 'marginal',
    name: 'Estrada Marginal',
    label: 'Marginal',
    desc: 'The road along the Tagus, open to crosswinds off the water.',
    lat: 38.69,
    lng: -9.31,
  },
  {
    id: 'sintra',
    name: 'Serra de Sintra (Peninha)',
    label: 'Sintra',
    desc: 'Mountain roads where gusts change from one bend to the next.',
    lat: 38.78,
    lng: -9.42,
  },
  {
    id: 'monsanto',
    name: 'Monsanto Forest Park',
    label: 'Monsanto',
    desc: 'Forested climbs with good cover from the wind.',
    lat: 38.73,
    lng: -9.19,
    anchor: 'right',
  },
  {
    id: 'vasco_gama',
    name: 'Ponte Vasco da Gama',
    label: 'Vasco da Gama',
    desc: 'Flat estuary path with no protection from cross-gusts.',
    lat: 38.79,
    lng: -9.09,
  },
  {
    id: 'povoa',
    name: 'Póvoa de Santa Iria',
    label: 'Póvoa',
    desc: 'Flat riverside route, often straight into the wind.',
    lat: 38.86,
    lng: -9.05,
  },
  {
    id: 'caparica',
    name: 'Costa da Caparica',
    label: 'Caparica',
    desc: 'Open sandy coast south of the river with steady sea breezes.',
    lat: 38.64,
    lng: -9.24,
  },
  {
    id: 'arrabida',
    name: 'Serra da Arrábida',
    label: 'Arrábida',
    desc: 'Steep cliff roads above the sea, gusty near the top.',
    lat: 38.48,
    lng: -9.01,
  },
];

const API_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_KEY = 'wind-forecast-v2';
const FIELDS = ['temperature_2m', 'apparent_temperature', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];

function toForecast(json, fetchedAt) {
  if (!Array.isArray(json) || json.length !== GRID_POINTS.length) {
    throw new Error('Unexpected forecast response');
  }
  const hours = json[0]?.hourly?.time;
  if (!Array.isArray(hours) || hours.length === 0) {
    throw new Error('Unexpected forecast response');
  }
  const points = json.map((p) => {
    const h = p.hourly;
    if (!h || FIELDS.some((f) => !Array.isArray(h[f]) || h[f].length !== hours.length)) {
      throw new Error('Unexpected forecast response');
    }
    return {
      speed: h.wind_speed_10m,
      dir: h.wind_direction_10m,
      gust: h.wind_gusts_10m,
      temp: h.temperature_2m,
      feels: h.apparent_temperature,
    };
  });

  // Open-Meteo sends null where a model has no value. Keep only the hours where every grid point has wind,
  // so a hole in the data can never be drawn as "0 km/h, calm".
  const hasWind = (h) => points.every((p) => Number.isFinite(p.speed[h]) && Number.isFinite(p.dir[h]) && Number.isFinite(p.gust[h]));
  let complete = 0;
  while (complete < hours.length && hasWind(complete)) complete++;
  if (complete === 0) {
    throw new Error('The forecast has no wind data');
  }
  if (complete === hours.length) return { hours, points, fetchedAt };
  // what is left has to reach the present, or its last hour would be shown as "now"
  if (hours[complete - 1] * 1000 <= fetchedAt) {
    throw new Error('The forecast has no wind data for the current hour');
  }
  return {
    hours: hours.slice(0, complete),
    points: points.map((p) => ({
      speed: p.speed.slice(0, complete),
      dir: p.dir.slice(0, complete),
      gust: p.gust.slice(0, complete),
      temp: p.temp.slice(0, complete),
      feels: p.feels.slice(0, complete),
    })),
    fetchedAt,
  };
}

let pendingRequest = null;

/**
 * Fetches three days of hourly forecast for the whole grid.
 * Throws when the request fails: callers decide what to show, nothing is invented.
 * Calls made while a request is already under way share that request.
 */
export function fetchForecast() {
  if (!pendingRequest) {
    pendingRequest = requestForecast().finally(() => {
      pendingRequest = null;
    });
  }
  return pendingRequest;
}

async function requestForecast() {
  const params = new URLSearchParams({
    latitude: GRID_POINTS.map((p) => p.lat).join(','),
    longitude: GRID_POINTS.map((p) => p.lng).join(','),
    hourly: FIELDS.join(','),
    forecast_days: '3',
    timeformat: 'unixtime',
    // each grid point takes the model cell it sits in (the default prefers a land cell, which can be kilometres away)
    cell_selection: 'nearest',
  });
  const response = await fetch(`${API_URL}?${params}`, { signal: timeoutSignal(15000) });
  if (!response.ok) {
    const error = new Error(`Open-Meteo answered ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const forecast = toForecast(await response.json(), Date.now());
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(forecast));
  } catch {
    // storage full or unavailable: the forecast still works for this session
  }
  return forecast;
}

/**
 * Last forecast saved on this device, or null when there is none whose last hour is still ahead.
 */
export function loadCachedForecast(now = Date.now()) {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (!cached || !Array.isArray(cached.hours) || !Array.isArray(cached.points)) return null;
    if (cached.points.length !== GRID_POINTS.length) return null;
    const lastHour = cached.hours[cached.hours.length - 1] * 1000;
    return lastHour > now ? cached : null;
  } catch {
    return null;
  }
}

/**
 * Index of the forecast hour that contains `now`.
 */
export function currentHourIndex(hours, now = Date.now()) {
  const t = now / 1000;
  let i = 0;
  while (i + 1 < hours.length && hours[i + 1] <= t) i++;
  return i;
}

const fieldCache = new WeakMap();
const blendCache = new WeakMap();

const emptyField = (n) => ({
  u: new Float32Array(n),
  v: new Float32Array(n),
  speed: new Float32Array(n),
  gust: new Float32Array(n),
  temp: new Float32Array(n),
  feels: new Float32Array(n),
});

// The grid at one whole forecast hour.
function hourField(forecast, h) {
  let perHour = fieldCache.get(forecast);
  if (!perHour) {
    perHour = new Map();
    fieldCache.set(forecast, perHour);
  }
  if (perHour.has(h)) return perHour.get(h);

  const last = forecast.hours.length - 1;
  const field = emptyField(forecast.points.length);
  forecast.points.forEach((p, k) => {
    const speed = p.speed[h] ?? 0;
    const { u, v } = windVector(speed, p.dir[h] ?? 0);
    field.u[k] = u;
    field.v[k] = v;
    field.speed[k] = speed;
    // Open-Meteo's gust for an hour is the strongest gust of the hour that ENDS then, while speed and
    // direction are the values at that moment. So the gusts a rider meets from h:00 on are stored under h + 1.
    field.gust[k] = p.gust[Math.min(last, h + 1)] ?? speed;
    field.temp[k] = p.temp[h] ?? 0;
    field.feels[k] = p.feels[h] ?? field.temp[k];
  });
  perHour.set(h, field);
  return field;
}

/**
 * The forecast at one moment as flat arrays over the grid (row-major, south to north).
 * `hour` is an index into forecast.hours and may be fractional (18.4 = 24 minutes past hour 18):
 * the wind is then blended between the two hours, and the gusts are those of the hour in progress.
 */
export function buildField(forecast, hour) {
  const last = forecast.hours.length - 1;
  const h = Math.max(0, Math.min(last, Number.isFinite(hour) ? hour : 0));
  const h0 = Math.floor(h);
  const t = h - h0;
  const lower = hourField(forecast, h0);
  if (t < 1e-3 || h0 >= last) return lower;

  // "now" moves a little every minute, so only the latest blend is kept
  const key = Math.round(h * 600);
  const cached = blendCache.get(forecast);
  if (cached?.key === key) return cached.field;

  const upper = hourField(forecast, h0 + 1);
  const field = emptyField(forecast.points.length);
  for (let k = 0; k < field.speed.length; k++) {
    const speed = lower.speed[k] + (upper.speed[k] - lower.speed[k]) * t;
    const u = lower.u[k] + (upper.u[k] - lower.u[k]) * t;
    const v = lower.v[k] + (upper.v[k] - lower.v[k]) * t;
    const magnitude = Math.hypot(u, v);
    field.u[k] = magnitude > 1e-6 ? (u / magnitude) * speed : 0;
    field.v[k] = magnitude > 1e-6 ? (v / magnitude) * speed : 0;
    field.speed[k] = speed;
    field.gust[k] = lower.gust[k];
    field.temp[k] = lower.temp[k] + (upper.temp[k] - lower.temp[k]) * t;
    field.feels[k] = lower.feels[k] + (upper.feels[k] - lower.feels[k]) * t;
  }
  blendCache.set(forecast, { key, field });
  return field;
}

export function inCoverage(lat, lng) {
  return lat >= COVERAGE.south && lat <= COVERAGE.north && lng >= COVERAGE.west && lng <= COVERAGE.east;
}

/**
 * Weather at any position, blended from the four surrounding grid points.
 * Direction is blended as a vector (350° and 10° give 0°, not 180°) and speed as a plain number,
 * so a spot between two opposing winds keeps a realistic speed.
 * Positions outside the grid get the nearest edge value and `outside: true`.
 */
export function sampleField(field, lat, lng) {
  const fx = Math.min(GRID.cols - 1, Math.max(0, (lng - GRID.west) / GRID.step));
  const fy = Math.min(GRID.rows - 1, Math.max(0, (lat - GRID.south) / GRID.step));
  const x0 = Math.min(GRID.cols - 2, Math.floor(fx));
  const y0 = Math.min(GRID.rows - 2, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const a = y0 * GRID.cols + x0;
  const b = a + 1;
  const c = a + GRID.cols;
  const d = c + 1;
  const wa = (1 - tx) * (1 - ty);
  const wb = tx * (1 - ty);
  const wc = (1 - tx) * ty;
  const wd = tx * ty;
  const blend = (arr) => arr[a] * wa + arr[b] * wb + arr[c] * wc + arr[d] * wd;

  const speed = blend(field.speed);
  let u = blend(field.u);
  let v = blend(field.v);
  const magnitude = Math.hypot(u, v);
  if (magnitude > 1e-6) {
    u = (u / magnitude) * speed;
    v = (v / magnitude) * speed;
  } else {
    u = 0;
    v = 0;
  }

  return {
    u,
    v,
    speed,
    gust: blend(field.gust),
    temp: blend(field.temp),
    feels: blend(field.feels),
    from: windFromVector(u, v),
    outside: !inCoverage(lat, lng),
  };
}

/**
 * Weather at a position and a fractional forecast hour (e.g. 18.4 = 24 minutes past hour 18).
 * Unlike buildField this keeps no blended grid, so it suits the many different moments along a route.
 */
export function sampleForecast(forecast, hour, lat, lng) {
  const last = forecast.hours.length - 1;
  const h = Math.max(0, Math.min(last, Number.isFinite(hour) ? hour : 0));
  const h0 = Math.floor(h);
  const lower = sampleField(hourField(forecast, h0), lat, lng);
  const t = h - h0;
  if (t < 1e-3 || h0 >= last) return lower;

  const upper = sampleField(hourField(forecast, h0 + 1), lat, lng);
  const mix = (x, y) => x + (y - x) * t;
  const speed = mix(lower.speed, upper.speed);
  let u = mix(lower.u, upper.u);
  let v = mix(lower.v, upper.v);
  const magnitude = Math.hypot(u, v);
  if (magnitude > 1e-6) {
    u = (u / magnitude) * speed;
    v = (v / magnitude) * speed;
  } else {
    u = 0;
    v = 0;
  }
  return {
    u,
    v,
    speed,
    // the gusts of the hour in progress
    gust: lower.gust,
    temp: mix(lower.temp, upper.temp),
    feels: mix(lower.feels, upper.feels),
    from: windFromVector(u, v),
    outside: lower.outside,
  };
}

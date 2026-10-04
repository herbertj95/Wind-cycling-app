// Open-Meteo: the hourly forecast for any list of points, and the search for places by name.
// Nothing here knows about the map: windStore decides which points to ask for and keeps the answers.
import { timeoutSignal } from './net';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const SEARCH_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FIELDS = ['temperature_2m', 'apparent_temperature', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];
// Hours asked for, counted from the hour in progress: a few back, so the time bar shows how the wind got
// here, and two days ahead.
const PAST_HOURS = 3;
const FORECAST_HOURS = 49;
const HOUR = 3600;

const finite = Number.isFinite;

async function httpError(response) {
  const error = new Error(`Open-Meteo answered ${response.status}`);
  error.status = response.status;
  if (response.status === 429) {
    // the answer says which allowance ran out: the one per minute, per hour or per day
    let reason = '';
    try {
      reason = String((await response.json()).reason ?? '');
    } catch {
      // no readable reason: treat it as the shortest wait
    }
    error.limit = /daily/i.test(reason) ? 'day' : /hourly/i.test(reason) ? 'hour' : 'minute';
  }
  return error;
}

// One location of the answer as a forecast point: `n` hourly values starting at unix time `t0`.
function toPoint(location, fetchedAt) {
  const h = location?.hourly;
  const times = h?.time;
  if (!Array.isArray(times) || times.length === 0 || FIELDS.some((f) => !Array.isArray(h[f]) || h[f].length !== times.length)) {
    throw new Error('Unexpected forecast response');
  }
  if (!finite(times[0]) || (times.length > 1 && times[1] - times[0] !== HOUR)) {
    throw new Error('Unexpected forecast response');
  }
  // Open-Meteo sends null where a model has no value. Only the hours before the first one without wind are
  // kept, so a hole in the data can never be drawn as "0 km/h, calm".
  let n = 0;
  while (n < times.length && finite(h.wind_speed_10m[n]) && finite(h.wind_direction_10m[n]) && finite(h.wind_gusts_10m[n])) n++;
  return {
    t0: times[0],
    n,
    speed: h.wind_speed_10m.slice(0, n),
    dir: h.wind_direction_10m.slice(0, n),
    gust: h.wind_gusts_10m.slice(0, n),
    temp: h.temperature_2m.slice(0, n),
    feels: h.apparent_temperature.slice(0, n),
    zone: typeof location.timezone === 'string' ? location.timezone : null,
    fetchedAt,
  };
}

/**
 * Fetches the hourly forecast for a list of positions ({ lat, lng }) in one request.
 * Returns one forecast point per position, in the same order:
 * { t0, n, speed[], dir[], gust[], temp[], feels[], zone, fetchedAt }, where `n` may be 0 when a position has no wind data.
 * Throws when the request fails: callers decide what to show, nothing is invented.
 * Each position counts as one call against Open-Meteo's free allowance.
 */
export async function fetchPoints(points) {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lng).join(','),
    hourly: FIELDS.join(','),
    past_hours: String(PAST_HOURS),
    forecast_hours: String(FORECAST_HOURS),
    timeformat: 'unixtime',
    // each point also says which time zone it is in, so times can be shown in the local time of the place
    timezone: 'auto',
    // each point takes the model cell it sits in (the default prefers a land cell, which can be kilometres away)
    cell_selection: 'nearest',
  });
  const response = await fetch(`${FORECAST_URL}?${params}`, { signal: timeoutSignal(15000) });
  if (!response.ok) throw await httpError(response);
  const json = await response.json();
  // a single position is answered with a bare object instead of a list
  const locations = Array.isArray(json) ? json : [json];
  if (locations.length !== points.length) throw new Error('Unexpected forecast response');
  const fetchedAt = Date.now();
  return locations.map((location) => toPoint(location, fetchedAt));
}

/**
 * Places whose name matches `query`, best match first: [{ id, name, region, lat, lng, zone }].
 * `region` tells two places with the same name apart, e.g. "Catalonia, Spain".
 * `signal` cancels the search, for when the query has changed meanwhile.
 */
export async function searchPlaces(query, signal) {
  const params = new URLSearchParams({ name: query, count: '6', language: 'en', format: 'json' });
  const response = await fetch(`${SEARCH_URL}?${params}`, { signal: timeoutSignal(10000, signal) });
  if (!response.ok) throw await httpError(response);
  const json = await response.json();
  const results = Array.isArray(json?.results) ? json.results : [];
  return results
    .filter((r) => r && typeof r.name === 'string' && finite(r.latitude) && finite(r.longitude))
    .map((r, i) => ({
      id: r.id ?? `result-${i}`,
      name: r.name,
      region: [r.admin1, r.country].filter((part) => part && part !== r.name).join(', '),
      lat: r.latitude,
      lng: r.longitude,
      zone: typeof r.timezone === 'string' ? r.timezone : null,
    }));
}

// IPMA, the weather service of Portugal: the wind its stations measured in the last hours, to hold
// against the forecast. Nothing about the user is sent: the same file is downloaded whatever place is in focus.
import { timeoutSignal } from './net';
import { calculateDistance } from './gpxParser';

const OBSERVATIONS_URL = 'https://api.ipma.pt/open-data/observation/meteorology/stations/obs-surface.geojson';
// IPMA files the wind under one of eight directions, by number: where it comes from, in degrees.
// 0 is no direction, and 9 is north once more.
const SECTOR_FROM = [null, 0, 45, 90, 135, 180, 225, 270, 315, 0];
// Rough boxes around Portuguese territory, as [south, west, north, east]: the mainland, Madeira and
// the Azores. Outside them there is no station to look for, and nothing is downloaded.
const AREAS = [
  [36.7, -9.8, 42.4, -5.9],
  [32.2, -17.6, 33.4, -15.9],
  [36.6, -31.7, 40, -24.7],
];
// Where the last download is kept, so the app does not open without it. The storage is only touched
// when it is used: where the browser refuses it, even looking at it throws.
const STORAGE_KEY = 'wind-ipma-v1';
const deviceStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
};
/** A station further away than this says little about the wind at a place. */
export const STATION_RANGE_KM = 30;
// The forecast is called right when it is within this many km/h of what was measured
const AGREE_KMH = 5;

/** Whether a position is where IPMA has stations, give or take. */
export function inIpmaArea(lat, lng) {
  return AREAS.some(([south, west, north, east]) => lat >= south && lat <= north && lng >= west && lng <= east);
}

/**
 * The stations of an IPMA observations file (GeoJSON, the last three hours of every station), each
 * with the latest wind it measured: [{ id, name, lat, lng, time, speed, from }].
 * `time` is the hour of the reading in unix seconds, `speed` the wind at 10 m in km/h, and `from` where
 * it came from in degrees, one of eight directions, or null when the station gave none.
 * Readings without a wind speed (IPMA writes -99) are skipped; a station with none is left out.
 */
export function parseObservations(geojson) {
  const stations = new Map();
  for (const feature of Array.isArray(geojson?.features) ? geojson.features : []) {
    const p = feature?.properties;
    const [lng, lat] = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
    // the hours are given in UTC, without saying so
    const time = typeof p?.time === 'string' ? Date.parse(`${p.time}Z`) / 1000 : NaN;
    const speed = p?.intensidadeVentoKM;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(time) || !Number.isFinite(speed) || speed < 0) continue;
    const id = p.idEstacao ?? `${lat},${lng}`;
    if (stations.get(id)?.time >= time) continue;
    stations.set(id, {
      id,
      name: typeof p.localEstacao === 'string' && p.localEstacao.trim() ? p.localEstacao.trim() : 'IPMA station',
      lat,
      lng,
      time,
      speed,
      from: SECTOR_FROM[p.idDireccVento] ?? null,
    });
  }
  return [...stations.values()];
}

/**
 * Downloads the latest observations of every IPMA station (see parseObservations).
 * Throws when the request fails or the answer is not what it should be.
 */
export async function fetchObservations(signal) {
  const response = await fetch(OBSERVATIONS_URL, { signal: timeoutSignal(15000, signal) });
  if (!response.ok) throw new Error(`IPMA answered ${response.status}`);
  const json = await response.json();
  if (!Array.isArray(json?.features)) throw new Error('Unexpected observations response');
  return parseObservations(json);
}

/**
 * How a measured wind stands beside the forecast for the same place and hour, both in km/h, as they
 * are shown (in whole km/h): 'as forecast', 'stronger than forecast' or 'lighter than forecast'.
 * Null when there is no forecast to hold it against.
 */
export function compareWithForecast(measured, forecast) {
  if (!Number.isFinite(measured) || !Number.isFinite(forecast)) return null;
  const more = Math.round(measured) - Math.round(forecast);
  if (Math.abs(more) < AGREE_KMH) return 'as forecast';
  return more > 0 ? 'stronger than forecast' : 'lighter than forecast';
}

/**
 * The station nearest to a position, with `km`, its distance from there; null when none is within `maxKm`.
 * - stations: from parseObservations
 */
export function nearestStation(stations, lat, lng, maxKm = STATION_RANGE_KM) {
  let nearest = null;
  for (const station of stations) {
    const km = calculateDistance(lat, lng, station.lat, station.lng);
    if (km <= maxKm && (!nearest || km < nearest.km)) nearest = { ...station, km };
  }
  return nearest;
}

/**
 * The last download kept on the device: { stations, at } with `at` when it was downloaded (ms), or null
 * when nothing usable is kept. `now` is the present in ms.
 */
export function loadObservations(storage = deviceStorage, now = Date.now()) {
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY));
    if (!Number.isFinite(saved?.at) || !Array.isArray(saved.stations)) return null;
    const valid = (s) => s && typeof s.name === 'string' && [s.lat, s.lng, s.time, s.speed].every(Number.isFinite) && (s.from === null || Number.isFinite(s.from));
    // A copy dated after now was kept while the clock of the device was ahead. It counts as old, so
    // that it is downloaded again instead of standing in the way until that moment comes.
    return { stations: saved.stations.filter(valid), at: saved.at <= now ? saved.at : 0 };
  } catch {
    return null;
  }
}

/** Keeps a download on the device (see loadObservations). Without storage it is simply not kept. */
export function saveObservations(stations, at, storage = deviceStorage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ at, stations }));
  } catch {
    // it will be downloaded again next time
  }
}

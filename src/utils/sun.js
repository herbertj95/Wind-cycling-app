// Where the sun stands, worked out from the date and the position: day and night without asking any service.
import { positionAt } from './gpxParser';

const RAD = Math.PI / 180;
const DAY = 86400;
// 2000-01-01 12:00 UTC, the moment the formulas count their days from, in days since 1970
const J2000_DAYS = 10957.5;
// The sun rises and sets when its centre is this far below the horizon: its upper edge is then on the
// horizon, lifted into view by the bending of light in the air
const HORIZON_DEG = -0.833;

/**
 * Altitude of the sun above the horizon in degrees, at a moment (unix seconds) and a position.
 * Low-precision formulas of the Astronomical Almanac: right to a small fraction of a degree, which is
 * a minute or two of sunrise and sunset.
 */
export function sunAltitude(unixSeconds, lat, lng) {
  const d = unixSeconds / DAY - J2000_DAYS;
  const meanLongitude = 280.46 + 0.9856474 * d;
  const meanAnomaly = (357.528 + 0.9856003 * d) * RAD;
  const eclipticLongitude = (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RAD;
  const obliquity = (23.439 - 0.0000004 * d) * RAD;
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  // how far the sky has turned over Greenwich, and from there over this position
  const siderealTime = (280.46061837 + 360.98564736629 * d) * RAD;
  const hourAngle = siderealTime + lng * RAD - rightAscension;
  const phi = lat * RAD;
  return Math.asin(Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle)) / RAD;
}

/** Whether the sun is up at a moment (unix seconds) and a position. */
export function isDaylight(unixSeconds, lat, lng) {
  return sunAltitude(unixSeconds, lat, lng) > HORIZON_DEG;
}

// Light enough to ride by lasts until the end of civil twilight, with the centre of the sun this far below
// the horizon, and starts again at its beginning in the morning
const CIVIL_TWILIGHT_DEG = -6;

/** Whether there is light enough to ride by at a moment (unix seconds) and a position: civil twilight or day. */
export function isRidingLight(unixSeconds, lat, lng) {
  return sunAltitude(unixSeconds, lat, lng) > CIVIL_TWILIGHT_DEG;
}

/**
 * How many times the dark meets a ride: it is looked at where the rider is when they set off, at every
 * full hour after that and when they finish. 0 for a ride all in the light, which is what the app offers.
 * - route: from parseGpxData; start: unix seconds; rideKmh: the average riding speed
 */
export function darkChecks(route, start, rideKmh) {
  const hours = route.totalDistance / rideKmh;
  const moments = [];
  for (let h = 0; h < hours; h++) moments.push(h);
  moments.push(hours);
  let dark = 0;
  for (const h of moments) {
    const at = positionAt(route.points, h * rideKmh);
    if (!isRidingLight(start + h * 3600, at.lat, at.lng)) dark++;
  }
  return dark;
}

// Where the sun stands, worked out from the date and the position: day and night without asking any service.

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

/**
 * How much of a ride is in daylight: 'ride' when all of it is, 'start' when it sets off in daylight and
 * the night catches up with it, 'none' when it sets off in the dark.
 * - start, end: unix seconds; from, to: { lat, lng } of where the ride starts and where it finishes
 */
export function rideLight(start, end, from, to) {
  if (!isDaylight(start, from.lat, from.lng)) return 'none';
  if (!isDaylight(end, to.lat, to.lng)) return 'start';
  // a ride of many hours can set off one day and finish the next, with a night in between
  for (let t = start + 3600; t < end; t += 3600) {
    if (!isDaylight(t, from.lat, from.lng)) return 'start';
  }
  return 'ride';
}

// Shared wind vocabulary: compass words, Beaufort names and what the wind does to a rider.
// Convention used everywhere: a wind direction is where the wind comes FROM (0 = north, 90 = east).

const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

// Below this the air is still and its direction means nothing
export const CALM_KMH = 1;
// A head, tail or crosswind weaker than this is hardly felt on the bike
export const NOTICEABLE_KMH = 5;

const norm360 = (deg) => ((deg % 360) + 360) % 360;

/**
 * Converts a bearing in degrees to a 16-point compass word.
 */
export function compassPoint(deg) {
  return COMPASS_POINTS[Math.round(norm360(deg) / 22.5) % 16];
}

/**
 * Beaufort description for a 10 m wind speed in km/h.
 */
export function beaufortLabel(kmh) {
  if (kmh < 1) return 'Calm';
  if (kmh < 6) return 'Light air';
  if (kmh < 12) return 'Light breeze';
  if (kmh < 20) return 'Gentle breeze';
  if (kmh < 29) return 'Moderate breeze';
  if (kmh < 39) return 'Fresh breeze';
  if (kmh < 50) return 'Strong breeze';
  if (kmh < 62) return 'Near gale';
  if (kmh < 75) return 'Gale';
  if (kmh < 89) return 'Strong gale';
  return 'Storm';
}

/**
 * Signed smallest difference a - b in degrees, in the range (-180, 180].
 */
export function angleDiff(a, b) {
  const d = norm360(a - b);
  return d > 180 ? d - 360 : d;
}

/**
 * Wind as eastward (u) and northward (v) air movement. The air moves away from where it comes from.
 */
export function windVector(speed, windFrom) {
  const a = windFrom * Math.PI / 180;
  return { u: -speed * Math.sin(a), v: -speed * Math.cos(a) };
}

/**
 * Direction a wind vector comes from, in degrees.
 */
export function windFromVector(u, v) {
  return norm360(Math.atan2(-u, -v) * 180 / Math.PI);
}

/**
 * Splits the wind into what a rider feels.
 * - head > 0 slows the rider, head < 0 pushes from behind
 * - cross > 0 hits from the right, cross < 0 from the left
 */
export function windComponents(bearing, windFrom, speed) {
  const rel = angleDiff(windFrom, bearing) * Math.PI / 180;
  return { head: speed * Math.cos(rel), cross: speed * Math.sin(rel) };
}

/**
 * Classifies the wind relative to the cyclist's travel bearing, by what the rider feels along the road.
 * Returns 'headwind' or 'tailwind' when at least NOTICEABLE_KMH blows against or behind the rider,
 * and 'crosswind' for everything else: wind from the side, or too light to matter.
 * The route colours, the share bar and the wording all use this same rule.
 */
export function classifyWindEffect(bearing, windFrom, speed) {
  const { head } = windComponents(bearing, windFrom, speed);
  if (head >= NOTICEABLE_KMH) return 'headwind';
  if (head <= -NOTICEABLE_KMH) return 'tailwind';
  return 'crosswind';
}

/**
 * One line on what the wind is doing to the rider, leading with whichever part is larger.
 * head > 0 is against the rider; cross > 0 comes from the right.
 */
export function describeRiderWind(head, cross) {
  const along = Math.abs(head);
  const across = Math.abs(cross);
  if (along < NOTICEABLE_KMH && across < NOTICEABLE_KMH) return 'Hardly any wind here';

  const alongText = `${Math.round(along)} km/h ${head > 0 ? 'against you' : 'pushing you'}`;
  const acrossText = `${Math.round(across)} km/h from the ${cross > 0 ? 'right' : 'left'}`;
  if (across > along) {
    return along >= NOTICEABLE_KMH ? `Crosswind, ${acrossText}, with ${alongText}` : `Crosswind, ${acrossText}`;
  }
  const name = head > 0 ? 'Headwind' : 'Tailwind';
  return across >= NOTICEABLE_KMH ? `${name}, ${alongText}, with ${acrossText}` : `${name}, ${alongText}`;
}

/**
 * Whole degrees for display, 0 to 359 (359.6 reads as 0, not 360).
 */
export function wholeDegrees(deg) {
  return Math.round(norm360(deg)) % 360;
}

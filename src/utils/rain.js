// Shared rain vocabulary: when an hour counts as wet and how to say how much it rains.
// Amounts are mm of water falling in one hour (rain, or snow once melted); chances are percent.
// An amount or a chance the forecast does not give is NaN, and nothing is said about it.

/** An hour with less than this is dry. The forecast's own chance of rain counts from 0.1 mm as well. */
export const WET_MM = 0.1;
/**
 * With no amount forecast, a chance from here on is still worth a line. And an amount that comes with a
 * smaller chance than this is only called possible: the amount is one run of the model, the chance is
 * how many of its runs agree.
 */
export const LIKELY_PERCENT = 30;
// where light rain ends and where heavy rain starts, in mm an hour
const MODERATE_MM = 2.5;
const HEAVY_MM = 7.5;
// An amount read between forecast points that all say 0.1 comes out as 0.09999999999999999 now and
// then: the limits are met from a hair under them
const HAIR = 1e-9;

/** Whether that much rain in an hour gets a rider wet. An unknown amount does not count. */
export const isWet = (mm) => mm >= WET_MM - HAIR;

/**
 * How hard it rains: 'none', 'light', 'moderate' or 'heavy'.
 */
export function rainLevel(mm) {
  if (!isWet(mm)) return 'none';
  if (mm < MODERATE_MM - HAIR) return 'light';
  return mm < HEAVY_MM - HAIR ? 'moderate' : 'heavy';
}

/**
 * An amount of rain as text, without its unit: one decimal while that says something ("0.4"), whole mm above.
 */
export function formatRain(mm) {
  return mm < 10 ? mm.toFixed(1) : String(Math.round(mm));
}

/**
 * The rain of one hour in words, or null when there is nothing worth saying: a dry hour without much of
 * a chance, or an hour the forecast says nothing about.
 * - mm: the amount forecast for the hour
 * - chance: how likely any rain is in that hour, in percent
 */
export function describeRain(mm, chance) {
  const likely = Number.isFinite(chance) ? Math.round(chance) : null;
  if (isWet(mm)) {
    const words = { light: 'Light rain', moderate: 'Moderate rain', heavy: 'Heavy rain' }[rainLevel(mm)];
    const doubt = likely !== null && likely < LIKELY_PERCENT ? ' possible' : '';
    return `${words}${doubt}, ${formatRain(mm)} mm/h${likely === null ? '' : ` (${likely}% chance)`}`;
  }
  return likely !== null && likely >= LIKELY_PERCENT ? `${likely}% chance of rain` : null;
}

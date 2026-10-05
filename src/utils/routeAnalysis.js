// What the wind does along a route: head/tail/cross at every point, the totals and a plain-language advisory.
// And what the rain does: where on the route the rider gets wet.
import { windComponents, classifyWindEffect, CALM_KMH } from './wind';
import { LIKELY_PERCENT, formatRain, isWet } from './rain';

// Average riding speeds offered when planning, in km/h
export const RIDE_SPEEDS = [20, 25, 30];

// A headwind of this many km/h or more is what riders notice as hard work
const STRONG_HEAD_KMH = 15;
// Gusts this strong, or this strong across the road, make a bike hard to hold on line
const STRONG_GUST_KMH = 50;
const STRONG_CROSS_GUST_KMH = 35;
// With gusts from this strength on, a day of light wind is not described as calm
const LIGHT_WIND_GUST_KMH = 30;

// The wind band under the profile is drawn against a round number of km/h, and at least this many,
// so that a calm day does not fill the chart
const MIN_BAND_KMH = 15;
const BAND_STEP_KMH = 5;

const round = (n) => Math.round(n);

/**
 * The strongest wind against the rider and the strongest wind behind them along a route, in km/h:
 * the highest and the lowest point of the wind band under the profile. Zero where there is none.
 * - wind: the per-point analysis from analyseRoute
 */
export function windPeaks(wind) {
  let head = 0;
  let tail = 0;
  for (const w of wind) {
    if (!Number.isFinite(w.head)) continue;
    head = Math.max(head, w.head);
    tail = Math.max(tail, -w.head);
  }
  return { head, tail };
}

/**
 * The km/h that the full height of the wind band under the profile stands for, the same upwards
 * (headwind) as downwards (tailwind): the strongest head or tailwind of the route, rounded up to a
 * multiple of 5, and never less than 15.
 * - wind: the per-point analysis from analyseRoute
 */
export function bandScale(wind) {
  const { head, tail } = windPeaks(wind);
  // the small allowance keeps a wind of exactly 15 km/h, worked out as 15.0000001, on the 15 scale
  return Math.max(MIN_BAND_KMH, Math.ceil((Math.max(head, tail) - 1e-6) / BAND_STEP_KMH) * BAND_STEP_KMH);
}

function buildAdvisory(a, totalKm) {
  // one gusty reading at a single point is not a gusty ride: it has to last for a real stretch of road
  if (a.gustyKm >= Math.max(1, totalKm * 0.03)) {
    return {
      tone: 'gusty',
      title: 'Gusty: hold your line',
      text: `Gusts reach ${round(a.maxGust)} km/h, with up to ${round(a.maxCrossGust)} km/h across the road. Leave the deep-section wheels at home.`,
    };
  }
  if (a.avgSpeed < 8) {
    if (a.maxGust >= LIGHT_WIND_GUST_KMH) {
      return {
        tone: 'mixed',
        title: 'Light wind with gusts',
        text: `About ${round(a.avgSpeed)} km/h along the route, but gusts reach ${round(a.maxGust)} km/h.`,
      };
    }
    return {
      tone: 'calm',
      title: 'Barely any wind',
      text: `About ${round(a.avgSpeed)} km/h along the route. The wind will not decide this ride.`,
    };
  }
  if (a.strongHeadKm >= totalKm * 0.25) {
    return {
      tone: 'hard',
      title: 'Long stretches into the wind',
      text: `${round(a.strongHeadKm)} km with ${STRONG_HEAD_KMH} km/h or more against you. Keep something back for them.`,
    };
  }
  if (a.net <= -4) {
    return {
      tone: 'good',
      title: 'Wind mostly behind you',
      text: `On balance ${Math.abs(a.net).toFixed(0)} km/h pushing you along.`,
    };
  }
  if (a.net >= 4) {
    return {
      tone: 'hard',
      title: 'Wind mostly against you',
      text: `On balance ${a.net.toFixed(0)} km/h in your face.`,
    };
  }
  return {
    tone: 'mixed',
    title: 'Mixed wind',
    text: `${round(a.share.tail)} km with the wind, ${round(a.share.head)} km against it and ${round(a.share.cross)} km across.`,
  };
}

// The rain along the route in one sentence, or null when there is nothing worth saying about it.
function buildRainNote(rain, coveredKm) {
  if (!rain.known) return null;
  // a single wet reading is not a wet ride: it has to last for a real stretch of road
  if (rain.wetKm >= Math.max(0.5, coveredKm * 0.01)) {
    // an amount with little chance behind it is only possible (see describeRain)
    const rainWord = rain.wetChance > 0 && rain.wetChance < LIKELY_PERCENT ? 'Rain possible' : 'Rain';
    const where = rain.wetKm >= coveredKm * 0.95 ? `${rainWord} all the way` : `${rainWord} on ${Math.max(1, round(rain.wetKm))} km of the ride`;
    const chance = rain.wetChance > 0 ? ` (${round(rain.wetChance)}% chance)` : '';
    return `${where}, up to ${formatRain(rain.max)} mm/h${chance}.`;
  }
  return rain.chance >= LIKELY_PERCENT ? `Up to a ${round(rain.chance)}% chance of rain on the way.` : null;
}

/**
 * Analyses a route for a ride that starts at `startHour` and averages `rideKmh`.
 * - forecast.sample(lat, lng, hour): the wind at a position and a moment, in hours on the same clock as
 *   `startHour`, or null where no forecast is loaded. Past the end of the forecast it answers with the
 *   last hour and `late: true`.
 * Each point is sampled at the time the rider gets there, not all at the start time.
 * `share` splits the distance by what the rider feels along the road (see classifyWindEffect):
 * `cross` holds everything that is neither a noticeable head nor tailwind.
 * Stretches without a forecast are counted in `outsideKm` and in nothing else.
 * `rain` is what the forecast says about getting wet: the km ridden in rain (`wetKm`), the heaviest
 * rain met (`max`, mm an hour) with its chance (`wetChance`), and the highest chance of rain anywhere
 * on the way (`chance`). `known` is false when the forecast along the route says nothing about rain.
 * `rainNote` puts that in a sentence, or is null on a dry ride.
 */
export function analyseRoute(route, forecast, startHour, rideKmh = 25) {
  const pts = route.points;
  const totalKm = route.totalDistance || 1;

  const share = { tail: 0, cross: 0, head: 0 };
  let headSum = 0;
  let speedSum = 0;
  let maxGust = 0;
  let maxCrossGust = 0;
  let strongHeadKm = 0;
  let gustyKm = 0;
  let outsideKm = 0;
  let beyondForecast = false;
  const rain = { wetKm: 0, max: 0, wetChance: 0, chance: 0, known: false };

  const wind = pts.map((pt, i) => {
    const segKm = i > 0 ? pt.distance - pts[i - 1].distance : 0;
    const w = forecast.sample(pt.lat, pt.lng, startHour + pt.distance / rideKmh);
    if (!w) {
      // without a forecast there is no wind to report: the stretch is left out of every total
      outsideKm += segKm;
      return { speed: 0, gust: 0, from: 0, temp: NaN, feels: NaN, rain: NaN, rainChance: NaN, head: 0, cross: 0, effect: 'unknown', outside: true };
    }
    if (w.late) beyondForecast = true;
    const { head, cross } = windComponents(pt.bearing, w.from, w.speed);
    const effect = classifyWindEffect(pt.bearing, w.from, w.speed);

    if (effect === 'headwind') share.head += segKm;
    else if (effect === 'tailwind') share.tail += segKm;
    else share.cross += segKm;

    headSum += head * segKm;
    speedSum += w.speed * segKm;
    if (head >= STRONG_HEAD_KMH) strongHeadKm += segKm;
    maxGust = Math.max(maxGust, w.gust);
    // sideways part of a gust, assuming it comes from the same direction as the steady wind
    const crossGust = w.speed >= CALM_KMH ? (Math.abs(cross) / w.speed) * w.gust : 0;
    maxCrossGust = Math.max(maxCrossGust, crossGust);
    if (w.gust >= STRONG_GUST_KMH || crossGust >= STRONG_CROSS_GUST_KMH) gustyKm += segKm;

    // the rain of the hour in which the rider gets to this point
    const wet = Number.isFinite(w.rain) ? w.rain : NaN;
    const wetChance = Number.isFinite(w.rainChance) ? w.rainChance : NaN;
    if (Number.isFinite(wet)) rain.known = true;
    if (wetChance > rain.chance) rain.chance = wetChance;
    if (isWet(wet)) {
      rain.wetKm += segKm;
      if (wet > rain.max) rain.max = wet;
      if (wetChance > rain.wetChance) rain.wetChance = wetChance;
    }

    return { speed: w.speed, gust: w.gust, from: w.from, temp: w.temp, feels: w.feels, rain: wet, rainChance: wetChance, head, cross, effect, outside: false };
  });

  const durationHours = totalKm / rideKmh;
  // averages are over the part of the route that has a forecast
  const coveredKm = Math.max(1e-6, totalKm - outsideKm);
  const result = {
    wind,
    share,
    net: headSum / coveredKm,
    avgSpeed: speedSum / coveredKm,
    maxGust,
    maxCrossGust,
    gustyKm,
    strongHeadKm,
    outsideKm,
    durationHours,
    beyondForecast,
    rain,
    rainNote: buildRainNote(rain, coveredKm),
  };
  result.advisory = buildAdvisory(result, totalKm);
  return result;
}

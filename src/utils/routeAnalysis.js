// What the wind does along a route: head/tail/cross at every point, the totals and a plain-language advisory.
import { windComponents, classifyWindEffect, CALM_KMH } from './wind';

// Average riding speeds offered when planning, in km/h
export const RIDE_SPEEDS = [20, 25, 30];

// A headwind of this many km/h or more is what riders notice as hard work
const STRONG_HEAD_KMH = 15;
// Gusts this strong, or this strong across the road, make a bike hard to hold on line
const STRONG_GUST_KMH = 50;
const STRONG_CROSS_GUST_KMH = 35;
// With gusts from this strength on, a day of light wind is not described as calm
const LIGHT_WIND_GUST_KMH = 30;

const round = (n) => Math.round(n);

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

/**
 * Analyses a route for a ride that starts at `startHour` and averages `rideKmh`.
 * - forecast.sample(lat, lng, hour): the wind at a position and a moment, in hours on the same clock as
 *   `startHour`, or null where no forecast is loaded. Past the end of the forecast it answers with the
 *   last hour and `late: true`.
 * Each point is sampled at the time the rider gets there, not all at the start time.
 * `share` splits the distance by what the rider feels along the road (see classifyWindEffect):
 * `cross` holds everything that is neither a noticeable head nor tailwind.
 * Stretches without a forecast are counted in `outsideKm` and in nothing else.
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

  const wind = pts.map((pt, i) => {
    const segKm = i > 0 ? pt.distance - pts[i - 1].distance : 0;
    const w = forecast.sample(pt.lat, pt.lng, startHour + pt.distance / rideKmh);
    if (!w) {
      // without a forecast there is no wind to report: the stretch is left out of every total
      outsideKm += segKm;
      return { speed: 0, gust: 0, from: 0, temp: NaN, feels: NaN, head: 0, cross: 0, effect: 'unknown', outside: true };
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

    return { speed: w.speed, gust: w.gust, from: w.from, temp: w.temp, feels: w.feels, head, cross, effect, outside: false };
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
  };
  result.advisory = buildAdvisory(result, totalKm);
  return result;
}

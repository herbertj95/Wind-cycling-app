// What the wind does along a route: head/tail/cross at every point, the totals and a plain-language advisory.
// And what the rain does: where on the route the rider gets wet. The same for every hour the ride could
// start at, to find the best one.
import { windComponents, classifyWindEffect, CALM_KMH } from './wind';
import { LIKELY_PERCENT, formatRain, isWet, rainLevel } from './rain';
import { calculateDistance } from './gpxParser';

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

// A route that finishes this close to where it started is ridden out and home again: within half a
// kilometre, or a twentieth of its length
const LOOP_KM = 0.5;
const LOOP_SHARE = 0.05;
// The turn for home is the point farthest from the start, when that lies in this part of the distance
const TURN_FROM = 0.3;
const TURN_TO = 0.7;
// A part of the ride is into the wind, or has it behind, when the wind along the road averages this much there
const ORDER_KMH = 3;

// What rain and gusts weigh when departures are compared, as the wind cost (km/h, see windCost) of a whole
// ride of them: riding all the way in likely light rain is put on a par with a steady 15 km/h headwind,
// and a ride of gusts that push a bike off its line with one of 20.
const RAIN_COST_KMH = 15;
const GUST_COST_KMH = 20;
const RAIN_WEIGHT = { none: 0, light: 1, moderate: 1.5, heavy: 2.5 };
// rain the forecast puts no chance on counts as more likely than not
const UNKNOWN_CHANCE = 0.6;
// Points of the route a departure is judged on: the totals of a ride do not need every bend of it
const SCAN_POINTS = 120;

const round = (n) => Math.round(n);

/**
 * What a wind along the road costs the rider, in km/h. It is the air resistance the wind adds to that
 * of still air at the riding speed, written as the light headwind that would add as much. A light wind
 * costs what it blows; a strong headwind costs more than that, and a tailwind gives back less than
 * the same headwind takes, which is why a windy loop is harder than a calm one although head and
 * tailwind even out.
 * - head: the wind along the road in km/h, positive against the rider
 * Used to compare one ride with another, never shown as a number: it takes the forecast's wind at
 * 10 m as it is, like the rest of the app, and a rider sits lower than that.
 */
export function windCost(head, rideKmh) {
  const air = rideKmh + head;
  return (air * Math.abs(air) - rideKmh * rideKmh) / (2 * rideKmh);
}

/**
 * Where a route turns for home: { loop, km }. A route that finishes where it started is split at the
 * point farthest from the start, as the crow flies. Any other route, and a loop whose farthest point
 * is near one of its ends (a figure of eight, a lap ridden twice), is split at half its distance.
 */
export function routeTurn(route) {
  const pts = route.points;
  const total = route.totalDistance || 1;
  const start = pts[0];
  const end = pts[pts.length - 1];
  const loop = calculateDistance(start.lat, start.lng, end.lat, end.lng) < Math.max(LOOP_KM, total * LOOP_SHARE);
  let km = total / 2;
  if (loop) {
    let farthest = 0;
    let farthestKm = km;
    for (const p of pts) {
      const away = calculateDistance(start.lat, start.lng, p.lat, p.lng);
      if (away > farthest) {
        farthest = away;
        farthestKm = p.distance;
      }
    }
    if (farthestKm >= total * TURN_FROM && farthestKm <= total * TURN_TO) km = farthestKm;
  }
  return { loop, km };
}

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

// Which part of the ride has the wind against it, in a few words: "Headwind out, tailwind home."
// Null when both parts get the same, or when one of them has no forecast.
function buildOrderNote(order) {
  if (!Number.isFinite(order.first) || !Number.isFinite(order.second)) return null;
  const side = (kmh) => (kmh >= ORDER_KMH ? 'Headwind' : kmh <= -ORDER_KMH ? 'Tailwind' : null);
  const first = side(order.first);
  const second = side(order.second);
  if (first === second) return null;
  if (first && second) {
    return order.loop ? `${first} out, ${second.toLowerCase()} home.` : `${first} first, ${second.toLowerCase()} later.`;
  }
  if (first) return order.loop ? `${first} on the way out.` : `${first} in the first half.`;
  return order.loop ? `${second} on the way home.` : `${second} in the second half.`;
}

// The rain along the route in one sentence, or null when there is nothing worth saying about it.
function buildRainNote(rain, coveredKm) {
  if (!rain.known) return null;
  if (rain.wet) {
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
 * `wet` says whether that is a real stretch of road. `rainNote` puts it in a sentence, or is null on a dry ride.
 * `against` and `behind` are the wind along the road averaged over the ride, in km/h: what blows
 * against the rider, counting the rest of the way as nothing, and the same for what pushes.
 * `order` compares the two parts of the ride (see routeTurn): the wind along the road averaged over the
 * way out (`first`) and over the way home (`second`), positive against the rider, NaN for a part without
 * a forecast. `orderNote` says it in a few words, or is null when there is nothing to tell them apart.
 * `score` puts the whole ride in one number to compare it with the same ride at another time, or the
 * other way round: lower is easier (see windCost, and the weights of rain and gusts above).
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
  let againstSum = 0;
  let costSum = 0;
  const rain = { wetKm: 0, max: 0, wetChance: 0, chance: 0, known: false, wet: false };
  const turn = routeTurn(route);
  // the way out and the way home: the kilometres with a forecast, and the wind along the road over them
  const parts = [{ km: 0, head: 0 }, { km: 0, head: 0 }];

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
    againstSum += Math.max(0, head) * segKm;
    costSum += windCost(head, rideKmh) * segKm;
    const part = parts[pt.distance <= turn.km ? 0 : 1];
    part.km += segKm;
    part.head += head * segKm;
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
  // a single wet reading is not a wet ride: it has to last for a real stretch of road
  rain.wet = rain.wetKm >= Math.max(0.5, coveredKm * 0.01);
  const order = {
    loop: turn.loop,
    first: parts[0].km > 0 ? parts[0].head / parts[0].km : NaN,
    second: parts[1].km > 0 ? parts[1].head / parts[1].km : NaN,
  };
  const rainCost = rain.wet
    ? RAIN_COST_KMH * (rain.wetKm / coveredKm) * (rain.wetChance > 0 ? rain.wetChance / 100 : UNKNOWN_CHANCE) * RAIN_WEIGHT[rainLevel(rain.max)]
    : 0;
  const result = {
    wind,
    share,
    net: headSum / coveredKm,
    against: againstSum / coveredKm,
    behind: (againstSum - headSum) / coveredKm,
    order,
    orderNote: buildOrderNote(order),
    score: costSum / coveredKm + rainCost + GUST_COST_KMH * (gustyKm / coveredKm),
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

/**
 * The ride as it would go for each of the moments it could start at: [{ start, known, late, against,
 * behind, score, wet, rain, rainChance }], one per start and in the same order.
 * - starts: when each ride sets off, in hours on the forecast's clock (see analyseRoute)
 * `known` is false for a start with no forecast for most of the route, and `late` is true for a ride
 * that ends after the forecast does. `against`, `behind` and `score` are those of analyseRoute; `wet`
 * says the ride meets rain, `rain` the heaviest of it (mm an hour) and `rainChance` its chance.
 * The route is read at a hundred or so of its points, which is plenty for totals.
 */
export function scanDepartures(route, forecast, starts, rideKmh = 25) {
  const step = Math.ceil(route.points.length / SCAN_POINTS);
  const last = route.points.length - 1;
  const light = step > 1 ? { ...route, points: route.points.filter((_, i) => i % step === 0 || i === last) } : route;
  const total = route.totalDistance || 1;
  return starts.map((start) => {
    const ride = analyseRoute(light, forecast, start, rideKmh);
    return {
      start,
      known: ride.outsideKm < total * 0.5,
      late: ride.beyondForecast,
      against: ride.against,
      behind: ride.behind,
      score: ride.score,
      wet: ride.rain.wet,
      rain: ride.rain.max,
      rainChance: ride.rain.wetChance,
    };
  });
}

/**
 * The best moment to leave on each day, out of a scan of departures: the easiest ride of the day, by
 * its score. The earlier one wins a tie.
 * - departures: from scanDepartures, in the order of time, each with what the app knows about that
 *   moment: `day` (the day it falls on, any value that tells days apart), `past` (it can no longer be
 *   chosen) and `light`: 'ride' when the whole ride is in daylight, 'start' when it only sets off in it,
 *   'none' otherwise
 * Only rides in daylight from start to finish are offered. On a route too long for any day of the
 * forecast, the ones that at least set off in daylight are; and failing those, any.
 * Returns the chosen departures, at most `maxDays` of them, in the order of time.
 */
export function bestDepartures(departures, maxDays = 3) {
  const open = departures.filter((d) => d.known && !d.late && !d.past && Number.isFinite(d.score));
  const pool = [open.filter((d) => d.light === 'ride'), open.filter((d) => d.light !== 'none'), open].find((list) => list.length > 0) ?? [];
  const best = new Map();
  for (const d of pool) {
    const held = best.get(d.day);
    if (!held || d.score < held.score) best.set(d.day, d);
  }
  return [...best.values()].slice(0, maxDays);
}

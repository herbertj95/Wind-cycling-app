// What the wind does along a route: head/tail/cross at every point, the totals and a plain-language advisory.
// And what the rain does: where on the route the rider gets wet. The same for every hour the ride could
// start at, to find the best one.
import { windComponents, classifyWindEffect, CALM_KMH } from './wind';
import { LIKELY_PERCENT, formatRain, isWet, rainLevel } from './rain';
import { calculateDistance, positionAt } from './gpxParser';

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

// The turn for home is the point farthest from the start, when that lies in this part of the distance
const TURN_FROM = 0.3;
const TURN_TO = 0.7;
// A route that passes by its start in this part of its distance is ridden in laps: it has no one way out
// and one way home. "By" is within half a kilometre, or a fiftieth of its length.
const LAPS_FROM = 0.15;
const LAPS_TO = 0.85;
const PASS_KM = 0.5;
const PASS_SHARE = 0.02;
// A part of the ride is into the wind, or has it behind, when the wind along the road averages this much there
const ORDER_KMH = 5;
// A route comes back by the same road when most of its way out is this close to its way home
const SAME_ROAD_KM = 0.15;
const SAME_ROAD_SHARE = 0.8;
const SAME_ROAD_SAMPLES = 40;
// km in a degree of latitude, on the sphere of calculateDistance
const KM_PER_DEGREE = (6371 * Math.PI) / 180;

// What rain and gusts weigh when departures are compared, as the wind cost (km/h, see windCost) of a whole
// ride of them: riding all the way in likely light rain is put on a par with a steady 15 km/h headwind,
// and a ride of gusts that push a bike off its line with one of 20.
const RAIN_COST_KMH = 15;
const GUST_COST_KMH = 20;
const RAIN_WEIGHT = { none: 0, light: 1, moderate: 1.5, heavy: 2.5 };
// rain the forecast puts no chance on counts as more likely than not
const UNKNOWN_CHANCE = 0.6;
// Gusts start to count from the first number of km/h and count in full from the second: across the road,
// or from any side
const CROSS_GUST_RAMP = [25, 45];
const GUST_RAMP = [40, 60];
// Points of the route a departure is judged on: the totals of a ride do not need every bend of it
const SCAN_POINTS = 120;
// The best time to leave is every hour in a row whose score is within this much of the best of its day
const WINDOW_MARGIN = 1.5;
// "any time" is only said of a window of at least this many hours
const ANY_TIME_HOURS = 3;

const round = (n) => Math.round(n);
// 0 below `from`, 1 above `to`, in a straight line between
const ramp = (value, [from, to]) => Math.max(0, Math.min(1, (value - from) / (to - from)));

// What the rain of one hour at one point weighs: how hard it falls times how likely it is. Rain under the
// 0.1 mm that wets a rider still counts as light when it is likely.
function rainLoad(mm, chance) {
  const level = rainLevel(mm);
  const weight = level !== 'none' ? RAIN_WEIGHT[level] : chance >= LIKELY_PERCENT ? RAIN_WEIGHT.light : 0;
  if (weight === 0) return 0;
  return weight * (chance > 0 ? chance / 100 : UNKNOWN_CHANCE);
}

/**
 * What a wind costs the rider, in km/h. It is the air resistance the wind adds to that of still air at
 * the riding speed, along the road, written as the light headwind that would add as much. A light wind
 * costs what it blows; a strong headwind costs more than that, and a tailwind gives back less than
 * the same headwind takes, which is why a windy loop is harder than a calm one although head and
 * tailwind even out. A wind across the road adds to the air the rider meets, and so to the drag.
 * - head: the wind along the road in km/h, positive against the rider
 * - cross: the wind across the road in km/h, either side
 * Used to compare one ride with another, never shown as a number: it takes the forecast's wind at
 * 10 m as it is, like the rest of the app, and a rider sits lower than that.
 */
export function windCost(head, rideKmh, cross = 0) {
  const along = rideKmh + head;
  return (Math.hypot(along, cross) * along - rideKmh * rideKmh) / (2 * rideKmh);
}

// worked out once per route: a route is never changed, only replaced
const turns = new WeakMap();

/**
 * Where a route turns for home: { returns, km }.
 * A route `returns` when it finishes closer to its start than half the way to its farthest point, as the
 * crow flies. It is then split at that farthest point, when it lies between 30% and 70% of the
 * distance; otherwise `km` is null, and so it is for a route that passes by its start between 15% and
 * 85% of the way (laps, a figure of eight): there is no one way out and one way home to tell apart.
 * A route that does not return is split at half its distance.
 */
export function routeTurn(route) {
  const known = turns.get(route);
  if (known) return known;
  const pts = route.points;
  const total = route.totalDistance || 1;
  const start = pts[0];
  const end = pts[pts.length - 1];
  const pass = Math.max(PASS_KM, total * PASS_SHARE);
  let farthest = 0;
  let farthestKm = total / 2;
  let laps = false;
  for (const p of pts) {
    const away = calculateDistance(start.lat, start.lng, p.lat, p.lng);
    if (away > farthest) {
      farthest = away;
      farthestKm = p.distance;
    }
    if (away < pass && p.distance >= total * LAPS_FROM && p.distance <= total * LAPS_TO) laps = true;
  }
  const returns = calculateDistance(start.lat, start.lng, end.lat, end.lng) < farthest / 2;
  let km = total / 2;
  if (laps) km = null;
  else if (returns) km = farthestKm >= total * TURN_FROM && farthestKm <= total * TURN_TO ? farthestKm : null;
  const turn = { returns, km };
  turns.set(route, turn);
  return turn;
}

/**
 * Whether a route comes home by the road it went out on: then riding it the other way round is the
 * same ride. Most of its first half has to be within 150 m of its second half.
 */
export function retracesItself(route) {
  const pts = route.points;
  const total = route.totalDistance;
  if (!(total > 0) || pts.length < 2) return false;
  const first = pts.findIndex((p) => p.distance >= total / 2);
  const home = pts.slice(Math.max(0, first - 1));
  let close = 0;
  for (let i = 0; i < SAME_ROAD_SAMPLES; i++) {
    const out = positionAt(pts, (total / 2) * (i / SAME_ROAD_SAMPLES));
    if (nearPath(out, home, SAME_ROAD_KM)) close++;
  }
  return close >= SAME_ROAD_SAMPLES * SAME_ROAD_SHARE;
}

// Whether a position is within `km` of a line through some points, on a flat map around the position:
// at the few hundred metres asked about, the earth is flat enough.
function nearPath(at, path, km) {
  const kmPerLng = KM_PER_DEGREE * Math.cos((at.lat * Math.PI) / 180);
  const flat = (p) => [(p.lng - at.lng) * kmPerLng, (p.lat - at.lat) * KM_PER_DEGREE];
  let [ax, ay] = flat(path[0]);
  if (Math.hypot(ax, ay) <= km) return true;
  for (let i = 1; i < path.length; i++) {
    const [bx, by] = flat(path[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    // the nearest point of the segment to the position, which is at 0, 0
    const t = length > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
    if (Math.hypot(ax + t * dx, ay + t * dy) <= km) return true;
    ax = bx;
    ay = by;
  }
  return false;
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
// Null when both parts get the same, when one of them has no forecast, and on a calm day.
function buildOrderNote(order, tone) {
  if (tone === 'calm' || !Number.isFinite(order.first) || !Number.isFinite(order.second)) return null;
  const side = (kmh) => (kmh >= ORDER_KMH ? 'Headwind' : kmh <= -ORDER_KMH ? 'Tailwind' : null);
  const first = side(order.first);
  const second = side(order.second);
  if (first === second) return null;
  if (first && second) {
    return order.returns ? `${first} out, ${second.toLowerCase()} home.` : `${first}, then ${second.toLowerCase()}.`;
  }
  if (first) return order.returns ? `${first} on the way out.` : `${first} in the first half.`;
  return order.returns ? `${second} on the way home.` : `${second} in the second half.`;
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
 * a forecast or for a route without one way out and one way home. `orderNote` says it in a few words, or
 * is null when there is nothing to tell them apart.
 * `score` puts the whole ride in one number to compare it with the same ride at another time: lower is
 * easier. It is the wind cost (see windCost) averaged over the ride, which is `windScore`, plus what
 * the rain and the gusts weigh, kilometre by kilometre (see the weights above).
 * - turn: where the route turns for home, when the caller already knows (see routeTurn)
 */
export function analyseRoute(route, forecast, startHour, rideKmh = 25, turn = routeTurn(route)) {
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
  let rainSum = 0;
  let gustSum = 0;
  const rain = { wetKm: 0, max: 0, wetChance: 0, chance: 0, known: false, wet: false };
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
    costSum += windCost(head, rideKmh, cross) * segKm;
    if (turn.km !== null) {
      const part = parts[pt.distance <= turn.km ? 0 : 1];
      part.km += segKm;
      part.head += head * segKm;
    }
    speedSum += w.speed * segKm;
    if (head >= STRONG_HEAD_KMH) strongHeadKm += segKm;
    maxGust = Math.max(maxGust, w.gust);
    // sideways part of a gust, assuming it comes from the same direction as the steady wind
    const crossGust = w.speed >= CALM_KMH ? (Math.abs(cross) / w.speed) * w.gust : 0;
    maxCrossGust = Math.max(maxCrossGust, crossGust);
    if (w.gust >= STRONG_GUST_KMH || crossGust >= STRONG_CROSS_GUST_KMH) gustyKm += segKm;
    gustSum += Math.max(ramp(crossGust, CROSS_GUST_RAMP), ramp(w.gust, GUST_RAMP)) * segKm;

    // the rain of the hour in which the rider gets to this point
    const wet = Number.isFinite(w.rain) ? w.rain : NaN;
    const wetChance = Number.isFinite(w.rainChance) ? w.rainChance : NaN;
    if (Number.isFinite(wet)) rain.known = true;
    rainSum += rainLoad(wet, wetChance) * segKm;
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
    returns: turn.returns,
    first: parts[0].km > 0 ? parts[0].head / parts[0].km : NaN,
    second: parts[1].km > 0 ? parts[1].head / parts[1].km : NaN,
  };
  const windScore = costSum / coveredKm;
  const result = {
    wind,
    share,
    net: headSum / coveredKm,
    against: againstSum / coveredKm,
    behind: (againstSum - headSum) / coveredKm,
    order,
    windScore,
    score: windScore + (RAIN_COST_KMH * rainSum + GUST_COST_KMH * gustSum) / coveredKm,
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
  result.orderNote = buildOrderNote(order, result.advisory.tone);
  return result;
}

// the lighter copy of a route that departures are scanned on, made once per route
const scanCopies = new WeakMap();

function scanCopy(route) {
  let light = scanCopies.get(route);
  if (!light) {
    const step = Math.ceil(route.points.length / SCAN_POINTS);
    const last = route.points.length - 1;
    light = step > 1 ? { ...route, points: route.points.filter((_, i) => i % step === 0 || i === last) } : route;
    scanCopies.set(route, light);
  }
  return light;
}

/**
 * The ride as it would go for each of the moments it could start at: [{ start, known, late, against,
 * behind, score, wet, rain, rainChance }], one per start and in the same order.
 * - starts: when each ride sets off, in hours on the forecast's clock (see analyseRoute)
 * `known` is true for a start with a forecast for at least 95% of the route, and `late` is true for a
 * ride that ends after the forecast does. `against`, `behind` and `score` are those of analyseRoute;
 * `wet` says the ride meets rain, `rain` the heaviest of it (mm an hour) and `rainChance` its chance.
 * The route is read at a hundred or so of its points, which is plenty for totals.
 */
export function scanDepartures(route, forecast, starts, rideKmh = 25) {
  const light = scanCopy(route);
  const turn = routeTurn(route);
  const total = route.totalDistance || 1;
  return starts.map((start) => {
    const ride = analyseRoute(light, forecast, start, rideKmh, turn);
    return {
      start,
      known: ride.outsideKm < total * 0.05,
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
 * The best time to leave on each of some days, out of a scan of departures: { windows, unlit }.
 * - departures: one per hour in a row, in the order of time, as scanDepartures gives them, each with
 *   what the app knows about that moment: `time` (unix seconds), `day` (the day it falls on, any value
 *   that tells days apart), `past` (it can no longer be chosen) and `dark` (see darkChecks: 0 for a
 *   ride in the light from start to finish)
 * - days: the days to look at, in order
 * Only rides in the light from start to finish are offered. When no ride of the whole scan fits in the
 * light (a route too long for the day), each day offers those with the least of the dark instead.
 * `windows` holds a window for each day that has one, in the order of `days`: { day, from, to, best,
 * any }. `best` is the easiest ride of the day (the earlier one wins a tie), and `from` and `to` the
 * first and the last of the hours in a row around it that are within 1.5 of its score. `any` says the
 * window holds every hour of the day there is light for, and at least three of them.
 * `unlit` lists the days that still have rides to choose from, but none in the light.
 */
export function bestWindows(departures, days) {
  const open = (d) => d.known && !d.late && !d.past && Number.isFinite(d.score);
  const lit = departures.some((d) => open(d) && d.dark === 0);
  const windows = [];
  const unlit = [];
  for (const day of days) {
    const choices = [];
    departures.forEach((d, i) => {
      if (d.day === day && open(d)) choices.push(i);
    });
    if (choices.length === 0) continue;
    const least = lit ? 0 : Math.min(...choices.map((i) => departures[i].dark));
    const fit = choices.filter((i) => departures[i].dark === least);
    if (fit.length === 0) {
      unlit.push(day);
      continue;
    }
    let best = fit[0];
    for (const i of fit) {
      if (departures[i].score < departures[best].score) best = i;
    }
    const fits = new Set(fit);
    const near = (i) => fits.has(i) && departures[i].score <= departures[best].score + WINDOW_MARGIN;
    let from = best;
    while (near(from - 1)) from--;
    let to = best;
    while (near(to + 1)) to++;
    windows.push({
      day,
      from: departures[from].time,
      to: departures[to].time,
      best: departures[best].time,
      any: to - from + 1 >= ANY_TIME_HOURS && fit.every((i) => i >= from && i <= to),
    });
  }
  return { windows, unlit };
}

// Reading the wind out of forecast points: one point at a moment, and a position between four of them.
import { windVector, windFromVector } from './wind';
import { cellAt, nodeKey } from './lattice';

const HOUR = 3600;

/**
 * A forecast point (see fetchPoints) at a moment given in unix seconds.
 * Between two forecast hours the wind is blended; the gusts are those of the hour in progress.
 * A moment before the first hour gets the first hour; one after the last hour gets the last hour and
 * `late: true`, so callers can tell a forecast from a stand-in.
 * Returns null for a point without data.
 */
export function pointAt(point, time) {
  if (!point || !(point.n > 0)) return null;
  const last = point.n - 1;
  const position = (time - point.t0) / HOUR;
  const h = Math.max(0, Math.min(last, Number.isFinite(position) ? position : 0));
  const h0 = Math.floor(h);
  const t = h - h0;

  let speed = point.speed[h0];
  let { u, v } = windVector(speed, point.dir[h0]);
  let temp = point.temp[h0] ?? NaN;
  let feels = point.feels[h0] ?? temp;

  if (t >= 1e-3 && h0 < last) {
    const next = windVector(point.speed[h0 + 1], point.dir[h0 + 1]);
    speed += (point.speed[h0 + 1] - speed) * t;
    // the direction turns with the blended vector, the speed is blended as a plain number
    u += (next.u - u) * t;
    v += (next.v - v) * t;
    const magnitude = Math.hypot(u, v);
    u = magnitude > 1e-6 ? (u / magnitude) * speed : 0;
    v = magnitude > 1e-6 ? (v / magnitude) * speed : 0;
    const nextTemp = point.temp[h0 + 1] ?? NaN;
    temp += (nextTemp - temp) * t;
    feels += ((point.feels[h0 + 1] ?? nextTemp) - feels) * t;
  }

  return {
    u,
    v,
    speed,
    // Open-Meteo's gust for an hour is the strongest gust of the hour that ENDS then, while speed and
    // direction are the values at that moment. So the gusts a rider meets from h:00 on are stored under h + 1.
    gust: point.gust[Math.min(last, h0 + 1)],
    temp,
    feels,
    late: position > last + 1e-6,
    fetchedAt: point.fetchedAt,
  };
}

/**
 * Wind at a position, blended from the four lattice points around it.
 * - levels: the lattice levels to try, finest first; the first one with all four points loaded is used
 * - valueAt(key): the lattice point with that key at the wanted moment (see pointAt), or null when it is not loaded
 * Direction is blended as a vector (350° and 10° give 0°, not 180°) and speed as a plain number,
 * so a spot between two opposing winds keeps a realistic speed.
 * Returns null when no level has the four points: nothing is guessed from further away.
 */
export function blendAt(lat, lng, levels, valueAt) {
  for (const level of levels) {
    const { row, col, tx, ty } = cellAt(level, lat, lng);
    const a = valueAt(nodeKey(level, row, col));
    if (!a) continue;
    const b = valueAt(nodeKey(level, row, col + 1));
    if (!b) continue;
    const c = valueAt(nodeKey(level, row + 1, col));
    if (!c) continue;
    const d = valueAt(nodeKey(level, row + 1, col + 1));
    if (!d) continue;

    const wa = (1 - tx) * (1 - ty);
    const wb = tx * (1 - ty);
    const wc = (1 - tx) * ty;
    const wd = tx * ty;
    const blend = (name) => a[name] * wa + b[name] * wb + c[name] * wc + d[name] * wd;

    const speed = blend('speed');
    let u = blend('u');
    let v = blend('v');
    const magnitude = Math.hypot(u, v);
    if (magnitude > 1e-6) {
      u = (u / magnitude) * speed;
      v = (v / magnitude) * speed;
    } else {
      u = 0;
      v = 0;
    }

    return {
      u,
      v,
      speed,
      gust: blend('gust'),
      temp: blend('temp'),
      feels: blend('feels'),
      from: windFromVector(u, v),
      late: a.late || b.late || c.late || d.late,
      // as old as the oldest of the four
      fetchedAt: Math.min(a.fetchedAt, b.fetchedAt, c.fetchedAt, d.fetchedAt),
      level,
    };
  }
  return null;
}

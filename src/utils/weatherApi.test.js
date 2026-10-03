import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GRID,
  GRID_POINTS,
  COVERAGE,
  SPOTS,
  currentHourIndex,
  buildField,
  inCoverage,
  sampleField,
  sampleForecast,
  loadCachedForecast,
  fetchForecast,
} from './weatherApi';
import { angleDiff } from './wind';

// Convention under test: a wind direction is where the wind comes FROM (0 = north, 90 = east), speeds in km/h.

// 2026-10-03 00:00 UTC, in unix seconds like Open-Meteo sends with timeformat=unixtime
const T0 = 1790985600;
const HOUR = 3600;

/**
 * Synthetic forecast. `at(k, h, point)` describes grid point k at hour h and returns
 * { speed, dir, gust?, temp?, feels? }; missing fields get plain defaults.
 */
function makeForecast(hourCount, at) {
  return {
    hours: Array.from({ length: hourCount }, (_, h) => T0 + h * HOUR),
    points: GRID_POINTS.map((point, k) => {
      const p = { speed: [], dir: [], gust: [], temp: [], feels: [] };
      for (let h = 0; h < hourCount; h++) {
        const w = at(k, h, point);
        p.speed.push(w.speed);
        p.dir.push(w.dir);
        p.gust.push('gust' in w ? w.gust : w.speed);
        p.temp.push('temp' in w ? w.temp : 18);
        p.feels.push('feels' in w ? w.feels : 17);
      }
      return p;
    }),
    fetchedAt: T0 * 1000,
  };
}

// A different value at every grid point and hour. Every number is exact in a Float32Array
// (integers and quarters), so comparisons with the grid can be exact.
//   speed = 5 + k + 2h, dir = 10k + 90h, gust = speed + 4.5, temp = 15 + k/4 - h, feels = temp - 1.5
const ramp = (k, h) => ({
  speed: 5 + k + 2 * h,
  dir: (10 * k + 90 * h) % 360,
  gust: 5 + k + 2 * h + 4.5,
  temp: 15 + 0.25 * k - h,
  feels: 15 + 0.25 * k - h - 1.5,
});

const col = (k) => k % GRID.cols;

/** Asserts two directions are the same within `tol` degrees, treating 359.99 and 0 as neighbours. */
function expectDirection(actual, expected, tol = 0.01) {
  expect(Math.abs(angleDiff(actual, expected))).toBeLessThan(tol);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GRID_POINTS and COVERAGE', () => {
  it('has 6 x 6 = 36 points', () => {
    expect(GRID.rows).toBe(6);
    expect(GRID.cols).toBe(6);
    expect(GRID_POINTS).toHaveLength(36);
  });

  it('is row-major: west to east inside a row, rows from south to north', () => {
    // index k = row * 6 + col, lat = 38.375 + row * 0.125, lng = -9.5 + col * 0.125
    expect(GRID_POINTS[0]).toEqual({ lat: 38.375, lng: -9.5 }); // south-west corner
    expect(GRID_POINTS[1]).toEqual({ lat: 38.375, lng: -9.375 }); // one step east
    expect(GRID_POINTS[5]).toEqual({ lat: 38.375, lng: -8.875 }); // south-east corner
    expect(GRID_POINTS[6]).toEqual({ lat: 38.5, lng: -9.5 }); // one step north, back at the west edge
    expect(GRID_POINTS[14]).toEqual({ lat: 38.625, lng: -9.25 }); // row 2, col 2
    expect(GRID_POINTS[30]).toEqual({ lat: 39, lng: -9.5 }); // north-west corner
    expect(GRID_POINTS[35]).toEqual({ lat: 39, lng: -8.875 }); // north-east corner
  });

  it('never goes west or south as the index grows inside a row / across rows', () => {
    for (let k = 1; k < GRID_POINTS.length; k++) {
      const prev = GRID_POINTS[k - 1];
      const here = GRID_POINTS[k];
      if (k % GRID.cols === 0) {
        expect(here.lat).toBeGreaterThan(prev.lat);
        expect(here.lng).toBe(GRID.west);
      } else {
        expect(here.lat).toBe(prev.lat);
        expect(here.lng).toBeGreaterThan(prev.lng);
      }
    }
  });

  it('covers 38.375..39 north and -9.5..-8.875 east', () => {
    // 5 steps of 0.125 = 0.625 from the south-west corner in both directions
    expect(COVERAGE).toEqual({ south: 38.375, west: -9.5, north: 39, east: -8.875 });
  });

  it('has the coverage corners as its first and last point', () => {
    expect(GRID_POINTS[0]).toEqual({ lat: COVERAGE.south, lng: COVERAGE.west });
    expect(GRID_POINTS[35]).toEqual({ lat: COVERAGE.north, lng: COVERAGE.east });
  });

  it('contains every riding spot', () => {
    expect(SPOTS.length).toBeGreaterThan(0);
    expect(new Set(SPOTS.map((s) => s.id)).size).toBe(SPOTS.length);
    for (const spot of SPOTS) {
      expect(inCoverage(spot.lat, spot.lng), spot.id).toBe(true);
    }
  });
});

describe('inCoverage', () => {
  it('includes the edges and corners', () => {
    expect(inCoverage(38.375, -9.5)).toBe(true);
    expect(inCoverage(39, -8.875)).toBe(true);
    expect(inCoverage(38.375, -8.875)).toBe(true);
    expect(inCoverage(39, -9.5)).toBe(true);
    expect(inCoverage(38.7, -9.5)).toBe(true);
    expect(inCoverage(39, -9.1)).toBe(true);
  });

  it('includes central Lisbon', () => {
    expect(inCoverage(38.72, -9.14)).toBe(true);
  });

  it('excludes anything just past an edge', () => {
    expect(inCoverage(38.3749, -9.2)).toBe(false); // south
    expect(inCoverage(39.0001, -9.2)).toBe(false); // north
    expect(inCoverage(38.7, -9.5001)).toBe(false); // west
    expect(inCoverage(38.7, -8.8749)).toBe(false); // east
  });

  it('excludes places far away', () => {
    expect(inCoverage(41.15, -8.61)).toBe(false); // Porto
    expect(inCoverage(-38.7, 9.14)).toBe(false);
  });
});

describe('currentHourIndex', () => {
  const hours = [0, 1, 2, 3, 4, 5].map((h) => T0 + h * HOUR);
  const ms = (seconds) => seconds * 1000;

  it('is 0 before the first hour', () => {
    expect(currentHourIndex(hours, ms(T0 - 1))).toBe(0);
    expect(currentHourIndex(hours, ms(T0 - 10 * HOUR))).toBe(0);
  });

  it('is the hour itself when the clock is exactly on it', () => {
    expect(currentHourIndex(hours, ms(T0))).toBe(0);
    expect(currentHourIndex(hours, ms(T0 + 2 * HOUR))).toBe(2);
    expect(currentHourIndex(hours, ms(T0 + 5 * HOUR))).toBe(5);
  });

  it('is the hour that has started, not the nearest one, between two hours', () => {
    expect(currentHourIndex(hours, ms(T0 + 2 * HOUR + 1800))).toBe(2); // 02:30
    expect(currentHourIndex(hours, ms(T0 + 2 * HOUR + 3540))).toBe(2); // 02:59
    expect(currentHourIndex(hours, ms(T0 + 3 * HOUR) - 1)).toBe(2); // 1 ms before 03:00
    expect(currentHourIndex(hours, ms(T0 + 3 * HOUR))).toBe(3);
  });

  it('stays on the last hour once the forecast has run out', () => {
    expect(currentHourIndex(hours, ms(T0 + 5 * HOUR + 1))).toBe(5);
    expect(currentHourIndex(hours, ms(T0 + 500 * HOUR))).toBe(5);
  });

  it('uses the clock when no time is given', () => {
    vi.spyOn(Date, 'now').mockReturnValue(ms(T0 + 4 * HOUR + 60));
    expect(currentHourIndex(hours)).toBe(4);
  });

  it('answers 0 for a single-hour forecast', () => {
    expect(currentHourIndex([T0], ms(T0 + 99 * HOUR))).toBe(0);
  });
});

describe('buildField', () => {
  it('returns one flat typed array per quantity, one entry per grid point', () => {
    const field = buildField(makeForecast(3, ramp), 0);
    for (const key of ['u', 'v', 'speed', 'gust', 'temp', 'feels']) {
      expect(field[key], key).toBeInstanceOf(Float32Array);
      expect(field[key], key).toHaveLength(36);
    }
  });

  it('copies speed, temperature and feels-like for the requested hour, and the gusts of the hour that follows', () => {
    const field = buildField(makeForecast(3, ramp), 1);
    // hour 1: speed = 7 + k, temp = 14 + k/4, feels = 12.5 + k/4
    // Open-Meteo's gust value for an hour is the maximum of the hour ENDING then, so the gusts met from
    // hour 1 on are the ones stored under hour 2: 13.5 + k
    for (let k = 0; k < 36; k++) {
      expect(field.speed[k]).toBe(7 + k);
      expect(field.gust[k]).toBe(13.5 + k);
      expect(field.temp[k]).toBe(14 + 0.25 * k);
      expect(field.feels[k]).toBe(12.5 + 0.25 * k);
    }
  });

  it('turns speed and direction into the vector the air moves along', () => {
    const field = buildField(makeForecast(3, ramp), 1);
    // hour 1: dir = 10k + 90
    // k = 0: 7 km/h from 90 (east) -> blows west: u = -7, v = 0
    expect(field.u[0]).toBeCloseTo(-7, 4);
    expect(field.v[0]).toBeCloseTo(0, 4);
    // k = 9: 16 km/h from 180 (south) -> blows north: u = 0, v = +16
    expect(field.u[9]).toBeCloseTo(0, 4);
    expect(field.v[9]).toBeCloseTo(16, 4);
    // k = 18: 25 km/h from 270 (west) -> blows east: u = +25, v = 0
    expect(field.u[18]).toBeCloseTo(25, 4);
    expect(field.v[18]).toBeCloseTo(0, 4);
    // k = 27: 34 km/h from 360 = 0 (north) -> blows south: u = 0, v = -34
    expect(field.u[27]).toBeCloseTo(0, 4);
    expect(field.v[27]).toBeCloseTo(-34, 4);
    // k = 3: 10 km/h from 120 -> u = -10 sin 120 = -8.6603, v = -10 cos 120 = +5
    expect(field.u[3]).toBeCloseTo(-8.6603, 3);
    expect(field.v[3]).toBeCloseTo(5, 3);
  });

  it('keeps |(u, v)| equal to the speed at every point', () => {
    const field = buildField(makeForecast(3, ramp), 2);
    for (let k = 0; k < 36; k++) {
      expect(Math.hypot(field.u[k], field.v[k])).toBeCloseTo(field.speed[k], 4);
    }
  });

  it('reads a different hour as different numbers', () => {
    const forecast = makeForecast(3, ramp);
    expect(buildField(forecast, 0).speed[4]).toBe(9); // 5 + 4
    expect(buildField(forecast, 2).speed[4]).toBe(13); // 5 + 4 + 2 * 2
  });

  it('returns the very same object when asked twice for the same hour', () => {
    const forecast = makeForecast(3, ramp);
    const first = buildField(forecast, 1);
    expect(buildField(forecast, 1)).toBe(first);
    expect(buildField(forecast, 1)).toBe(first);
  });

  it('builds a separate field per hour and per forecast', () => {
    const forecast = makeForecast(3, ramp);
    expect(buildField(forecast, 0)).not.toBe(buildField(forecast, 1));
    // same numbers, different forecast object: nothing is shared
    expect(buildField(makeForecast(3, ramp), 1)).not.toBe(buildField(forecast, 1));
    expect(buildField(makeForecast(3, ramp), 1)).toEqual(buildField(forecast, 1));
  });

  it('keeps the gusts of the last hour for the last hour, where there is no following value', () => {
    const forecast = makeForecast(3, ramp);
    // hour 2 is the last one: gust stays 13.5 + k
    expect(buildField(forecast, 2).gust[5]).toBe(13.5 + 5);
  });

  it('blends the wind between two hours for a fractional hour', () => {
    const forecast = makeForecast(3, ramp);
    const lower = buildField(forecast, 1);
    const upper = buildField(forecast, 2);
    const half = buildField(forecast, 1.5);
    expect(half).not.toBe(lower);
    expect(half).not.toBe(upper);
    for (const k of [0, 7, 35]) {
      expect(half.speed[k]).toBeCloseTo((lower.speed[k] + upper.speed[k]) / 2, 4);
      expect(half.temp[k]).toBeCloseTo((lower.temp[k] + upper.temp[k]) / 2, 4);
      // the gusts are those of the hour in progress, not a blend
      expect(half.gust[k]).toBe(lower.gust[k]);
      // the blended vector keeps the blended speed
      expect(Math.hypot(half.u[k], half.v[k])).toBeCloseTo(half.speed[k], 3);
    }
    // a quarter of the way: speed moves a quarter of the difference
    expect(buildField(forecast, 1.25).speed[7]).toBeCloseTo(lower.speed[7] + (upper.speed[7] - lower.speed[7]) * 0.25, 4);
  });

  it('keeps the gusts of the hour in progress at a fractional hour, without blending in the next hour', () => {
    // four hours, so hour 1.5 is not in the last pair (where both ends hold the same clamped gusts)
    const forecast = makeForecast(4, ramp);
    // between hour 1 and hour 2 the gusts are the ones Open-Meteo files under hour 2: 9.5 + k + 2 * 2 = 13.5 + k.
    // Blending towards the following hour's 15.5 + k would give 14.5 + k.
    const half = buildField(forecast, 1.5);
    for (const k of [0, 7, 35]) {
      expect(half.gust[k]).toBe(13.5 + k);
    }
  });

  it('returns the same blended field while the moment is the same, and the whole-hour field on the hour', () => {
    const forecast = makeForecast(3, ramp);
    expect(buildField(forecast, 1.4)).toBe(buildField(forecast, 1.4));
    expect(buildField(forecast, 1.0004)).toBe(buildField(forecast, 1));
    expect(buildField(forecast, NaN)).toBe(buildField(forecast, 0));
  });

  it('clamps an hour outside the forecast to the first or last hour', () => {
    const forecast = makeForecast(3, ramp);
    expect(buildField(forecast, -4)).toBe(buildField(forecast, 0));
    expect(buildField(forecast, 99)).toBe(buildField(forecast, 2));
  });

  it('fills gaps in the data without inventing wind', () => {
    const forecast = makeForecast(2, (k) => {
      if (k === 3) return { speed: null, dir: null, gust: null, temp: null, feels: null };
      if (k === 4) return { speed: 12, dir: 90, gust: null, temp: 20, feels: null };
      return { speed: 10, dir: 0 };
    });
    const field = buildField(forecast, 0);
    // nothing known at point 3: no wind, and gust falls back to the (zero) speed
    expect(field.speed[3]).toBe(0);
    expect(Math.abs(field.u[3])).toBe(0);
    expect(Math.abs(field.v[3])).toBe(0);
    expect(field.gust[3]).toBe(0);
    expect(field.temp[3]).toBe(0);
    expect(field.feels[3]).toBe(0);
    // point 4: a missing gust is the steady speed, a missing feels-like is the temperature
    expect(field.gust[4]).toBe(12);
    expect(field.feels[4]).toBe(20);
  });
});

describe('sampleField', () => {
  it('reproduces the grid values exactly at every grid node', () => {
    const field = buildField(makeForecast(1, ramp), 0);
    GRID_POINTS.forEach((point, k) => {
      const s = sampleField(field, point.lat, point.lng);
      expect(s.speed, `speed at ${k}`).toBe(5 + k);
      expect(s.gust, `gust at ${k}`).toBe(9.5 + k);
      expect(s.temp, `temp at ${k}`).toBe(15 + 0.25 * k);
      expect(s.feels, `feels at ${k}`).toBe(13.5 + 0.25 * k);
      expectDirection(s.from, 10 * k, 0.001);
      expect(s.u).toBeCloseTo(field.u[k], 4);
      expect(s.v).toBeCloseTo(field.v[k], 4);
      expect(s.outside, `outside at ${k}`).toBe(false);
    });
  });

  it('is the mean of the four corners at a cell centre', () => {
    const field = buildField(makeForecast(1, ramp), 0);
    // centre of the south-west cell: corners are points 0, 1, 6 and 7
    const sw = sampleField(field, 38.4375, -9.4375);
    expect(sw.speed).toBeCloseTo(8.5, 10); // (5 + 6 + 11 + 12) / 4
    expect(sw.gust).toBeCloseTo(13, 10); // (9.5 + 10.5 + 15.5 + 16.5) / 4
    expect(sw.temp).toBeCloseTo(15.875, 10); // (15 + 15.25 + 16.5 + 16.75) / 4
    expect(sw.feels).toBeCloseTo(14.375, 10); // temp - 1.5
    expect(sw.outside).toBe(false);
    // centre of the north-east cell: corners are points 28, 29, 34 and 35
    const ne = sampleField(field, 38.9375, -8.9375);
    expect(ne.speed).toBeCloseTo(36.5, 10); // (33 + 34 + 39 + 40) / 4
  });

  it('weights the corners bilinearly away from the centre', () => {
    const field = buildField(makeForecast(1, ramp), 0);
    // a quarter of the way east and three quarters of the way north inside the south-west cell:
    // weights SW 0.75 * 0.25, SE 0.25 * 0.25, NW 0.75 * 0.75, NE 0.25 * 0.75
    // speed = 5 * 0.1875 + 6 * 0.0625 + 11 * 0.5625 + 12 * 0.1875 = 9.75
    expect(sampleField(field, 38.46875, -9.46875).speed).toBeCloseTo(9.75, 10);
    // speed = 5 + col + 6 * row is linear, so it is reproduced anywhere: row 2.75, col 3.25 -> 24.75
    expect(sampleField(field, 38.71875, -9.09375).speed).toBeCloseTo(24.75, 10);
  });

  it('blends direction as a vector: neighbours at 350 and 10 give north, never south', () => {
    // columns alternate between 350 and 10 degrees, all at 10 km/h
    const field = buildField(makeForecast(1, (k) => ({ speed: 10, dir: col(k) % 2 === 0 ? 350 : 10 })), 0);
    // halfway between two nodes of the same row
    const onRow = sampleField(field, 38.5, -9.4375);
    expectDirection(onRow.from, 0);
    expect(onRow.speed).toBeCloseTo(10, 6);
    // the air still moves south at the full 10 km/h
    expect(onRow.u).toBeCloseTo(0, 4);
    expect(onRow.v).toBeCloseTo(-10, 4);
    // centre of a cell: two corners at 350, two at 10
    const centre = sampleField(field, 38.5625, -9.1875);
    expectDirection(centre.from, 0);
    expect(centre.speed).toBeCloseTo(10, 6);
  });

  it('leans towards the nearer neighbour when blending direction', () => {
    const field = buildField(makeForecast(1, (k) => ({ speed: 10, dir: col(k) % 2 === 0 ? 350 : 10 })), 0);
    // a quarter of the way from the 350 node to the 10 node:
    //   u = 0.75 * (-10 sin 350) + 0.25 * (-10 sin 10) = 1.7365 * 0.5 = 0.8682
    //   v = -10 cos 10 = -9.8481
    //   from = atan2(-0.8682, 9.8481) = -5.04 degrees = 354.96
    const s = sampleField(field, 38.5, -9.46875);
    expect(s.from).toBeCloseTo(354.96, 1);
    expect(s.speed).toBeCloseTo(10, 6);
  });

  it('uses the plain mean for speed and the vector mean for direction', () => {
    // even columns: 10 km/h from the north. odd columns: 20 km/h from the east.
    const field = buildField(makeForecast(1, (k) => (col(k) % 2 === 0 ? { speed: 10, dir: 0 } : { speed: 20, dir: 90 })), 0);
    const s = sampleField(field, 38.5, -9.4375);
    // speed: (10 + 20) / 2 = 15
    expect(s.speed).toBeCloseTo(15, 6);
    // vector mean: u = (0 - 20) / 2 = -10, v = (-10 + 0) / 2 = -5 -> from = atan2(10, 5) = 63.435
    expect(s.from).toBeCloseTo(63.435, 2);
    // the vector is stretched from its mean length 11.18 to the blended speed 15:
    // u = -10 / 11.1803 * 15 = -13.4164, v = -5 / 11.1803 * 15 = -6.7082
    expect(s.u).toBeCloseTo(-13.4164, 3);
    expect(s.v).toBeCloseTo(-6.7082, 3);
    expect(Math.hypot(s.u, s.v)).toBeCloseTo(s.speed, 6);
  });

  it('keeps the speed between two opposing winds instead of cancelling it to zero', () => {
    // columns alternate between 20 km/h from the north and 20 km/h from the south
    const field = buildField(makeForecast(1, (k) => ({ speed: 20, dir: col(k) % 2 === 0 ? 0 : 180 })), 0);
    // exactly halfway the two vectors cancel, the speed must not
    const middle = sampleField(field, 38.5, -9.4375);
    expect(middle.speed).toBeCloseTo(20, 6);
    expect(Number.isFinite(middle.from)).toBe(true);
    expect(Number.isFinite(middle.u)).toBe(true);
    expect(Number.isFinite(middle.v)).toBe(true);
    // a quarter of the way: the vector mean is only 10 km/h (0.75 * -20 + 0.25 * 20) but the
    // speed stays 20, pointing the way of the nearer (northerly) neighbour
    const nearNorth = sampleField(field, 38.5, -9.46875);
    expect(nearNorth.speed).toBeCloseTo(20, 6);
    expectDirection(nearNorth.from, 0);
    expect(nearNorth.v).toBeCloseTo(-20, 4);
    // and three quarters of the way the southerly neighbour wins
    const nearSouth = sampleField(field, 38.5, -9.40625);
    expect(nearSouth.speed).toBeCloseTo(20, 6);
    expectDirection(nearSouth.from, 180);
  });

  it('gives the nearest edge value outside the grid and says so', () => {
    const field = buildField(makeForecast(1, ramp), 0);
    // due south of the south-west corner -> point 0
    const south = sampleField(field, 37, -9.5);
    expect(south.speed).toBe(5);
    expect(south.outside).toBe(true);
    // due west of the south-west corner -> point 0
    const west = sampleField(field, 38.375, -10.2);
    expect(west.speed).toBe(5);
    expect(west.temp).toBe(15);
    expect(west.outside).toBe(true);
    // far to the north-east -> point 35
    const northEast = sampleField(field, 40, -8);
    expect(northEast.speed).toBe(40);
    expect(northEast.gust).toBe(44.5);
    expectDirection(northEast.from, 350, 0.001);
    expect(northEast.outside).toBe(true);
    // far to the south-east -> point 5
    expect(sampleField(field, 30, 0).speed).toBe(10);
    // far to the north-west -> point 30
    expect(sampleField(field, 50, -20).speed).toBe(35);
  });

  it('still interpolates along the edge it was clamped to', () => {
    const field = buildField(makeForecast(1, ramp), 0);
    // north of the grid, halfway between the columns of points 30 and 31: (35 + 36) / 2
    const north = sampleField(field, 39.5, -9.4375);
    expect(north.speed).toBeCloseTo(35.5, 10);
    expect(north.outside).toBe(true);
    // the same values as on the edge itself
    const onEdge = sampleField(field, 39, -9.4375);
    expect(onEdge.outside).toBe(false);
    expect({ ...north, outside: false }).toEqual(onEdge);
  });

  it('counts the grid edges themselves as inside', () => {
    const field = buildField(makeForecast(1, ramp), 0);
    expect(sampleField(field, 38.375, -9.2).outside).toBe(false);
    expect(sampleField(field, 39, -8.875).outside).toBe(false);
    expect(sampleField(field, 39.0001, -8.875).outside).toBe(true);
    expect(sampleField(field, 38.7, -8.8749).outside).toBe(true);
  });
});

describe('sampleForecast', () => {
  // hour 0: 10 km/h from the north, gust 20, 10 degrees, feels 8
  // hour 1: 20 km/h from the north, gust 40, 20 degrees, feels 16
  const building = (k, h) => ({ speed: 10 + 10 * h, dir: 0, gust: 20 + 20 * h, temp: 10 + 10 * h, feels: 8 + 8 * h });
  const LAT = 38.7;
  const LNG = -9.2;

  it('is the field of that hour on a whole hour', () => {
    const forecast = makeForecast(2, building);
    expect(sampleForecast(forecast, 0, LAT, LNG)).toEqual(sampleField(buildField(forecast, 0), LAT, LNG));
    expect(sampleForecast(forecast, 1, LAT, LNG)).toEqual(sampleField(buildField(forecast, 1), LAT, LNG));
  });

  it('interpolates every quantity halfway between two hours', () => {
    const s = sampleForecast(makeForecast(2, building), 0.5, LAT, LNG);
    expect(s.speed).toBeCloseTo(15, 6); // (10 + 20) / 2
    expect(s.gust).toBeCloseTo(40, 6); // gusts of the hour in progress: Open-Meteo stores them under hour 1
    expect(s.temp).toBeCloseTo(15, 6); // (10 + 20) / 2
    expect(s.feels).toBeCloseTo(12, 6); // (8 + 16) / 2
    expectDirection(s.from, 0);
    expect(s.u).toBeCloseTo(0, 6);
    expect(s.v).toBeCloseTo(-15, 6);
    expect(s.outside).toBe(false);
  });

  it('interpolates in proportion to the minutes past the hour', () => {
    const forecast = makeForecast(2, building);
    expect(sampleForecast(forecast, 0.25, LAT, LNG).speed).toBeCloseTo(12.5, 6); // 10 + 0.25 * 10
    expect(sampleForecast(forecast, 0.4, LAT, LNG).speed).toBeCloseTo(14, 6); // 24 minutes past
    expect(sampleForecast(forecast, 0.9, LAT, LNG).gust).toBeCloseTo(40, 6); // not blended: the gusts of hour 0 to 1
  });

  it('reports the gusts of the hour in progress, not a blend with the next hour', () => {
    const forecast = makeForecast(4, ramp);
    // point 14 is the node at 38.625, -9.25: gust = 23.5 + 2h. Between hour 1 and hour 2 the gusts are the
    // ones filed under hour 2, 27.5, all the way through; a blend would pass 28.5 at half past.
    expect(sampleForecast(forecast, 1.1, 38.625, -9.25).gust).toBeCloseTo(27.5, 6);
    expect(sampleForecast(forecast, 1.5, 38.625, -9.25).gust).toBeCloseTo(27.5, 6);
    expect(sampleForecast(forecast, 1.9, 38.625, -9.25).gust).toBeCloseTo(27.5, 6);
    // and from hour 2 on, the ones filed under hour 3
    expect(sampleForecast(forecast, 2, 38.625, -9.25).gust).toBeCloseTo(29.5, 6);
  });

  it('picks the right pair of hours in a longer forecast', () => {
    const forecast = makeForecast(4, ramp);
    // point 14 is the node at 38.625, -9.25: speed = 19 + 2h, so hour 2.5 gives 24
    expect(sampleForecast(forecast, 2.5, 38.625, -9.25).speed).toBeCloseTo(24, 6);
    // temp = 18.5 - h, so hour 1.25 gives 17.25
    expect(sampleForecast(forecast, 1.25, 38.625, -9.25).temp).toBeCloseTo(17.25, 6);
  });

  it('turns the wind through north, not through south, between 350 and 10 degrees', () => {
    const veering = makeForecast(2, (k, h) => ({ speed: 10, dir: h === 0 ? 350 : 10 }));
    const s = sampleForecast(veering, 0.5, LAT, LNG);
    expectDirection(s.from, 0);
    expect(s.speed).toBeCloseTo(10, 6);
    // a quarter of the way through the hour, same sum as in space: 354.96
    expect(sampleForecast(veering, 0.25, LAT, LNG).from).toBeCloseTo(354.96, 1);
  });

  it('keeps the speed when the wind reverses within the hour', () => {
    const reversing = makeForecast(2, (k, h) => ({ speed: 20, dir: h === 0 ? 0 : 180 }));
    const s = sampleForecast(reversing, 0.5, LAT, LNG);
    expect(s.speed).toBeCloseTo(20, 6);
    expect(Number.isFinite(s.from)).toBe(true);
    expectDirection(sampleForecast(reversing, 0.25, LAT, LNG).from, 0);
    expectDirection(sampleForecast(reversing, 0.75, LAT, LNG).from, 180);
  });

  it('clamps beyond the last hour to the last hour', () => {
    const forecast = makeForecast(2, building);
    const last = sampleField(buildField(forecast, 1), LAT, LNG);
    expect(sampleForecast(forecast, 1.5, LAT, LNG)).toEqual(last);
    expect(sampleForecast(forecast, 7.3, LAT, LNG)).toEqual(last);
    expect(sampleForecast(forecast, 7.3, LAT, LNG).speed).toBeCloseTo(20, 6);
  });

  it('clamps before the first hour to the first hour', () => {
    const forecast = makeForecast(2, building);
    expect(sampleForecast(forecast, -3, LAT, LNG)).toEqual(sampleField(buildField(forecast, 0), LAT, LNG));
  });

  it('interpolates in space and time together', () => {
    const forecast = makeForecast(2, ramp);
    // centre of the south-west cell: 8.5 at hour 0 (see above) and 10.5 at hour 1 -> 9.5 halfway
    expect(sampleForecast(forecast, 0.5, 38.4375, -9.4375).speed).toBeCloseTo(9.5, 6);
  });

  it('flags positions outside the grid at any time', () => {
    const forecast = makeForecast(2, building);
    expect(sampleForecast(forecast, 0, 41.15, -8.61).outside).toBe(true);
    expect(sampleForecast(forecast, 0.5, 41.15, -8.61).outside).toBe(true);
    expect(sampleForecast(forecast, 0.5, 41.15, -8.61).speed).toBeCloseTo(15, 6);
  });
});

/** A one-slot stand-in for localStorage that records which keys were used. */
function fakeStorage(initial = null) {
  const state = { value: initial, readKeys: [], writtenKeys: [] };
  return {
    state,
    getItem: (key) => {
      state.readKeys.push(key);
      return state.value;
    },
    setItem: (key, value) => {
      state.writtenKeys.push(key);
      state.value = String(value);
    },
  };
}

describe('loadCachedForecast', () => {
  const steady = () => ({ speed: 10, dir: 0 });
  // 3 hours: T0, T0 + 1h, T0 + 2h
  const stored = () => makeForecast(3, steady);
  const nowAt = (seconds) => seconds * 1000;

  it('returns null when nothing was saved', () => {
    vi.stubGlobal('localStorage', fakeStorage(null));
    expect(loadCachedForecast(nowAt(T0))).toBeNull();
  });

  it('returns the saved forecast while its last hour is still ahead', () => {
    vi.stubGlobal('localStorage', fakeStorage(JSON.stringify(stored())));
    expect(loadCachedForecast(nowAt(T0 + HOUR))).toEqual(stored());
    expect(loadCachedForecast(nowAt(T0 - 5 * HOUR))).toEqual(stored());
  });

  it('returns null once the forecast has run out', () => {
    vi.stubGlobal('localStorage', fakeStorage(JSON.stringify(stored())));
    expect(loadCachedForecast(nowAt(T0 + 3 * HOUR + 1))).toBeNull();
    expect(loadCachedForecast(nowAt(T0 + 48 * HOUR))).toBeNull();
  });

  it('runs out at the moment its last hour begins, not an hour later', () => {
    vi.stubGlobal('localStorage', fakeStorage(JSON.stringify(stored())));
    // the last hour is T0 + 2h: one second earlier it is still ahead, on the dot there is nothing left to look ahead to
    expect(loadCachedForecast(nowAt(T0 + 2 * HOUR - 1))).toEqual(stored());
    expect(loadCachedForecast(nowAt(T0 + 2 * HOUR))).toBeNull();
    expect(loadCachedForecast(nowAt(T0 + 2 * HOUR + 1800))).toBeNull();
  });

  it('uses the clock when no time is given', () => {
    vi.stubGlobal('localStorage', fakeStorage(JSON.stringify(stored())));
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(nowAt(T0 + 600));
    expect(loadCachedForecast()).toEqual(stored());
    clock.mockReturnValue(nowAt(T0 + 72 * HOUR));
    expect(loadCachedForecast()).toBeNull();
  });

  it('returns null for text that is not JSON', () => {
    vi.stubGlobal('localStorage', fakeStorage('{not json'));
    expect(loadCachedForecast(nowAt(T0))).toBeNull();
  });

  it('returns null for JSON of the wrong shape', () => {
    for (const bad of ['null', '42', '"forecast"', '{}', '{"hours":[1,2]}', '{"points":[]}', '{"hours":"x","points":"y"}']) {
      vi.stubGlobal('localStorage', fakeStorage(bad));
      expect(loadCachedForecast(nowAt(T0)), bad).toBeNull();
    }
  });

  it('returns null when the saved grid has a different number of points', () => {
    const smaller = stored();
    smaller.points = smaller.points.slice(0, 25); // e.g. saved by a version with a 5 x 5 grid
    vi.stubGlobal('localStorage', fakeStorage(JSON.stringify(smaller)));
    expect(loadCachedForecast(nowAt(T0))).toBeNull();
  });

  it('returns null when the saved forecast has no hours', () => {
    const empty = stored();
    empty.hours = [];
    vi.stubGlobal('localStorage', fakeStorage(JSON.stringify(empty)));
    expect(loadCachedForecast(nowAt(T0))).toBeNull();
  });

  it('returns null when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(loadCachedForecast(nowAt(T0))).toBeNull();
  });

  it('returns null when there is no storage at all', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadCachedForecast(nowAt(T0))).toBeNull();
  });
});

describe('fetchForecast', () => {
  // What Open-Meteo answers for a multi-location request: one object per requested location, in order.
  function apiPayload(hourCount = 4) {
    const time = Array.from({ length: hourCount }, (_, h) => T0 + h * HOUR);
    return GRID_POINTS.map((point, k) => ({
      latitude: point.lat,
      longitude: point.lng,
      hourly: {
        time,
        temperature_2m: time.map((_, h) => 15 + 0.25 * k - h),
        apparent_temperature: time.map((_, h) => 13.5 + 0.25 * k - h),
        wind_speed_10m: time.map((_, h) => 5 + k + 2 * h),
        wind_direction_10m: time.map((_, h) => (10 * k + 90 * h) % 360),
        wind_gusts_10m: time.map((_, h) => 9.5 + k + 2 * h),
      },
    }));
  }

  const answering = (payload, init = {}) =>
    vi.fn(async () => ({ ok: true, status: 200, json: async () => payload, ...init }));

  it('asks Open-Meteo once for every grid point, three days, in unix time', async () => {
    const fetchMock = answering(apiPayload());
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', fakeStorage());

    await fetchForecast();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(url.searchParams.get('latitude').split(',').map(Number)).toEqual(GRID_POINTS.map((p) => p.lat));
    expect(url.searchParams.get('longitude').split(',').map(Number)).toEqual(GRID_POINTS.map((p) => p.lng));
    expect(url.searchParams.get('timeformat')).toBe('unixtime');
    expect(url.searchParams.get('forecast_days')).toBe('3');
    const hourly = url.searchParams.get('hourly').split(',');
    for (const name of ['temperature_2m', 'apparent_temperature', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m']) {
      expect(hourly).toContain(name);
    }
    // km/h and Celsius are Open-Meteo's defaults; a unit override would change every number in the app
    expect(url.searchParams.get('wind_speed_unit') ?? 'kmh').toBe('kmh');
    expect(url.searchParams.get('temperature_unit') ?? 'celsius').toBe('celsius');
    // the model cell each grid point sits in, not Open-Meteo's default of the nearest land cell: half of
    // this grid is sea and estuary, and the routes run along the shore
    expect(url.searchParams.get('cell_selection')).toBe('nearest');
  });

  it('reshapes the answer into hours plus one series set per grid point', async () => {
    vi.stubGlobal('fetch', answering(apiPayload(4)));
    vi.stubGlobal('localStorage', fakeStorage());
    vi.spyOn(Date, 'now').mockReturnValue(1234567890123);

    const forecast = await fetchForecast();

    expect(forecast.hours).toEqual([T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR]);
    expect(forecast.fetchedAt).toBe(1234567890123);
    expect(forecast.points).toHaveLength(36);
    // point 7 at hours 0..3: speed 12 + 2h, dir 70 + 90h, gust 16.5 + 2h, temp 16.75 - h, feels 15.25 - h
    expect(forecast.points[7]).toEqual({
      speed: [12, 14, 16, 18],
      dir: [70, 160, 250, 340],
      gust: [16.5, 18.5, 20.5, 22.5],
      temp: [16.75, 15.75, 14.75, 13.75],
      feels: [15.25, 14.25, 13.25, 12.25],
    });
    // and it feeds straight into the field builder
    expect(buildField(forecast, 1).speed[7]).toBe(14);
  });

  it('refuses a forecast whose complete hours end before now, instead of showing its last hour as the present', async () => {
    const payload = apiPayload(4);
    payload[7].hourly.wind_speed_10m[2] = null;
    payload[7].hourly.wind_speed_10m[3] = null;
    vi.stubGlobal('fetch', answering(payload));
    vi.stubGlobal('localStorage', fakeStorage());
    // it is already hour 2, the first one with a hole
    const clock = vi.spyOn(Date, 'now').mockReturnValue((T0 + 2 * HOUR) * 1000 + 60000);

    await expect(fetchForecast()).rejects.toThrow('no wind data for the current hour');
    clock.mockRestore();
  });

  it('refuses a forecast with no complete hour at all', async () => {
    const payload = apiPayload(4);
    payload[3].hourly.wind_gusts_10m[0] = null;
    vi.stubGlobal('fetch', answering(payload));
    vi.stubGlobal('localStorage', fakeStorage());
    await expect(fetchForecast()).rejects.toThrow('no wind data');
  });

  it('saves the forecast so the next launch can read it back', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('fetch', answering(apiPayload(4)));
    vi.stubGlobal('localStorage', storage);

    const forecast = await fetchForecast();

    expect(storage.state.writtenKeys).toHaveLength(1);
    const cached = loadCachedForecast((T0 + HOUR) * 1000);
    expect(cached).toEqual(forecast);
    // read back from the same slot it was written to
    expect(storage.state.readKeys.at(-1)).toBe(storage.state.writtenKeys[0]);
  });

  it('shares one request between calls made while it is under way', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => apiPayload(4) };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', fakeStorage());

    const first = fetchForecast();
    const second = fetchForecast();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(a.points).toHaveLength(36);
  });

  it('asks again once the previous request has finished', async () => {
    const fetchMock = answering(apiPayload(4));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', fakeStorage());

    await fetchForecast();
    await fetchForecast();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks again after a failed request instead of repeating the failure', async () => {
    vi.stubGlobal('localStorage', fakeStorage());
    vi.stubGlobal('fetch', answering(null, { ok: false, status: 500 }));
    await expect(fetchForecast()).rejects.toThrow('500');

    vi.stubGlobal('fetch', answering(apiPayload(4)));
    const forecast = await fetchForecast();
    expect(forecast.hours).toHaveLength(4);
  });

  it('fails every caller that was waiting on a shared request', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', fakeStorage());

    const results = await Promise.allSettled([fetchForecast(), fetchForecast()]);

    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still returns the forecast when storage is full', async () => {
    vi.stubGlobal('fetch', answering(apiPayload(4)));
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    const forecast = await fetchForecast();
    expect(forecast.points).toHaveLength(36);
  });

  it('throws on an HTTP error instead of inventing weather', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('fetch', answering(null, { ok: false, status: 503 }));
    vi.stubGlobal('localStorage', storage);
    await expect(fetchForecast()).rejects.toThrow('503');
    expect(storage.state.writtenKeys).toHaveLength(0);
  });

  it('throws when the network is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    vi.stubGlobal('localStorage', fakeStorage());
    await expect(fetchForecast()).rejects.toThrow('Failed to fetch');
  });

  it('rejects an answer with the wrong number of locations', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('fetch', answering(apiPayload(4).slice(0, 35)));
    vi.stubGlobal('localStorage', storage);
    await expect(fetchForecast()).rejects.toThrow('Unexpected forecast response');
    expect(storage.state.writtenKeys).toHaveLength(0);
  });

  it('rejects an answer that is not a list, such as an API error object', async () => {
    vi.stubGlobal('fetch', answering({ error: true, reason: 'Too many requests' }));
    vi.stubGlobal('localStorage', fakeStorage());
    await expect(fetchForecast()).rejects.toThrow('Unexpected forecast response');
  });

  it('rejects an answer without hours', async () => {
    const payload = apiPayload(4);
    payload[0].hourly.time = [];
    vi.stubGlobal('fetch', answering(payload));
    vi.stubGlobal('localStorage', fakeStorage());
    await expect(fetchForecast()).rejects.toThrow('Unexpected forecast response');
  });

  it('rejects an answer where one location misses a series or has a shorter one', async () => {
    const missing = apiPayload(4);
    delete missing[20].hourly.wind_gusts_10m;
    vi.stubGlobal('fetch', answering(missing));
    vi.stubGlobal('localStorage', fakeStorage());
    await expect(fetchForecast()).rejects.toThrow('Unexpected forecast response');

    const short = apiPayload(4);
    short[20].hourly.wind_speed_10m = [1, 2, 3];
    vi.stubGlobal('fetch', answering(short));
    await expect(fetchForecast()).rejects.toThrow('Unexpected forecast response');
  });

  it('drops the hours for which a grid point has no wind, so a hole is never shown as calm', async () => {
    // Open-Meteo sends null where a model has no value: here point 7 has no wind speed for hours 2 and 3
    const payload = apiPayload(4);
    payload[7].hourly.wind_speed_10m[2] = null;
    payload[7].hourly.wind_speed_10m[3] = null;
    vi.stubGlobal('fetch', answering(payload));
    vi.stubGlobal('localStorage', fakeStorage());
    // it is one minute past the first hour, so the two complete hours still reach the present
    const clock = vi.spyOn(Date, 'now').mockReturnValue(T0 * 1000 + 60000);

    const forecast = await fetchForecast();
    clock.mockRestore();

    expect(forecast.hours).toEqual([T0, T0 + HOUR]);
    for (const point of forecast.points) {
      for (const key of ['speed', 'dir', 'gust', 'temp', 'feels']) {
        expect(point[key], key).toHaveLength(2);
      }
    }
    // the two hours that are left are untouched: point 7 has speed 12 + 2h and direction 70 + 90h
    expect(forecast.points[7].speed).toEqual([12, 14]);
    expect(forecast.points[7].dir).toEqual([70, 160]);
    expect(buildField(forecast, 1).speed[7]).toBe(14);
  });

  it('rejects an answer whose very first hour has no wind', async () => {
    const storage = fakeStorage();
    const payload = apiPayload(4);
    payload[20].hourly.wind_direction_10m[0] = null;
    vi.stubGlobal('fetch', answering(payload));
    vi.stubGlobal('localStorage', storage);
    await expect(fetchForecast()).rejects.toThrow('no wind data');
    expect(storage.state.writtenKeys).toHaveLength(0);
  });
});

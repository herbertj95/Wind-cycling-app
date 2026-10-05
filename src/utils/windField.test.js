import { describe, it, expect } from 'vitest';
import { pointAt, blendAt } from './windField';
import { nodeKey } from './lattice';
import { angleDiff } from './wind';

// Convention under test: a wind direction is where the wind comes FROM (0 = north, 90 = east), speeds in km/h.
// In the vector (u, v), u is the part blowing towards the east and v the part blowing towards the north.

const T0 = 1790985600; // 2026-10-03 00:00 UTC, in unix seconds like Open-Meteo sends with timeformat=unixtime
const HOUR = 3600;

/** A forecast point as fetchPoints returns it, from one { speed, dir, gust?, temp?, feels?, rain?, rainChance? } per hour. */
function makePoint(hourly, extra = {}) {
  return {
    t0: T0,
    n: hourly.length,
    speed: hourly.map((w) => w.speed),
    dir: hourly.map((w) => w.dir),
    gust: hourly.map((w) => ('gust' in w ? w.gust : w.speed)),
    temp: hourly.map((w) => ('temp' in w ? w.temp : 18)),
    feels: hourly.map((w) => ('feels' in w ? w.feels : 17)),
    rain: hourly.map((w) => ('rain' in w ? w.rain : 0)),
    rainChance: hourly.map((w) => ('rainChance' in w ? w.rainChance : 0)),
    zone: 'Europe/Lisbon',
    fetchedAt: T0 * 1000,
    ...extra,
  };
}

/** Asserts two directions are the same within `tol` degrees, treating 359.99 and 0 as neighbours. */
function expectDirection(actual, expected, tol = 0.01) {
  expect(Math.abs(angleDiff(actual, expected))).toBeLessThan(tol);
}

const directionOf = (value) => ((Math.atan2(-value.u, -value.v) * 180) / Math.PI + 360) % 360;

describe('pointAt', () => {
  const point = makePoint([
    { speed: 10, dir: 0, gust: 14, temp: 20, feels: 19 },
    { speed: 20, dir: 90, gust: 26, temp: 18, feels: 16 },
    { speed: 30, dir: 180, gust: 44, temp: 16, feels: 13 },
  ]);

  it('has nothing to say about a point that is not loaded or has no hours', () => {
    expect(pointAt(undefined, T0)).toBeNull();
    expect(pointAt(null, T0)).toBeNull();
    expect(pointAt(makePoint([]), T0)).toBeNull();
  });

  it('gives the forecast values on the hour', () => {
    const at = pointAt(point, T0 + HOUR);
    expect(at.speed).toBe(20);
    expect(at.temp).toBe(18);
    expect(at.feels).toBe(16);
    expect(at.late).toBe(false);
    expect(at.fetchedAt).toBe(T0 * 1000);
  });

  it('turns the direction the wind comes from into the vector it blows along', () => {
    // from the north: blowing south
    const north = pointAt(point, T0);
    expect(north.u).toBeCloseTo(0, 9);
    expect(north.v).toBeCloseTo(-10, 9);
    // from the east: blowing west
    const east = pointAt(point, T0 + HOUR);
    expect(east.u).toBeCloseTo(-20, 9);
    expect(east.v).toBeCloseTo(0, 9);
    // from the south: blowing north
    const south = pointAt(point, T0 + 2 * HOUR);
    expect(south.u).toBeCloseTo(0, 9);
    expect(south.v).toBeCloseTo(30, 9);
  });

  it('reports the gusts of the hour in progress, which Open-Meteo files under the hour that ends it', () => {
    // the gusts met from 00:00 on are the 01:00 value, and so on
    expect(pointAt(point, T0).gust).toBe(26);
    expect(pointAt(point, T0 + 0.5 * HOUR).gust).toBe(26);
    expect(pointAt(point, T0 + HOUR).gust).toBe(44);
    expect(pointAt(point, T0 + 1.9 * HOUR).gust).toBe(44);
    // the last hour has no next value: it keeps its own
    expect(pointAt(point, T0 + 2 * HOUR).gust).toBe(44);
  });

  it('reports the rain of the hour in progress and its chance, filed like the gusts under the hour that ends it', () => {
    const showers = makePoint([
      { speed: 10, dir: 0, rain: 9, rainChance: 99 },
      { speed: 10, dir: 0, rain: 0.4, rainChance: 60 },
      { speed: 10, dir: 0, rain: 2.5, rainChance: 85 },
    ]);
    // what falls from 00:00 to 01:00 is the 01:00 value: the 00:00 value belongs to the hour before
    expect(pointAt(showers, T0).rain).toBe(0.4);
    expect(pointAt(showers, T0).rainChance).toBe(60);
    // it is an amount for the whole hour, not a value to blend towards the next one
    expect(pointAt(showers, T0 + 0.5 * HOUR).rain).toBe(0.4);
    expect(pointAt(showers, T0 + HOUR).rain).toBe(2.5);
    expect(pointAt(showers, T0 + HOUR).rainChance).toBe(85);
    // the last hour has no next value: it keeps its own
    expect(pointAt(showers, T0 + 2 * HOUR).rain).toBe(2.5);
  });

  it('has nothing to say about the rain where the forecast does not give it', () => {
    const patchy = makePoint([
      { speed: 10, dir: 0 },
      { speed: 10, dir: 0, rain: null, rainChance: null },
    ]);
    expect(Number.isNaN(pointAt(patchy, T0).rain)).toBe(true);
    expect(Number.isNaN(pointAt(patchy, T0).rainChance)).toBe(true);
    // a point kept from before the app read the rain has no such series at all: its wind is still read
    const old = makePoint([{ speed: 12, dir: 0 }, { speed: 14, dir: 0 }]);
    delete old.rain;
    delete old.rainChance;
    expect(pointAt(old, T0).speed).toBe(12);
    expect(Number.isNaN(pointAt(old, T0).rain)).toBe(true);
    expect(Number.isNaN(pointAt(old, T0).rainChance)).toBe(true);
  });

  it('blends speed and temperature between two hours', () => {
    const at = pointAt(point, T0 + 0.25 * HOUR);
    expect(at.speed).toBeCloseTo(12.5, 9);
    expect(at.temp).toBeCloseTo(19.5, 9);
    expect(at.feels).toBeCloseTo(18.25, 9);
  });

  it('turns the direction through the shorter way round, and keeps the blended speed', () => {
    const veering = makePoint([{ speed: 20, dir: 350 }, { speed: 20, dir: 10 }]);
    const mid = pointAt(veering, T0 + 0.5 * HOUR);
    expectDirection(directionOf(mid), 0);
    // the vector is scaled back to the blended speed: two 20 km/h winds never average to less
    expect(Math.hypot(mid.u, mid.v)).toBeCloseTo(20, 9);
    expect(mid.speed).toBeCloseTo(20, 9);
  });

  it('follows the stronger wind when the direction swings right round', () => {
    const swinging = makePoint([{ speed: 20, dir: 0 }, { speed: 20, dir: 180 }]);
    // a quarter of the way the northerly still wins, three quarters of the way the southerly does
    expectDirection(directionOf(pointAt(swinging, T0 + 0.25 * HOUR)), 0);
    expectDirection(directionOf(pointAt(swinging, T0 + 0.75 * HOUR)), 180);
  });

  it('treats a moment within a few seconds of the hour as the hour', () => {
    const at = pointAt(point, T0 + HOUR + 2);
    expect(at.speed).toBe(20);
    expect(at.u).toBeCloseTo(-20, 9);
  });

  it('uses the first hour for an earlier moment, without calling it late', () => {
    const at = pointAt(point, T0 - 5 * HOUR);
    expect(at.speed).toBe(10);
    expect(at.late).toBe(false);
  });

  it('uses the last hour past the end of the forecast and says so', () => {
    const exactlyLast = pointAt(point, T0 + 2 * HOUR);
    expect(exactlyLast.speed).toBe(30);
    expect(exactlyLast.late).toBe(false);
    const after = pointAt(point, T0 + 2 * HOUR + 60);
    expect(after.speed).toBe(30);
    expect(after.gust).toBe(44);
    expect(after.late).toBe(true);
    expect(pointAt(point, T0 + 50 * HOUR).late).toBe(true);
  });

  it('counts hours from the point\'s own first hour, which is not a whole UTC hour everywhere', () => {
    // India and Nepal run 30 and 45 minutes off: Open-Meteo starts their hours on the local hour
    const offset = makePoint([{ speed: 10, dir: 0 }, { speed: 20, dir: 0 }], { t0: T0 + 1800 });
    expect(pointAt(offset, T0 + 1800).speed).toBe(10);
    expect(pointAt(offset, T0 + HOUR).speed).toBeCloseTo(15, 9);
    expect(pointAt(offset, T0 + 1800 + HOUR).speed).toBe(20);
  });

  it('survives a moment that is not a number', () => {
    expect(pointAt(point, NaN).speed).toBe(10);
  });

  it('shows a missing temperature as missing, not as zero, and lets the felt one fall back on it', () => {
    const noTemp = makePoint([{ speed: 10, dir: 0, temp: null, feels: null }]);
    expect(Number.isNaN(pointAt(noTemp, T0).temp)).toBe(true);
    expect(Number.isNaN(pointAt(noTemp, T0).feels)).toBe(true);
    const noFeels = makePoint([{ speed: 10, dir: 0, temp: 21, feels: null }]);
    expect(pointAt(noFeels, T0).feels).toBe(21);
  });
});

describe('blendAt', () => {
  // four points of the finest lattice around central Lisbon: 38.625..38.75 north, -9.25..-9.125 east
  const SW = nodeKey(0, 309, -74);
  const SE = nodeKey(0, 309, -73);
  const NW = nodeKey(0, 310, -74);
  const NE = nodeKey(0, 310, -73);

  const value = (speed, dir, extra = {}) => {
    const rad = (dir * Math.PI) / 180;
    return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad), speed, gust: speed + 5, rain: 0, rainChance: 0, temp: 18, feels: 17, late: false, fetchedAt: 1000, ...extra };
  };
  const reader = (values) => (key) => values.get(key) ?? null;
  const corners = (sw, se, nw, ne) => new Map([[SW, sw], [SE, se], [NW, nw], [NE, ne]]);

  it('is the point itself on a lattice point', () => {
    const values = corners(value(10, 0), value(20, 90), value(30, 180), value(40, 270));
    const at = blendAt(38.625, -9.25, [0], reader(values));
    expect(at.speed).toBeCloseTo(10, 9);
    expectDirection(at.from, 0);
    expect(at.gust).toBeCloseTo(15, 9);
    expect(at.level).toBe(0);
  });

  it('is the average halfway between two points', () => {
    const values = corners(value(10, 0), value(20, 0), value(30, 0), value(40, 0));
    expect(blendAt(38.625, -9.1875, [0], reader(values)).speed).toBeCloseTo(15, 9);
    expect(blendAt(38.6875, -9.25, [0], reader(values)).speed).toBeCloseTo(20, 9);
  });

  it('weighs the four points by how close each is', () => {
    const values = corners(value(10, 0), value(20, 0), value(30, 0), value(40, 0));
    // a quarter of the way east and three quarters of the way north
    const at = blendAt(38.625 + 0.75 * 0.125, -9.25 + 0.25 * 0.125, [0], reader(values));
    const expected = 10 * 0.75 * 0.25 + 20 * 0.25 * 0.25 + 30 * 0.75 * 0.75 + 40 * 0.25 * 0.75;
    expect(at.speed).toBeCloseTo(expected, 9);
    expect(at.gust).toBeCloseTo(expected + 5, 9);
  });

  it('blends directions as vectors: 350 and 10 give north, not south', () => {
    const values = corners(value(20, 350), value(20, 10), value(20, 350), value(20, 10));
    const at = blendAt(38.7, -9.1875, [0], reader(values));
    expectDirection(at.from, 0);
    expect(at.speed).toBeCloseTo(20, 9);
  });

  it('keeps a realistic speed between two opposing winds', () => {
    // west column blows from the north, east column from the south-south-east
    const values = corners(value(20, 0), value(20, 170), value(20, 0), value(20, 170));
    const at = blendAt(38.7, -9.1875, [0], reader(values));
    expect(at.speed).toBeCloseTo(20, 9);
    expect(Math.hypot(at.u, at.v)).toBeCloseTo(20, 9);
  });

  it('has no direction to give where the vectors cancel out exactly', () => {
    const values = corners(value(20, 0), value(20, 180), value(20, 0), value(20, 180));
    const at = blendAt(38.7, -9.1875, [0], reader(values));
    expect(at.u).toBe(0);
    expect(at.v).toBe(0);
    expect(at.speed).toBeCloseTo(20, 9);
  });

  it('guesses nothing when one of the four points is missing', () => {
    const values = corners(value(10, 0), value(20, 0), value(30, 0), value(40, 0));
    values.delete(NE);
    expect(blendAt(38.7, -9.2, [0], reader(values))).toBeNull();
    expect(blendAt(38.7, -9.2, [], reader(values))).toBeNull();
  });

  it('falls back on a coarser level only when the finer one is incomplete', () => {
    // The same spot is inside the level 1 cell 38.5..38.75 north, -9.25..-9 east. Its north-west corner
    // is the north-west corner of the fine cell too: one point, whichever level reads it.
    expect(nodeKey(1, 155, -37)).toBe(NW);
    const values = corners(value(10, 0), value(10, 0), value(10, 0), value(10, 0));
    for (const [row, col] of [[154, -37], [154, -36], [155, -36]]) values.set(nodeKey(1, row, col), value(50, 0));

    const fine = blendAt(38.7, -9.2, [0, 1], reader(values));
    expect(fine.speed).toBeCloseTo(10, 9);
    expect(fine.level).toBe(0);

    values.delete(SW);
    const coarse = blendAt(38.7, -9.2, [0, 1], reader(values));
    expect(coarse.level).toBe(1);
    // a fifth of the way east and four fifths of the way north in the coarse cell: mostly the shared corner
    expect(coarse.speed).toBeCloseTo(50 * 0.16 + 50 * 0.04 + 10 * 0.64 + 50 * 0.16, 9);
    // and not at all when only the finest level may be used
    expect(blendAt(38.7, -9.2, [0], reader(values))).toBeNull();
  });

  it('is late as soon as one of the four points is, and as old as the oldest of them', () => {
    const values = corners(value(10, 0, { fetchedAt: 5000 }), value(10, 0, { fetchedAt: 3000 }), value(10, 0, { fetchedAt: 9000 }), value(10, 0, { late: true, fetchedAt: 4000 }));
    const at = blendAt(38.7, -9.2, [0], reader(values));
    expect(at.late).toBe(true);
    expect(at.fetchedAt).toBe(3000);
    values.set(NE, value(10, 0));
    expect(blendAt(38.7, -9.2, [0], reader(values)).late).toBe(false);
  });

  it('blends the rain and its chance like the speed', () => {
    const values = corners(value(10, 0, { rain: 2, rainChance: 80 }), value(10, 0), value(10, 0), value(10, 0));
    // on the wet point, halfway to a dry one, and in the middle of the four
    expect(blendAt(38.625, -9.25, [0], reader(values)).rain).toBeCloseTo(2, 9);
    expect(blendAt(38.625, -9.1875, [0], reader(values)).rain).toBeCloseTo(1, 9);
    const middle = blendAt(38.6875, -9.1875, [0], reader(values));
    expect(middle.rain).toBeCloseTo(0.5, 9);
    expect(middle.rainChance).toBeCloseTo(20, 9);
  });

  it('does not make up the rain when one of the four points does not have it', () => {
    const values = corners(value(10, 0, { rain: 2, rainChance: 80 }), value(10, 0, { rain: NaN, rainChance: NaN }), value(10, 0), value(10, 0));
    const at = blendAt(38.7, -9.2, [0], reader(values));
    expect(Number.isNaN(at.rain)).toBe(true);
    expect(Number.isNaN(at.rainChance)).toBe(true);
    expect(at.speed).toBeCloseTo(10, 9);
  });

  it('carries a missing temperature through as missing', () => {
    const values = corners(value(10, 0), value(10, 0, { temp: NaN, feels: NaN }), value(10, 0), value(10, 0));
    const at = blendAt(38.7, -9.2, [0], reader(values));
    expect(Number.isNaN(at.temp)).toBe(true);
    expect(at.speed).toBeCloseTo(10, 9);
  });

  it('reads across the date line', () => {
    // 179.875 east and 180 (the same meridian as -180) are neighbours
    const values = new Map([
      [nodeKey(0, 80, 1439), value(10, 0)],
      [nodeKey(0, 80, -1440), value(30, 0)],
      [nodeKey(0, 81, 1439), value(10, 0)],
      [nodeKey(0, 81, -1440), value(30, 0)],
    ]);
    expect(blendAt(10.05, 179.9375, [0], reader(values)).speed).toBeCloseTo(20, 9);
    // the map reports the same place as 179.9375 - 360 on a repeated copy of the world
    expect(blendAt(10.05, 179.9375 - 360, [0], reader(values)).speed).toBeCloseTo(20, 9);
  });
});

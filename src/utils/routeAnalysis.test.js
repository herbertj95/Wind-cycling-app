import { describe, it, expect } from 'vitest';
import { analyseRoute, bandScale, bestDepartures, routeTurn, scanDepartures, windCost, windPeaks, RIDE_SPEEDS } from './routeAnalysis';
import { nodeKey } from './lattice';
import { pointAt, blendAt } from './windField';
import { angleDiff, windComponents } from './wind';

// Convention under test: a wind direction is where the wind comes FROM (0 = north, 90 = east), speeds in km/h.

const T0 = 1790985600; // 2026-10-03 00:00 UTC in unix seconds
const HOUR = 3600;
const KM_PER_DEGREE = 111.19492664455873; // 6371 km * pi / 180

// The forecast these tests load: a 6 x 6 block of the finest lattice over greater Lisbon, 0.125° apart,
// from 38.375 to 39 north and from -9.5 to -8.875 east. Beyond it there is no forecast.
const GRID = { south: 38.375, west: -9.5, step: 0.125, rows: 6, cols: 6 };
const GRID_POINTS = [];
for (let r = 0; r < GRID.rows; r++) {
  for (let c = 0; c < GRID.cols; c++) {
    GRID_POINTS.push({ lat: GRID.south + r * GRID.step, lng: GRID.west + c * GRID.step });
  }
}

/**
 * Synthetic forecast. `at(k, h, point)` describes grid point k (row-major, south to north) at hour h and
 * returns { speed, dir, gust?, temp?, feels?, rain?, rainChance? }. Hours are dry unless they say otherwise;
 * `rain: undefined` makes a forecast that knows nothing about rain.
 * The result is what analyseRoute reads from: sample(lat, lng, hour), with hours counted from the first
 * forecast hour, as the start hours in the tests below are.
 */
function makeForecast(hourCount, at) {
  const points = new Map();
  GRID_POINTS.forEach((point, k) => {
    const p = { t0: T0, n: hourCount, speed: [], dir: [], gust: [], temp: [], feels: [], rain: [], rainChance: [], zone: 'Europe/Lisbon', fetchedAt: T0 * 1000 };
    for (let h = 0; h < hourCount; h++) {
      const w = at(k, h, point);
      p.speed.push(w.speed);
      p.dir.push(w.dir);
      p.gust.push('gust' in w ? w.gust : w.speed);
      p.temp.push('temp' in w ? w.temp : 18);
      p.feels.push('feels' in w ? w.feels : 17);
      p.rain.push('rain' in w ? w.rain ?? null : 0);
      p.rainChance.push('rainChance' in w ? w.rainChance ?? null : 0);
    }
    points.set(nodeKey(0, Math.round(point.lat / GRID.step), Math.round(point.lng / GRID.step)), p);
  });
  return {
    sample: (lat, lng, hour) => blendAt(lat, lng, [0], (key) => pointAt(points.get(key), T0 + hour * HOUR)),
  };
}

/** The same wind everywhere; `hourly` lists it hour by hour as { speed, dir, gust }. */
const everywhere = (hourly) => makeForecast(hourly.length, (k, h) => hourly[h]);

/** The same wind everywhere and at every hour. */
const steady = (speed, dir, gust, hours = 4) => everywhere(Array.from({ length: hours }, () => ({ speed, dir, gust })));

// The wind most tests use: 20 km/h from the north, gusting 30, for four hours
const northerly = () => steady(20, 0, 30);

/**
 * Builds a route the way the GPX parser hands it over: points with lat, lng, ele, cumulative
 * distance in km and the bearing ridden at that point. Each leg is { bearing, km, steps }.
 */
function makeRoute(start, legs) {
  let { lat, lng } = start;
  let legStart = 0;
  const points = [{ lat, lng, ele: 0, distance: 0, bearing: legs[0].bearing }];
  for (const leg of legs) {
    const stepKm = leg.km / leg.steps;
    const rad = (leg.bearing * Math.PI) / 180;
    for (let s = 1; s <= leg.steps; s++) {
      lat += (stepKm * Math.cos(rad)) / KM_PER_DEGREE;
      lng += (stepKm * Math.sin(rad)) / (KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
      points.push({ lat, lng, ele: 0, distance: legStart + (leg.km * s) / leg.steps, bearing: leg.bearing });
    }
    legStart += leg.km;
  }
  return { name: 'Test route', points, totalDistance: legStart, totalElevationGain: 0 };
}

// 50 km routes with a point every kilometre, all well inside the forecast grid
const northbound = () => makeRoute({ lat: 38.45, lng: -9.2 }, [{ bearing: 0, km: 50, steps: 50 }]);
const southbound = () => makeRoute({ lat: 38.9, lng: -9.2 }, [{ bearing: 180, km: 50, steps: 50 }]);
// 40 km along the 38.7 parallel
const eastbound = () => makeRoute({ lat: 38.7, lng: -9.45 }, [{ bearing: 90, km: 40, steps: 40 }]);
const westbound = () => makeRoute({ lat: 38.7, lng: -9.0 }, [{ bearing: 270, km: 40, steps: 40 }]);

const sameDirection = (a, b) => Math.abs(angleDiff(a, b)) < 0.01;

describe('RIDE_SPEEDS', () => {
  it('offers ascending, positive riding speeds that include the default 25 km/h', () => {
    expect(RIDE_SPEEDS.length).toBeGreaterThan(0);
    expect(RIDE_SPEEDS).toContain(25);
    RIDE_SPEEDS.forEach((kmh, i) => {
      expect(kmh).toBeGreaterThan(0);
      if (i > 0) expect(kmh).toBeGreaterThan(RIDE_SPEEDS[i - 1]);
    });
  });
});

describe('windPeaks', () => {
  const heads = (...values) => values.map((head) => ({ head }));

  it('gives the strongest headwind and the strongest tailwind, both as positive km/h', () => {
    expect(windPeaks(heads(3, 12.4, -8, 5, -2))).toEqual({ head: 12.4, tail: 8 });
    expect(windPeaks(heads(-31, 6))).toEqual({ head: 6, tail: 31 });
  });

  it('is zero for the way the wind never blows', () => {
    expect(windPeaks(heads(4, 9, 0.5))).toEqual({ head: 9, tail: 0 });
    expect(windPeaks(heads(-4, -9))).toEqual({ head: 0, tail: 9 });
    expect(windPeaks(heads(0, 0))).toEqual({ head: 0, tail: 0 });
    expect(windPeaks([])).toEqual({ head: 0, tail: 0 });
  });

  it('skips points without a reading', () => {
    expect(windPeaks(heads(12, NaN, undefined, -18))).toEqual({ head: 12, tail: 18 });
  });

  it('matches an analysed route: against the wind one way, with it on the way back', () => {
    const out = windPeaks(analyseRoute(northbound(), steady(20, 0, 30), 0, 25).wind);
    expect(out.head).toBeCloseTo(20, 5);
    expect(out.tail).toBe(0);
    const back = windPeaks(analyseRoute(northbound(), steady(20, 180, 30), 0, 25).wind);
    expect(back.head).toBe(0);
    expect(back.tail).toBeCloseTo(20, 5);
  });
});

describe('bandScale', () => {
  const heads = (...values) => values.map((head) => ({ head }));

  it('is 15 km/h for a calm route, so a breeze does not fill the chart', () => {
    expect(bandScale(heads(0, 0, 0))).toBe(15);
    expect(bandScale(heads(3, -6, 7.2))).toBe(15);
    expect(bandScale([])).toBe(15);
  });

  it('grows in steps of 5 km/h to hold the strongest wind along the road', () => {
    expect(bandScale(heads(4, 15))).toBe(15);
    expect(bandScale(heads(4, 15.2))).toBe(20);
    expect(bandScale(heads(19.9, -3))).toBe(20);
    expect(bandScale(heads(23, 10))).toBe(25);
    expect(bandScale(heads(41, 2))).toBe(45);
  });

  it('counts a tailwind like a headwind: the scale is the same up and down', () => {
    expect(bandScale(heads(5, -23))).toBe(25);
    expect(bandScale(heads(-31))).toBe(35);
  });

  it('is not pushed a step up by rounding noise on a round value', () => {
    expect(bandScale(heads(15.0000000001))).toBe(15);
    expect(bandScale(heads(-20.0000000001))).toBe(20);
  });

  it('skips points without a reading', () => {
    expect(bandScale(heads(12, NaN, undefined, 18))).toBe(20);
  });

  it('holds every point of an analysed route', () => {
    const result = analyseRoute(northbound(), steady(27, 0, 40), 0, 25);
    const scale = bandScale(result.wind);
    expect(scale).toBe(30);
    for (const w of result.wind) expect(Math.abs(w.head)).toBeLessThanOrEqual(scale);
  });
});

describe('analyseRoute in a steady 20 km/h northerly gusting 30', () => {
  describe('riding north', () => {
    const route = northbound();
    const result = analyseRoute(route, northerly(), 0, 25);

    it('reports the wind at every route point', () => {
      expect(result.wind).toHaveLength(route.points.length);
      for (const w of result.wind) {
        expect(w.speed).toBeCloseTo(20, 6);
        expect(w.gust).toBeCloseTo(30, 6);
        expect(sameDirection(w.from, 0)).toBe(true);
        expect(w.temp).toBeCloseTo(18, 6);
        expect(w.feels).toBeCloseTo(17, 6);
        expect(w.outside).toBe(false);
      }
    });

    it('is a pure 20 km/h headwind at every point', () => {
      for (const w of result.wind) {
        expect(w.effect).toBe('headwind');
        expect(w.head).toBeCloseTo(20, 6);
        expect(w.cross).toBeCloseTo(0, 6);
      }
    });

    it('is 100% headwind', () => {
      expect(result.share.head).toBeCloseTo(50, 9);
      expect(result.share.tail).toBe(0);
      expect(result.share.cross).toBe(0);
    });

    it('nets +20 km/h against the rider', () => {
      expect(result.net).toBeCloseTo(20, 6);
      expect(result.avgSpeed).toBeCloseTo(20, 6);
    });

    it('reports the gusts, with nothing across the road', () => {
      expect(result.maxGust).toBeCloseTo(30, 6);
      expect(result.maxCrossGust).toBeCloseTo(0, 6);
    });

    it('counts all 50 km as strong headwind and none as outside the forecast area', () => {
      expect(result.strongHeadKm).toBeCloseTo(50, 9);
      expect(result.outsideKm).toBe(0);
    });

    it('takes 2 hours at 25 km/h and stays inside the forecast', () => {
      expect(result.durationHours).toBeCloseTo(2, 12);
      expect(result.beyondForecast).toBe(false);
    });
  });

  describe('riding south', () => {
    const result = analyseRoute(southbound(), northerly(), 0, 25);

    it('is 100% tailwind', () => {
      expect(result.share.tail).toBeCloseTo(50, 9);
      expect(result.share.head).toBe(0);
      expect(result.share.cross).toBe(0);
      for (const w of result.wind) {
        expect(w.effect).toBe('tailwind');
        expect(w.head).toBeCloseTo(-20, 6);
        expect(w.cross).toBeCloseTo(0, 6);
      }
    });

    it('nets -20 km/h: the wind pushes', () => {
      expect(result.net).toBeCloseTo(-20, 6);
      expect(result.avgSpeed).toBeCloseTo(20, 6);
      expect(result.strongHeadKm).toBe(0);
    });
  });

  describe('riding east', () => {
    const result = analyseRoute(eastbound(), northerly(), 0, 25);

    it('is 100% crosswind', () => {
      expect(result.share.cross).toBeCloseTo(40, 9);
      expect(result.share.head).toBe(0);
      expect(result.share.tail).toBe(0);
      for (const w of result.wind) {
        expect(w.effect).toBe('crosswind');
      }
    });

    it('nets ~0: a pure crosswind neither helps nor slows', () => {
      expect(result.net).toBeCloseTo(0, 6);
      expect(result.avgSpeed).toBeCloseTo(20, 6);
      expect(result.strongHeadKm).toBe(0);
    });

    it('comes from the left (north is on the left hand when facing east), like windComponents says', () => {
      const expected = windComponents(90, 0, 20);
      expect(expected.cross).toBeCloseTo(-20, 6);
      for (const w of result.wind) {
        expect(Math.sign(w.cross)).toBe(Math.sign(expected.cross));
        expect(w.cross).toBeCloseTo(-20, 6);
        expect(w.head).toBeCloseTo(0, 6);
      }
    });

    it('puts the whole 30 km/h gust across the road', () => {
      expect(result.maxGust).toBeCloseTo(30, 6);
      expect(result.maxCrossGust).toBeCloseTo(30, 6);
    });
  });

  describe('riding west', () => {
    const result = analyseRoute(westbound(), northerly(), 0, 25);

    it('is 100% crosswind from the right', () => {
      expect(result.share.cross).toBeCloseTo(40, 9);
      expect(result.net).toBeCloseTo(0, 6);
      for (const w of result.wind) {
        expect(w.effect).toBe('crosswind');
        expect(w.cross).toBeCloseTo(20, 6);
      }
    });
  });

  describe('out and back', () => {
    // 15 km north, then the same 15 km back south
    const route = makeRoute({ lat: 38.6, lng: -9.2 }, [
      { bearing: 0, km: 15, steps: 15 },
      { bearing: 180, km: 15, steps: 15 },
    ]);
    const result = analyseRoute(route, northerly(), 0, 25);

    it('is half headwind and half tailwind', () => {
      expect(result.share.head).toBeCloseTo(15, 9);
      expect(result.share.tail).toBeCloseTo(15, 9);
      expect(result.share.cross).toBe(0);
    });

    it('nets ~0 although the wind blows 20 km/h all the way', () => {
      // (+20 * 15 km - 20 * 15 km) / 30 km = 0
      expect(result.net).toBeCloseTo(0, 6);
      expect(result.avgSpeed).toBeCloseTo(20, 6);
      expect(result.strongHeadKm).toBeCloseTo(15, 9);
    });
  });

  describe('a mostly northbound route with a short leg east', () => {
    // 30 km north then 10 km east: head +20 on 30 km, 0 on 10 km -> net = 20 * 30 / 40 = 15
    const route = makeRoute({ lat: 38.5, lng: -9.3 }, [
      { bearing: 0, km: 30, steps: 30 },
      { bearing: 90, km: 10, steps: 10 },
    ]);
    const result = analyseRoute(route, northerly(), 0, 25);

    it('weights the net wind by distance', () => {
      expect(result.net).toBeCloseTo(15, 6);
      expect(result.share.head).toBeCloseTo(30, 9);
      expect(result.share.cross).toBeCloseTo(10, 9);
      expect(result.strongHeadKm).toBeCloseTo(30, 9);
    });
  });

  describe('the same route with only a few points on the long leg', () => {
    // 30 km north drawn with 3 points, then 10 km east drawn with 10: still 30 of the 40 km into the wind
    const route = makeRoute({ lat: 38.5, lng: -9.3 }, [
      { bearing: 0, km: 30, steps: 3 },
      { bearing: 90, km: 10, steps: 10 },
    ]);
    const result = analyseRoute(route, northerly(), 0, 25);

    it('weights by kilometres, not by the number of points', () => {
      // by distance: 20 * 30 / 40 = 15. Counting points would give 20 * 4 / 14 = 5.7 (4 of the 14 points head north)
      expect(route.points).toHaveLength(14);
      expect(result.net).toBeCloseTo(15, 6);
      expect(result.avgSpeed).toBeCloseTo(20, 6);
      expect(result.share.head).toBeCloseTo(30, 9);
      expect(result.share.cross).toBeCloseTo(10, 9);
      expect(result.strongHeadKm).toBeCloseTo(30, 9);
    });
  });
});

describe('analyseRoute strong headwind', () => {
  it('counts a headwind as strong from 15 km/h up', () => {
    // 14 km/h on the nose all the way is never strong, 16 km/h is strong for the whole 50 km
    expect(analyseRoute(northbound(), steady(14, 0, 20), 0, 25).strongHeadKm).toBe(0);
    expect(analyseRoute(northbound(), steady(16, 0, 20), 0, 25).strongHeadKm).toBeCloseTo(50, 9);
  });

  it('goes by the part of the wind that is against the rider, not by the wind speed', () => {
    // 45 degrees off the nose: 20 km/h is 20 * cos(45) = 14.1 against, 22 km/h is 15.6 against
    expect(analyseRoute(northbound(), steady(20, 45, 25), 0, 25).strongHeadKm).toBe(0);
    expect(analyseRoute(northbound(), steady(22, 45, 27), 0, 25).strongHeadKm).toBeCloseTo(50, 9);
  });
});

describe('analyseRoute shares', () => {
  // a square: 10 km north, east, south and west
  const square = () => makeRoute({ lat: 38.6, lng: -9.3 }, [
    { bearing: 0, km: 10, steps: 10 },
    { bearing: 90, km: 10, steps: 10 },
    { bearing: 180, km: 10, steps: 10 },
    { bearing: 270, km: 10, steps: 10 },
  ]);

  it('splits a square loop in a northerly into one side against, one side with, two sides across', () => {
    const route = square();
    const result = analyseRoute(route, northerly(), 0, 25);
    expect(result.share.head).toBeCloseTo(10, 9);
    expect(result.share.tail).toBeCloseTo(10, 9);
    expect(result.share.cross).toBeCloseTo(20, 9);
    expect(result.share.head + result.share.tail + result.share.cross).toBeCloseTo(route.totalDistance, 9);
    expect(result.net).toBeCloseTo(0, 6);
  });

  it('splits the square by the wind along each side for an 18 km/h wind from 60 degrees', () => {
    // north leg: 18 * cos 60 = 9 against -> head. east leg: 18 * cos 30 = 15.6 against -> head.
    // south leg: 18 * cos 120 = -9 -> tail. west leg: 18 * cos 150 = -15.6 -> tail.
    const result = analyseRoute(square(), steady(18, 60, 25), 0, 25);
    expect(result.share.head).toBeCloseTo(20, 9);
    expect(result.share.tail).toBeCloseTo(20, 9);
    expect(result.share.cross).toBeCloseTo(0, 9);
    // net = 18 * (cos 60 + cos 30 + cos 120 + cos 150) * 10 km / 40 km = 0
    expect(result.net).toBeCloseTo(0, 6);
  });

  it('always adds up to the route distance, whatever the wind direction', () => {
    const route = square();
    for (const dir of [0, 33, 60, 135, 200, 271, 310]) {
      const { share } = analyseRoute(route, steady(18, dir, 25), 0, 25);
      expect(share.head + share.tail + share.cross).toBeCloseTo(route.totalDistance, 9);
      expect(share.head).toBeGreaterThanOrEqual(0);
      expect(share.tail).toBeGreaterThanOrEqual(0);
      expect(share.cross).toBeGreaterThanOrEqual(0);
    }
  });

  it('adds up to the route distance when the wind changes during the ride', () => {
    const route = northbound();
    const turning = everywhere([
      { speed: 10, dir: 0, gust: 15 },
      { speed: 25, dir: 100, gust: 30 },
      { speed: 15, dir: 190, gust: 20 },
      { speed: 5, dir: 300, gust: 8 },
    ]);
    const { share } = analyseRoute(route, turning, 0, 25);
    expect(share.head + share.tail + share.cross).toBeCloseTo(route.totalDistance, 9);
    expect(share.head).toBeGreaterThan(0);
    expect(share.cross).toBeGreaterThan(0);
    expect(share.tail).toBeGreaterThan(0);
  });
});

describe('analyseRoute samples the wind when the rider gets there', () => {
  // calm at hour 0, then 20 km/h from the north from hour 1 on
  const building = () => everywhere([
    { speed: 0, dir: 0, gust: 0 },
    { speed: 20, dir: 0, gust: 30 },
    { speed: 20, dir: 0, gust: 30 },
    { speed: 20, dir: 0, gust: 30 },
  ]);

  it('sees the later wind at points reached later', () => {
    // at 25 km/h the rider reaches km d at hour d / 25
    const result = analyseRoute(northbound(), building(), 0, 25);
    expect(result.wind[0].speed).toBeCloseTo(0, 6); // start, hour 0: calm
    expect(result.wind[5].speed).toBeCloseTo(4, 5); // km 5, hour 0.2: 0.2 * 20
    expect(result.wind[12].speed).toBeCloseTo(9.6, 5); // km 12, hour 0.48: 0.48 * 20
    expect(result.wind[25].speed).toBeCloseTo(20, 5); // km 25, hour 1
    expect(result.wind[40].speed).toBeCloseTo(20, 5); // km 40, hour 1.6
    expect(result.wind[50].speed).toBeCloseTo(20, 5); // km 50, hour 2
    // the growing wind is a headwind for a northbound rider
    expect(result.wind[12].head).toBeCloseTo(9.6, 5);
    expect(result.wind[12].effect).toBe('headwind');
    // gusts are those of the hour in progress (hour 0 to 1), which Open-Meteo stores under hour 1
    expect(result.wind[12].gust).toBeCloseTo(30, 5);
  });

  it('averages the wind actually met, not the wind at the start', () => {
    // km 1..25 meet 0.8, 1.6 .. 20 km/h (sum 0.8 * 325 = 260), km 26..50 meet 20 (sum 500): 760 / 50 = 15.2
    const result = analyseRoute(northbound(), building(), 0, 25);
    expect(result.avgSpeed).toBeCloseTo(15.2, 4);
    expect(result.net).toBeCloseTo(15.2, 4);
    expect(result.maxGust).toBeCloseTo(30, 5);
  });

  it('sees the full wind from the first metre when starting an hour later', () => {
    const result = analyseRoute(northbound(), building(), 1, 25);
    for (const w of result.wind) {
      expect(w.speed).toBeCloseTo(20, 5);
    }
    expect(result.net).toBeCloseTo(20, 5);
  });

  it('gets further before the wind arrives when riding faster', () => {
    // at 50 km/h, km 25 is reached at hour 0.5 and km 50 at hour 1
    const result = analyseRoute(northbound(), building(), 0, 50);
    expect(result.wind[25].speed).toBeCloseTo(10, 5);
    expect(result.wind[50].speed).toBeCloseTo(20, 5);
    expect(result.durationHours).toBeCloseTo(1, 12);
  });

  it('defaults to 25 km/h', () => {
    const result = analyseRoute(northbound(), building(), 0);
    expect(result.durationHours).toBeCloseTo(2, 12);
    expect(result.wind[25].speed).toBeCloseTo(20, 5);
  });

  it('turns a headwind into a tailwind when the wind swings round mid-ride', () => {
    // northerly for hours 0 and 1, southerly from hour 2. Riding north at 25 km/h:
    // km 0..25 (hours 0..1) headwind. Between hour 1 and 2 the vector goes from 20 south-moving to
    // 20 north-moving, so it flips halfway, at km 37.5: km 26..37 still headwind, km 38..50 tailwind.
    const swinging = everywhere([
      { speed: 20, dir: 0, gust: 30 },
      { speed: 20, dir: 0, gust: 30 },
      { speed: 20, dir: 180, gust: 30 },
      { speed: 20, dir: 180, gust: 30 },
    ]);
    const result = analyseRoute(northbound(), swinging, 0, 25);
    expect(result.wind[20].effect).toBe('headwind');
    expect(result.wind[37].effect).toBe('headwind');
    expect(result.wind[38].effect).toBe('tailwind');
    expect(result.wind[50].effect).toBe('tailwind');
    expect(result.share.head).toBeCloseTo(37, 9);
    expect(result.share.tail).toBeCloseTo(13, 9);
    // net = (20 * 37 - 20 * 13) / 50 = 9.6, where sampling everything at the start would say 20
    expect(result.net).toBeCloseTo(9.6, 4);
  });

  // A dead calm has no direction (a zero wind vector reports `from: 180`). With nothing blowing along the
  // road it is neither head nor tailwind, whichever way the rider is heading.
  it('does not depend on the riding direction when there is no wind at all', () => {
    const calm = steady(0, 0, 0);
    const north = analyseRoute(northbound(), calm, 0, 25);
    const south = analyseRoute(southbound(), calm, 0, 25);
    expect(north.net).toBeCloseTo(0, 9);
    expect(south.net).toBeCloseTo(0, 9);
    // nothing is blowing, so both rides must be described the same way
    expect(north.wind[10].effect).toBe('crosswind');
    expect(south.wind[10].effect).toBe('crosswind');
    expect(north.share).toEqual(south.share);
    expect(north.share.head).toBe(0);
    expect(north.share.tail).toBe(0);
  });

  it('needs a noticeable wind along the road before it calls it head or tailwind', () => {
    // 4 km/h from the north is under the 5 km/h a rider notices: neither rider gets a head or tailwind
    const light = steady(4, 0, 5);
    expect(analyseRoute(northbound(), light, 0, 25).wind[10].effect).toBe('crosswind');
    expect(analyseRoute(southbound(), light, 0, 25).wind[10].effect).toBe('crosswind');
    expect(analyseRoute(northbound(), light, 0, 25).share.cross).toBeCloseTo(50, 9);
    // 6 km/h is against the northbound rider and behind the southbound one
    const fresh = steady(6, 0, 8);
    const north = analyseRoute(northbound(), fresh, 0, 25);
    const south = analyseRoute(southbound(), fresh, 0, 25);
    expect(north.wind[10].effect).toBe('headwind');
    expect(north.share.head).toBeCloseTo(50, 9);
    expect(south.wind[10].effect).toBe('tailwind');
    expect(south.share.tail).toBeCloseTo(50, 9);
  });

  it('samples the wind where the rider is, not only when', () => {
    // calm over the three western grid columns, 20 km/h northerly over the three eastern ones
    const split = makeForecast(4, (k) => (k % GRID.cols <= 2 ? { speed: 0, dir: 0 } : { speed: 20, dir: 0 }));
    const route = eastbound(); // from -9.45 to about -8.99 along 38.7 north
    const result = analyseRoute(route, split, 0, 25);
    const last = result.wind.length - 1;
    expect(route.points[0].lng).toBeLessThan(-9.25); // west of column 2
    expect(route.points[last].lng).toBeGreaterThan(-9.125); // east of column 3
    expect(result.wind[0].speed).toBeCloseTo(0, 6);
    expect(result.wind[last].speed).toBeCloseTo(20, 5);
    expect(result.wind[last].effect).toBe('crosswind');
  });
});

describe('analyseRoute advisory', () => {
  const toneOf = (route, forecast, startHour = 0, rideKmh = 25) => analyseRoute(route, forecast, startHour, rideKmh).advisory.tone;

  it('always comes with a title and a sentence', () => {
    for (const forecast of [northerly(), steady(5, 0, 8), steady(20, 0, 60), steady(20, 90, 30)]) {
      const { advisory } = analyseRoute(northbound(), forecast, 0, 25);
      expect(typeof advisory.title).toBe('string');
      expect(advisory.title.length).toBeGreaterThan(0);
      expect(typeof advisory.text).toBe('string');
      expect(advisory.text.length).toBeGreaterThan(0);
      expect(advisory.text).not.toMatch(/NaN|undefined|Infinity/);
    }
  });

  it("is 'calm' when the wind averages under 8 km/h, from any side", () => {
    expect(toneOf(northbound(), steady(5, 0, 8))).toBe('calm');
    expect(toneOf(southbound(), steady(5, 0, 8))).toBe('calm');
    expect(toneOf(eastbound(), steady(7.5, 0, 10))).toBe('calm');
    expect(toneOf(northbound(), steady(0, 0, 0))).toBe('calm');
  });

  it("is no longer 'calm' from 8 km/h up", () => {
    expect(toneOf(northbound(), steady(9, 0, 12))).not.toBe('calm');
    expect(toneOf(southbound(), steady(9, 0, 12))).not.toBe('calm');
  });

  it("does not call a light wind 'calm' when it comes with gusts of 30 km/h or more", () => {
    // 5 km/h on average but gusting 35, head-on for a northbound rider: too little for 'gusty', too much for 'calm'
    expect(toneOf(northbound(), steady(5, 0, 35))).not.toBe('calm');
    expect(toneOf(northbound(), steady(5, 0, 35))).not.toBe('gusty');
    // gusts of 25 km/h belong to an ordinary light breeze
    expect(toneOf(northbound(), steady(5, 0, 25))).toBe('calm');
  });

  it("is 'gusty' when gusts reach 50 km/h", () => {
    // the route starts exactly on the grid node 38.5, -9.25, so the 50 is read without interpolation
    const fromNode = makeRoute({ lat: 38.5, lng: -9.25 }, [{ bearing: 0, km: 20, steps: 20 }]);
    expect(toneOf(fromNode, steady(20, 0, 50))).toBe('gusty');
    expect(toneOf(northbound(), steady(20, 0, 55))).toBe('gusty');
    expect(toneOf(southbound(), steady(20, 0, 70))).toBe('gusty');
  });

  it("is not 'gusty' just below 50 km/h when the gusts come from ahead", () => {
    expect(toneOf(northbound(), steady(20, 0, 49))).not.toBe('gusty');
  });

  it("is 'gusty' when 35 km/h or more of a gust hits from the side", () => {
    // riding east in a northerly the whole gust is sideways
    expect(toneOf(eastbound(), steady(20, 0, 36))).toBe('gusty');
    expect(toneOf(eastbound(), steady(20, 0, 34))).not.toBe('gusty');
    // riding north the same 36 km/h gust is head-on and stays under the 50 km/h limit
    expect(toneOf(northbound(), steady(20, 0, 36))).not.toBe('gusty');
  });

  it("is not 'gusty' for one gusty kilometre: the gusts have to last for a real stretch of the road", () => {
    // gusts of 30 km/h, then 60 km/h in the hour that starts at hour 2 (Open-Meteo files those under hour 3)
    const lateGusts = everywhere([
      { speed: 20, dir: 0, gust: 30 },
      { speed: 20, dir: 0, gust: 30 },
      { speed: 20, dir: 0, gust: 30 },
      { speed: 20, dir: 0, gust: 60 },
    ]);
    // starting at hour 0.02 the rider passes hour 2 at km 49.5: only the last of the 50 km is gusty
    const brief = analyseRoute(northbound(), lateGusts, 0.02, 25);
    expect(brief.maxGust).toBeCloseTo(60, 5);
    expect(brief.gustyKm).toBeCloseTo(1, 6);
    expect(brief.advisory.tone).not.toBe('gusty');
    // starting at hour 0.5 the rider passes hour 2 at km 37.5: the last 13 km are gusty
    const lasting = analyseRoute(northbound(), lateGusts, 0.5, 25);
    expect(lasting.gustyKm).toBeCloseTo(13, 6);
    expect(lasting.advisory.tone).toBe('gusty');
  });

  it("puts 'gusty' before everything else, even a light or a helpful wind", () => {
    expect(toneOf(northbound(), steady(5, 0, 55))).toBe('gusty');
    expect(toneOf(southbound(), steady(20, 0, 55))).toBe('gusty');
  });

  it("is 'hard' for a long strong headwind", () => {
    expect(toneOf(northbound(), northerly())).toBe('hard');
  });

  it("is 'hard' when a quarter of the route is into a strong headwind, even if the way back evens it out", () => {
    // out and back: net 0, but 15 of 30 km are into 20 km/h
    const outAndBack = makeRoute({ lat: 38.6, lng: -9.2 }, [
      { bearing: 0, km: 15, steps: 15 },
      { bearing: 180, km: 15, steps: 15 },
    ]);
    const result = analyseRoute(outAndBack, northerly(), 0, 25);
    expect(result.net).toBeCloseTo(0, 6);
    expect(result.advisory.tone).toBe('hard');
  });

  it("is 'hard' for a moderate headwind all the way", () => {
    // 10 km/h on the nose: never a strong headwind (15+), but +10 on balance
    const result = analyseRoute(northbound(), steady(10, 0, 15), 0, 25);
    expect(result.strongHeadKm).toBe(0);
    expect(result.advisory.tone).toBe('hard');
  });

  it("is 'good' for a tailwind", () => {
    expect(toneOf(southbound(), northerly())).toBe('good');
    expect(toneOf(northbound(), steady(20, 180, 30))).toBe('good');
    expect(toneOf(southbound(), steady(10, 0, 15))).toBe('good');
  });

  it("is 'mixed' when the wind is across or evens out", () => {
    // pure crosswind, gusts 30 < 35 across the road
    expect(toneOf(eastbound(), northerly())).toBe('mixed');
    // 3 km north then 17 km east: only 15% into the wind, net = 20 * 3 / 20 = 3 km/h
    const mostlyAcross = makeRoute({ lat: 38.6, lng: -9.4 }, [
      { bearing: 0, km: 3, steps: 3 },
      { bearing: 90, km: 17, steps: 17 },
    ]);
    const result = analyseRoute(mostlyAcross, northerly(), 0, 25);
    expect(result.net).toBeCloseTo(3, 6);
    expect(result.advisory.tone).toBe('mixed');
  });

  it('only uses the documented tones', () => {
    const tones = new Set(['gusty', 'calm', 'hard', 'good', 'mixed']);
    for (const route of [northbound(), southbound(), eastbound(), westbound()]) {
      for (const forecast of [northerly(), steady(3, 40, 5), steady(30, 250, 65), steady(12, 135, 18)]) {
        expect(tones.has(toneOf(route, forecast))).toBe(true);
      }
    }
  });
});

describe('analyseRoute at the limits of the forecast', () => {
  // three forecast hours: the last one is hour 2
  const threeHours = () => steady(20, 0, 30, 3);

  it('is inside the forecast when the ride ends on or before the last hour', () => {
    // 50 km at 25 km/h = 2 h: start 0 -> ends at hour 2, exactly the last one
    expect(analyseRoute(northbound(), threeHours(), 0, 25).beyondForecast).toBe(false);
    // 50 km at 30 km/h = 1.67 h
    expect(analyseRoute(northbound(), threeHours(), 0, 30).beyondForecast).toBe(false);
  });

  it('is beyond the forecast when the ride ends after the last hour', () => {
    // start 1 -> ends at hour 3
    expect(analyseRoute(northbound(), threeHours(), 1, 25).beyondForecast).toBe(true);
    // 50 km at 20 km/h = 2.5 h: start 0 -> ends at hour 2.5
    expect(analyseRoute(northbound(), threeHours(), 0, 20).beyondForecast).toBe(true);
    expect(analyseRoute(northbound(), threeHours(), 2, 25).beyondForecast).toBe(true);
  });

  it('keeps using the last known hour past the end of the forecast', () => {
    const dropping = everywhere([
      { speed: 20, dir: 0, gust: 30 },
      { speed: 20, dir: 0, gust: 30 },
      { speed: 10, dir: 0, gust: 15 },
    ]);
    // start at hour 1: km 25 is hour 2 (10 km/h), km 50 would be hour 3 -> still the hour 2 values
    const result = analyseRoute(northbound(), dropping, 1, 25);
    expect(result.beyondForecast).toBe(true);
    expect(result.wind[0].speed).toBeCloseTo(20, 5);
    expect(result.wind[25].speed).toBeCloseTo(10, 5);
    expect(result.wind[50].speed).toBeCloseTo(10, 5);
    expect(result.wind[50].head).toBeCloseTo(10, 5);
  });

  it('counts the kilometres ridden where there is no forecast', () => {
    // 12 points 0.01 degrees (1.112 km) apart, from 38.945 to 39.055 north. The loaded points end at 39.0,
    // so the six points from 39.005 on have no forecast around them: 6 of the 11 segments.
    const step = 0.01 * KM_PER_DEGREE;
    const route = makeRoute({ lat: 38.945, lng: -9.2 }, [{ bearing: 0, km: 11 * step, steps: 11 }]);
    const result = analyseRoute(route, northerly(), 0, 25);
    expect(result.wind[5].outside).toBe(false);
    expect(result.wind[6].outside).toBe(true);
    expect(result.wind[11].outside).toBe(true);
    expect(result.outsideKm).toBeCloseTo(6 * step, 6);
    // nothing is claimed about the wind out there: no speed, no head or tail, and it is in no share
    expect(result.wind[11].speed).toBe(0);
    expect(result.wind[11].head).toBe(0);
    expect(result.wind[11].effect).toBe('unknown');
    expect(result.share.head + result.share.tail + result.share.cross).toBeCloseTo(5 * step, 6);
    // the averages describe the covered part only: 20 km/h, all of it against a northbound rider
    expect(result.avgSpeed).toBeCloseTo(20, 5);
    expect(result.net).toBeCloseTo(20, 5);
    expect(result.share.head).toBeCloseTo(5 * step, 6);
  });
});

describe('analyseRoute rain', () => {
  // an easterly across a northbound ride: the wind is not what these are about
  const hour = (extra = {}) => ({ speed: 10, dir: 90, gust: 12, ...extra });
  const hours = (...list) => everywhere(list);

  it('finds a dry ride dry, with nothing to add', () => {
    const result = analyseRoute(northbound(), hours(hour(), hour(), hour(), hour()), 0, 25);
    expect(result.rain).toEqual({ wetKm: 0, max: 0, wetChance: 0, chance: 0, known: true, wet: false });
    expect(result.rainNote).toBeNull();
    expect(result.wind[10].rain).toBe(0);
    expect(result.wind[10].rainChance).toBe(0);
  });

  it('says so when it rains all the way', () => {
    const wet = hour({ rain: 1.2, rainChance: 80 });
    const result = analyseRoute(northbound(), hours(wet, wet, wet, wet), 0, 25);
    expect(result.rain.wetKm).toBeCloseTo(50, 6);
    expect(result.rain.max).toBeCloseTo(1.2, 9);
    expect(result.rain.wetChance).toBeCloseTo(80, 9);
    expect(result.wind[25].rain).toBeCloseTo(1.2, 9);
    expect(result.wind[25].rainChance).toBeCloseTo(80, 9);
    expect(result.rainNote).toBe('Rain all the way, up to 1.2 mm/h (80% chance).');
  });

  it('counts the rain where the rider is when it falls, not at the start', () => {
    // A 2 h ride. The rain of an hour is filed under the hour that ends it: the first hour ridden is
    // dry and the second one wet, so the rider gets wet from km 25 on.
    const wet = hour({ rain: 3, rainChance: 90 });
    const forecast = hours(hour(), hour(), wet, wet);
    const result = analyseRoute(northbound(), forecast, 0, 25);
    expect(result.wind[24].rain).toBe(0);
    expect(result.wind[25].rain).toBeCloseTo(3, 9);
    expect(result.rain.wetKm).toBeCloseTo(26, 6);
    expect(result.rain.max).toBeCloseTo(3, 9);
    expect(result.rainNote).toBe('Rain on 26 km of the ride, up to 3.0 mm/h (90% chance).');
    // leaving an hour later, the whole ride is in it
    expect(analyseRoute(northbound(), forecast, 1, 25).rainNote).toBe('Rain all the way, up to 3.0 mm/h (90% chance).');
    // riding it in 50 minutes, the rider is home before it starts
    expect(analyseRoute(northbound(), forecast, 0, 60).rain.wetKm).toBe(0);
  });

  it('takes the heaviest rain met and the chance that goes with the rain, not with the dry part', () => {
    const forecast = hours(hour(), hour({ rain: 0.4, rainChance: 55 }), hour({ rain: 8, rainChance: 70 }), hour({ rain: 0, rainChance: 95 }));
    const result = analyseRoute(northbound(), forecast, 0, 25);
    expect(result.rain.max).toBeCloseTo(8, 9);
    expect(result.rain.wetChance).toBeCloseTo(70, 9);
    expect(result.rainNote).toBe('Rain all the way, up to 8.0 mm/h (70% chance).');
  });

  it('calls rain with little chance behind it only possible', () => {
    const shower = hour({ rain: 0.4, rainChance: 8 });
    expect(analyseRoute(northbound(), hours(shower, shower, shower, shower), 0, 25).rainNote).toBe('Rain possible all the way, up to 0.4 mm/h (8% chance).');
    const later = analyseRoute(northbound(), hours(hour(), hour(), shower, shower), 0, 25);
    expect(later.rainNote).toBe('Rain possible on 26 km of the ride, up to 0.4 mm/h (8% chance).');
    // an amount with no chance given at all is taken as forecast
    const unsure = hour({ rain: 0.4, rainChance: undefined });
    expect(analyseRoute(northbound(), hours(unsure, unsure, unsure, unsure), 0, 25).rainNote).toBe('Rain all the way, up to 0.4 mm/h.');
  });

  it('mentions a real chance of rain on a ride that is dry in the forecast', () => {
    const maybe = hour({ rain: 0, rainChance: 45 });
    const result = analyseRoute(northbound(), hours(hour(), hour(), maybe, maybe), 0, 25);
    expect(result.rain.wetKm).toBe(0);
    expect(result.rain.chance).toBeCloseTo(45, 9);
    expect(result.rainNote).toBe('Up to a 45% chance of rain on the way.');
  });

  it('keeps quiet about a small chance', () => {
    const unlikely = hour({ rain: 0, rainChance: 20 });
    expect(analyseRoute(northbound(), hours(unlikely, unlikely, unlikely, unlikely), 0, 25).rainNote).toBeNull();
  });

  it('says nothing about rain when the forecast does not give it', () => {
    const blank = hour({ rain: undefined, rainChance: undefined });
    const result = analyseRoute(northbound(), hours(blank, blank, blank, blank), 0, 25);
    expect(result.rain.known).toBe(false);
    expect(result.rain.wetKm).toBe(0);
    expect(result.rainNote).toBeNull();
    expect(Number.isNaN(result.wind[10].rain)).toBe(true);
    expect(Number.isNaN(result.wind[10].rainChance)).toBe(true);
    // the wind is still analysed
    expect(result.wind[10].speed).toBeCloseTo(10, 9);
  });

  it('has no rain to report where there is no forecast', () => {
    const step = 0.01 * KM_PER_DEGREE;
    const route = makeRoute({ lat: 38.945, lng: -9.2 }, [{ bearing: 0, km: 11 * step, steps: 11 }]);
    const wet = hour({ rain: 2, rainChance: 80 });
    const result = analyseRoute(route, hours(wet, wet, wet, wet), 0, 25);
    expect(result.wind[5].rain).toBeCloseTo(2, 9);
    expect(Number.isNaN(result.wind[11].rain)).toBe(true);
    // only the five segments with a forecast count as ridden in the rain
    expect(result.rain.wetKm).toBeCloseTo(5 * step, 6);
    expect(result.rainNote).toBe('Rain all the way, up to 2.0 mm/h (80% chance).');
  });
});

describe('windCost', () => {
  it('is nothing in still air', () => {
    expect(windCost(0, 25)).toBe(0);
  });

  it('is about what the wind blows, for a light wind', () => {
    // ((25 + 2)^2 - 25^2) / 50 = 2.08 and ((25 - 2)^2 - 25^2) / 50 = -1.92
    expect(windCost(2, 25)).toBeCloseTo(2.08, 9);
    expect(windCost(-2, 25)).toBeCloseTo(-1.92, 9);
  });

  it('charges more for a headwind than the same tailwind gives back', () => {
    // (40^2 - 25^2) / 50 = 19.5 against (10^2 - 25^2) / 50 = -10.5
    expect(windCost(15, 25)).toBeCloseTo(19.5, 9);
    expect(windCost(-15, 25)).toBeCloseTo(-10.5, 9);
  });

  it('keeps growing with the wind, also for a tailwind faster than the rider', () => {
    // at 25 km/h a 50 km/h tailwind pushes as hard as still air holds back: (-25^2 - 25^2) / 50 = -25
    expect(windCost(-50, 25)).toBeCloseTo(-25, 9);
    const winds = [-60, -50, -30, -25, -10, 0, 10, 25, 40];
    winds.forEach((w, i) => {
      if (i > 0) expect(windCost(w, 25)).toBeGreaterThan(windCost(winds[i - 1], 25));
    });
  });

  it('weighs the same wind more for a slower rider', () => {
    // (35^2 - 20^2) / 40 = 20.625
    expect(windCost(15, 20)).toBeCloseTo(20.625, 9);
    expect(windCost(15, 20)).toBeGreaterThan(windCost(15, 30));
  });
});

describe('routeTurn', () => {
  const start = { lat: 38.6, lng: -9.3 };

  it('turns an out-and-back at its far end', () => {
    const route = makeRoute(start, [{ bearing: 0, km: 15, steps: 15 }, { bearing: 180, km: 15, steps: 15 }]);
    const turn = routeTurn(route);
    expect(turn.loop).toBe(true);
    expect(turn.km).toBeCloseTo(15, 9);
  });

  it('turns a loop at the point farthest from the start, not at half the distance', () => {
    // 4 km north, 12 km east, 4 km south, then 12 km straight back: the far corner is 16 km into the 32
    const route = makeRoute(start, [
      { bearing: 0, km: 4, steps: 4 },
      { bearing: 90, km: 12, steps: 12 },
      { bearing: 180, km: 4, steps: 4 },
      { bearing: 270, km: 12, steps: 12 },
    ]);
    expect(routeTurn(route)).toEqual({ loop: true, km: expect.closeTo(16, 6) });
    // ridden from the corner next to it, the farthest point comes after 12 km of the 32
    const shifted = makeRoute(start, [
      { bearing: 90, km: 12, steps: 12 },
      { bearing: 180, km: 4, steps: 4 },
      { bearing: 270, km: 12, steps: 12 },
      { bearing: 0, km: 4, steps: 4 },
    ]);
    expect(routeTurn(shifted).km).toBeCloseTo(16, 6);
  });

  it('splits a route from one place to another at half its distance', () => {
    const turn = routeTurn(northbound());
    expect(turn.loop).toBe(false);
    expect(turn.km).toBeCloseTo(25, 9);
  });

  it('splits a loop at half its distance when its farthest point is near one end', () => {
    // 5 km out and back, then two short laps of 4 km out and back: the farthest point is 5 km into 26
    const route = makeRoute(start, [
      { bearing: 0, km: 5, steps: 5 },
      { bearing: 180, km: 5, steps: 5 },
      { bearing: 90, km: 4, steps: 4 },
      { bearing: 270, km: 4, steps: 4 },
      { bearing: 90, km: 4, steps: 4 },
      { bearing: 270, km: 4, steps: 4 },
    ]);
    expect(routeTurn(route)).toEqual({ loop: true, km: expect.closeTo(13, 9) });
  });

  it('takes a long route that finishes a few kilometres from its start for a loop, and a short one not', () => {
    // 94 km that end 3 km from the start: within a twentieth of the distance
    const long = makeRoute(start, [{ bearing: 0, km: 48.5, steps: 97 }, { bearing: 180, km: 45.5, steps: 91 }]);
    expect(routeTurn(long).loop).toBe(true);
    // 10 km that end 3 km from the start
    const short = makeRoute(start, [{ bearing: 0, km: 6.5, steps: 13 }, { bearing: 180, km: 3.5, steps: 7 }]);
    expect(routeTurn(short).loop).toBe(false);
  });
});

describe('analyseRoute against and behind', () => {
  it('averages the headwind and the tailwind over the whole ride, each on its own', () => {
    const route = makeRoute({ lat: 38.6, lng: -9.2 }, [{ bearing: 0, km: 15, steps: 15 }, { bearing: 180, km: 15, steps: 15 }]);
    const result = analyseRoute(route, northerly(), 0, 25);
    // 20 km/h against on half the way and nothing on the rest: 10; the same from behind
    expect(result.against).toBeCloseTo(10, 6);
    expect(result.behind).toBeCloseTo(10, 6);
    expect(result.against - result.behind).toBeCloseTo(result.net, 9);
  });

  it('has nothing behind on a ride into the wind, and nothing against on a ride with it', () => {
    const into = analyseRoute(northbound(), northerly(), 0, 25);
    expect(into.against).toBeCloseTo(20, 6);
    expect(into.behind).toBeCloseTo(0, 6);
    const pushed = analyseRoute(southbound(), northerly(), 0, 25);
    expect(pushed.against).toBeCloseTo(0, 6);
    expect(pushed.behind).toBeCloseTo(20, 6);
  });
});

describe('analyseRoute order of the wind', () => {
  const start = { lat: 38.6, lng: -9.2 };
  const outAndBack = (first) => makeRoute(first === 0 ? start : { lat: 38.8, lng: -9.2 }, [
    { bearing: first, km: 15, steps: 15 },
    { bearing: (first + 180) % 360, km: 15, steps: 15 },
  ]);

  it('says a loop that sets off into the wind comes home with it', () => {
    const result = analyseRoute(outAndBack(0), northerly(), 0, 25);
    expect(result.order.loop).toBe(true);
    expect(result.order.first).toBeCloseTo(20, 6);
    expect(result.order.second).toBeCloseTo(-20, 6);
    expect(result.orderNote).toBe('Headwind out, tailwind home.');
  });

  it('says a loop that sets off with the wind comes home against it', () => {
    const result = analyseRoute(outAndBack(180), northerly(), 0, 25);
    expect(result.order.first).toBeCloseTo(-20, 6);
    expect(result.order.second).toBeCloseTo(20, 6);
    expect(result.orderNote).toBe('Tailwind out, headwind home.');
  });

  it('goes by the way out and the way home of a loop, wherever half its distance falls', () => {
    // 4 km north, 12 km east, 4 km south, 12 km west in a 20 km/h easterly: out ends at the far corner
    const route = makeRoute({ lat: 38.6, lng: -9.3 }, [
      { bearing: 0, km: 4, steps: 4 },
      { bearing: 90, km: 12, steps: 12 },
      { bearing: 180, km: 4, steps: 4 },
      { bearing: 270, km: 12, steps: 12 },
    ]);
    const result = analyseRoute(route, steady(20, 90, 30), 0, 25);
    // out: 12 of 16 km into it; home: 12 of 16 km with it
    expect(result.order.first).toBeCloseTo(15, 1);
    expect(result.order.second).toBeCloseTo(-15, 1);
    expect(result.orderNote).toBe('Headwind out, tailwind home.');
  });

  it('speaks of first and later on a route that does not come back', () => {
    // 20 km north and 10 km back south: 10 km from the start at the end, split at km 15
    const route = makeRoute(start, [{ bearing: 0, km: 20, steps: 20 }, { bearing: 180, km: 10, steps: 10 }]);
    const result = analyseRoute(route, northerly(), 0, 25);
    expect(result.order.loop).toBe(false);
    expect(result.order.first).toBeCloseTo(20, 6);
    // 5 km still into it, 10 km with it: (100 - 200) / 15
    expect(result.order.second).toBeCloseTo(-6.667, 2);
    expect(result.orderNote).toBe('Headwind first, tailwind later.');
    expect(analyseRoute(route, steady(20, 180, 30), 0, 25).orderNote).toBe('Tailwind first, headwind later.');
  });

  it('names the one part that has wind along the road when the other has none', () => {
    // north, then east: in a northerly only the first half is into the wind
    const corner = makeRoute({ lat: 38.5, lng: -9.4 }, [{ bearing: 0, km: 20, steps: 20 }, { bearing: 90, km: 20, steps: 20 }]);
    expect(analyseRoute(corner, northerly(), 0, 25).orderNote).toBe('Headwind in the first half.');
    expect(analyseRoute(corner, steady(20, 180, 30), 0, 25).orderNote).toBe('Tailwind in the first half.');
    // and in a westerly only the second half has it behind; in an easterly, against
    expect(analyseRoute(corner, steady(20, 270, 30), 0, 25).orderNote).toBe('Tailwind in the second half.');
    expect(analyseRoute(corner, steady(20, 90, 30), 0, 25).orderNote).toBe('Headwind in the second half.');
  });

  it('says so when the wind drops before the way home', () => {
    // 20 km/h from the north at the start, calm an hour later. At 20 km/h the turn comes after 45 minutes:
    // the way out meets 20 falling to 5, the way home what is left of it for a quarter of an hour.
    const dying = everywhere([{ speed: 20, dir: 0, gust: 25 }, { speed: 0, dir: 0, gust: 0 }, { speed: 0, dir: 0, gust: 0 }, { speed: 0, dir: 0, gust: 0 }]);
    const result = analyseRoute(outAndBack(0), dying, 0, 20);
    expect(result.order.first).toBeGreaterThan(10);
    expect(Math.abs(result.order.second)).toBeLessThan(3);
    expect(result.orderNote).toBe('Headwind on the way out.');
    // and when it only gets up for the way home: calm for the first hour, then a southerly that builds.
    // Leaving a quarter past, the turn comes on the hour.
    const rising = everywhere([{ speed: 0, dir: 180, gust: 0 }, { speed: 0, dir: 180, gust: 0 }, { speed: 20, dir: 180, gust: 25 }, { speed: 20, dir: 180, gust: 25 }]);
    const later = analyseRoute(outAndBack(0), rising, 0.25, 20);
    expect(Math.abs(later.order.first)).toBeLessThan(1e-6);
    expect(later.order.second).toBeGreaterThan(5);
    expect(later.orderNote).toBe('Headwind on the way home.');
  });

  it('has nothing to say when both parts get the same wind', () => {
    expect(analyseRoute(northbound(), northerly(), 0, 25).orderNote).toBeNull();
    expect(analyseRoute(southbound(), northerly(), 0, 25).orderNote).toBeNull();
    // a crosswind both ways, and no wind at all
    expect(analyseRoute(outAndBack(0), steady(20, 90, 30), 0, 25).orderNote).toBeNull();
    expect(analyseRoute(outAndBack(0), steady(0, 0, 0), 0, 25).orderNote).toBeNull();
  });

  it('needs 3 km/h along the road, on average, before it calls a part head or tailwind', () => {
    expect(analyseRoute(outAndBack(0), steady(2.9, 0, 5), 0, 25).orderNote).toBeNull();
    expect(analyseRoute(outAndBack(0), steady(3.1, 0, 5), 0, 25).orderNote).toBe('Headwind out, tailwind home.');
  });

  it('says nothing when one part of the ride has no forecast', () => {
    // 11 steps north across the edge of the forecast: only the first five have wind
    const step = 0.01 * KM_PER_DEGREE;
    const route = makeRoute({ lat: 38.945, lng: -9.2 }, [{ bearing: 0, km: 11 * step, steps: 11 }]);
    const result = analyseRoute(route, northerly(), 0, 25);
    expect(result.order.first).toBeCloseTo(20, 6);
    expect(Number.isNaN(result.order.second)).toBe(true);
    expect(result.orderNote).toBeNull();
  });
});

describe('analyseRoute score', () => {
  const crosswind = (extra = {}) => ({ speed: 10, dir: 90, gust: 12, ...extra });
  const hours = (...list) => everywhere(list);

  it('is the wind cost averaged over the ride when it is dry and not gusty', () => {
    // into 20 km/h all the way: (45^2 - 25^2) / 50 = 28; with it: (5^2 - 25^2) / 50 = -12
    expect(analyseRoute(northbound(), northerly(), 0, 25).score).toBeCloseTo(28, 6);
    expect(analyseRoute(southbound(), northerly(), 0, 25).score).toBeCloseTo(-12, 6);
  });

  it('finds a windy out-and-back harder than a calm one, although head and tailwind even out', () => {
    const route = makeRoute({ lat: 38.6, lng: -9.2 }, [{ bearing: 0, km: 15, steps: 15 }, { bearing: 180, km: 15, steps: 15 }]);
    const windy = analyseRoute(route, northerly(), 0, 25);
    expect(windy.net).toBeCloseTo(0, 6);
    // (28 - 12) / 2
    expect(windy.score).toBeCloseTo(8, 6);
    expect(analyseRoute(route, steady(0, 0, 0), 0, 25).score).toBeCloseTo(0, 9);
  });

  it('is the same both ways round a loop in a steady wind, and not on the way there and the way back', () => {
    const corner = { lat: 38.6, lng: -9.3 };
    const sides = (...bearings) => makeRoute(corner, bearings.map((bearing) => ({ bearing, km: 10, steps: 10 })));
    // a square ridden north first, and the same square ridden east first
    const one = analyseRoute(sides(0, 90, 180, 270), northerly(), 0, 25);
    const other = analyseRoute(sides(90, 0, 270, 180), northerly(), 0, 25);
    // one side into it, one with it, two across: (28 - 12) / 4
    expect(one.score).toBeCloseTo(4, 6);
    expect(other.score).toBeCloseTo(one.score, 6);
    // from one place to another it is not: 28 there, -12 back
    expect(analyseRoute(northbound(), northerly(), 0, 25).score).toBeGreaterThan(analyseRoute(southbound(), northerly(), 0, 25).score);
  });

  it('adds the rain by how much of the ride it wets, how likely it is and how hard it falls', () => {
    const dry = analyseRoute(northbound(), hours(crosswind(), crosswind(), crosswind(), crosswind()), 0, 25);
    expect(dry.score).toBeCloseTo(0, 6);
    // light rain all the way at 80%: 15 * 1 * 0.8 * 1
    const light = crosswind({ rain: 1.2, rainChance: 80 });
    expect(analyseRoute(northbound(), hours(light, light, light, light), 0, 25).score).toBeCloseTo(12, 6);
    // the same rain with a chance of 20%
    const doubtful = crosswind({ rain: 1.2, rainChance: 20 });
    expect(analyseRoute(northbound(), hours(doubtful, doubtful, doubtful, doubtful), 0, 25).score).toBeCloseTo(3, 6);
    // moderate rain counts half as much again, heavy rain two and a half times
    const moderate = crosswind({ rain: 3, rainChance: 80 });
    expect(analyseRoute(northbound(), hours(moderate, moderate, moderate, moderate), 0, 25).score).toBeCloseTo(18, 6);
    const heavy = crosswind({ rain: 9, rainChance: 80 });
    expect(analyseRoute(northbound(), hours(heavy, heavy, heavy, heavy), 0, 25).score).toBeCloseTo(30, 6);
    // rain on the second hour only wets 26 of the 50 km
    const half = analyseRoute(northbound(), hours(crosswind(), crosswind(), light, light), 0, 25);
    expect(half.score).toBeCloseTo(12 * (26 / 50), 6);
  });

  it('takes rain the forecast puts no chance on for more likely than not', () => {
    const wet = crosswind({ rain: 1.2, rainChance: undefined });
    // 15 * 1 * 0.6 * 1
    expect(analyseRoute(northbound(), hours(wet, wet, wet, wet), 0, 25).score).toBeCloseTo(9, 6);
  });

  it('adds the gusts by how much of the ride they are a danger on', () => {
    // 10 km/h across the road with gusts of 55: no wind cost, gusty all the way
    expect(analyseRoute(northbound(), steady(10, 90, 55), 0, 25).score).toBeCloseTo(20, 6);
    // gusts of 45 from the side are not yet the kind that count (35 across the road is)
    expect(analyseRoute(northbound(), steady(40, 90, 45), 0, 25).score).toBeCloseTo(20, 6);
    expect(analyseRoute(northbound(), steady(10, 90, 30), 0, 25).score).toBeCloseTo(0, 6);
  });

  it('marks the ride wet only when the rain lasts for a real stretch of road', () => {
    const wet = crosswind({ rain: 1.2, rainChance: 80 });
    expect(analyseRoute(northbound(), hours(wet, wet, wet, wet), 0, 25).rain.wet).toBe(true);
    expect(analyseRoute(northbound(), hours(crosswind(), crosswind(), crosswind(), crosswind()), 0, 25).rain.wet).toBe(false);
  });
});

describe('scanDepartures', () => {
  // calm at hour 0, then 20 km/h from the north from hour 1 on
  const building = () => everywhere([
    { speed: 0, dir: 0, gust: 0 },
    { speed: 20, dir: 0, gust: 30 },
    { speed: 20, dir: 0, gust: 30 },
    { speed: 20, dir: 0, gust: 30 },
    { speed: 20, dir: 0, gust: 30 },
  ]);

  it('gives one ride per start, in the order asked, each as analyseRoute finds it', () => {
    const route = northbound();
    const starts = [1.5, 0, 1];
    const scan = scanDepartures(route, building(), starts, 25);
    expect(scan.map((d) => d.start)).toEqual(starts);
    scan.forEach((d) => {
      const ride = analyseRoute(route, building(), d.start, 25);
      expect(d.against).toBeCloseTo(ride.against, 9);
      expect(d.behind).toBeCloseTo(ride.behind, 9);
      expect(d.score).toBeCloseTo(ride.score, 9);
      expect(d.known).toBe(true);
      expect(d.late).toBe(false);
    });
    // leaving in the calm is easier than leaving once the wind is up
    expect(scan[1].score).toBeLessThan(scan[2].score);
    expect(scan[2].against).toBeCloseTo(20, 6);
  });

  it('defaults to 25 km/h', () => {
    const route = northbound();
    expect(scanDepartures(route, building(), [0])[0].score).toBeCloseTo(scanDepartures(route, building(), [0], 25)[0].score, 9);
    expect(scanDepartures(route, building(), [0], 20)[0].score).not.toBeCloseTo(scanDepartures(route, building(), [0], 25)[0].score, 3);
  });

  it('reads a long route at fewer points and still gets its totals right', () => {
    // 50 km with a point every 50 m: 1001 points
    const route = makeRoute({ lat: 38.45, lng: -9.2 }, [{ bearing: 0, km: 50, steps: 1000 }]);
    let asked = 0;
    const forecast = building();
    const counting = { sample: (...args) => { asked++; return forecast.sample(...args); } };
    const [ride] = scanDepartures(route, counting, [0], 25);
    expect(asked).toBeLessThanOrEqual(130);
    const full = analyseRoute(route, forecast, 0, 25);
    expect(ride.against).toBeCloseTo(full.against, 0);
    expect(Math.abs(ride.score - full.score)).toBeLessThan(0.3);
  });

  it('flags a ride that ends after the forecast, and one with no forecast along the route', () => {
    // 5 hours of forecast, a 2 h ride: leaving at hour 2 it ends on the last hour, at hour 3 an hour too late
    const scan = scanDepartures(northbound(), building(), [2, 3], 25);
    expect(scan.map((d) => d.late)).toEqual([false, true]);
    const elsewhere = makeRoute({ lat: 45, lng: 3 }, [{ bearing: 0, km: 20, steps: 20 }]);
    const [lost] = scanDepartures(elsewhere, building(), [0], 25);
    expect(lost.known).toBe(false);
  });

  it('says which rides meet rain, how hard and how likely', () => {
    const dry = { speed: 10, dir: 90, gust: 12 };
    const wet = { ...dry, rain: 3, rainChance: 70 };
    const forecast = everywhere([dry, dry, dry, wet, wet, wet]);
    // the rain starts with hour 2. At 30 km/h the ride takes 1 h 40: over in time when it leaves at hour 0
    const scan = scanDepartures(northbound(), forecast, [0, 2], 30);
    expect(scan[0].wet).toBe(false);
    expect(scan[1].wet).toBe(true);
    expect(scan[1].rain).toBeCloseTo(3, 9);
    expect(scan[1].rainChance).toBeCloseTo(70, 9);
    expect(scan[1].score).toBeGreaterThan(scan[0].score);
  });
});

describe('bestDepartures', () => {
  const ride = (start, score, extra = {}) => ({ start, score, known: true, late: false, past: false, day: 'Mon', light: 'ride', ...extra });

  it('takes the easiest ride of each day, in the order of time', () => {
    const best = bestDepartures([
      ride(8, 6), ride(9, 4), ride(10, 5),
      ride(32, 3, { day: 'Tue' }), ride(33, 1, { day: 'Tue' }), ride(34, 2, { day: 'Tue' }),
    ]);
    expect(best.map((d) => d.start)).toEqual([9, 33]);
  });

  it('leaves out what can no longer be chosen, what ends after the forecast and what has no forecast', () => {
    const best = bestDepartures([
      ride(8, 1, { past: true }),
      ride(9, 5),
      ride(10, 2, { late: true }),
      ride(11, 3, { known: false }),
      ride(12, NaN),
    ]);
    expect(best.map((d) => d.start)).toEqual([9]);
  });

  it('does not send anyone out in the dark for an easier ride', () => {
    const best = bestDepartures([
      ride(4, -5, { light: 'none' }),
      ride(9, 6),
      ride(18, 2, { light: 'start' }),
    ]);
    expect(best.map((d) => d.start)).toEqual([9]);
  });

  it('has nothing for a day whose daylight is too short by now, while another day has room', () => {
    const best = bestDepartures([
      ride(18, 2, { light: 'start' }),
      ride(21, 1, { light: 'none' }),
      ride(33, 4, { day: 'Tue' }),
    ]);
    expect(best.map((d) => d.start)).toEqual([33]);
  });

  it('falls back to rides that set off in daylight when none fits in a day, and then to any', () => {
    const long = [ride(6, 7, { light: 'start' }), ride(7, 5, { light: 'start' }), ride(22, 1, { light: 'none' })];
    expect(bestDepartures(long).map((d) => d.start)).toEqual([7]);
    const polar = [ride(6, 7, { light: 'none' }), ride(7, 5, { light: 'none' })];
    expect(bestDepartures(polar).map((d) => d.start)).toEqual([7]);
  });

  it('lets the earlier ride win a tie', () => {
    expect(bestDepartures([ride(9, 4), ride(10, 4), ride(11, 4)]).map((d) => d.start)).toEqual([9]);
  });

  it('stops at three days unless told otherwise, and is empty when there is nothing to choose from', () => {
    const week = ['Mon', 'Tue', 'Wed', 'Thu'].map((day, i) => ride(9 + 24 * i, 4, { day }));
    expect(bestDepartures(week).map((d) => d.day)).toEqual(['Mon', 'Tue', 'Wed']);
    expect(bestDepartures(week, 1).map((d) => d.day)).toEqual(['Mon']);
    expect(bestDepartures([])).toEqual([]);
    expect(bestDepartures([ride(9, 4, { past: true })])).toEqual([]);
  });
});

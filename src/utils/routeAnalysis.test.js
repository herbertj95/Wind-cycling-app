import { describe, it, expect } from 'vitest';
import { analyseRoute, RIDE_SPEEDS } from './routeAnalysis';
import { GRID, GRID_POINTS } from './weatherApi';
import { angleDiff, windComponents } from './wind';

// Convention under test: a wind direction is where the wind comes FROM (0 = north, 90 = east), speeds in km/h.

const T0 = 1790985600; // 2026-10-03 00:00 UTC in unix seconds
const KM_PER_DEGREE = 111.19492664455873; // 6371 km * pi / 180

/**
 * Synthetic forecast. `at(k, h, point)` describes grid point k at hour h and returns
 * { speed, dir, gust?, temp?, feels? }.
 */
function makeForecast(hourCount, at) {
  return {
    hours: Array.from({ length: hourCount }, (_, h) => T0 + h * 3600),
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

  it('counts the kilometres ridden outside the forecast area', () => {
    // 12 points 0.01 degrees (1.112 km) apart, from 38.945 to 39.055 north. The grid ends at 39.0,
    // so the six points from 39.005 on are outside: 6 of the 11 segments.
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

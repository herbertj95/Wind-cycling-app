// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { calculateDistance, calculateBearing, parseGpxData, reverseRoute, positionAt, PRESET_ROUTES } from './gpxParser';

// One degree of latitude on the 6371 km sphere the parser uses: 6371 * pi / 180
const KM_PER_DEGREE = 111.19492664455873;

// Tests that parse thousands of points take a second or so; give them room on a busy machine.
const SLOW = { timeout: 20000 };

/** Smallest angle between two bearings, so 359.9 and 0.1 are 0.2 apart. */
const bearingGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/** GPX 1.1 document with one track segment. Points are { lat, lng, ele? }; no `ele` means no <ele> tag. */
function gpxTrack(points) {
  const body = points
    .map((p) => `<trkpt lat="${p.lat}" lon="${p.lng}">${p.ele === undefined ? '' : `<ele>${p.ele}</ele>`}</trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>Test</name><trkseg>
${body}
</trkseg></trk>
</gpx>`;
}

/** `count` points due north from 38.6, -9.2, one every `stepDeg` degrees, with elevations from `eleAt(i)`. */
function northLine(count, stepDeg, eleAt) {
  return Array.from({ length: count }, (_, i) => ({
    lat: 38.6 + i * stepDeg,
    lng: -9.2,
    ele: eleAt ? eleAt(i) : undefined,
  }));
}

describe('calculateDistance', () => {
  it('is 0 between identical points', () => {
    expect(calculateDistance(38.7, -9.14, 38.7, -9.14)).toBe(0);
    expect(calculateDistance(0, 0, 0, 0)).toBe(0);
  });

  it('measures one degree of latitude as 111.19 km', () => {
    // 6371 km * pi / 180 = 111.195 km, the same anywhere on a sphere
    expect(calculateDistance(38, -9, 39, -9)).toBeCloseTo(111.19, 2);
    expect(calculateDistance(0, 0, 1, 0)).toBeCloseTo(111.19, 2);
    expect(calculateDistance(-45, 100, -44, 100)).toBeCloseTo(111.19, 2);
  });

  it('measures one degree of longitude as 111.19 km on the equator and half that at 60 north', () => {
    expect(calculateDistance(0, 0, 0, 1)).toBeCloseTo(111.19, 2);
    // cos(60) = 0.5 -> 55.60 km
    expect(calculateDistance(60, 0, 60, 1)).toBeCloseTo(55.6, 1);
  });

  it('shrinks a degree of longitude by cos(latitude) around Lisbon', () => {
    // 0.01 degrees of longitude at 38.7 north: 1.11195 km * cos(38.7) = 1.11195 * 0.78043 = 0.8678 km
    expect(calculateDistance(38.7, -9.2, 38.7, -9.19)).toBeCloseTo(0.8678, 3);
  });

  it('is the same in both directions', () => {
    const there = calculateDistance(38.7223, -9.1393, 38.6979, -9.4215);
    const back = calculateDistance(38.6979, -9.4215, 38.7223, -9.1393);
    expect(there).toBeCloseTo(back, 12);
    expect(there).toBeGreaterThan(0);
  });

  it('puts Lisbon and Porto about 274 km apart', () => {
    // 2.4356 degrees north (270.8 km) and 0.5102 degrees east at ~39.9 north (43.5 km): sqrt(270.8^2 + 43.5^2) = 274.3
    expect(calculateDistance(38.7223, -9.1393, 41.1579, -8.6291)).toBeCloseTo(274.3, 0);
  });

  it('measures a quarter of the way round the globe', () => {
    // equator to pole: 6371 * pi / 2 = 10007.54 km
    expect(calculateDistance(0, 0, 90, 0)).toBeCloseTo(10007.54, 1);
  });
});

describe('calculateBearing', () => {
  it('is 0 due north', () => {
    expect(calculateBearing(38, -9, 39, -9)).toBeCloseTo(0, 6);
  });

  it('is 90 due east', () => {
    expect(calculateBearing(0, 0, 0, 1)).toBeCloseTo(90, 6);
  });

  it('is 180 due south', () => {
    expect(calculateBearing(39, -9, 38, -9)).toBeCloseTo(180, 6);
  });

  it('is 270 due west', () => {
    expect(calculateBearing(0, 0, 0, -1)).toBeCloseTo(270, 6);
  });

  it('is within a hundredth of a degree of east and west for a short hop along a parallel in Lisbon', () => {
    // a great circle leaves a parallel by (dLon / 2) * sin(lat): 0.005 * 0.625 = 0.003 degrees here
    expect(calculateBearing(38.7, -9.2, 38.7, -9.19)).toBeCloseTo(90, 1);
    expect(calculateBearing(38.7, -9.19, 38.7, -9.2)).toBeCloseTo(270, 1);
  });

  it('is 45 for equal steps north and east on the equator', () => {
    expect(calculateBearing(0, 0, 0.01, 0.01)).toBeCloseTo(45, 3);
    expect(calculateBearing(0, 0, -0.01, 0.01)).toBeCloseTo(135, 3);
    expect(calculateBearing(0, 0, -0.01, -0.01)).toBeCloseTo(225, 3);
    expect(calculateBearing(0, 0, 0.01, -0.01)).toBeCloseTo(315, 3);
  });

  it('always answers inside [0, 360)', () => {
    const targets = [[39, -9], [38, -9], [38.5, -8], [38.5, -10], [38.5, -9], [38.6, -9.1], [38.4, -9.1]];
    for (const [lat, lng] of targets) {
      const bearing = calculateBearing(38.5, -9, lat, lng);
      expect(Number.isFinite(bearing)).toBe(true);
      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThan(360);
    }
  });
});

describe('parseGpxData', () => {
  describe('a short track', () => {
    // 5 points due north, 0.01 degrees (1.112 km) apart
    const points = northLine(5, 0.01, (i) => 10 * i);
    const route = parseGpxData(gpxTrack(points), 'Morning loop');

    it('keeps the name it was given', () => {
      expect(route.name).toBe('Morning loop');
      expect(parseGpxData(gpxTrack(points)).name).toBe('Imported Route');
    });

    it('keeps every point of a track that is already small', () => {
      expect(route.points).toHaveLength(5);
      route.points.forEach((p, i) => {
        expect(p.lat).toBe(points[i].lat);
        expect(p.lng).toBe(points[i].lng);
        expect(p.ele).toBe(10 * i);
      });
    });

    it('measures the cumulative distance at every point', () => {
      // 0.04 degrees of latitude = 4.4478 km in total, 1.11195 km per step
      expect(route.totalDistance).toBeCloseTo(4.4478, 3);
      route.points.forEach((p, i) => {
        expect(p.distance).toBeCloseTo(i * 0.01 * KM_PER_DEGREE, 6);
      });
      expect(route.points[0].distance).toBe(0);
      expect(route.points[4].distance).toBe(route.totalDistance);
    });

    it('heads north at every point', () => {
      for (const p of route.points) {
        expect(bearingGap(p.bearing, 0)).toBeLessThan(0.001);
      }
    });

    it('reports climbing as a whole, non-negative number of metres', () => {
      expect(Number.isInteger(route.totalElevationGain)).toBe(true);
      expect(route.totalElevationGain).toBeGreaterThan(0);
      expect(route.totalElevationGain).toBeLessThanOrEqual(40);
    });
  });

  describe('a long straight track with more points than it keeps', () => {
    // 3000 points due north over 0.3 degrees of latitude: 0.3 * 111.195 = 33.358 km
    const COUNT = 3000;
    const points = Array.from({ length: COUNT }, (_, i) => ({ lat: 38.5 + (0.3 * i) / (COUNT - 1), lng: -9.2, ele: 50 }));
    const route = parseGpxData(gpxTrack(points));
    const trueLength = 0.3 * KM_PER_DEGREE;

    it('thins the line to at most 601 points without over-thinning it', () => {
      expect(route.points.length).toBeLessThanOrEqual(601);
      // 3000 evenly spaced points: every 5th one is kept, so the line stays detailed
      expect(route.points.length).toBeGreaterThan(300);
    });

    it('keeps the full length: within 0.1% of the true 33.358 km', () => {
      expect(Math.abs(route.totalDistance - trueLength) / trueLength).toBeLessThan(0.001);
      expect(route.totalDistance).toBeCloseTo(33.358, 2);
    });

    it('keeps the first and the last point of the track', () => {
      const first = route.points[0];
      const last = route.points[route.points.length - 1];
      expect(first.lat).toBe(points[0].lat);
      expect(first.lng).toBe(points[0].lng);
      expect(first.distance).toBe(0);
      expect(last.lat).toBe(points[COUNT - 1].lat);
      expect(last.lng).toBe(points[COUNT - 1].lng);
      expect(last.distance).toBe(route.totalDistance);
    });

    it('has distance growing from one kept point to the next', () => {
      for (let i = 1; i < route.points.length; i++) {
        expect(route.points[i].distance).toBeGreaterThan(route.points[i - 1].distance);
      }
    });

    it('spreads the kept points evenly along the route', () => {
      // 600 slots over 33.36 km = 55.6 m each; no gap should be much larger than two slots
      const slot = route.totalDistance / 600;
      for (let i = 1; i < route.points.length; i++) {
        expect(route.points[i].distance - route.points[i - 1].distance).toBeLessThan(2 * slot);
      }
    });

    it('heads north (bearing ~0) at every kept point', () => {
      for (const p of route.points) {
        expect(bearingGap(p.bearing, 0)).toBeLessThan(0.01);
      }
    });

    it('gives every kept point the full set of fields', () => {
      for (const p of route.points) {
        expect(Object.keys(p).sort()).toEqual(['bearing', 'distance', 'ele', 'lat', 'lng', 'pathKm']);
        expect(p.ele).toBe(50);
      }
    });
  });

  describe('a long zig-zag track', () => {
    // 3001 points: 0.0001 degrees north per step while stepping 0.0001 degrees east and back west.
    // One step is 11.119 m north and 11.119 * cos(38.65) = 8.684 m sideways: sqrt(11.119^2 + 8.684^2) = 14.109 m.
    // 3000 steps = 42.33 km, although start and end are only 0.3 degrees = 33.36 km apart.
    const COUNT = 3001;
    const points = Array.from({ length: COUNT }, (_, i) => ({ lat: 38.5 + i * 0.0001, lng: -9.2 + (i % 2) * 0.0001 }));
    const route = parseGpxData(gpxTrack(points));

    it('reports the distance over ALL raw points, not over the thinned line', () => {
      expect(route.totalDistance).toBeCloseTo(42.33, 1);
      let exact = 0;
      for (let i = 1; i < COUNT; i++) {
        exact += calculateDistance(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
      }
      expect(route.totalDistance).toBeCloseTo(exact, 9);
      // well above the straight-line distance a thinned line would tend towards
      expect(route.totalDistance).toBeGreaterThan(1.2 * 0.3 * KM_PER_DEGREE);
    });

    it('still thins to at most 601 points and ends at the full distance', () => {
      expect(route.points.length).toBeLessThanOrEqual(601);
      expect(route.points.length).toBeGreaterThan(300);
      expect(route.points[0].distance).toBe(0);
      expect(route.points[route.points.length - 1].distance).toBe(route.totalDistance);
      expect(route.points[route.points.length - 1].lat).toBe(points[COUNT - 1].lat);
    });

    it('never lets distance go backwards', () => {
      for (let i = 1; i < route.points.length; i++) {
        expect(route.points[i].distance).toBeGreaterThanOrEqual(route.points[i - 1].distance);
      }
    });
  });

  describe('an L-shaped track', () => {
    // 10 steps of 0.01 degrees north from 38.60, -9.20 to the corner at 38.70, -9.20, then 10 steps east to 38.70, -9.10
    const north = Array.from({ length: 11 }, (_, i) => ({ lat: (3860 + i) / 100, lng: -9.2 }));
    const east = Array.from({ length: 10 }, (_, j) => ({ lat: 38.7, lng: -(920 - (j + 1)) / 100 }));
    const route = parseGpxData(gpxTrack([...north, ...east]));

    it('keeps all 21 points', () => {
      expect(route.points).toHaveLength(21);
    });

    it('adds both legs: 11.12 km north plus 8.68 km east', () => {
      // 0.1 degrees of latitude = 11.119 km; 0.1 degrees of longitude at 38.7 north = 11.119 * 0.78043 = 8.678 km
      expect(route.points[10].distance).toBeCloseTo(11.119, 2);
      expect(route.totalDistance).toBeCloseTo(19.797, 2);
    });

    it('heads north on the first leg', () => {
      for (let i = 0; i <= 9; i++) {
        expect(bearingGap(route.points[i].bearing, 0), `point ${i}`).toBeLessThan(0.1);
      }
    });

    it('heads east on the second leg', () => {
      for (let i = 11; i <= 20; i++) {
        expect(bearingGap(route.points[i].bearing, 90), `point ${i}`).toBeLessThan(0.1);
      }
    });

    it('turns through north-east at the corner', () => {
      // from the point before the corner (38.69, -9.20) to the point after it (38.70, -9.19):
      // 1.112 km north and 0.868 km east -> atan(0.868 / 1.112) = 38.0 degrees
      expect(route.points[10].bearing).toBeCloseTo(38, 0);
    });
  });

  describe('elevation', () => {
    it('handles a track with no <ele> at all: everything sits at 0 and nothing is climbed', () => {
      const route = parseGpxData(gpxTrack(northLine(20, 0.001)));
      expect(route.points).toHaveLength(20);
      for (const p of route.points) {
        expect(p.ele).toBe(0);
      }
      expect(route.totalElevationGain).toBe(0);
    });

    it('fills a missing <ele> from the last reading, and leading gaps from the first reading', () => {
      const points = northLine(6, 0.001);
      points[2].ele = 50;
      points[4].ele = 60;
      const route = parseGpxData(gpxTrack(points));
      expect(route.points.map((p) => p.ele)).toEqual([50, 50, 50, 50, 60, 60]);
      // one clean 10 m step between points 111 m apart: nothing to smooth, nothing invented by the filling
      expect(route.totalElevationGain).toBe(10);
    });

    it('treats an empty or unreadable <ele> as missing', () => {
      const points = northLine(4, 0.001, (i) => ['12', '', 'n/a', '14'][i]);
      const route = parseGpxData(gpxTrack(points));
      expect(route.points.map((p) => p.ele)).toEqual([12, 12, 12, 14]);
    });

    it('ignores +-1 m of noise on a flat road', () => {
      // 200 points 11 m apart alternating 99 m and 101 m. Averaged with their neighbours they stay within
      // 100 +- 0.4 m, far below the 2 m a rise needs before it counts.
      const route = parseGpxData(gpxTrack(northLine(200, 0.0001, (i) => (i % 2 ? 101 : 99))));
      expect(route.totalElevationGain).toBe(0);
    });

    it('ignores +-1 m of noise on a densely recorded flat road', () => {
      // one point every 2.2 m, the same wobble
      const route = parseGpxData(gpxTrack(northLine(600, 0.00002, (i) => (i % 2 ? 101 : 99))));
      expect(route.totalElevationGain).toBe(0);
    });

    it('counts a steady 100 m climb, give or take a few metres', () => {
      // 201 points rising 0.5 m each from 100 m to 200 m. Averaging clips about 0.5 m off each end,
      // so 97..100 m is the honest range.
      const route = parseGpxData(gpxTrack(northLine(201, 0.0001, (i) => 100 + 0.5 * i)));
      expect(route.totalElevationGain).toBeGreaterThanOrEqual(95);
      expect(route.totalElevationGain).toBeLessThanOrEqual(101);
    });

    it('counts a 100 m climb through +-1 m of noise', () => {
      const route = parseGpxData(gpxTrack(northLine(201, 0.0001, (i) => 100 + 0.5 * i + (i % 2 ? 1 : -1))));
      expect(route.totalElevationGain).toBeGreaterThanOrEqual(95);
      expect(route.totalElevationGain).toBeLessThanOrEqual(105);
    });

    it('counts only the way up on a climb followed by the same descent', () => {
      // 100 m up over 200 steps, then 100 m back down
      const route = parseGpxData(gpxTrack(northLine(401, 0.0001, (i) => 100 + 0.5 * (i <= 200 ? i : 400 - i))));
      expect(route.totalElevationGain).toBeGreaterThanOrEqual(95);
      expect(route.totalElevationGain).toBeLessThanOrEqual(101);
    });

    it('adds up two separate climbs', () => {
      // up 50 m, down 50 m, up 50 m again: 100 m of climbing
      const profile = (i) => {
        if (i <= 100) return 0.5 * i;
        if (i <= 200) return 50 - 0.5 * (i - 100);
        return 0.5 * (i - 200);
      };
      const route = parseGpxData(gpxTrack(northLine(301, 0.0001, profile)));
      expect(route.totalElevationGain).toBeGreaterThanOrEqual(92);
      expect(route.totalElevationGain).toBeLessThanOrEqual(101);
    });

    it('counts nothing on a pure descent', () => {
      const route = parseGpxData(gpxTrack(northLine(201, 0.0001, (i) => 200 - 0.5 * i)));
      expect(route.totalElevationGain).toBe(0);
    });

    it('counts every big climb of a long track that gets thinned', SLOW, () => {
      // 3001 points, 6 hills of 100 m up and 100 m down, 500 points each (0.4 m per point): 600 m of climbing.
      // Smoothing clips about half a metre off every top and bottom, so about 99 m per hill; allow 5%.
      const hill = (i) => {
        const phase = i % 500;
        return 100 + (phase <= 250 ? phase : 500 - phase) * 0.4;
      };
      const route = parseGpxData(gpxTrack(northLine(3001, 0.0001, hill)));
      expect(route.points.length).toBeLessThanOrEqual(601);
      expect(route.totalElevationGain).toBeGreaterThanOrEqual(570);
      expect(route.totalElevationGain).toBeLessThanOrEqual(600);
    });

    it('measures climbing on the full track, not on the thinned line', SLOW, () => {
      // 6000 points 11 m apart (66.7 km), of which about every 10th is kept. The road rolls 10 m up and down
      // every 20 points (222 m) as a sine wave, so points 10 apart sit at the same height: a thinned line is
      // flat, while the ride really climbs 300 * 10 m = 3000 m. Averaging over +-2 points flattens a 20-point
      // wave by (1 + 2 cos 18 + 2 cos 36) / 5 = 0.904, so about 2710 m is the honest count; allow 20% under.
      const wave = (i) => (100 + 5 * Math.sin((2 * Math.PI * i) / 20)).toFixed(3);
      const route = parseGpxData(gpxTrack(northLine(6000, 0.0001, wave)));
      expect(route.points.length).toBeLessThanOrEqual(601);
      expect(route.totalElevationGain).toBeGreaterThanOrEqual(2400);
      expect(route.totalElevationGain).toBeLessThanOrEqual(3000);
    });

    // Regression: an earlier version moved its reference height in 2 m steps both ways and dropped the
    // last <2 m of every climb, losing up to 4 m per roller: these 600 m came out as 362 m.
    it('counts rolling terrain: sixty 10 m rollers are close to 600 m of climbing', SLOW, () => {
      // 3001 points, 60 rollers of 10 m up and 10 m down, 50 points each (0.4 m per point).
      // Each roller should count from its lowest to its highest point: 10 m minus about 0.5 m of
      // smoothing at each end, about 9 m, 540 m in total.
      const roller = (i) => {
        const phase = i % 50;
        return 100 + (phase <= 25 ? phase : 50 - phase) * 0.4;
      };
      const route = parseGpxData(gpxTrack(northLine(3001, 0.0001, roller)));
      // within 20% of the true 600 m
      expect(route.totalElevationGain).toBeGreaterThanOrEqual(480);
      expect(route.totalElevationGain).toBeLessThanOrEqual(600);
    });

    // Regression: an earlier version averaged over 5 neighbouring points whatever their spacing, which
    // on a sparse track averages across kilometres: the 40 m below came out as 20 m, the 200 m hill as 47 m.
    it('counts the climbing of a sparse track whose points are a kilometre apart', () => {
      // 0.01 degrees of latitude = 1.11 km between points; clean elevations, nothing to smooth away
      const steady = parseGpxData(gpxTrack(northLine(5, 0.01, (i) => 10 * i)));
      expect(steady.totalElevationGain).toBeGreaterThanOrEqual(38);
      expect(steady.totalElevationGain).toBeLessThanOrEqual(40);

      const hill = parseGpxData(gpxTrack(northLine(7, 0.01, (i) => [0, 0, 100, 200, 100, 0, 0][i])));
      expect(hill.totalElevationGain).toBeGreaterThanOrEqual(190);
      expect(hill.totalElevationGain).toBeLessThanOrEqual(200);
    });

    it('ignores barometer jitter while the rider stands still', () => {
      // 60 readings at the same spot wobbling between 99 and 101 m, then a flat kilometre
      const waiting = Array.from({ length: 60 }, (_, i) => ({ lat: 38.6, lng: -9.2, ele: i % 2 ? 101 : 99 }));
      const riding = Array.from({ length: 100 }, (_, i) => ({ lat: 38.6 + (i + 1) * 0.0001, lng: -9.2, ele: 100 }));
      const route = parseGpxData(gpxTrack([...waiting, ...riding]));
      expect(route.totalElevationGain).toBe(0);
    });
  });

  describe('file variants', () => {
    it('accepts a route-only file (<rtept> instead of <trkpt>)', () => {
      const gpx = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
<rte><name>Planned</name>
<rtept lat="38.60" lon="-9.20"><ele>5</ele></rtept>
<rtept lat="38.61" lon="-9.20"><ele>6</ele></rtept>
<rtept lat="38.62" lon="-9.20"><ele>7</ele></rtept>
</rte>
</gpx>`;
      const route = parseGpxData(gpx);
      expect(route.points).toHaveLength(3);
      expect(route.totalDistance).toBeCloseTo(2.2239, 3); // 0.02 degrees of latitude
      expect(route.points.map((p) => p.ele)).toEqual([5, 6, 7]);
    });

    it('prefers the recorded track when a file has both a track and a route', () => {
      const gpx = `<gpx xmlns="http://www.topografix.com/GPX/1/1">
<rte><rtept lat="40.0" lon="-8.0"/><rtept lat="41.0" lon="-8.0"/></rte>
<trk><trkseg><trkpt lat="38.60" lon="-9.20"/><trkpt lat="38.61" lon="-9.20"/></trkseg></trk>
</gpx>`;
      const route = parseGpxData(gpx);
      expect(route.points).toHaveLength(2);
      expect(route.points[0].lat).toBe(38.6);
      expect(route.totalDistance).toBeCloseTo(1.112, 3);
    });

    it('accepts prefixed tags (gpx:trkpt)', () => {
      const gpx = `<?xml version="1.0"?>
<gpx:gpx version="1.1" xmlns:gpx="http://www.topografix.com/GPX/1/1">
<gpx:trk><gpx:trkseg>
<gpx:trkpt lat="38.60" lon="-9.20"><gpx:ele>10</gpx:ele></gpx:trkpt>
<gpx:trkpt lat="38.61" lon="-9.20"><gpx:ele>20</gpx:ele></gpx:trkpt>
<gpx:trkpt lat="38.62" lon="-9.20"><gpx:ele>30</gpx:ele></gpx:trkpt>
</gpx:trkseg></gpx:trk>
</gpx:gpx>`;
      const route = parseGpxData(gpx);
      expect(route.points).toHaveLength(3);
      expect(route.points.map((p) => p.ele)).toEqual([10, 20, 30]);
      expect(route.totalDistance).toBeCloseTo(2.2239, 3);
    });

    it('accepts the older GPX 1.0 namespace and files with no namespace', () => {
      const body = '<trk><trkseg><trkpt lat="38.60" lon="-9.20"><ele>1</ele></trkpt><trkpt lat="38.61" lon="-9.20"><ele>2</ele></trkpt></trkseg></trk>';
      const v10 = parseGpxData(`<gpx version="1.0" xmlns="http://www.topografix.com/GPX/1/0">${body}</gpx>`);
      const bare = parseGpxData(`<gpx>${body}</gpx>`);
      expect(v10.points).toHaveLength(2);
      expect(bare.points).toHaveLength(2);
      expect(bare.points.map((p) => p.ele)).toEqual([1, 2]);
      expect(bare.totalDistance).toBeCloseTo(v10.totalDistance, 12);
    });

    it('reads a device export with times and extensions', () => {
      const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="Garmin" version="1.1" xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
<metadata><time>2026-10-03T08:00:00Z</time></metadata>
<wpt lat="38.0" lon="-9.0"><name>Cafe</name></wpt>
<trk><name>Ride</name><trkseg>
<trkpt lat="38.600" lon="-9.200"><ele>12.4</ele><time>2026-10-03T08:00:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
<trkpt lat="38.605" lon="-9.200"><ele>13.1</ele><time>2026-10-03T08:01:00Z</time></trkpt>
<trkpt lat="38.610" lon="-9.200"><ele>13.9</ele><time>2026-10-03T08:02:00Z</time></trkpt>
</trkseg></trk>
</gpx>`;
      const route = parseGpxData(gpx, 'Ride');
      // the waypoint is not part of the track
      expect(route.points).toHaveLength(3);
      expect(route.points.map((p) => p.ele)).toEqual([12.4, 13.1, 13.9]);
      expect(route.totalDistance).toBeCloseTo(1.112, 3);
    });

    it('joins the segments of a multi-segment track in order', () => {
      const gpx = `<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk>
<trkseg><trkpt lat="38.60" lon="-9.20"/><trkpt lat="38.61" lon="-9.20"/></trkseg>
<trkseg><trkpt lat="38.62" lon="-9.20"/><trkpt lat="38.63" lon="-9.20"/></trkseg>
</trk></gpx>`;
      const route = parseGpxData(gpx);
      expect(route.points.map((p) => p.lat)).toEqual([38.6, 38.61, 38.62, 38.63]);
      expect(route.totalDistance).toBeCloseTo(0.03 * KM_PER_DEGREE, 6);
    });

    it('skips points with missing or impossible coordinates', () => {
      const gpx = `<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
<trkpt lat="38.60" lon="-9.20"/>
<trkpt lat="abc" lon="-9.20"/>
<trkpt lon="-9.20"/>
<trkpt lat="95" lon="-9.20"/>
<trkpt lat="38.605" lon="-190"/>
<trkpt lat="38.61" lon="-9.20"/>
</trkseg></trk></gpx>`;
      const route = parseGpxData(gpx);
      expect(route.points.map((p) => p.lat)).toEqual([38.6, 38.61]);
      expect(route.totalDistance).toBeCloseTo(1.112, 3);
    });

    it('copes with a rider standing still (repeated points)', () => {
      const points = [
        { lat: 38.6, lng: -9.2 },
        { lat: 38.6, lng: -9.2 },
        { lat: 38.6, lng: -9.2 },
        { lat: 38.61, lng: -9.2 },
        { lat: 38.61, lng: -9.2 },
        { lat: 38.62, lng: -9.2 },
      ];
      const route = parseGpxData(gpxTrack(points));
      expect(route.totalDistance).toBeCloseTo(2.2239, 3);
      for (let i = 0; i < route.points.length; i++) {
        expect(Number.isFinite(route.points[i].bearing)).toBe(true);
        if (i > 0) expect(route.points[i].distance).toBeGreaterThanOrEqual(route.points[i - 1].distance);
      }
      expect(route.points[route.points.length - 1].distance).toBe(route.totalDistance);
    });

    // The last point of a track is always kept, also when the rider had already stopped and it repeats
    // the position of the kept point before it. A heading from a point to itself would come out as 0 (north),
    // so a point with no movement around it keeps the heading the rider arrived with.
    it('keeps the heading of travel at the end of a track that finishes standing still', () => {
      const points = [
        { lat: 38.6, lng: -9.2 },
        { lat: 38.6, lng: -9.19 },
        { lat: 38.6, lng: -9.18 },
        { lat: 38.6, lng: -9.18 },
      ];
      const route = parseGpxData(gpxTrack(points));
      const last = route.points[route.points.length - 1];
      expect(bearingGap(last.bearing, 90)).toBeLessThan(0.1);
    });
  });

  describe('recording gaps and the drawn line', () => {
    // 200 points 11.1 m apart heading north (2.21 km), a 5.5 km jump (a ferry), then 200 more
    const withFerry = () => {
      const points = [];
      for (let i = 0; i < 200; i++) points.push({ lat: 38.6 + i * 0.0001, lng: -9.2, ele: 10 });
      for (let i = 0; i < 200; i++) points.push({ lat: 38.67 + i * 0.0001, lng: -9.2, ele: 10 });
      return parseGpxData(gpxTrack(points));
    };

    it('does not count a jump far longer than the usual point spacing as ridden distance', () => {
      const route = withFerry();
      // two stretches of 199 steps of 0.0001 degrees: 2 * 199 * 0.0111195 km = 4.4256 km
      expect(route.totalDistance).toBeCloseTo(4.4256, 2);
      const gaps = route.points.filter((p) => p.gap);
      expect(gaps).toHaveLength(1);
      expect(gaps[0].lat).toBeCloseTo(38.67, 6);
      // the point before the jump is kept too, and distance does not move across it
      const at = route.points.indexOf(gaps[0]);
      expect(route.points[at - 1].lat).toBeCloseTo(38.6199, 6);
      expect(gaps[0].distance).toBe(route.points[at - 1].distance);
    });

    it('splits the drawn line at the jump and measures it with the jump included', () => {
      const route = withFerry();
      expect(route.parts).toHaveLength(2);
      expect(route.parts[0][0]).toEqual([-9.2, 38.6]);
      expect(route.parts[1][0][1]).toBeCloseTo(38.67, 6);
      // 38.6 to 38.6899 in a straight line: 0.0899 degrees = 9.996 km
      expect(route.pathLength).toBeCloseTo(9.996, 2);
      expect(route.points[route.points.length - 1].pathKm).toBeCloseTo(route.pathLength, 9);
      for (let i = 1; i < route.points.length; i++) {
        expect(route.points[i].pathKm).toBeGreaterThanOrEqual(route.points[i - 1].pathKm);
      }
    });

    // 40 points heading north 33 m apart at `eleBefore(i)`, a 13 km jump to the north-east
    // (9.8 km north, 8.7 km east), then 40 points heading east 35 m apart at `eleAfter(i)`
    const withTurn = (eleBefore, eleAfter) => parseGpxData(gpxTrack([
      ...Array.from({ length: 40 }, (_, i) => ({ lat: 38.6 + i * 0.0003, lng: -9.2, ele: eleBefore(i) })),
      ...Array.from({ length: 40 }, (_, i) => ({ lat: 38.7, lng: -9.1 + i * 0.0004, ele: eleAfter(i) })),
    ]));

    it('takes headings from the same side of the jump', () => {
      const route = withTurn(() => 10, () => 10);
      // ridden: 39 * 0.0003 * 111.195 = 1.3010 km north plus 39 * 0.0004 * 111.195 * cos(38.7) = 1.3538 km east
      expect(route.totalDistance).toBeCloseTo(2.6548, 3);
      const at = route.points.findIndex((p) => p.gap);
      expect(at).toBe(40);
      // a heading taken across the jump would point north-east, about 41 degrees
      expect(bearingGap(route.points[at - 1].bearing, 0)).toBeLessThan(0.1); // last point before: still north
      expect(bearingGap(route.points[at].bearing, 90)).toBeLessThan(0.1); // first point after: already east
    });

    it('counts the climbing on each side of the jump, not the height difference across it', () => {
      // flat at 10 m before the jump and flat at 300 m after it: nothing was climbed
      expect(withTurn(() => 10, () => 300).totalElevationGain).toBe(0);
      // 1 m up per point on both sides: 39 m + 39 m, and still not the 251 m in between
      expect(withTurn((i) => 10 + i, (i) => 300 + i).totalElevationGain).toBe(78);
    });

    it('needs more than half a kilometre without points before a dense recording counts as interrupted', () => {
      // 100 points 11 m apart, a hole, 100 more: 198 steps of 0.0001 degrees = 2.2017 km without the hole
      const withHole = (holeKm) => parseGpxData(gpxTrack([
        ...Array.from({ length: 100 }, (_, i) => ({ lat: 38.6 + i * 0.0001, lng: -9.2 })),
        ...Array.from({ length: 100 }, (_, i) => ({ lat: 38.6099 + holeKm / KM_PER_DEGREE + i * 0.0001, lng: -9.2 })),
      ]));
      // 300 m without a fix (trees, an underpass) was still ridden
      const short = withHole(0.3);
      expect(short.points.some((p) => p.gap)).toBe(false);
      expect(short.totalDistance).toBeCloseTo(2.2017 + 0.3, 3);
      // 2 km was not
      const long = withHole(2);
      expect(long.points.filter((p) => p.gap)).toHaveLength(1);
      expect(long.totalDistance).toBeCloseTo(2.2017, 3);
    });

    it('keeps both sides of the jump when the track is thinned', () => {
      // 701 points 11 m apart, a jump of 23 km, 700 more: 1401 points, so only every third is kept.
      // The last point before the jump is number 700, which thinning alone would skip (it keeps 0, 3, .. 699).
      const first = Array.from({ length: 701 }, (_, i) => ({ lat: 38.5 + i * 0.0001, lng: -9.2 }));
      const second = Array.from({ length: 700 }, (_, i) => ({ lat: 38.7 + i * 0.0001, lng: -9 }));
      const route = parseGpxData(gpxTrack([...first, ...second]));
      expect(route.points.length).toBeLessThan(700);
      const at = route.points.findIndex((p) => p.gap);
      expect(route.points[at - 1].lat).toBe(first[700].lat);
      expect(route.points[at].lat).toBe(38.7);
      expect(route.points[at].lng).toBe(-9);
      // 700 + 699 steps of 0.0001 degrees
      expect(route.totalDistance).toBeCloseTo(1399 * 0.0001 * KM_PER_DEGREE, 6);
    });

    it('does not mistake a sparse planned route for a string of gaps', () => {
      // a point every 1.11 km: long steps are this track's normal spacing
      const route = parseGpxData(gpxTrack(northLine(20, 0.01)));
      expect(route.points.some((p) => p.gap)).toBe(false);
      expect(route.parts).toHaveLength(1);
      expect(route.totalDistance).toBeCloseTo(19 * 1.11195, 2);
      expect(route.pathLength).toBeCloseTo(route.totalDistance, 6);
    });

    it('on a sparse route, only a leg far longer than the others is a jump', () => {
      // a point every 1.11 km, with the sixth leg `factor` times as long
      const sparse = (factor) => {
        let lat = 38.3;
        const points = [{ lat, lng: -9.2 }];
        for (let i = 0; i < 10; i++) {
          lat += (i === 5 ? factor : 1) * 0.01;
          points.push({ lat, lng: -9.2 });
        }
        return parseGpxData(gpxTrack(points));
      };
      // three times as long (3.3 km) is just a long straight: 12 * 1.11195 = 13.343 km
      const straight = sparse(3);
      expect(straight.points.some((p) => p.gap)).toBe(false);
      expect(straight.totalDistance).toBeCloseTo(13.343, 2);
      // thirty times as long (33 km) is a jump: the other 9 legs are 10.008 km
      const jump = sparse(30);
      expect(jump.points.filter((p) => p.gap)).toHaveLength(1);
      expect(jump.totalDistance).toBeCloseTo(10.008, 2);
    });

    it('keeps the full detail of the track in the drawn line while thinning the analysis points', SLOW, () => {
      const route = parseGpxData(gpxTrack(northLine(3001, 0.0001)));
      const drawn = route.parts.flat().length;
      expect(route.points.length).toBeLessThanOrEqual(601);
      expect(drawn).toBeGreaterThan(route.points.length);
      expect(drawn).toBeLessThanOrEqual(3001);
    });
  });

  describe('files it must refuse', () => {
    it('throws on text that is not XML', () => {
      expect(() => parseGpxData('this is not a gpx file')).toThrow('not valid GPX');
      expect(() => parseGpxData('')).toThrow('not valid GPX');
    });

    it('throws on broken XML', () => {
      expect(() => parseGpxData('<gpx><trk><trkseg><trkpt lat="38.6" lon="-9.2"></trkseg></trk></gpx>')).toThrow('not valid GPX');
      expect(() => parseGpxData('<gpx><trk>')).toThrow('not valid GPX');
    });

    it('throws on a track with no points', () => {
      const empty = '<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Empty</name><trkseg></trkseg></trk></gpx>';
      expect(() => parseGpxData(empty)).toThrow('No track found');
    });

    it('throws on a file with only waypoints', () => {
      const gpx = '<gpx xmlns="http://www.topografix.com/GPX/1/1"><wpt lat="38.6" lon="-9.2"/><wpt lat="38.7" lon="-9.2"/></gpx>';
      expect(() => parseGpxData(gpx)).toThrow('No track found');
    });

    it('throws on a single point', () => {
      expect(() => parseGpxData(gpxTrack([{ lat: 38.6, lng: -9.2 }]))).toThrow('No track found');
    });

    it('throws on well-formed XML that is not GPX', () => {
      expect(() => parseGpxData('<html><body><p>hello</p></body></html>')).toThrow('No track found');
    });

    it('throws on a track that goes nowhere', () => {
      const still = Array.from({ length: 10 }, () => ({ lat: 38.6, lng: -9.2 }));
      expect(() => parseGpxData(gpxTrack(still))).toThrow('too short');
    });
  });
});

describe('parseGpxData descent', () => {
  it('measures the descent like the climbing: it is the climbing of the way back', () => {
    // 1 m down per point for 100 points, 11 m apart; and the same slope ridden up
    const down = parseGpxData(gpxTrack(northLine(101, 0.0001, (i) => 200 - i)));
    const up = parseGpxData(gpxTrack(northLine(101, 0.0001, (i) => 100 + i)));
    expect(down.totalElevationGain).toBe(0);
    expect(up.totalElevationLoss).toBe(0);
    expect(down.totalElevationLoss).toBe(up.totalElevationGain);
    // the smoothing rounds off the two ends of the slope
    expect(Math.abs(down.totalElevationLoss - 100)).toBeLessThanOrEqual(3);
    // up 60 m, then down 25 m
    const over = parseGpxData(gpxTrack(northLine(86, 0.0001, (i) => (i <= 60 ? 100 + i : 220 - i))));
    expect(Math.abs(over.totalElevationGain - 60)).toBeLessThanOrEqual(3);
    expect(Math.abs(over.totalElevationLoss - 25)).toBeLessThanOrEqual(3);
  });

  it('counts the descent on each side of a jump, not the height difference across it', () => {
    // flat at 300 m, a 13 km jump, flat at 10 m: nothing was descended
    const flat = parseGpxData(gpxTrack([
      ...Array.from({ length: 40 }, (_, i) => ({ lat: 38.6 + i * 0.0003, lng: -9.2, ele: 300 })),
      ...Array.from({ length: 40 }, (_, i) => ({ lat: 38.7, lng: -9.1 + i * 0.0004, ele: 10 })),
    ]));
    expect(flat.totalElevationLoss).toBe(0);
    expect(flat.totalElevationGain).toBe(0);
  });
});

describe('reverseRoute', () => {
  // 40 points north 33 m apart climbing 1 m each, then 40 points east 35 m apart descending 0.5 m each
  const corner = () => parseGpxData(gpxTrack([
    ...Array.from({ length: 40 }, (_, i) => ({ lat: 38.6 + i * 0.0003, lng: -9.2, ele: 10 + i })),
    ...Array.from({ length: 40 }, (_, i) => ({ lat: 38.6117, lng: -9.2 + (i + 1) * 0.0004, ele: 49 - (i + 1) * 0.5 })),
  ]), 'Corner');

  // 200 points 11.1 m apart heading north, a 5.5 km jump (a ferry), then 200 more
  const withFerry = () => {
    const points = [];
    for (let i = 0; i < 200; i++) points.push({ lat: 38.6 + i * 0.0001, lng: -9.2, ele: 10 });
    for (let i = 0; i < 200; i++) points.push({ lat: 38.67 + i * 0.0001, lng: -9.2, ele: 10 });
    return parseGpxData(gpxTrack(points));
  };

  it('starts where the route finished and counts the distance from there', () => {
    const route = corner();
    const back = reverseRoute(route);
    const n = route.points.length;
    expect(back.points).toHaveLength(n);
    expect(back.totalDistance).toBe(route.totalDistance);
    expect(back.points[0].distance).toBe(0);
    expect(back.points[n - 1].distance).toBeCloseTo(route.totalDistance, 9);
    back.points.forEach((p, i) => {
      const was = route.points[n - 1 - i];
      expect([p.lat, p.lng, p.ele]).toEqual([was.lat, was.lng, was.ele]);
      expect(p.distance).toBeCloseTo(route.totalDistance - was.distance, 9);
      if (i > 0) expect(p.distance).toBeGreaterThanOrEqual(back.points[i - 1].distance);
    });
  });

  it('turns every heading round', () => {
    const route = corner();
    const back = reverseRoute(route);
    const n = route.points.length;
    // (a heading and the heading back differ from 180 degrees by a hair, on a sphere)
    back.points.forEach((p, i) => {
      expect(bearingGap(p.bearing, route.points[n - 1 - i].bearing + 180)).toBeLessThan(0.01);
    });
    // it sets off west along what was the last leg, and ends heading south
    expect(bearingGap(back.points[0].bearing, 270)).toBeLessThan(0.1);
    expect(bearingGap(back.points[n - 1].bearing, 180)).toBeLessThan(0.1);
  });

  it('swaps the climbing and the descent', () => {
    // 39 m up along the first leg, 20 m down along the second
    const route = corner();
    expect(Math.abs(route.totalElevationGain - 39)).toBeLessThanOrEqual(3);
    expect(Math.abs(route.totalElevationLoss - 20)).toBeLessThanOrEqual(3);
    const back = reverseRoute(route);
    expect(back.totalElevationGain).toBe(route.totalElevationLoss);
    expect(back.totalElevationLoss).toBe(route.totalElevationGain);
  });

  it('turns the drawn line round as well, so each point keeps its place on it', () => {
    const route = corner();
    const back = reverseRoute(route);
    expect(back.pathLength).toBe(route.pathLength);
    expect(back.parts).toHaveLength(1);
    expect(back.parts[0]).toEqual([...route.parts[0]].reverse());
    expect(back.points[0].pathKm).toBeCloseTo(0, 9);
    expect(back.points[back.points.length - 1].pathKm).toBeCloseTo(route.pathLength, 9);
    for (let i = 1; i < back.points.length; i++) {
      expect(back.points[i].pathKm).toBeGreaterThanOrEqual(back.points[i - 1].pathKm);
    }
  });

  it('moves the mark of a jump to the point that now comes after it', () => {
    const route = withFerry();
    const back = reverseRoute(route);
    const gaps = back.points.filter((p) => p.gap);
    expect(gaps).toHaveLength(1);
    // the other way round the ferry is boarded at 38.67 and left at 38.6199
    const at = back.points.indexOf(gaps[0]);
    expect(gaps[0].lat).toBeCloseTo(38.6199, 6);
    expect(back.points[at - 1].lat).toBeCloseTo(38.67, 6);
    expect(gaps[0].distance).toBeCloseTo(back.points[at - 1].distance, 9);
    expect(back.totalDistance).toBeCloseTo(4.4256, 2);
    // the two stretches are drawn in the new order, each from its new start
    expect(back.parts).toHaveLength(2);
    expect(back.parts[0][0][1]).toBeCloseTo(38.6899, 6);
    expect(back.parts[1][back.parts[1].length - 1]).toEqual([-9.2, 38.6]);
    // and no heading is taken across the water: both stretches run south
    back.points.forEach((p) => expect(bearingGap(p.bearing, 180)).toBeLessThan(0.1));
  });

  it('says which way the route runs, and gives the first direction back when reversed twice', () => {
    const route = corner();
    const back = reverseRoute(route);
    expect(route.reversed).toBeFalsy();
    expect(back.reversed).toBe(true);
    const again = reverseRoute(back);
    expect(again.reversed).toBe(false);
    expect(again.parts).toEqual(route.parts);
    expect(again.totalElevationGain).toBe(route.totalElevationGain);
    again.points.forEach((p, i) => {
      const was = route.points[i];
      expect([p.lat, p.lng, p.ele, p.gap]).toEqual([was.lat, was.lng, was.ele, was.gap]);
      expect(p.distance).toBeCloseTo(was.distance, 9);
      expect(p.pathKm).toBeCloseTo(was.pathKm, 9);
      expect(bearingGap(p.bearing, was.bearing)).toBeLessThan(1e-6);
    });
  });

  it('keeps the name and whatever else the route carries, and leaves the route it was given alone', () => {
    const route = { ...corner(), id: 'corner' };
    const before = JSON.stringify(route);
    const back = reverseRoute(route);
    expect(back.name).toBe('Corner');
    expect(back.id).toBe('corner');
    expect(JSON.stringify(route)).toBe(before);
  });
});

describe('PRESET_ROUTES', () => {
  it('lists each bundled route once, with a .gpx file to load', () => {
    expect(PRESET_ROUTES.length).toBeGreaterThan(0);
    expect(new Set(PRESET_ROUTES.map((r) => r.id)).size).toBe(PRESET_ROUTES.length);
    for (const preset of PRESET_ROUTES) {
      expect(preset.name).toBeTruthy();
      expect(preset.filename).toMatch(/\.gpx$/);
    }
  });
});

describe('positionAt', () => {
  const points = [
    { lat: 38, lng: -9, distance: 0 },
    { lat: 38.1, lng: -9, distance: 10 },
    { lat: 38.1, lng: -8.8, distance: 30 },
  ];

  it('gives the point itself at its own distance', () => {
    expect(positionAt(points, 10)).toMatchObject({ lat: 38.1, lng: -9 });
  });

  it('goes in a straight line between the two points around a distance', () => {
    expect(positionAt(points, 5)).toEqual({ lat: expect.closeTo(38.05, 9), lng: expect.closeTo(-9, 9) });
    expect(positionAt(points, 20)).toEqual({ lat: expect.closeTo(38.1, 9), lng: expect.closeTo(-8.9, 9) });
  });

  it('stays at the ends before the start and past the finish', () => {
    expect(positionAt(points, -3)).toMatchObject({ lat: 38, lng: -9 });
    expect(positionAt(points, 99)).toMatchObject({ lat: 38.1, lng: -8.8 });
  });
});

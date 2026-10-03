import { describe, it, expect } from 'vitest';
import {
  compassPoint,
  beaufortLabel,
  angleDiff,
  windVector,
  windFromVector,
  windComponents,
  classifyWindEffect,
  describeRiderWind,
  wholeDegrees,
} from './wind';

// Convention under test: a wind direction is where the wind comes FROM (0 = north, 90 = east), speeds in km/h.

describe('compassPoint', () => {
  it('names the four cardinal and four intercardinal points', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(45)).toBe('NE');
    expect(compassPoint(90)).toBe('E');
    expect(compassPoint(135)).toBe('SE');
    expect(compassPoint(180)).toBe('S');
    expect(compassPoint(225)).toBe('SW');
    expect(compassPoint(270)).toBe('W');
    expect(compassPoint(315)).toBe('NW');
  });

  it('walks the 16 points clockwise, one every 22.5 degrees', () => {
    const expected = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    expected.forEach((name, i) => {
      expect(compassPoint(i * 22.5)).toBe(name);
    });
  });

  it('switches from N to NNE half a sector (11.25 degrees) past north', () => {
    // each sector is 22.5 wide and centred on its point, so N covers 348.75 .. 11.25
    expect(compassPoint(11.24)).toBe('N'); // 11.24 / 22.5 = 0.4996 -> sector 0
    expect(compassPoint(11.26)).toBe('NNE'); // 11.26 / 22.5 = 0.5004 -> sector 1
  });

  it('switches from NNW to N half a sector before north', () => {
    expect(compassPoint(348.74)).toBe('NNW'); // 348.74 / 22.5 = 15.4996 -> sector 15
    expect(compassPoint(348.75)).toBe('N'); // exactly 15.5 sectors: a boundary goes to the clockwise sector
    expect(compassPoint(348.76)).toBe('N');
    expect(compassPoint(359.9)).toBe('N'); // 15.996 -> sector 16, which wraps back to 0
  });

  it('gives each boundary to the clockwise sector, on both sides of north', () => {
    expect(compassPoint(11.25)).toBe('NNE'); // exactly 0.5 sectors -> 1
    expect(compassPoint(33.75)).toBe('NE'); // exactly 1.5 sectors -> 2
  });

  it('wraps a full turn and negative bearings', () => {
    expect(compassPoint(360)).toBe('N');
    expect(compassPoint(-10)).toBe('N'); // -10 is 350, inside 348.75 .. 11.25
    expect(compassPoint(-90)).toBe('W'); // -90 is 270
    expect(compassPoint(450)).toBe('E'); // 450 is 90
    expect(compassPoint(-382.5)).toBe('NNW'); // -382.5 is 337.5 = 15 sectors
  });

  it('names the south-south-west point', () => {
    expect(compassPoint(202.5)).toBe('SSW'); // 202.5 / 22.5 = 9 -> the 10th point
  });
});

describe('beaufortLabel', () => {
  // Beaufort scale in km/h: 0 <1, 1 1-5, 2 6-11, 3 12-19, 4 20-28, 5 29-38, 6 39-49, 7 50-61, 8 62+
  const steps = [
    [0, 'Calm'],
    [0.99, 'Calm'],
    [1, 'Light air'],
    [5.99, 'Light air'],
    [6, 'Light breeze'],
    [11.99, 'Light breeze'],
    [12, 'Gentle breeze'],
    [19.99, 'Gentle breeze'],
    [20, 'Moderate breeze'],
    [28.99, 'Moderate breeze'],
    [29, 'Fresh breeze'],
    [38.99, 'Fresh breeze'],
    [39, 'Strong breeze'],
    [49.99, 'Strong breeze'],
    [50, 'Near gale'],
    [61.99, 'Near gale'],
    [62, 'Gale'],
    [74.9, 'Gale'],
    [75, 'Strong gale'],
    [88.9, 'Strong gale'],
    [89, 'Storm'],
    [120, 'Storm'],
  ];

  it.each(steps)('%f km/h is "%s"', (kmh, label) => {
    expect(beaufortLabel(kmh)).toBe(label);
  });
});

describe('angleDiff', () => {
  it('is the signed shortest turn from b to a', () => {
    expect(angleDiff(90, 0)).toBe(90);
    expect(angleDiff(0, 90)).toBe(-90);
    expect(angleDiff(30, 30)).toBe(0);
  });

  it('wraps across north instead of going the long way round', () => {
    expect(angleDiff(350, 10)).toBe(-20); // 350 - 10 = 340, the short way is 20 anticlockwise
    expect(angleDiff(10, 350)).toBe(20); // 10 - 350 = -340, the short way is 20 clockwise
    expect(angleDiff(1, 359)).toBe(2);
    expect(angleDiff(359, 1)).toBe(-2);
  });

  it('returns +180, never -180, for opposite directions', () => {
    expect(angleDiff(180, 0)).toBe(180);
    expect(angleDiff(0, 180)).toBe(180);
    expect(angleDiff(270, 90)).toBe(180);
    expect(angleDiff(90, 270)).toBe(180);
  });

  it('stays inside (-180, 180] for inputs outside 0..360', () => {
    expect(angleDiff(720, 0)).toBe(0);
    expect(angleDiff(370, 350)).toBe(20);
    expect(angleDiff(-10, 10)).toBe(-20);
    expect(angleDiff(181, 0)).toBe(-179);
    for (let a = -720; a <= 720; a += 37) {
      for (let b = -720; b <= 720; b += 53) {
        const d = angleDiff(a, b);
        expect(d).toBeGreaterThan(-180);
        expect(d).toBeLessThanOrEqual(180);
      }
    }
  });
});

describe('windVector', () => {
  it('wind FROM the north moves the air south (v < 0, no east-west part)', () => {
    const { u, v } = windVector(10, 0);
    expect(u).toBeCloseTo(0, 10);
    expect(v).toBeCloseTo(-10, 10);
  });

  it('wind FROM the east moves the air west (u < 0)', () => {
    const { u, v } = windVector(10, 90);
    expect(u).toBeCloseTo(-10, 10);
    expect(v).toBeCloseTo(0, 10);
  });

  it('wind FROM the south moves the air north (v > 0)', () => {
    const { u, v } = windVector(10, 180);
    expect(u).toBeCloseTo(0, 10);
    expect(v).toBeCloseTo(10, 10);
  });

  it('wind FROM the west moves the air east (u > 0)', () => {
    const { u, v } = windVector(10, 270);
    expect(u).toBeCloseTo(10, 10);
    expect(v).toBeCloseTo(0, 10);
  });

  it('splits a north-easterly evenly: 10 km/h from 45 is 7.071 west and 7.071 south', () => {
    // 10 * sin(45) = 10 * cos(45) = 10 / sqrt(2) = 7.0711
    const { u, v } = windVector(10, 45);
    expect(u).toBeCloseTo(-7.0711, 4);
    expect(v).toBeCloseTo(-7.0711, 4);
  });

  it('keeps the speed as the length of the vector', () => {
    for (let dir = 0; dir < 360; dir += 17) {
      const { u, v } = windVector(23.5, dir);
      expect(Math.hypot(u, v)).toBeCloseTo(23.5, 10);
    }
  });

  it('is the zero vector for calm air', () => {
    const { u, v } = windVector(0, 123);
    expect(Math.abs(u)).toBe(0);
    expect(Math.abs(v)).toBe(0);
  });
});

describe('windFromVector', () => {
  it('reads the direction the air comes from', () => {
    expect(windFromVector(0, -10)).toBeCloseTo(0, 10); // air moving south comes from the north
    expect(windFromVector(-10, 0)).toBeCloseTo(90, 10); // air moving west comes from the east
    expect(windFromVector(0, 10)).toBeCloseTo(180, 10); // air moving north comes from the south
    expect(windFromVector(10, 0)).toBeCloseTo(270, 10); // air moving east comes from the west
    expect(windFromVector(-5, -5)).toBeCloseTo(45, 10); // moving south-west comes from the north-east
    expect(windFromVector(5, 5)).toBeCloseTo(225, 10);
  });

  it('does not depend on the speed', () => {
    expect(windFromVector(-1, 0)).toBeCloseTo(windFromVector(-80, 0), 10);
    expect(windFromVector(3, -4)).toBeCloseTo(windFromVector(30, -40), 10);
  });

  it('always answers inside [0, 360), also for a zero vector', () => {
    for (const [u, v] of [[0, 0], [-0, -0], [1e-9, -1], [-1e-9, -1], [7, 3], [-7, 3]]) {
      const from = windFromVector(u, v);
      expect(Number.isFinite(from)).toBe(true);
      expect(from).toBeGreaterThanOrEqual(0);
      expect(from).toBeLessThan(360);
    }
  });

  it('round-trips with windVector for every direction', () => {
    for (let dir = 0; dir < 360; dir += 7.5) {
      const { u, v } = windVector(12, dir);
      // compared through angleDiff so 359.999999 and 0 count as the same direction
      expect(Math.abs(angleDiff(windFromVector(u, v), dir))).toBeLessThan(1e-9);
    }
  });

  it('round-trips the other way: vector -> direction and speed -> vector', () => {
    const cases = [[3, 4], [-3, 4], [3, -4], [-3, -4], [0, 9], [9, 0]];
    for (const [u, v] of cases) {
      const back = windVector(Math.hypot(u, v), windFromVector(u, v));
      expect(back.u).toBeCloseTo(u, 9);
      expect(back.v).toBeCloseTo(v, 9);
    }
  });
});

describe('windComponents', () => {
  it('riding north into a north wind is a pure headwind', () => {
    const { head, cross } = windComponents(0, 0, 20);
    expect(head).toBeCloseTo(20, 10);
    expect(cross).toBeCloseTo(0, 10);
  });

  it('riding north with a south wind is a pure tailwind (negative head)', () => {
    const { head, cross } = windComponents(0, 180, 20);
    expect(head).toBeCloseTo(-20, 10);
    expect(cross).toBeCloseTo(0, 10);
  });

  it('riding north with an east wind is hit from the right (cross > 0)', () => {
    const { head, cross } = windComponents(0, 90, 20);
    expect(head).toBeCloseTo(0, 10);
    expect(cross).toBeCloseTo(20, 10);
  });

  it('riding north with a west wind is hit from the left (cross < 0)', () => {
    const { head, cross } = windComponents(0, 270, 20);
    expect(head).toBeCloseTo(0, 10);
    expect(cross).toBeCloseTo(-20, 10);
  });

  it('follows the rider: heading east, a north wind comes from the left', () => {
    // facing east, north is on the left hand
    const { head, cross } = windComponents(90, 0, 20);
    expect(head).toBeCloseTo(0, 10);
    expect(cross).toBeCloseTo(-20, 10);
  });

  it('follows the rider: heading west, a north wind comes from the right', () => {
    const { head, cross } = windComponents(270, 0, 20);
    expect(head).toBeCloseTo(0, 10);
    expect(cross).toBeCloseTo(20, 10);
  });

  it('splits a quartering wind: 20 km/h from 45 degrees off the nose', () => {
    // 20 * cos(45) = 20 * sin(45) = 14.1421
    const { head, cross } = windComponents(0, 45, 20);
    expect(head).toBeCloseTo(14.1421, 4);
    expect(cross).toBeCloseTo(14.1421, 4);
  });

  it('splits a wind from behind and to the left: 20 km/h, 120 degrees off the nose to the left', () => {
    // heading 90, wind from 330: relative angle -120. 20 * cos(-120) = -10, 20 * sin(-120) = -17.3205
    const { head, cross } = windComponents(90, 330, 20);
    expect(head).toBeCloseTo(-10, 4);
    expect(cross).toBeCloseTo(-17.3205, 4);
  });

  it('works across north: heading 350 with wind from 10 is 20 degrees off the nose to the right', () => {
    // 10 * cos(20) = 9.3969, 10 * sin(20) = 3.4202
    const { head, cross } = windComponents(350, 10, 10);
    expect(head).toBeCloseTo(9.3969, 4);
    expect(cross).toBeCloseTo(3.4202, 4);
    // and mirrored: heading 10 with wind from 350 comes from the left
    const mirrored = windComponents(10, 350, 10);
    expect(mirrored.head).toBeCloseTo(9.3969, 4);
    expect(mirrored.cross).toBeCloseTo(-3.4202, 4);
  });

  it('never invents or loses wind: head and cross always add up to the speed', () => {
    for (let bearing = 0; bearing < 360; bearing += 35) {
      for (let from = 0; from < 360; from += 25) {
        const { head, cross } = windComponents(bearing, from, 18);
        expect(Math.hypot(head, cross)).toBeCloseTo(18, 10);
      }
    }
  });

  it('is zero in calm air', () => {
    const { head, cross } = windComponents(123, 45, 0);
    expect(Math.abs(head)).toBe(0);
    expect(Math.abs(cross)).toBe(0);
  });
});

describe('classifyWindEffect', () => {
  // The rule: 5 km/h or more along the road is a head or tailwind. Everything else, wind from the side
  // or too light to matter, is 'crosswind'.
  it('names the obvious cases for a rider heading north in a 20 km/h wind', () => {
    expect(classifyWindEffect(0, 0, 20)).toBe('headwind');
    expect(classifyWindEffect(0, 180, 20)).toBe('tailwind');
    expect(classifyWindEffect(0, 90, 20)).toBe('crosswind');
    expect(classifyWindEffect(0, 270, 20)).toBe('crosswind');
  });

  it('goes by the part of the wind along the road, not by the angle alone', () => {
    // 20 km/h from 60 degrees off the nose: 20 * cos 60 = 10 km/h against
    expect(classifyWindEffect(0, 60, 20)).toBe('headwind');
    expect(classifyWindEffect(0, 300, 20)).toBe('headwind'); // the same on the left
    // 20 km/h from 80 degrees off: 20 * cos 80 = 3.5 km/h against, which is not noticeable
    expect(classifyWindEffect(0, 80, 20)).toBe('crosswind');
    // 20 km/h from 120 degrees off: 20 * cos 120 = -10, pushing
    expect(classifyWindEffect(0, 120, 20)).toBe('tailwind');
    expect(classifyWindEffect(0, 240, 20)).toBe('tailwind');
    // a gale almost exactly across still has little along the road: 60 * cos 86 = 4.2
    expect(classifyWindEffect(0, 86, 60)).toBe('crosswind');
  });

  it('needs 5 km/h along the road', () => {
    expect(classifyWindEffect(0, 0, 5)).toBe('headwind');
    expect(classifyWindEffect(0, 0, 4.99)).toBe('crosswind');
    expect(classifyWindEffect(0, 180, 5)).toBe('tailwind');
    expect(classifyWindEffect(0, 180, 4.99)).toBe('crosswind');
  });

  it('never calls still air a head or tailwind, whichever way the rider is heading', () => {
    for (let bearing = 0; bearing < 360; bearing += 45) {
      // a zero wind vector reports "from 180", which must not turn into a tailwind for a northbound rider
      expect(classifyWindEffect(bearing, 180, 0)).toBe('crosswind');
      expect(classifyWindEffect(bearing, 0, 0.5)).toBe('crosswind');
    }
  });

  it('measures the angle across the 0/360 seam', () => {
    expect(classifyWindEffect(350, 10, 20)).toBe('headwind'); // 20 degrees apart, not 340: 20 * cos 20 = 18.8
    expect(classifyWindEffect(10, 350, 20)).toBe('headwind');
    expect(classifyWindEffect(350, 80, 20)).toBe('crosswind'); // 90 apart
    expect(classifyWindEffect(10, 190, 20)).toBe('tailwind'); // 180 apart
    expect(classifyWindEffect(350, 170, 20)).toBe('tailwind');
  });

  it('agrees with the head component for every heading and direction', () => {
    for (let bearing = 0; bearing < 360; bearing += 30) {
      for (let from = 0; from < 360; from += 10) {
        const effect = classifyWindEffect(bearing, from, 10);
        const { head } = windComponents(bearing, from, 10);
        if (effect === 'headwind') expect(head).toBeGreaterThanOrEqual(5);
        if (effect === 'tailwind') expect(head).toBeLessThanOrEqual(-5);
        if (effect === 'crosswind') expect(Math.abs(head)).toBeLessThan(5);
      }
    }
  });
});

describe('describeRiderWind', () => {
  it('leads with the head or tailwind when that is the larger part', () => {
    expect(describeRiderWind(12, 1)).toBe('Headwind, 12 km/h against you');
    expect(describeRiderWind(-8, 0)).toBe('Tailwind, 8 km/h pushing you');
    expect(describeRiderWind(12, 7)).toBe('Headwind, 12 km/h against you, with 7 km/h from the right');
    expect(describeRiderWind(-12, -7)).toBe('Tailwind, 12 km/h pushing you, with 7 km/h from the left');
  });

  it('leads with the crosswind when the wind is mostly from the side', () => {
    // 20 km/h from 80 degrees off the nose: 3.5 along, 19.7 across
    expect(describeRiderWind(3.5, 19.7)).toBe('Crosswind, 20 km/h from the right');
    expect(describeRiderWind(9, -14)).toBe('Crosswind, 14 km/h from the left, with 9 km/h against you');
    expect(describeRiderWind(-9, 14)).toBe('Crosswind, 14 km/h from the right, with 9 km/h pushing you');
  });

  it('says so when there is hardly any wind', () => {
    expect(describeRiderWind(2, 3)).toBe('Hardly any wind here');
    expect(describeRiderWind(0, 0)).toBe('Hardly any wind here');
    expect(describeRiderWind(-4.9, 4.9)).toBe('Hardly any wind here');
  });
});

describe('wholeDegrees', () => {
  it('rounds to whole degrees and never prints 360', () => {
    expect(wholeDegrees(74.4)).toBe(74);
    expect(wholeDegrees(74.5)).toBe(75);
    expect(wholeDegrees(359.6)).toBe(0);
    expect(wholeDegrees(360)).toBe(0);
    expect(wholeDegrees(0.4)).toBe(0);
    expect(wholeDegrees(-10)).toBe(350);
  });
});

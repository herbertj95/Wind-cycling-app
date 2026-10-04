import { describe, it, expect } from 'vitest';
import {
  BASE_STEP,
  MAX_LEVEL,
  stepOf,
  wrapLng,
  nodeKey,
  nodePosition,
  cellAt,
  nodesAround,
  nodesInBounds,
  levelForBounds,
  nodesAlong,
  inBounds,
} from './lattice';

const keyOf = (node) => nodeKey(node.level, node.row, node.col);
const positionOf = (node) => nodePosition(node.level, node.row, node.col);

// greater Lisbon, the area the app covered before it went worldwide: 38.375..39 north, -9.5..-8.875 east
const LISBON = { south: 38.375, north: 39, west: -9.5, east: -8.875 };

describe('stepOf', () => {
  it('starts at 0.125 degrees and doubles with every level', () => {
    expect(BASE_STEP).toBe(0.125);
    expect(stepOf(0)).toBe(0.125);
    expect(stepOf(1)).toBe(0.25);
    expect(stepOf(3)).toBe(1);
    expect(stepOf(MAX_LEVEL)).toBe(0.125 * 2 ** MAX_LEVEL);
  });

  it('divides the circle into a whole number of columns at every level', () => {
    for (let level = 0; level <= MAX_LEVEL; level++) {
      expect(Number.isInteger(360 / stepOf(level))).toBe(true);
    }
  });
});

describe('wrapLng', () => {
  it('leaves longitudes inside the range alone', () => {
    expect(wrapLng(0)).toBe(0);
    expect(wrapLng(-9.14)).toBeCloseTo(-9.14, 12);
    expect(wrapLng(139.69)).toBeCloseTo(139.69, 12);
    expect(wrapLng(-180)).toBe(-180);
  });

  it('brings longitudes past the date line back round', () => {
    expect(wrapLng(180)).toBe(-180);
    expect(wrapLng(190)).toBe(-170);
    expect(wrapLng(-190)).toBe(170);
    expect(wrapLng(540)).toBe(-180);
    expect(wrapLng(361)).toBeCloseTo(1, 12);
    expect(wrapLng(-721)).toBeCloseTo(-1, 12);
  });
});

describe('nodeKey', () => {
  it('gives every point of a block its own key, at every level', () => {
    const keys = new Set();
    let count = 0;
    for (let level = 0; level <= MAX_LEVEL; level++) {
      for (let row = -12; row <= 12; row++) {
        for (let col = -12; col <= 12; col++) {
          keys.add(nodeKey(level, row, col));
          count++;
        }
      }
    }
    expect(keys.size).toBe(count);
  });

  it('is the same for a column and that column a whole turn of the globe away', () => {
    expect(nodeKey(0, 310, -74)).toBe(nodeKey(0, 310, -74 + 2880));
    expect(nodeKey(0, 310, -74)).toBe(nodeKey(0, 310, -74 - 2880));
    expect(nodeKey(MAX_LEVEL, 3, 0)).toBe(nodeKey(MAX_LEVEL, 3, 360 / stepOf(MAX_LEVEL)));
    // 180 east and 180 west are one meridian
    expect(nodeKey(0, 0, 1440)).toBe(nodeKey(0, 0, -1440));
  });

  it('tells rows apart in both hemispheres up to the poles', () => {
    const rows = [-720, -1, 0, 1, 720];
    expect(new Set(rows.map((row) => nodeKey(0, row, 5))).size).toBe(rows.length);
  });

  it('is a safe integer', () => {
    expect(Number.isSafeInteger(nodeKey(MAX_LEVEL, 720, 2879))).toBe(true);
    expect(Number.isSafeInteger(nodeKey(0, -720, -2879))).toBe(true);
  });
});

describe('nodePosition', () => {
  it('counts rows from the equator and columns from Greenwich', () => {
    expect(nodePosition(0, 0, 0)).toEqual({ lat: 0, lng: 0 });
    expect(nodePosition(0, 307, -76)).toEqual({ lat: 38.375, lng: -9.5 });
    expect(nodePosition(1, 155, -37)).toEqual({ lat: 38.75, lng: -9.25 });
    expect(nodePosition(3, -34, 151)).toEqual({ lat: -34, lng: 151 });
  });

  it('wraps the longitude of a column past the date line', () => {
    expect(nodePosition(0, 0, 1440)).toEqual({ lat: 0, lng: -180 });
    expect(nodePosition(0, 0, 1441)).toEqual({ lat: 0, lng: -179.875 });
    expect(nodePosition(0, 0, -1441)).toEqual({ lat: 0, lng: 179.875 });
  });
});

describe('cellAt', () => {
  it('finds the cell around central Lisbon and how far into it the position is', () => {
    const cell = cellAt(0, 38.73, -9.14);
    expect(cell.row).toBe(309); // 38.625
    expect(cell.col).toBe(-74); // -9.25
    expect(cell.ty).toBeCloseTo((38.73 - 38.625) / 0.125, 9);
    expect(cell.tx).toBeCloseTo((-9.14 + 9.25) / 0.125, 9);
  });

  it('puts a position that is exactly on a lattice point at the start of its cell', () => {
    expect(cellAt(0, 38.375, -9.5)).toEqual({ row: 307, col: -76, ty: 0, tx: 0 });
  });

  it('works south of the equator and east of Greenwich', () => {
    const cell = cellAt(2, -33.9, 151.2);
    expect(cell.row).toBe(-68); // -34
    expect(cell.col).toBe(302); // 151
    expect(cell.ty).toBeCloseTo(0.2, 9);
    expect(cell.tx).toBeCloseTo(0.4, 9);
  });

  it('keeps the fractions between 0 and 1', () => {
    for (const [lat, lng] of [[38.73, -9.14], [-0.01, -0.01], [84.9, 179.99], [-84.9, -179.99], [0, 0]]) {
      for (let level = 0; level <= MAX_LEVEL; level++) {
        const { tx, ty } = cellAt(level, lat, lng);
        expect(tx).toBeGreaterThanOrEqual(0);
        expect(tx).toBeLessThan(1);
        expect(ty).toBeGreaterThanOrEqual(0);
        expect(ty).toBeLessThan(1);
      }
    }
  });
});

describe('nodesAround', () => {
  it('returns the four corners of the cell, which enclose the position', () => {
    const nodes = nodesAround(0, 38.73, -9.14);
    expect(nodes).toHaveLength(4);
    expect(new Set(nodes.map(keyOf)).size).toBe(4);
    const lats = nodes.map((n) => positionOf(n).lat);
    const lngs = nodes.map((n) => positionOf(n).lng);
    expect(Math.min(...lats)).toBe(38.625);
    expect(Math.max(...lats)).toBe(38.75);
    expect(Math.min(...lngs)).toBe(-9.25);
    expect(Math.max(...lngs)).toBe(-9.125);
  });

  it('reaches across the date line', () => {
    const lngs = nodesAround(0, 10, 179.95).map((n) => positionOf(n).lng);
    expect(lngs).toContain(179.875);
    expect(lngs).toContain(-180);
  });
});

describe('nodesInBounds', () => {
  it('is the 6 x 6 block over greater Lisbon at the finest level', () => {
    const nodes = nodesInBounds(0, LISBON);
    expect(nodes).toHaveLength(36);
    expect(positionOf(nodes[0])).toEqual({ lat: 38.375, lng: -9.5 });
    expect(positionOf(nodes[35])).toEqual({ lat: 39, lng: -8.875 });
  });

  it('includes the points just outside a view that does not sit on the lattice, so the edges can be read too', () => {
    const nodes = nodesInBounds(0, { south: 38.4, north: 38.6, west: -9.3, east: -9.2 });
    const lats = nodes.map((n) => positionOf(n).lat);
    const lngs = nodes.map((n) => positionOf(n).lng);
    expect(Math.min(...lats)).toBe(38.375);
    expect(Math.max(...lats)).toBe(38.625);
    expect(Math.min(...lngs)).toBe(-9.375);
    expect(Math.max(...lngs)).toBe(-9.125);
    expect(nodes).toHaveLength(3 * 3);
  });

  it('covers every position inside the bounds: the four points around it are all there', () => {
    const bounds = { south: 41.9, north: 42.31, west: 2.61, east: 3.07 };
    for (let level = 0; level <= 2; level++) {
      const keys = new Set(nodesInBounds(level, bounds).map(keyOf));
      for (const [lat, lng] of [[41.9, 2.61], [42.31, 3.07], [42.1, 2.8], [41.9, 3.07], [42.3099, 2.6101]]) {
        for (const node of nodesAround(level, lat, lng)) {
          // a position on the last row or column needs no point beyond it
          const { lat: nodeLat, lng: nodeLng } = positionOf(node);
          if (nodeLat - stepOf(level) >= bounds.north || nodeLng - stepOf(level) >= bounds.east) continue;
          expect(keys.has(keyOf(node)), `level ${level}, ${lat}, ${lng}`).toBe(true);
        }
      }
    }
  });

  it('gets fewer points as the level gets coarser', () => {
    const bounds = { south: 36, north: 44, west: -10, east: 4 };
    let previous = Infinity;
    for (let level = 0; level <= MAX_LEVEL; level++) {
      const count = nodesInBounds(level, bounds).length;
      expect(count).toBeLessThan(previous);
      previous = count;
    }
  });

  it('runs across the date line without repeating a point', () => {
    const nodes = nodesInBounds(MAX_LEVEL, { south: -2, north: 2, west: 178, east: 182 });
    const lngs = [...new Set(nodes.map((n) => positionOf(n).lng))].sort((a, b) => a - b);
    expect(lngs).toEqual([-180, -176, 176]);
    expect(new Set(nodes.map(keyOf)).size).toBe(nodes.length);
  });

  it('takes every column once for a view wider than the world', () => {
    const nodes = nodesInBounds(MAX_LEVEL, { south: -1, north: 1, west: -300, east: 300 });
    const keys = new Set(nodes.map(keyOf));
    expect(keys.size).toBe(nodes.length);
    const columns = 360 / stepOf(MAX_LEVEL);
    expect(new Set(nodes.map((n) => positionOf(n).lng)).size).toBe(columns);
  });

  it('never asks for a latitude beyond the poles', () => {
    for (let level = 0; level <= MAX_LEVEL; level++) {
      for (const node of nodesInBounds(level, { south: -120, north: 120, west: 0, east: 1 })) {
        expect(Math.abs(positionOf(node).lat)).toBeLessThanOrEqual(90);
      }
    }
  });
});

describe('levelForBounds', () => {
  it('uses the finest level when the view fits in the allowance', () => {
    expect(levelForBounds(LISBON, 36)).toBe(0);
    expect(levelForBounds(LISBON, 120)).toBe(0);
  });

  it('goes one level coarser as soon as the finest one needs too many points', () => {
    expect(levelForBounds(LISBON, 35)).toBe(1);
  });

  it('keeps the number of points within the allowance', () => {
    const views = [
      { south: 38.2, north: 39.1, west: -10, east: -8.3 },
      { south: 36, north: 44, west: -10, east: 4 },
      { south: 30, north: 60, west: -20, east: 30 },
      { south: -40, north: -10, west: 110, east: 155 },
    ];
    for (const bounds of views) {
      const level = levelForBounds(bounds, 120);
      if (level < MAX_LEVEL) expect(nodesInBounds(level, bounds).length).toBeLessThanOrEqual(120);
      // and it is the finest level that does: one finer would be too many
      if (level > 0) expect(nodesInBounds(level - 1, bounds).length).toBeGreaterThan(120);
    }
  });

  it('settles for the coarsest level when even that is over the allowance', () => {
    expect(levelForBounds({ south: -85, north: 85, west: -180, east: 180 }, 120)).toBe(MAX_LEVEL);
  });
});

describe('nodesAlong', () => {
  // points every 0.01 degrees along a parallel
  const line = (lat, fromLng, toLng) => {
    const points = [];
    for (let lng = fromLng; lng <= toLng + 1e-9; lng += 0.01) points.push({ lat, lng });
    return points;
  };

  it('returns nothing for a route without points', () => {
    expect(nodesAlong([], 64)).toEqual([]);
  });

  it('takes the finest level for a route of ordinary length, and only the cells it passes through', () => {
    const route = line(38.7, -9.45, -9.0); // about 39 km along the coast
    const nodes = nodesAlong(route, 64);
    expect(nodes.every((n) => n.level === 0)).toBe(true);
    // two rows of points (38.625 and 38.75) over five cells: far fewer than the 36 of its bounding block would be
    expect(nodes).toHaveLength(2 * 5);
    expect(new Set(nodes.map(keyOf)).size).toBe(nodes.length);
  });

  it('has the four points around every point of the route', () => {
    const route = [...line(38.7, -9.45, -9.0), ...line(38.93, -9.3, -9.1), { lat: 38.4, lng: -8.9 }];
    const nodes = nodesAlong(route, 64);
    const keys = new Set(nodes.map(keyOf));
    const level = nodes[0].level;
    for (const point of route) {
      for (const node of nodesAround(level, point.lat, point.lng)) expect(keys.has(keyOf(node))).toBe(true);
    }
  });

  it('goes coarser for a very long route rather than over the allowance', () => {
    const route = line(42, -8, 3); // across the north of Spain: 11 degrees
    const nodes = nodesAlong(route, 64);
    expect(nodes.length).toBeLessThanOrEqual(64);
    expect(nodes[0].level).toBeGreaterThan(0);
    expect(nodes.every((n) => n.level === nodes[0].level)).toBe(true);
    // one level finer would not have fitted
    const keys = new Set();
    route.forEach((p) => nodesAround(nodes[0].level - 1, p.lat, p.lng).forEach((n) => keys.add(keyOf(n))));
    expect(keys.size).toBeGreaterThan(64);
  });
});

describe('inBounds', () => {
  it('is true inside and on the edges, false outside', () => {
    expect(inBounds(LISBON, 38.73, -9.14)).toBe(true);
    expect(inBounds(LISBON, 38.375, -9.5)).toBe(true);
    expect(inBounds(LISBON, 39, -8.875)).toBe(true);
    expect(inBounds(LISBON, 39.01, -9.14)).toBe(false);
    expect(inBounds(LISBON, 38.3, -9.14)).toBe(false);
    expect(inBounds(LISBON, 38.73, -9.6)).toBe(false);
    expect(inBounds(LISBON, 38.73, -8.8)).toBe(false);
    expect(inBounds(LISBON, 41.15, -8.61)).toBe(false); // Porto
  });

  it('understands a view that crosses the date line, whose east edge runs past 180', () => {
    const fiji = { south: -25, north: -10, west: 170, east: 190 };
    expect(inBounds(fiji, -18, 178.4)).toBe(true);
    expect(inBounds(fiji, -18, -175)).toBe(true); // the same as 185 east
    expect(inBounds(fiji, -18, 160)).toBe(false);
    expect(inBounds(fiji, -18, -160)).toBe(false);
  });

  it('understands a view the map reports west of -180', () => {
    const view = { south: 50, north: 70, west: -200, east: -170 };
    expect(inBounds(view, 60, 170)).toBe(true); // the same as -190
    expect(inBounds(view, 60, -175)).toBe(true);
    expect(inBounds(view, 60, 150)).toBe(false);
  });

  it('has every longitude inside a view as wide as the world', () => {
    const world = { south: -60, north: 60, west: -250, east: 250 };
    expect(inBounds(world, 0, 0)).toBe(true);
    expect(inBounds(world, 0, 179)).toBe(true);
    expect(inBounds(world, 0, -179)).toBe(true);
    expect(inBounds(world, 70, 0)).toBe(false);
  });
});

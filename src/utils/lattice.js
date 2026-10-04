// The forecast is requested on a fixed lattice over the whole globe, so views that overlap share points
// and a point that was downloaded once is not asked for again while it is fresh.
// Level 0 has a point every 0.125°; each level above doubles the spacing, for when the map is zoomed out.

export const BASE_STEP = 0.125;
export const MAX_LEVEL = 5; // 4° between points
// Beyond this latitude the Mercator map has nothing to show
const MAX_LAT = 85;

/** Degrees between neighbouring lattice points of a level. */
export const stepOf = (level) => BASE_STEP * 2 ** level;

const columnsOf = (level) => Math.round(360 / stepOf(level));

/** Longitude brought into [-180, 180). */
export function wrapLng(lng) {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * One number for a lattice point. `row` counts steps of latitude from the equator, `col` steps of
 * longitude from Greenwich; columns wrap, so col and col + 360° are the same point.
 */
export function nodeKey(level, row, col) {
  const columns = columnsOf(level);
  const wrapped = ((col % columns) + columns) % columns;
  return level * 0x1000000 + (row + 0x800) * 0x1000 + wrapped;
}

/** Where a lattice point is. */
export function nodePosition(level, row, col) {
  const step = stepOf(level);
  return { lat: row * step, lng: wrapLng(col * step) };
}

/** The lattice cell that holds a position: its south-west point and how far into the cell the position is (0 to 1). */
export function cellAt(level, lat, lng) {
  const step = stepOf(level);
  const y = lat / step;
  const x = lng / step;
  const row = Math.floor(y);
  const col = Math.floor(x);
  return { row, col, ty: y - row, tx: x - col };
}

/** The four lattice points around a position. */
export function nodesAround(level, lat, lng) {
  const { row, col } = cellAt(level, lat, lng);
  return [
    { level, row, col },
    { level, row, col: col + 1 },
    { level, row: row + 1, col },
    { level, row: row + 1, col: col + 1 },
  ];
}

function rangeFor(level, bounds) {
  const step = stepOf(level);
  const south = Math.max(-MAX_LAT, Math.min(MAX_LAT, bounds.south));
  const north = Math.max(-MAX_LAT, Math.min(MAX_LAT, bounds.north));
  let { west, east } = bounds;
  // a view wider than the world needs every column once, not twice
  if (east - west >= 360 - step) {
    west = -180;
    east = 180 - step;
  }
  return {
    rowFrom: Math.floor(south / step),
    rowTo: Math.ceil(north / step),
    colFrom: Math.floor(west / step),
    colTo: Math.ceil(east / step),
  };
}

/** Every lattice point needed to read the wind anywhere inside `bounds` ({ south, north, west, east }). */
export function nodesInBounds(level, bounds) {
  const { rowFrom, rowTo, colFrom, colTo } = rangeFor(level, bounds);
  const nodes = [];
  for (let row = rowFrom; row <= rowTo; row++) {
    for (let col = colFrom; col <= colTo; col++) nodes.push({ level, row, col });
  }
  return nodes;
}

/** The finest level whose lattice covers `bounds` with at most `maxNodes` points. */
export function levelForBounds(bounds, maxNodes) {
  for (let level = 0; level < MAX_LEVEL; level++) {
    const { rowFrom, rowTo, colFrom, colTo } = rangeFor(level, bounds);
    if ((rowTo - rowFrom + 1) * (colTo - colFrom + 1) <= maxNodes) return level;
  }
  return MAX_LEVEL;
}

/**
 * Lattice points around a line of positions (a route), at the finest level that needs at most `maxNodes`.
 * Only the cells the line passes through are included, so a long route does not ask for its whole bounding box.
 */
export function nodesAlong(points, maxNodes) {
  for (let level = 0; level <= MAX_LEVEL; level++) {
    const found = new Map();
    for (const point of points) {
      for (const node of nodesAround(level, point.lat, point.lng)) {
        found.set(nodeKey(node.level, node.row, node.col), node);
      }
      if (found.size > maxNodes) break;
    }
    if (found.size <= maxNodes || level === MAX_LEVEL) return [...found.values()];
  }
  return [];
}

/** Whether a position is inside `bounds`, whose longitudes may run past ±180 when the view crosses the date line. */
export function inBounds(bounds, lat, lng) {
  if (lat < bounds.south || lat > bounds.north) return false;
  const width = bounds.east - bounds.west;
  if (width >= 360) return true;
  // how far east of the west edge the position is, 0 to 360
  const eastwards = (((lng - bounds.west) % 360) + 360) % 360;
  return eastwards <= width;
}

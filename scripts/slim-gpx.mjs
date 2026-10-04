#!/usr/bin/env node
// Slims GPX tracks down to what the app uses: the path and its elevation.
// A raw activity export carries a timestamp and sensor readings on every trackpoint. The timestamps are
// personal data and the rest is dead weight, so each file is rewritten in place as a minimal GPX 1.1 track.
//
//   node scripts/slim-gpx.mjs                 every .gpx in public/routes
//   node scripts/slim-gpx.mjs a.gpx b.gpx     only the given files
//   node scripts/slim-gpx.mjs --dry-run       report what would change, write nothing
//
// Running it on its own output changes nothing. A file that is cut short, or whose slim version does not
// read back as written, is reported and left as it was.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTES_DIR = fileURLToPath(new URL('../public/routes/', import.meta.url));

const RAD = Math.PI / 180;
const EARTH_RADIUS_M = 6371000;

// A point is kept if Ramer-Douglas-Peucker needs it to hold the line within this distance of the track...
const RDP_TOLERANCE_M = 3;
// ...or if skipping it would let more than this much travelled distance go by without a point, so a
// long straight road keeps its elevation profile.
const MAX_GAP_M = 40;
const COORD_DECIMALS = 5; // about 1 m
const ELE_DECIMALS = 1;

// ==========================================
// READING
// ==========================================

const NS = '(?:[\\w.-]+:)?'; // optional namespace prefix, as in <gpx:trkpt>

// <trkpt ...>...</trkpt> or self-closing <trkpt .../>
const pointPattern = (tag) => new RegExp(`<${NS}${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${NS}${tag}\\s*>)`, 'g');
const attrPattern = (name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
const LAT = attrPattern('lat');
const LON = attrPattern('lon');
const ELE = new RegExp(`<${NS}ele\\b[^>]*>([^<]*)</${NS}ele\\s*>`);
const NAME = new RegExp(`<${NS}name\\b[^>]*>([\\s\\S]*?)</${NS}name\\s*>`);
const GPX_END = new RegExp(`</${NS}gpx\\s*>\\s*$`);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text) {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(text);
  if (cdata) return cdata[1];
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()];
    const n = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function readAttr(pattern, attrs) {
  const m = pattern.exec(attrs);
  return parseFloat(m?.[1] ?? m?.[2]);
}

function readTag(xml, tag) {
  const points = [];
  let read = 0;
  for (const [, attrs, body = ''] of xml.matchAll(pointPattern(tag))) {
    read++;
    const lat = readAttr(LAT, attrs);
    const lon = readAttr(LON, attrs);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const ele = parseFloat(ELE.exec(body)?.[1]);
    points.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null });
  }
  // The pattern steps over what it cannot match, so a point that is cut short or never closed would
  // vanish without a word. Every opening tag has to have been read as a whole point.
  const opened = xml.match(new RegExp(`<${NS}${tag}\\b`, 'g'))?.length ?? 0;
  if (opened !== read) throw new Error(`damaged file, ${opened - read} of ${opened} <${tag}> elements are incomplete`);
  return points;
}

/**
 * The name of the track itself: the <name> between <trk> and its first segment, not a waypoint's.
 */
function readName(xml, container) {
  const open = new RegExp(`<${NS}${container}\\b[^>]*>`).exec(xml);
  if (!open) return '';
  const rest = xml.slice(open.index + open[0].length);
  const end = rest.search(new RegExp(`<${NS}(?:trkseg|trkpt|rtept)\\b`));
  const name = NAME.exec(end === -1 ? rest : rest.slice(0, end));
  return name ? decodeXml(name[1]).trim() : '';
}

/**
 * Gives every point an elevation the way the app does: a gap repeats the last reading, and points
 * before the first reading take that one. Returns false when the track has no elevation at all.
 */
function fillElevation(points) {
  const first = points.find((p) => p.ele !== null);
  if (!first) return false;
  let last = first.ele;
  for (const p of points) {
    if (p.ele === null) p.ele = last;
    else last = p.ele;
  }
  return true;
}

/**
 * Reads the track out of GPX text: trackpoints in document order, or route points when there are none.
 */
function readGpx(gpxText, fallbackName) {
  const xml = gpxText.replace(/<!--[\s\S]*?-->/g, ''); // a commented-out point is not a point
  let container = 'trk';
  let points = readTag(xml, 'trkpt');
  if (points.length === 0) {
    container = 'rte';
    points = readTag(xml, 'rtept');
  }
  if (points.length < 2) throw new Error('no track found');
  // A file cut off between two points still reads as a shorter track, so insist on the closing root tag
  if (!GPX_END.test(xml)) throw new Error('damaged file, it does not end with </gpx>');
  const hasElevation = fillElevation(points);
  return { name: readName(xml, container) || fallbackName, points, hasElevation };
}

// ==========================================
// GEOMETRY
// ==========================================

/**
 * Spherical distance between two points in metres (Haversine formula)
 */
function distanceM(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Flattens the track to metres east (x) and north (y) of its first point. One scale for the whole
 * track, taken at its mean latitude, is plenty for a tolerance of a few metres.
 */
function project(points) {
  const meanLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const mPerDegLat = EARTH_RADIUS_M * RAD;
  const mPerDegLon = mPerDegLat * Math.cos(meanLat * RAD);
  const x = new Float64Array(points.length);
  const y = new Float64Array(points.length);
  points.forEach((p, i) => {
    x[i] = (p.lon - points[0].lon) * mPerDegLon;
    y[i] = (p.lat - points[0].lat) * mPerDegLat;
  });
  return { x, y };
}

/**
 * Squared distance from point i to the segment a-b
 */
function segmentDistance2({ x, y }, i, a, b) {
  const dx = x[b] - x[a];
  const dy = y[b] - y[a];
  const len2 = dx * dx + dy * dy;
  // A segment of no length (a loop that closes on itself) is just a point
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x[i] - x[a]) * dx + (y[i] - y[a]) * dy) / len2));
  const ex = x[i] - (x[a] + t * dx);
  const ey = y[i] - (y[a] + t * dy);
  return ex * ex + ey * ey;
}

/**
 * Ramer-Douglas-Peucker with an explicit stack instead of recursion. Returns a keep flag per point.
 */
function rdpKeep(xy, toleranceM) {
  const count = xy.x.length;
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;

  const stack = [0, count - 1];
  while (stack.length > 0) {
    const b = stack.pop();
    const a = stack.pop();
    let farthest = -1;
    let farthestD2 = toleranceM * toleranceM;
    for (let i = a + 1; i < b; i++) {
      const d2 = segmentDistance2(xy, i, a, b);
      if (d2 > farthestD2) {
        farthestD2 = d2;
        farthest = i;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push(a, farthest, farthest, b);
    }
  }
  return keep;
}

function simplifyOnce(points) {
  if (points.length < 3) return points;
  const keep = rdpKeep(project(points), RDP_TOLERANCE_M);

  // The highest and lowest point always survive, so the elevation range is exact
  let highest = 0;
  let lowest = 0;
  points.forEach((p, i) => {
    if (p.ele > points[highest].ele) highest = i;
    if (p.ele < points[lowest].ele) lowest = i;
  });
  keep[highest] = 1;
  keep[lowest] = 1;

  // Keep a point when moving on to the next one would put more than MAX_GAP_M of travelled distance
  // behind the last kept point. Keeping the point before the limit rather than the first one past it
  // means no gap in the result is longer than MAX_GAP_M, unless the recording itself jumped.
  let travelled = 0;
  for (let i = 1; i < points.length - 1; i++) {
    travelled += distanceM(points[i - 1], points[i]);
    if (keep[i] || travelled + distanceM(points[i], points[i + 1]) > MAX_GAP_M) {
      keep[i] = 1;
      travelled = 0;
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round = (value, decimals) => Number(value.toFixed(decimals));

/**
 * Thins a track to the points that carry its shape and its elevation profile. Coordinates are rounded
 * to their output precision first and the pass repeats until it removes nothing more (the second pass
 * drops a handful of points at most), which is what makes a run on an already slim file a no-op.
 */
function simplify(points) {
  let current = points.map((p) => ({
    lat: round(p.lat, COORD_DECIMALS),
    lon: round(p.lon, COORD_DECIMALS),
    ele: p.ele === null ? null : round(p.ele, ELE_DECIMALS),
  }));
  for (;;) {
    const next = simplifyOnce(current);
    if (next.length === current.length) return next;
    current = next;
  }
}

// ==========================================
// WRITING
// ==========================================

function toGpx(name, points, hasElevation) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Wind Cycling" xmlns="http://www.topografix.com/GPX/1/1">',
    ' <trk>',
    `  <name>${escapeXml(name)}</name>`,
    '  <trkseg>',
  ];
  for (const p of points) {
    const ele = hasElevation ? `<ele>${p.ele.toFixed(ELE_DECIMALS)}</ele>` : '';
    lines.push(`   <trkpt lat="${p.lat.toFixed(COORD_DECIMALS)}" lon="${p.lon.toFixed(COORD_DECIMALS)}">${ele}</trkpt>`);
  }
  lines.push('  </trkseg>', ' </trk>', '</gpx>', '');
  return lines.join('\n');
}

// ==========================================
// REPORT
// ==========================================

function measure(points, hasElevation) {
  let lengthM = 0;
  let maxEle = -Infinity;
  let minEle = Infinity;
  points.forEach((p, i) => {
    if (i > 0) lengthM += distanceM(points[i - 1], p);
    if (hasElevation) {
      maxEle = Math.max(maxEle, p.ele);
      minEle = Math.min(minEle, p.ele);
    }
  });
  return { count: points.length, lengthKm: lengthM / 1000, maxEle, minEle };
}

// Path relative to the working directory when the file is inside it, the full path otherwise
function label(file) {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

/**
 * The text about to replace a track has to read back as exactly the name and points it was written from
 */
function assertReadsBack(output, name, slim) {
  const back = readGpx(output, name);
  const same =
    back.name === name &&
    back.points.length === slim.length &&
    back.points.every((p, i) => p.lat === slim[i].lat && p.lon === slim[i].lon && p.ele === slim[i].ele);
  if (!same) throw new Error('the slim track does not read back as written');
}

/**
 * Replaces a file in one step, so an interrupted run leaves the old track and never half of the new one
 */
function replaceFile(file, text) {
  const temp = `${file}.tmp`;
  try {
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function slimFile(file, dryRun) {
  const input = fs.readFileSync(file, 'utf8');
  const { name, points, hasElevation } = readGpx(input, path.basename(file, path.extname(file)));
  const slim = simplify(points);
  const output = toGpx(name, slim, hasElevation);

  const changed = output !== input.replace(/\r\n/g, '\n');
  if (changed) assertReadsBack(output, name, slim);
  if (changed && !dryRun) replaceFile(file, output);

  return {
    file: label(file),
    before: { ...measure(points, hasElevation), bytes: Buffer.byteLength(input) },
    after: { ...measure(slim, hasElevation), bytes: Buffer.byteLength(output) },
    hasElevation,
    status: !changed ? 'unchanged' : dryRun ? 'would rewrite' : 'rewritten',
  };
}

const arrow = (before, after) => `${before} -> ${after}`;
const signedPercent = (before, after) => {
  const pct = before === 0 ? 0 : ((after - before) / before) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
};

function printTable(rows) {
  const header = ['File', 'Points', 'Bytes', 'Length km', 'Diff', 'Max ele m', 'Min ele m', ''];
  const table = rows.map(({ file, before, after, hasElevation, status }) => [
    file,
    arrow(before.count, after.count),
    arrow(before.bytes.toLocaleString('en-US'), after.bytes.toLocaleString('en-US')),
    arrow(before.lengthKm.toFixed(3), after.lengthKm.toFixed(3)),
    signedPercent(before.lengthKm, after.lengthKm),
    hasElevation ? arrow(before.maxEle.toFixed(1), after.maxEle.toFixed(1)) : '-',
    hasElevation ? arrow(before.minEle.toFixed(1), after.minEle.toFixed(1)) : '-',
    status,
  ]);
  const widths = header.map((title, col) => Math.max(title.length, ...table.map((row) => row[col].length)));
  const line = (cells) => cells.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd();

  console.log(line(header));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  table.forEach((row) => console.log(line(row)));
}

// ==========================================
// COMMAND LINE
// ==========================================

function main(args) {
  const flags = args.filter((arg) => arg.startsWith('--'));
  const unknown = flags.filter((flag) => flag !== '--dry-run');
  if (unknown.length > 0) {
    console.error(`Unknown option ${unknown[0]}\nUsage: node scripts/slim-gpx.mjs [--dry-run] [file.gpx ...]`);
    process.exitCode = 1;
    return;
  }
  const dryRun = flags.includes('--dry-run');

  let files = args.filter((arg) => !arg.startsWith('--')).map((arg) => path.resolve(arg));
  if (files.length === 0) {
    files = fs.readdirSync(ROUTES_DIR)
      .filter((entry) => entry.toLowerCase().endsWith('.gpx'))
      .sort()
      .map((entry) => path.join(ROUTES_DIR, entry));
  }
  if (files.length === 0) {
    console.error(`No .gpx files in ${ROUTES_DIR}`);
    process.exitCode = 1;
    return;
  }

  const rows = [];
  for (const file of files) {
    try {
      rows.push(slimFile(file, dryRun));
    } catch (err) {
      console.error(`${label(file)}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  if (rows.length > 0) printTable(rows);
}

main(process.argv.slice(2));

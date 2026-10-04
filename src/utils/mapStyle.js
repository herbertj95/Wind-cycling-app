// Basemap: the OpenFreeMap "positron" vector style, recoloured so it stays quiet under the wind layer.
// No API key. To use another provider, change BASE_STYLE_URL (any OpenMapTiles-schema style works).

import { timeoutSignal } from './net';

const BASE_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
// Free elevation tiles (Mapzen Terrarium on AWS Open Data) for the hillshade
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const STYLE_CACHE_KEY = 'wind-basemap-v1';

// Map colours per theme. `flow` is the ink used for the wind itself, as [r, g, b].
// tail / neutral / head colour the route: blue pushes, red slows, grey barely matters.
// label is for towns and villages; landmark (points of reference, road numbers) and roadName sit a step
// behind it, so the names help finding a spot without competing with the wind.
export const MAP_THEMES = {
  dark: {
    sea: '#0a1a27', land: '#172830', wood: '#18312c', urban: '#1e3039', building: '#25373f',
    roadMinor: '#2c3f49', roadMajor: '#3d5563', roadCasing: '#12222a', path: '#2c3f49', rail: '#33454e',
    boundary: '#3a4d58', label: '#a9bcc7', labelWater: '#4d6f88', cycle: '#86a8ba',
    landmark: '#93a9b6', roadName: '#7b93a2',
    hillShadow: 'rgba(0,0,0,0.6)', hillHighlight: 'rgba(160,200,220,0.12)', hillAccent: 'rgba(0,0,0,0.4)',
    flow: [255, 255, 255], halo: '#0a1a27', casing: '#06121b',
    tail: '#3987e5', neutral: '#b4bec6', head: '#e66767',
  },
  light: {
    sea: '#c9dce8', land: '#f1ede4', wood: '#dbe6d2', urban: '#e9e4d9', building: '#ddd6c9',
    roadMinor: '#ffffff', roadMajor: '#ffffff', roadCasing: '#cfc8ba', path: '#d9d2c4', rail: '#c2bbae',
    boundary: '#b9b1a3', label: '#3d4c58', labelWater: '#5f86a0', cycle: '#5c7a8c',
    landmark: '#56666f', roadName: '#78858e',
    hillShadow: 'rgba(70,60,45,0.32)', hillHighlight: 'rgba(255,255,255,0.5)', hillAccent: 'rgba(70,60,45,0.2)',
    flow: [15, 34, 48], halo: '#f1ede4', casing: '#ffffff',
    tail: '#2a78d6', neutral: '#87919a', head: '#e34948',
  },
};

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Head or tailwind above this many km/h gets the full colour
const FULL_COLOR_KMH = 15;

/**
 * Colour for a head/tail component in km/h: positive (headwind) runs to red, negative (tailwind) to blue,
 * and anything close to zero stays grey.
 */
export function effectColor(headKmh, themeName) {
  const theme = MAP_THEMES[themeName];
  const k = Math.max(-1, Math.min(1, headKmh / FULL_COLOR_KMH));
  const strength = Math.pow(Math.abs(k), 0.7);
  const from = hexToRgb(theme.neutral);
  const to = hexToRgb(k > 0 ? theme.head : theme.tail);
  return `rgb(${from.map((c, i) => Math.round(c + (to[i] - c) * strength)).join(',')})`;
}

const TRANSPARENT = 'rgba(0,0,0,0)';

/**
 * Colours along a route as MapLibre line-gradient stops: flat [progress, colour, ...] with progress from 0 to 1.
 * - route: from parseGpxData (each point carries `pathKm`, its place along the drawn line)
 * - heads: head/tail component in km/h for each route point
 * Returns { line, casing }. Stretches that were not ridden (a point marked `gap`) are transparent in both.
 */
export function routeGradient(route, heads, themeName) {
  const casingColor = MAP_THEMES[themeName].casing;
  const { points } = route;
  const total = route.pathLength || 1;
  const line = [];
  const casing = [];
  let last = -1;
  const push = (progress, lineColor, casingStop) => {
    if (progress <= last) return;
    line.push(progress, lineColor);
    casing.push(progress, casingStop);
    last = progress;
  };

  points.forEach((p, i) => {
    const progress = Math.min(1, p.pathKm / total);
    if (p.gap && i > 0) {
      const from = Math.min(1, points[i - 1].pathKm / total);
      const edge = (progress - from) * 0.001;
      push(from + edge, TRANSPARENT, TRANSPARENT);
      push(progress - edge, TRANSPARENT, TRANSPARENT);
    }
    push(progress, effectColor(heads[i], themeName), casingColor);
  });
  if (last < 1) push(1, line[line.length - 1], casingColor);
  return { line, casing };
}

/**
 * Minimal style used until the basemap arrives, or when it cannot be loaded at all:
 * a plain background, so the wind layer still has something to draw on.
 */
export function fallbackStyle(themeName) {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': MAP_THEMES[themeName].land } }],
  };
}

// Left out of the base style: its road shields and airport label come with icons drawn for a light map
// (they are written as plain text further down instead), and one-way arrows are of no use here.
// Country and region names stay: zoomed out, they are what tells one part of the world from another.
const HIDDEN_LAYERS = /shield|oneway|airport|ice|glacier/;
const keepProps = (paint, ...keys) => {
  const out = {};
  keys.forEach((k) => {
    if (paint && paint[k] !== undefined) out[k] = paint[k];
  });
  return out;
};

// Points of reference worth a name on the map: the things a rider steers by or agrees to meet at.
// Shops, cafés, bus stops and the like are left out; there are hundreds of them in every town.
// The ones that stand out come first, at street level; the smaller ones wait for a closer look.
// (Hospitals, stations and viewpoints are picked by subclass further down.)
const MAIN_LANDMARKS = [
  'monument', 'castle', 'ruins', 'fort', 'lighthouse', 'museum', 'stadium', 'zoo', 'theme_park', 'golf',
  'cemetery', 'college', 'campsite', 'harbor', 'ferry_terminal', 'aerialway',
];
const LESSER_LANDMARKS = ['attraction', 'park', 'garden', 'place_of_worship', 'theatre', 'picnic_site', 'bicycle'];
// The tiles rank what they hold by importance within each area: 1 is the first thing to name there.
const LESSER_RANK_AT_15 = 25;
// from this zoom on, the numbers of these classes of road
const ROAD_REF_TIERS = [[10, ['motorway', 'trunk']], [11, ['primary']], [12, ['secondary']], [13, ['tertiary']]];
// a name longer than this is cut, so one museum does not take five lines
const LONGEST_NAME = 40;

const fullName = ['coalesce', ['get', 'name:latin'], ['get', 'name']];
const placeName = ['case', ['>', ['length', fullName], LONGEST_NAME], ['concat', ['slice', fullName, 0, LONGEST_NAME - 2], '…'], fullName];
const classIn = (classes) => ['match', ['get', 'class'], classes, true, false];
// "IC 17;A 36" is one road with two numbers: the first one is enough
const firstRef = ['case', ['>=', ['index-of', ';', ['get', 'ref']], 0], ['slice', ['get', 'ref'], 0, ['index-of', ';', ['get', 'ref']]], ['get', 'ref']];

/**
 * The names added on top of the base style, as plain text marked with a bullet or a triangle (the base
 * style's icons only suit a light map): road numbers, airports, summits with their height, and from
 * street level the landmarks. They go in below the names of towns, which keep the first claim on the room.
 */
function referenceLayers(source, t) {
  const paint = (color) => ({ 'text-color': color, 'text-halo-color': t.land, 'text-halo-width': 1.4 });
  // the mark sits on the spot and the name runs to its right
  const pointLabel = (mark, field) => ({
    'text-field': ['concat', mark, ' ', field],
    'text-font': ['Noto Sans Regular'],
    'text-size': 11,
    'text-anchor': 'left',
    'text-justify': 'left',
    'text-offset': [-0.4, 0],
    'text-max-width': 9,
    'symbol-sort-key': ['coalesce', ['get', 'rank'], 0],
  });
  const withHeight = ['concat', placeName, ['case', ['has', 'ele'], ['concat', '  ', ['to-string', ['get', 'ele']], ' m'], '']];
  const summit = ['all', ['has', 'name'], classIn(['peak', 'volcano', 'saddle'])];
  const subclassOf = (cls, subclasses) => ['all', ['==', ['get', 'class'], cls], ['match', ['get', 'subclass'], subclasses, true, false]];
  const main = ['any',
    classIn(MAIN_LANDMARKS),
    subclassOf('hospital', ['hospital']),
    subclassOf('railway', ['station', 'halt']),
    subclassOf('attraction', ['viewpoint']),
  ];
  const lesser = ['all', classIn(LESSER_LANDMARKS), ['!', subclassOf('attraction', ['viewpoint'])]];
  const landmarks = (id, minzoom, which) => ({
    id,
    type: 'symbol',
    source,
    'source-layer': 'poi',
    minzoom,
    filter: ['all', ['has', 'name'], which],
    layout: pointLabel('•', placeName),
    paint: paint(t.landmark),
  });

  return [
    ...ROAD_REF_TIERS.map(([minzoom, classes]) => ({
      id: `road-refs-${classes[0]}`,
      type: 'symbol',
      source,
      'source-layer': 'transportation_name',
      minzoom,
      // motorway junctions carry their exit number as a ref
      filter: ['all', ['has', 'ref'], ['!=', ['get', 'subclass'], 'junction'], classIn(classes)],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 320,
        'text-field': firstRef,
        'text-font': ['Noto Sans Bold'],
        'text-size': 10,
        // upright like a road sign, not turned along the road
        'text-rotation-alignment': 'viewport',
      },
      paint: paint(t.landmark),
    })),
    {
      id: 'airports',
      type: 'symbol',
      source,
      'source-layer': 'aerodrome_label',
      minzoom: 10,
      // the ones with scheduled flights; airfields and heliports would only be noise
      filter: ['all', ['has', 'name'], ['has', 'iata']],
      layout: pointLabel('•', placeName),
      paint: paint(t.landmark),
    },
    // zoomed out only the first summit of each area, so the hills do not fill up with names
    { id: 'summits-main', type: 'symbol', source, 'source-layer': 'mountain_peak', minzoom: 11, maxzoom: 13, filter: ['all', summit, ['<=', ['get', 'rank'], 1]], layout: pointLabel('▲', withHeight), paint: paint(t.landmark) },
    { id: 'summits', type: 'symbol', source, 'source-layer': 'mountain_peak', minzoom: 13, filter: summit, layout: pointLabel('▲', withHeight), paint: paint(t.landmark) },
    // the tiles only carry these from zoom 14
    landmarks('landmarks-main', 14, main),
    landmarks('landmarks-lesser', 15, ['all', lesser, ['<=', ['get', 'rank'], LESSER_RANK_AT_15]]),
    landmarks('landmarks-rest', 16, ['all', lesser, ['>', ['get', 'rank'], LESSER_RANK_AT_15]]),
  ];
}

/**
 * Recolours the base style for a theme, drops what a cyclist does not need (icons, one-way arrows),
 * and adds hillshade, dotted cycleways and the names of points of reference.
 */
export function tintBaseStyle(baseStyle, themeName) {
  const t = MAP_THEMES[themeName];
  const style = structuredClone(baseStyle);
  const vectorSource = Object.keys(style.sources).find((k) => style.sources[k].type === 'vector');
  Object.keys(style.sources).forEach((k) => {
    if (k !== vectorSource) delete style.sources[k];
  });

  style.layers = style.layers
    .filter((l) => (l.type === 'background' || l.source === vectorSource) && !HIDDEN_LAYERS.test(l.id))
    .map((l) => {
      const sourceLayer = l['source-layer'];
      if (l.type === 'background') {
        l.paint = { 'background-color': t.land };
      } else if (l.type === 'fill') {
        if (sourceLayer === 'water') l.paint = { 'fill-color': t.sea };
        else if (sourceLayer === 'building') l.paint = { 'fill-color': t.building, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 15, 1] };
        else if (sourceLayer === 'landcover' || sourceLayer === 'park') l.paint = { 'fill-color': t.wood, 'fill-opacity': 0.8 };
        else l.paint = { 'fill-color': t.urban, 'fill-opacity': 0.7 };
      } else if (l.type === 'line') {
        const paint = keepProps(l.paint, 'line-width', 'line-dasharray', 'line-gap-width', 'line-opacity');
        if (sourceLayer === 'waterway') paint['line-color'] = t.sea;
        else if (sourceLayer === 'boundary') paint['line-color'] = t.boundary;
        else if (/rail/.test(l.id)) paint['line-color'] = t.rail;
        else if (/casing/.test(l.id)) paint['line-color'] = t.roadCasing;
        else if (/motorway|major/.test(l.id)) paint['line-color'] = t.roadMajor;
        else if (/path/.test(l.id)) paint['line-color'] = t.path;
        else paint['line-color'] = t.roadMinor;
        l.paint = paint;
      } else if (l.type === 'symbol') {
        const water = sourceLayer === 'water_name' || sourceLayer === 'waterway';
        const road = sourceLayer === 'transportation_name';
        l.paint = {
          'text-color': water ? t.labelWater : road ? t.roadName : t.label,
          'text-halo-color': water ? t.sea : t.land,
          'text-halo-width': 1.3,
        };
        // villages and minor places only once you zoom in, so the wind numbers stay readable
        if (/village|other/.test(l.id)) l.minzoom = Math.max(l.minzoom || 0, 11.5);
        // street names are for finding a spot once zoomed in: small, and the main roads from zoom 13
        if (road) {
          l.layout = { ...l.layout, 'text-size': 11 };
          if (/major/.test(l.id)) l.minzoom = Math.max(l.minzoom || 0, 13);
        }
      }
      return l;
    });

  if (!vectorSource) return style;

  style.sources.dem = {
    type: 'raster-dem',
    tiles: [TERRAIN_TILES],
    tileSize: 256,
    maxzoom: 13,
    encoding: 'terrarium',
    attribution: 'Relief: Mapzen terrain tiles',
  };
  const firstRoad = style.layers.findIndex((l) => ['building', 'transportation', 'aeroway'].includes(l['source-layer']));
  style.layers.splice(firstRoad < 0 ? style.layers.length : firstRoad, 0, {
    id: 'relief',
    type: 'hillshade',
    source: 'dem',
    paint: {
      'hillshade-shadow-color': t.hillShadow,
      'hillshade-highlight-color': t.hillHighlight,
      'hillshade-accent-color': t.hillAccent,
      'hillshade-exaggeration': 0.55,
    },
  });

  const firstPlace = style.layers.findIndex((l) => l.type === 'symbol' && l['source-layer'] === 'place');
  style.layers.splice(firstPlace < 0 ? style.layers.length : firstPlace, 0, ...referenceLayers(vectorSource, t));
  // nothing left draws an icon, so the base style's sprite is not downloaded
  if (!style.layers.some((l) => l.layout?.['icon-image'] || l.paint?.['fill-pattern'] || l.paint?.['line-pattern'])) delete style.sprite;

  const firstLabel = style.layers.findIndex((l) => l.type === 'symbol');
  style.layers.splice(firstLabel < 0 ? style.layers.length : firstLabel, 0, {
    id: 'cycleways',
    type: 'line',
    source: vectorSource,
    'source-layer': 'transportation',
    minzoom: 11,
    filter: ['==', ['get', 'subclass'], 'cycleway'],
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': t.cycle,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 15, 2.4],
      'line-dasharray': [1.5, 1.5],
    },
  });

  return style;
}

/**
 * Loads the base style, falling back to the copy saved on this device when offline.
 * Returns null when neither is available.
 */
export async function loadBaseStyle() {
  try {
    const response = await fetch(BASE_STYLE_URL, { signal: timeoutSignal(12000) });
    if (!response.ok) throw new Error(`Basemap style answered ${response.status}`);
    const style = await response.json();
    try {
      localStorage.setItem(STYLE_CACHE_KEY, JSON.stringify(style));
    } catch {
      // not being able to cache is fine
    }
    return style;
  } catch (error) {
    try {
      const cached = JSON.parse(localStorage.getItem(STYLE_CACHE_KEY));
      if (cached?.layers) return cached;
    } catch {
      // fall through
    }
    console.warn('Basemap unavailable:', error.message);
    return null;
  }
}

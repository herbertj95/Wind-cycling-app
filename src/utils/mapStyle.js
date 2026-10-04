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
export const MAP_THEMES = {
  dark: {
    sea: '#0a1a27', land: '#172830', wood: '#18312c', urban: '#1e3039', building: '#25373f',
    roadMinor: '#2c3f49', roadMajor: '#3d5563', roadCasing: '#12222a', path: '#2c3f49', rail: '#33454e',
    boundary: '#3a4d58', label: '#a9bcc7', labelWater: '#4d6f88', cycle: '#86a8ba',
    hillShadow: 'rgba(0,0,0,0.6)', hillHighlight: 'rgba(160,200,220,0.12)', hillAccent: 'rgba(0,0,0,0.4)',
    flow: [255, 255, 255], halo: '#0a1a27', casing: '#06121b',
    tail: '#3987e5', neutral: '#b4bec6', head: '#e66767',
  },
  light: {
    sea: '#c9dce8', land: '#f1ede4', wood: '#dbe6d2', urban: '#e9e4d9', building: '#ddd6c9',
    roadMinor: '#ffffff', roadMajor: '#ffffff', roadCasing: '#cfc8ba', path: '#d9d2c4', rail: '#c2bbae',
    boundary: '#b9b1a3', label: '#3d4c58', labelWater: '#5f86a0', cycle: '#5c7a8c',
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

// Country and region names stay: zoomed out, they are what tells one part of the world from another.
const HIDDEN_LAYERS = /shield|oneway|highway.name|airport|ice|glacier/;
const keepProps = (paint, ...keys) => {
  const out = {};
  keys.forEach((k) => {
    if (paint && paint[k] !== undefined) out[k] = paint[k];
  });
  return out;
};

/**
 * Recolours the base style for a theme, drops what a cyclist does not need (shields, road names,
 * airports) and adds hillshade plus dotted cycleways.
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
        l.paint = {
          'text-color': water ? t.labelWater : t.label,
          'text-halo-color': water ? t.sea : t.land,
          'text-halo-width': 1.3,
        };
        // villages and minor places only once you zoom in, so the wind numbers stay readable
        if (/village|other/.test(l.id)) l.minzoom = Math.max(l.minzoom || 0, 11.5);
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

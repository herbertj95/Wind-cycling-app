import { describe, it, expect } from 'vitest';
import { MAP_THEMES, effectColor, routeGradient, tintBaseStyle, fallbackStyle } from './mapStyle';

const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',')})`;

describe('effectColor', () => {
  it('is the neutral grey when the wind is neither helping nor hindering', () => {
    expect(effectColor(0, 'dark')).toBe(rgb(MAP_THEMES.dark.neutral));
    expect(effectColor(0, 'light')).toBe(rgb(MAP_THEMES.light.neutral));
  });

  it('reaches the full headwind red at 15 km/h against and stays there', () => {
    expect(effectColor(15, 'dark')).toBe(rgb(MAP_THEMES.dark.head));
    expect(effectColor(40, 'dark')).toBe(rgb(MAP_THEMES.dark.head));
  });

  it('reaches the full tailwind blue at 15 km/h behind and stays there', () => {
    expect(effectColor(-15, 'light')).toBe(rgb(MAP_THEMES.light.tail));
    expect(effectColor(-60, 'light')).toBe(rgb(MAP_THEMES.light.tail));
  });

  it('moves towards red for a headwind and towards blue for a tailwind', () => {
    const channels = (color) => color.match(/\d+/g).map(Number);
    const [neutralR, , neutralB] = channels(effectColor(0, 'dark'));
    const [headR, , headB] = channels(effectColor(8, 'dark'));
    const [tailR, , tailB] = channels(effectColor(-8, 'dark'));
    // dark theme: head #e66767 is redder and less blue than the grey #b4bec6; tail #3987e5 is the opposite
    expect(headR).toBeGreaterThan(neutralR);
    expect(headB).toBeLessThan(neutralB);
    expect(tailR).toBeLessThan(neutralR);
    expect(tailB).toBeGreaterThan(neutralB);
  });
});

describe('routeGradient', () => {
  const progressOf = (stops) => stops.filter((_, i) => i % 2 === 0);
  const colorsOf = (stops) => stops.filter((_, i) => i % 2 === 1);
  const strictlyAscending = (values) => values.every((v, i) => i === 0 || v > values[i - 1]);

  it('gives one stop per point, from 0 to 1, placed by distance along the drawn line', () => {
    const route = { pathLength: 10, points: [{ pathKm: 0 }, { pathKm: 2.5 }, { pathKm: 10 }] };
    const { line, casing } = routeGradient(route, [20, 0, -20], 'dark');
    expect(progressOf(line)).toEqual([0, 0.25, 1]);
    expect(colorsOf(line)).toEqual([rgb(MAP_THEMES.dark.head), rgb(MAP_THEMES.dark.neutral), rgb(MAP_THEMES.dark.tail)]);
    expect(progressOf(casing)).toEqual([0, 0.25, 1]);
    expect(new Set(colorsOf(casing))).toEqual(new Set([MAP_THEMES.dark.casing]));
  });

  it('keeps stops strictly ascending when two points share a position', () => {
    const route = { pathLength: 4, points: [{ pathKm: 0 }, { pathKm: 2 }, { pathKm: 2 }, { pathKm: 4 }] };
    const { line } = routeGradient(route, [0, 0, 0, 0], 'light');
    expect(strictlyAscending(progressOf(line))).toBe(true);
    expect(progressOf(line)).toEqual([0, 0.5, 1]);
  });

  it('makes the stretch before a gap point transparent in both the line and its casing', () => {
    // ridden 0-2 km, a jump from 2 to 8 km, ridden 8-10 km
    const route = { pathLength: 10, points: [{ pathKm: 0 }, { pathKm: 2 }, { pathKm: 8, gap: true }, { pathKm: 10 }] };
    const { line, casing } = routeGradient(route, [0, 0, 0, 0], 'dark');
    const progress = progressOf(line);
    expect(strictlyAscending(progress)).toBe(true);
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    // two extra stops just inside the jump: 0.2 + 0.0006 and 0.8 - 0.0006
    expect(progress).toHaveLength(6);
    expect(progress[2]).toBeCloseTo(0.2006, 6);
    expect(progress[3]).toBeCloseTo(0.7994, 6);
    expect(colorsOf(line)[2]).toBe('rgba(0,0,0,0)');
    expect(colorsOf(line)[3]).toBe('rgba(0,0,0,0)');
    expect(colorsOf(casing)[2]).toBe('rgba(0,0,0,0)');
    expect(colorsOf(casing)[3]).toBe('rgba(0,0,0,0)');
    // both sides of the jump are solid again
    expect(colorsOf(line)[1]).toBe(rgb(MAP_THEMES.dark.neutral));
    expect(colorsOf(line)[4]).toBe(rgb(MAP_THEMES.dark.neutral));
  });

  it('always ends at 1 even if the last point falls short of the line length', () => {
    const route = { pathLength: 10, points: [{ pathKm: 0 }, { pathKm: 9 }] };
    const { line, casing } = routeGradient(route, [0, 0], 'dark');
    expect(progressOf(line)).toEqual([0, 0.9, 1]);
    expect(line.length % 2).toBe(0);
    expect(casing.length).toBe(line.length);
  });
});

describe('tintBaseStyle', () => {
  const base = {
    version: 8,
    sources: { openmaptiles: { type: 'vector', url: 'x' }, extra: { type: 'raster', tiles: [] } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#fff' } },
      { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: { 'fill-color': '#00f' } },
      { id: 'shade', type: 'raster', source: 'extra' },
      { id: 'highway_minor', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', paint: { 'line-color': '#000', 'line-width': 2 } },
      { id: 'highway-shield-non-us', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name', layout: {} },
      { id: 'label_city', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', layout: { 'text-field': '{name}' } },
    ],
  };

  it('recolours for the theme without touching the style it was given', () => {
    const copy = structuredClone(base);
    const style = tintBaseStyle(base, 'dark');
    expect(base).toEqual(copy);
    const byId = Object.fromEntries(style.layers.map((l) => [l.id, l]));
    expect(byId.background.paint['background-color']).toBe(MAP_THEMES.dark.land);
    expect(byId.water.paint['fill-color']).toBe(MAP_THEMES.dark.sea);
    expect(byId.highway_minor.paint).toEqual({ 'line-width': 2, 'line-color': MAP_THEMES.dark.roadMinor });
    expect(byId.label_city.paint['text-color']).toBe(MAP_THEMES.dark.label);
  });

  it('drops shields and other sources, and adds relief and cycleways', () => {
    const style = tintBaseStyle(base, 'light');
    const ids = style.layers.map((l) => l.id);
    expect(ids).not.toContain('highway-shield-non-us');
    expect(ids).not.toContain('shade');
    expect(Object.keys(style.sources).sort()).toEqual(['dem', 'openmaptiles']);
    // relief sits under the roads, cycleways under the labels
    expect(ids.indexOf('relief')).toBeLessThan(ids.indexOf('highway_minor'));
    expect(ids.indexOf('cycleways')).toBeLessThan(ids.indexOf('label_city'));
    expect(ids.indexOf('cycleways')).toBeGreaterThan(ids.indexOf('highway_minor'));
  });

  it('survives a style with no vector source', () => {
    const style = tintBaseStyle({ version: 8, sources: {}, layers: [{ id: 'background', type: 'background' }] }, 'dark');
    expect(style.layers).toHaveLength(1);
    expect(style.sources).toEqual({});
  });

  it('has a plain fallback in the theme land colour', () => {
    expect(fallbackStyle('light').layers[0].paint['background-color']).toBe(MAP_THEMES.light.land);
  });
});

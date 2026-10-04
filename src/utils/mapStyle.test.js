import { describe, it, expect } from 'vitest';
import { createExpression, featureFilter, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
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

describe('the names on the map', () => {
  const font = ['Noto Sans Regular'];
  const symbol = (id, sourceLayer, layout = {}, extra = {}) => ({
    id,
    type: 'symbol',
    source: 'openmaptiles',
    'source-layer': sourceLayer,
    layout: { 'text-field': ['get', 'name'], 'text-font': font, ...layout },
    ...extra,
  });
  // the label layers of the base style, in miniature
  const base = {
    version: 8,
    glyphs: 'https://example.org/fonts/{fontstack}/{range}.pbf',
    sprite: 'https://example.org/sprite',
    sources: { openmaptiles: { type: 'vector', url: 'https://example.org/tiles.json' } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#fff' } },
      { id: 'highway_minor', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', paint: { 'line-color': '#000' } },
      symbol('water_name', 'water_name'),
      symbol('highway-name-minor', 'transportation_name', { 'symbol-placement': 'line', 'text-size': 13 }, { minzoom: 15 }),
      symbol('highway-name-major', 'transportation_name', { 'symbol-placement': 'line', 'text-size': 13 }, { minzoom: 12.2 }),
      symbol('highway-shield-non-us', 'transportation_name', { 'icon-image': ['concat', 'road_', ['get', 'ref_length']], 'text-field': ['get', 'ref'] }),
      symbol('airport', 'aerodrome_label', { 'icon-image': 'airport_11' }),
      symbol('label_village', 'place', {}, { minzoom: 9 }),
      symbol('label_town', 'place'),
    ],
  };
  const style = tintBaseStyle(base, 'dark');
  const ids = style.layers.map((l) => l.id);
  const layer = (id) => style.layers.find((l) => l.id === id);
  const added = ['road-refs-motorway', 'road-refs-primary', 'road-refs-secondary', 'road-refs-tertiary', 'airports', 'summits-main', 'summits', 'landmarks-main', 'landmarks-lesser', 'landmarks-rest'];

  /** Whether a layer would draw a feature with these properties. */
  const shows = (id, properties) => featureFilter(layer(id).filter, `layers.${id}.filter`).filter({ zoom: 14 }, { type: 1, properties });
  /** What a layer would write for a feature with these properties. */
  const written = (id, properties) =>
    createExpression(layer(id).layout['text-field'], `layers.${id}.layout.text-field`).value.evaluate({ zoom: 14 }, { type: 1, properties });

  it('is a style MapLibre accepts, in both themes', () => {
    expect(validateStyleMin(style)).toEqual([]);
    expect(validateStyleMin(tintBaseStyle(base, 'light'))).toEqual([]);
  });

  it('keeps the street names, smaller and a step behind the names of towns', () => {
    for (const id of ['highway-name-major', 'highway-name-minor']) {
      expect(layer(id).paint['text-color']).toBe(MAP_THEMES.dark.roadName);
      expect(layer(id).layout['text-size']).toBe(11);
      expect(layer(id).layout['symbol-placement']).toBe('line');
    }
    expect(MAP_THEMES.dark.roadName).not.toBe(MAP_THEMES.dark.label);
    expect(layer('label_town').paint['text-color']).toBe(MAP_THEMES.dark.label);
  });

  it('shows the names of main roads from zoom 13 and of small streets as the base style has them', () => {
    expect(layer('highway-name-major').minzoom).toBe(13);
    expect(layer('highway-name-minor').minzoom).toBe(15);
  });

  it('adds road numbers, airports, summits and landmarks below the names of towns', () => {
    for (const id of added) expect(ids, id).toContain(id);
    const firstPlace = Math.min(ids.indexOf('label_village'), ids.indexOf('label_town'));
    for (const id of added) {
      expect(ids.indexOf(id), id).toBeLessThan(firstPlace);
      expect(ids.indexOf(id), id).toBeGreaterThan(ids.indexOf('highway_minor'));
    }
  });

  it('writes them as plain text in the landmark colour: the icons of the base style are for a light map', () => {
    expect(ids).not.toContain('highway-shield-non-us');
    expect(ids).not.toContain('airport');
    for (const id of added) {
      expect(layer(id).layout['icon-image'], id).toBeUndefined();
      expect(layer(id).paint['text-color'], id).toBe(MAP_THEMES.dark.landmark);
      expect(layer(id).paint['text-halo-color'], id).toBe(MAP_THEMES.dark.land);
    }
    expect(layer('landmarks-main').paint['text-color']).not.toBe(tintBaseStyle(base, 'light').layers.find((l) => l.id === 'landmarks-main').paint['text-color']);
  });

  it('does not download a sprite that nothing uses, and keeps one that is used', () => {
    expect('sprite' in style).toBe(false);
    const withDots = structuredClone(base);
    withDots.layers.at(-1).layout['icon-image'] = 'circle_11_black';
    expect(tintBaseStyle(withDots, 'dark').sprite).toBe(base.sprite);
  });

  it('brings in the names step by step as the map zooms in', () => {
    expect(layer('road-refs-motorway').minzoom).toBe(10);
    expect(layer('road-refs-primary').minzoom).toBe(11);
    expect(layer('road-refs-secondary').minzoom).toBe(12);
    expect(layer('road-refs-tertiary').minzoom).toBe(13);
    expect(layer('summits-main').minzoom).toBe(11);
    expect(layer('summits-main').maxzoom).toBe(layer('summits').minzoom);
    // the tiles carry no landmarks before zoom 14
    expect(layer('landmarks-main').minzoom).toBe(14);
    expect(layer('landmarks-lesser').minzoom).toBe(15);
    expect(layer('landmarks-rest').minzoom).toBe(16);
  });

  it('names the landmarks a rider steers by first', () => {
    for (const cls of ['monument', 'castle', 'museum', 'stadium', 'lighthouse', 'harbor', 'ferry_terminal', 'college', 'campsite']) {
      expect(shows('landmarks-main', { class: cls, subclass: cls, name: 'X', rank: 30 }), cls).toBe(true);
    }
    expect(shows('landmarks-main', { class: 'hospital', subclass: 'hospital', name: 'Hospital de Egas Moniz', rank: 1 })).toBe(true);
    expect(shows('landmarks-main', { class: 'railway', subclass: 'station', name: 'Sintra', rank: 1 })).toBe(true);
    expect(shows('landmarks-main', { class: 'railway', subclass: 'halt', name: 'Belém', rank: 4 })).toBe(true);
    expect(shows('landmarks-main', { class: 'attraction', subclass: 'viewpoint', name: 'Miradouro de Santo Amaro', rank: 10 })).toBe(true);
  });

  it('leaves out what every street has', () => {
    const noise = [
      { class: 'cafe', subclass: 'cafe' },
      { class: 'restaurant', subclass: 'restaurant' },
      { class: 'shop', subclass: 'convenience' },
      { class: 'bus', subclass: 'bus_stop' },
      { class: 'parking', subclass: 'parking' },
      { class: 'bank', subclass: 'bank' },
      // not every hospital-class or railway-class thing is a landmark
      { class: 'hospital', subclass: 'clinic' },
      { class: 'railway', subclass: 'tram_stop' },
      { class: 'railway', subclass: 'subway_entrance' },
    ];
    for (const properties of noise) {
      for (const id of ['landmarks-main', 'landmarks-lesser', 'landmarks-rest']) {
        expect(shows(id, { ...properties, name: 'X', rank: 1 }), `${properties.subclass} in ${id}`).toBe(false);
      }
    }
  });

  it('names nothing that has no name', () => {
    expect(shows('landmarks-main', { class: 'monument', subclass: 'monument', rank: 1 })).toBe(false);
    expect(shows('landmarks-lesser', { class: 'park', subclass: 'park', rank: 1 })).toBe(false);
    expect(shows('summits', { class: 'peak', ele: 400, rank: 1 })).toBe(false);
    expect(shows('airports', { iata: 'LIS' })).toBe(false);
  });

  it('keeps parks, churches and other attractions for a closer look, the first of each area before the rest', () => {
    for (const cls of ['park', 'garden', 'place_of_worship', 'attraction', 'theatre', 'bicycle']) {
      const first = { class: cls, subclass: cls, name: 'X', rank: 8 };
      const further = { ...first, rank: 60 };
      expect(shows('landmarks-main', first), cls).toBe(false);
      expect(shows('landmarks-lesser', first), cls).toBe(true);
      expect(shows('landmarks-rest', first), cls).toBe(false);
      expect(shows('landmarks-lesser', further), cls).toBe(false);
      expect(shows('landmarks-rest', further), cls).toBe(true);
    }
    // a viewpoint is already on the map from zoom 14: it is not written twice
    const viewpoint = { class: 'attraction', subclass: 'viewpoint', name: 'Miradouro', rank: 8 };
    expect(shows('landmarks-lesser', viewpoint)).toBe(false);
    expect(shows('landmarks-rest', { ...viewpoint, rank: 60 })).toBe(false);
  });

  it('marks a landmark with a bullet and uses its local name', () => {
    expect(written('landmarks-main', { name: 'Torre de Belém' })).toBe('• Torre de Belém');
    expect(written('landmarks-main', { name: '東京タワー', 'name:latin': 'Tokyo Tower' })).toBe('• Tokyo Tower');
    expect(written('airports', { name: 'Aeroporto Humberto Delgado', iata: 'LIS' })).toBe('• Aeroporto Humberto Delgado');
  });

  it('cuts a very long name instead of filling the map with it', () => {
    const long = 'Fundação Dona Anna de Sommer Champalimaud e Doutor Carlos Montez Champalimaud';
    const text = written('landmarks-main', { name: long });
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(2 + 40);
    expect(long.startsWith(text.slice(2, -1))).toBe(true);
    // a name of ordinary length is left alone
    expect(written('landmarks-main', { name: 'Museu Nacional de Arte Antiga' })).toBe('• Museu Nacional de Arte Antiga');
  });

  it('marks a summit with a triangle and its height', () => {
    expect(written('summits', { name: 'Peninha', ele: 487 })).toBe('▲ Peninha  487 m');
    expect(written('summits-main', { name: 'Cruz Alta', ele: 528 })).toBe('▲ Cruz Alta  528 m');
    expect(written('summits', { name: 'Monge' })).toBe('▲ Monge');
  });

  it('names summits and passes, not cliffs, and zoomed out only the first of each area', () => {
    for (const cls of ['peak', 'volcano', 'saddle']) expect(shows('summits', { class: cls, name: 'X', rank: 3 }), cls).toBe(true);
    expect(shows('summits', { class: 'cliff', name: 'Pedreira', rank: 1 })).toBe(false);
    expect(shows('summits-main', { class: 'peak', name: 'Peninha', rank: 1 })).toBe(true);
    expect(shows('summits-main', { class: 'peak', name: 'Pedra Amarela', rank: 2 })).toBe(false);
  });

  it('writes the number of a road upright along it, by class of road', () => {
    const ref = (cls, extra = {}) => ({ class: cls, ref: 'EN 6', ...extra });
    expect(shows('road-refs-motorway', ref('motorway'))).toBe(true);
    expect(shows('road-refs-motorway', ref('trunk'))).toBe(true);
    expect(shows('road-refs-motorway', ref('primary'))).toBe(false);
    expect(shows('road-refs-primary', ref('primary'))).toBe(true);
    expect(shows('road-refs-secondary', ref('secondary'))).toBe(true);
    expect(shows('road-refs-tertiary', ref('tertiary'))).toBe(true);
    expect(shows('road-refs-tertiary', ref('minor'))).toBe(false);
    // a road without a number, and the exit numbers of motorway junctions
    expect(shows('road-refs-primary', { class: 'primary', name: 'Avenida de Brasília' })).toBe(false);
    expect(shows('road-refs-motorway', ref('motorway', { subclass: 'junction', ref: '3' }))).toBe(false);
    for (const id of added.slice(0, 4)) {
      expect(layer(id).layout['symbol-placement'], id).toBe('line');
      expect(layer(id).layout['text-rotation-alignment'], id).toBe('viewport');
    }
  });

  it('writes one number for a road that has several', () => {
    expect(written('road-refs-motorway', { ref: 'IC 17;A 36' })).toBe('IC 17');
    expect(written('road-refs-motorway', { ref: 'PVG;IP 1' })).toBe('PVG');
    expect(written('road-refs-primary', { ref: 'EN 247' })).toBe('EN 247');
  });

  it('names the airports with scheduled flights', () => {
    expect(shows('airports', { name: 'Aeroporto Humberto Delgado', iata: 'LIS', class: 'international' })).toBe(true);
    expect(shows('airports', { name: 'Aeródromo de Tires', class: 'other' })).toBe(false);
  });

  it('recolours the added names with the theme', () => {
    const light = tintBaseStyle(base, 'light');
    for (const id of added) {
      const paint = light.layers.find((l) => l.id === id).paint;
      expect(paint['text-color'], id).toBe(MAP_THEMES.light.landmark);
      expect(paint['text-halo-color'], id).toBe(MAP_THEMES.light.land);
    }
  });
});

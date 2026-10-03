// The map itself: a MapLibre basemap with the wind drawn on two canvases above it, plus the spots,
// the route and the rider. Everything here is imperative; React talks to it through the returned methods.
import { Map as MapLibreMap, Marker, NavigationControl, AttributionControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { COVERAGE, SPOTS, sampleField } from '../utils/weatherApi';
import { calculateDistance } from '../utils/gpxParser';
import { CALM_KMH, compassPoint } from '../utils/wind';
import { MAP_THEMES, fallbackStyle, tintBaseStyle, loadBaseStyle } from '../utils/mapStyle';
import { createFlowLayer } from './flowLayer';
import { drawGlyphs } from './glyphLayer';

setWorkerUrl(workerUrl);

const COVERAGE_OUTLINE = [
  [COVERAGE.west, COVERAGE.south],
  [COVERAGE.east, COVERAGE.south],
  [COVERAGE.east, COVERAGE.north],
  [COVERAGE.west, COVERAGE.north],
  [COVERAGE.west, COVERAGE.south],
];
const ROUTE_LAYERS = ['route-km', 'route-chevrons', 'route-line', 'route-casing'];
const ROUTE_SOURCES = ['route', 'route-parts', 'route-km'];
const ZOOM = ['interpolate', ['linear'], ['zoom']];

// The home view shows every spot, with a little air around them.
const HOME_BOUNDS = (() => {
  const lats = SPOTS.map((s) => s.lat);
  const lngs = SPOTS.map((s) => s.lng);
  return [
    [Math.min(...lngs) - 0.05, Math.min(...lats) - 0.03],
    [Math.max(...lngs) + 0.05, Math.max(...lats) + 0.03],
  ];
})();

// Small arrow pointing down, rotated by the direction the wind comes from: it then points downwind.
const arrowSvg = (deg) =>
  `<svg viewBox="0 0 12 12" aria-hidden="true" style="transform:rotate(${Math.round(deg)}deg)"><path d="M6 1v9.5M6 10.5L2.5 6.5M6 10.5l3.5-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// one chevron per colour, drawn once
const chevrons = new Map();

function chevronImage(color) {
  if (chevrons.has(color)) return chevrons.get(color);
  const canvas = document.createElement('canvas');
  canvas.width = 24;
  canvas.height = 24;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(8, 5);
  ctx.lineTo(16, 12);
  ctx.lineTo(8, 19);
  ctx.stroke();
  const image = ctx.getImageData(0, 0, 24, 24);
  chevrons.set(color, image);
  return image;
}

/**
 * Creates the wind map inside `container`.
 * - onPick(lat, lng): the user tapped the map (anywhere, also outside the forecast area)
 * - onUserMove(): the user panned or zoomed the map by hand
 * - onSpot(id): the user tapped a spot label
 * - getPadding(): { top, right, bottom, left } px covered by floating panels, so fits avoid them
 */
export function createWindMap(container, { theme: initialTheme, flowEnabled, onPick, onSpot, onUserMove, getPadding }) {
  let themeName = initialTheme;
  let field = null;
  let baseStyle = null;
  let styleReady = false;
  let destroyed = false;
  let route = null;
  let routeStops = null;
  let width = 0;
  let height = 0;
  let pickTimer = 0;

  const spotMarkers = new Map();
  let endMarkers = [];
  let riderMarker = null;
  let pinMarker = null;
  let userMarker = null;

  const map = new MapLibreMap({
    container,
    style: fallbackStyle(themeName),
    center: [-9.19, 38.7],
    zoom: 9.6,
    minZoom: 8,
    maxZoom: 16,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
    attributionControl: false,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(
    new AttributionControl({ compact: true, customAttribution: '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a>' }),
    'bottom-left',
  );
  // the credits start folded, so they do not lie across the map on a phone
  const credits = container.querySelector('.maplibregl-ctrl-attrib');
  credits?.classList.remove('maplibregl-compact-show');
  credits?.removeAttribute('open');

  const addCanvas = () => {
    const canvas = document.createElement('canvas');
    canvas.className = 'map-overlay';
    map.getCanvasContainer().appendChild(canvas);
    return canvas;
  };
  const flowCanvas = addCanvas();
  const glyphCanvas = addCanvas();
  const glyphCtx = glyphCanvas.getContext('2d');
  const flow = createFlowLayer(flowCanvas);
  flow.setInk(MAP_THEMES[themeName].flow);
  flow.setEnabled(flowEnabled);

  const colors = () => MAP_THEMES[themeName];
  const sample = (lat, lng) => sampleField(field, lat, lng);
  const project = (lat, lng) => map.project([lng, lat]);

  function padding() {
    const p = { top: 0, right: 0, bottom: 0, left: 0, ...getPadding() };
    // never ask the map to fit into less room than the panels leave
    const roomY = height - p.top - p.bottom;
    if (roomY < 150) {
      const cut = (150 - roomY) / 2;
      p.top = Math.max(8, p.top - cut);
      p.bottom = Math.max(8, p.bottom - cut);
    }
    const roomX = width - p.left - p.right;
    if (roomX < 150) {
      const cut = (150 - roomX) / 2;
      p.left = Math.max(8, p.left - cut);
      p.right = Math.max(8, p.right - cut);
    }
    return p;
  }

  function redrawGlyphs() {
    if (!field || !width) return;
    const view = map.getBounds();
    drawGlyphs(glyphCtx, {
      width,
      height,
      zoom: map.getZoom(),
      bounds: { south: view.getSouth(), north: view.getNorth(), west: view.getWest(), east: view.getEast() },
      project,
      sample,
      ink: colors().flow,
      halo: colors().halo,
      avoid: [...spotMarkers.values()].map(({ spot }) => {
        const p = project(spot.lat, spot.lng);
        return [p.x, p.y];
      }),
    });
  }

  function refreshFlow() {
    if (!field || !width) return;
    const topLeft = map.project([COVERAGE.west, COVERAGE.north]);
    const bottomRight = map.project([COVERAGE.east, COVERAGE.south]);
    flow.update({
      unproject: (x, y) => map.unproject([x, y]),
      sample,
      bounds: [topLeft.x, topLeft.y, bottomRight.x, bottomRight.y],
    });
  }

  function sizeCanvases() {
    const el = map.getContainer();
    width = el.clientWidth;
    height = el.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    flow.resize(width, height, dpr);
    glyphCanvas.width = width * dpr;
    glyphCanvas.height = height * dpr;
    glyphCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    refreshFlow();
    flow.reseed();
    redrawGlyphs();
  }

  const gradient = (stops) => ['interpolate', ['linear'], ['line-progress'], ...stops];

  // until the wind along the route is known, it is drawn in the neutral colour
  function plainStops() {
    const t = colors();
    return { line: [0, t.neutral, 1, t.neutral], casing: [0, t.casing, 1, t.casing] };
  }

  function installOverlays() {
    const t = colors();
    if (!map.getSource('coverage')) {
      map.addSource('coverage', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: COVERAGE_OUTLINE } } });
      map.addLayer({ id: 'coverage', type: 'line', source: 'coverage', paint: { 'line-color': t.label, 'line-opacity': 0.35, 'line-width': 1, 'line-dasharray': [3, 3] } });
    }
    if (map.hasImage('chevron')) map.removeImage('chevron');
    map.addImage('chevron', chevronImage(t.casing), { pixelRatio: 2 });

    if (!route || map.getSource('route')) return;
    const offset = [...ZOOM, 9, 2.2, 13, 4];
    const layout = { 'line-cap': 'round', 'line-join': 'round' };
    map.addSource('route', {
      type: 'geojson',
      lineMetrics: true,
      data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.parts.flat() } },
    });
    // The stretches that were ridden, split where the recording jumps (a ferry): direction chevrons only go on these.
    map.addSource('route-parts', {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: route.parts.filter((part) => part.length > 1) } },
    });

    const stops = routeStops || plainStops();
    // The line is shifted to the right of the direction of travel, so on an out-and-back both legs stay visible.
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout, paint: { 'line-width': [...ZOOM, 9, 6.5, 13, 10.5], 'line-offset': offset, 'line-gradient': gradient(stops.casing) } });
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout,
      paint: { 'line-width': [...ZOOM, 9, 3.5, 13, 6.5], 'line-offset': offset, 'line-gradient': gradient(stops.line) },
    });
    map.addLayer({
      id: 'route-chevrons',
      type: 'symbol',
      source: 'route-parts',
      minzoom: 8.5,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 110,
        'icon-image': 'chevron',
        'icon-size': [...ZOOM, 8.5, 0.5, 13, 0.8],
        'icon-offset': [...ZOOM, 9, ['literal', [0, 2.2]], 13, ['literal', [0, 4]]],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });

    const kmMarks = [];
    for (let km = 10; km < route.totalDistance - 3; km += 10) {
      const p = route.points.find((q) => q.distance >= km);
      if (p) kmMarks.push({ type: 'Feature', properties: { label: `${km} km` }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } });
    }
    map.addSource('route-km', { type: 'geojson', data: { type: 'FeatureCollection', features: kmMarks } });
    map.addLayer({
      id: 'route-km',
      type: 'symbol',
      source: 'route-km',
      minzoom: 9.5,
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, 1.3] },
      paint: { 'text-color': t.label, 'text-halo-color': t.halo, 'text-halo-width': 1.6 },
    });
  }

  function removeRoute() {
    if (styleReady) {
      ROUTE_LAYERS.forEach((id) => map.getLayer(id) && map.removeLayer(id));
      ROUTE_SOURCES.forEach((id) => map.getSource(id) && map.removeSource(id));
    }
    endMarkers.forEach((m) => m.remove());
    endMarkers = [];
  }

  function applyStyle() {
    styleReady = false;
    map.setStyle(baseStyle ? tintBaseStyle(baseStyle, themeName) : fallbackStyle(themeName), { diff: false });
  }

  // A theme change only changes colours, so they are set layer by layer: the tiles stay loaded and the
  // map does not blink. (Swapping the whole style would throw every tile away and fetch it again.)
  function recolour() {
    const t = colors();
    const tinted = baseStyle ? tintBaseStyle(baseStyle, themeName) : fallbackStyle(themeName);
    tinted.layers.forEach((layer) => {
      if (!map.getLayer(layer.id)) return;
      Object.entries(layer.paint || {}).forEach(([key, value]) => map.setPaintProperty(layer.id, key, value));
    });
    map.setPaintProperty('coverage', 'line-color', t.label);
    map.updateImage('chevron', chevronImage(t.casing));
    if (map.getLayer('route-km')) {
      map.setPaintProperty('route-km', 'text-color', t.label);
      map.setPaintProperty('route-km', 'text-halo-color', t.halo);
    }
    if (map.getLayer('route-line')) {
      const stops = routeStops || plainStops();
      map.setPaintProperty('route-line', 'line-gradient', gradient(stops.line));
      map.setPaintProperty('route-casing', 'line-gradient', gradient(stops.casing));
    }
  }

  function fetchBaseStyle() {
    loadBaseStyle().then((style) => {
      if (destroyed || !style) return;
      baseStyle = style;
      applyStyle();
    });
  }

  // started without a connection: fetch the basemap as soon as there is one
  const onOnline = () => {
    if (!baseStyle) fetchBaseStyle();
  };
  window.addEventListener('online', onOnline);

  function fitCoverage(animate = true) {
    map.fitBounds(HOME_BOUNDS, { padding: padding(), animate });
  }

  map.on('style.load', () => {
    styleReady = true;
    installOverlays();
  });
  map.on('resize', sizeCanvases);
  map.on('movestart', (e) => {
    // movements started by a finger or the mouse carry the original event; the app's own fits do not
    if (e.originalEvent) onUserMove();
    flow.setMoving(true);
  });
  map.on('move', redrawGlyphs);
  map.on('moveend', () => {
    refreshFlow();
    flow.reseed();
    flow.setMoving(false);
    redrawGlyphs();
  });
  // A tap is reported a moment later, so the first tap of a double-tap zoom does not pin a point.
  const cancelPick = () => clearTimeout(pickTimer);
  map.on('click', (e) => {
    const { lat, lng } = e.lngLat;
    cancelPick();
    pickTimer = setTimeout(() => onPick(lat, lng), 280);
  });
  map.on('dblclick', cancelPick);
  map.on('zoomstart', cancelPick);
  sizeCanvases();
  fitCoverage(false);
  // canvas text needs the web font to be ready, otherwise the first numbers use the fallback face
  document.fonts?.load('600 12px Barlow').then(() => !destroyed && redrawGlyphs());

  fetchBaseStyle();

  return {
    setTheme(name) {
      if (name === themeName) return;
      themeName = name;
      flow.setInk(colors().flow);
      flow.reseed();
      // while a style is still loading, the load handler picks up the new theme's route colours itself
      if (styleReady) recolour();
      else applyStyle();
      redrawGlyphs();
    },

    /** One hour of forecast (see buildField). */
    setField(nextField) {
      const isFirst = !field;
      field = nextField;
      refreshFlow();
      // particles are seeded inside the forecast area, which is only known once there is a field
      if (isFirst) flow.reseed();
      redrawGlyphs();
    },

    setFlowEnabled(on) {
      flow.setEnabled(on);
    },

    /** spots: [{ id, label, lat, lng, anchor?, speed, from, selected }] */
    setSpots(spots) {
      const seen = new Set();
      spots.forEach((spot) => {
        seen.add(spot.id);
        let entry = spotMarkers.get(spot.id);
        if (!entry) {
          const el = document.createElement('button');
          el.type = 'button';
          el.className = 'spot-chip';
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            onSpot(spot.id);
          });
          const marker = new Marker({ element: el, anchor: spot.anchor || 'center' }).setLngLat([spot.lng, spot.lat]).addTo(map);
          entry = { el, marker, spot };
          spotMarkers.set(spot.id, entry);
        }
        entry.spot = spot;
        const hasWind = Number.isFinite(spot.speed);
        // still air has no direction, so it gets no arrow
        const hasDirection = hasWind && spot.speed >= CALM_KMH;
        entry.el.innerHTML = `<em>${spot.label}</em><b>${hasWind ? Math.round(spot.speed) : '–'}</b>${hasDirection ? arrowSvg(spot.from) : ''}`;
        entry.el.setAttribute(
          'aria-label',
          !hasWind ? spot.label : `${spot.label}: ${Math.round(spot.speed)} km/h${hasDirection ? ` from the ${compassPoint(spot.from)}` : ', calm'}`,
        );
        entry.el.classList.toggle('selected', !!spot.selected);
      });
      [...spotMarkers.keys()].filter((id) => !seen.has(id)).forEach((id) => {
        spotMarkers.get(id).marker.remove();
        spotMarkers.delete(id);
      });
      redrawGlyphs();
    },

    /** Draws a route (see parseGpxData) and fits the view to it; null removes it. */
    setRoute(nextRoute) {
      removeRoute();
      route = nextRoute;
      routeStops = null;
      if (!route) return;
      if (styleReady) installOverlays();

      const first = route.points[0];
      const last = route.points[route.points.length - 1];
      const badge = (text, p) => {
        const el = document.createElement('div');
        el.className = 'route-endpoint';
        el.textContent = text;
        // lifted clear of the rider marker and its wind arrow, which start on the same point
        endMarkers.push(new Marker({ element: el, anchor: 'bottom', offset: [0, -30] }).setLngLat([p.lng, p.lat]).addTo(map));
      };
      if (calculateDistance(first.lat, first.lng, last.lat, last.lng) < 0.4) {
        badge('Start and finish', first);
      } else {
        badge('Start', first);
        badge('Finish', last);
      }

      let south = 90;
      let north = -90;
      let west = 180;
      let east = -180;
      route.points.forEach((p) => {
        south = Math.min(south, p.lat);
        north = Math.max(north, p.lat);
        west = Math.min(west, p.lng);
        east = Math.max(east, p.lng);
      });
      // wait a frame so the route panel has its final height before measuring the padding
      requestAnimationFrame(() => {
        if (destroyed) return;
        const p = padding();
        // extra room at the top and sides for the start and finish labels
        map.fitBounds([[west, south], [east, north]], { padding: { top: p.top + 58, right: p.right + 40, bottom: p.bottom + 12, left: p.left + 40 } });
      });
    },

    /** stops: { line, casing } from routeGradient: flat [progress, colour, ...] lists along the route */
    setRouteColors(stops) {
      routeStops = stops;
      if (styleReady && map.getLayer('route-line')) {
        map.setPaintProperty('route-line', 'line-gradient', gradient(stops.line));
        map.setPaintProperty('route-casing', 'line-gradient', gradient(stops.casing));
      }
    },

    /** rider: { lat, lng, bearing, from, color } or null; `from` is null when there is no wind direction to show */
    setRider(rider) {
      if (!rider) {
        riderMarker?.remove();
        riderMarker = null;
        return;
      }
      if (!riderMarker) {
        const el = document.createElement('div');
        el.className = 'rider-marker';
        riderMarker = new Marker({ element: el, anchor: 'center' }).setLngLat([rider.lng, rider.lat]).addTo(map);
      }
      riderMarker.setLngLat([rider.lng, rider.lat]);
      const casing = colors().casing;
      const windArrow = 'M26 1v12M26 14l-4.5-6M26 14l4.5-6';
      const wind = Number.isFinite(rider.from)
        ? `<g transform="rotate(${Math.round(rider.from)} 26 26)" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="${windArrow}" stroke="${casing}" stroke-width="6"/>
          <path d="${windArrow}" stroke="${rider.color}" stroke-width="3"/>
        </g>`
        : '';
      riderMarker.getElement().innerHTML = `<svg viewBox="0 0 52 52" width="52" height="52" aria-hidden="true">
        ${wind}
        <circle cx="26" cy="26" r="10" fill="var(--inv)" stroke="${casing}" stroke-width="2"/>
        <path d="M26 19.5l4.6 10.5-4.6-2.6-4.6 2.6z" fill="var(--inv-ink)" transform="rotate(${Math.round(rider.bearing)} 26 26)"/>
      </svg>`;
    },

    setPin(pin) {
      pinMarker?.remove();
      pinMarker = null;
      if (!pin) return;
      const el = document.createElement('div');
      el.className = 'map-pin';
      pinMarker = new Marker({ element: el }).setLngLat([pin.lng, pin.lat]).addTo(map);
    },

    setUser(user) {
      userMarker?.remove();
      userMarker = null;
      if (!user) return;
      const el = document.createElement('div');
      el.className = 'user-dot';
      userMarker = new Marker({ element: el }).setLngLat([user.lng, user.lat]).addTo(map);
    },

    /** Brings a point into the part of the map the panels leave free. */
    focusOn(lat, lng, minZoom = 11) {
      const p = padding();
      map.easeTo({
        center: [lng, lat],
        zoom: Math.max(map.getZoom(), minZoom),
        offset: [(p.left - p.right) / 2, (p.top - p.bottom) / 2],
        duration: 700,
      });
    },

    fitCoverage,

    destroy() {
      destroyed = true;
      cancelPick();
      window.removeEventListener('online', onOnline);
      flow.destroy();
      map.remove();
    },
  };
}

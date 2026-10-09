import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, MagnifyingGlass, Moon, Path, Sun, Wind } from '@phosphor-icons/react';
import WindMap from './components/WindMap';
import WindReadout from './components/WindReadout';
import TimeBar from './components/TimeBar';
import RoutePanel from './components/RoutePanel';
import RoutesMenu from './components/RoutesMenu';
import PlacesMenu from './components/PlacesMenu';
import { useWind, useNow } from './hooks/useWind';
import { useObserved } from './hooks/useObserved';
import { useSystemBars } from './hooks/useSystemBars';
import { STALE_MS } from './utils/windStore';
import { inBounds, levelForBounds, nodesAlong, nodesAround, nodesInBounds, stepOf } from './utils/lattice';
import { PLACES_KEY, loadPlaces, makePlace, savePlaces } from './utils/places';
import { analyseRoute, bestWindows, retracesItself, scanDepartures } from './utils/routeAnalysis';
import { calculateDistance, parseGpxData, reverseRoute } from './utils/gpxParser';
import { ROUTE_MAX_KM, RoutingError, fetchBikeRoute } from './utils/routing';
import { darkChecks, isRidingLight } from './utils/sun';
import { CALM_KMH } from './utils/wind';
import { MAP_THEMES, effectColor, routeGradient } from './utils/mapStyle';
import { DEVICE_ZONE, formatClock, formatDay, formatDayClock, hourStart, validZone, zoneLabel } from './utils/time';
import './App.css';

const HOUR = 3600;
// Hours of forecast shown on the time bar, relative to now
const HOURS_BACK = 2;
const HOURS_AHEAD = 45;

const THEME_KEY = 'wind-theme';
const VIEW_KEY = 'wind-view-v1';
const FOCUS_KEY = 'wind-focus-v1';
const FOLDED_KEY = 'wind-folded-v1';
const ROUND_TRIP_KEY = 'wind-round-trip-v1';
const NARROW_SCREEN = 720;
// ms between rider steps at 1x: a 600-point route plays in a little over a minute
const RIDE_TICK_MS = 120;
// "Locate me" asks for a precise fix; the quiet look-up on start takes whatever is quick
const GEO_PRECISE = { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 };
const GEO_QUICK = { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 };
const GEO_TIMEOUT = 3;
const PLACES_MENU_ID = 'places-menu';
const ROUTES_MENU_ID = 'routes-menu';

// Forecast points asked for at once: across the map view, along a route, and around the saved places in view.
// Each one counts against the free allowance of the forecast service, so the view takes a coarser lattice
// when zoomed out instead of more points.
const VIEW_MAX_POINTS = 120;
const ROUTE_MAX_POINTS = 64;
const PLACES_WITH_WIND = 12;
// The wind for a view is asked for once the map has been still this long, so passing through downloads nothing
const VIEW_SETTLE_MS = 350;
// On start the map waits this long for a quick position fix before asking for the wind of the view it opened on
const START_HOLD_MS = 1200;
// A reading for one place only comes from forecast points at most 0.125° apart, never from the coarser ones
// of a zoomed-out view
const POINT = { maxLevel: 0 };
// The other direction of a route is called easier when the wind costs that much less there (see windScore in analyseRoute)
const FLIP_MARGIN = 3;
// A measurement older than this is no longer the wind of now
const MEASURED_MAX_AGE = 2 * HOUR;

function initialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // storage unavailable: fall through to the system setting
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// where the map was left, or null the first time (it then opens on the default places)
function initialView() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY));
    if (saved && [saved.lat, saved.lng, saved.zoom].every(Number.isFinite) && Math.abs(saved.lat) <= 85) {
      return { lat: saved.lat, lng: saved.lng, zoom: saved.zoom };
    }
  } catch {
    // nothing usable saved
  }
  return null;
}

// what the readout was showing when the app was last used, if it is still there; otherwise the first place
function initialFocus(places) {
  try {
    const saved = JSON.parse(localStorage.getItem(FOCUS_KEY));
    if (saved?.type === 'place' && places.some((p) => p.id === saved.id)) return { type: 'place', id: saved.id };
    if (saved?.type === 'pin' && Number.isFinite(saved.lat) && Number.isFinite(saved.lng)) {
      return {
        type: 'pin',
        lat: saved.lat,
        lng: saved.lng,
        name: typeof saved.name === 'string' ? saved.name : null,
        region: typeof saved.region === 'string' ? saved.region : null,
        zone: validZone(saved.zone),
      };
    }
  } catch {
    // nothing usable saved
  }
  return { type: 'place', id: places[0]?.id };
}

// which panels were left folded away, to give the map more room
function initialFolded() {
  try {
    const saved = JSON.parse(localStorage.getItem(FOLDED_KEY));
    return { time: saved?.time === true, route: saved?.route === true, readout: saved?.readout === true };
  } catch {
    return { time: false, route: false, readout: false };
  }
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// the focus moves to the rider and remembers what it was on, to go back to when the route is closed
const toRider = (prev) => (prev.type === 'rider' ? prev : { type: 'rider', back: prev });

export default function App() {
  const { store, wind } = useWind();
  const now = useNow();
  const nowSec = now / 1000;

  const [theme, setTheme] = useState(initialTheme);
  const [flowEnabled, setFlowEnabled] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // null follows the clock; otherwise the unix time (s) of the chosen forecast hour
  const [selectedTime, setSelectedTime] = useState(null);
  const [forecastPlaying, setForecastPlaying] = useState(false);

  const [places, setPlaces] = useState(loadPlaces);
  // What the readout describes: a saved place, a pinned point (tapped or found by search),
  // the rider on the route, or the user's position
  const [focus, setFocus] = useState(() => initialFocus(places));
  const [user, setUser] = useState(null);
  const [isLocating, setIsLocating] = useState(false);
  // a route being asked for to the place in focus (the number of the request, 0 for none), and whether it comes back
  const [routing, setRouting] = useState(0);
  const [roundTrip, setRoundTrip] = useState(() => {
    try {
      return localStorage.getItem(ROUND_TRIP_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [route, setRoute] = useState(null);
  const [riderIdx, setRiderIdx] = useState(0);
  const [ridePlaying, setRidePlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [rideKmh, setRideKmh] = useState(25);

  // which toolbar menu is open: 'places', 'routes' or null
  const [menu, setMenu] = useState(null);
  const [routeError, setRouteError] = useState(null);
  const [notice, setNotice] = useState(null);
  // the readout, the time bar and the route details can each be folded down to one line
  const [folded, setFolded] = useState(initialFolded);

  // what the map shows once it has come to rest: { bounds, center, zoom }
  const [view, setView] = useState(null);
  const [mapMoving, setMapMoving] = useState(false);
  // false while the start-up position fix may still move the map somewhere else
  const [viewReady, setViewReady] = useState(() => !navigator.geolocation);

  const mapRef = useRef(null);
  const readoutRef = useRef(null);
  const dockRef = useRef(null);
  const toolbarRef = useRef(null);
  const placesButtonRef = useRef(null);
  const routesButtonRef = useRef(null);
  const [startView] = useState(initialView);
  // true once the user (or a successful start-up GPS fix) has decided what the map shows
  const viewClaimed = useRef(false);
  const loadId = useRef(0);
  const trackCount = useRef(0);
  const riderIdxRef = useRef(0);
  // counts the times the rider was placed by hand or by opening a route, see the playback below
  const rideRun = useRef(0);
  const placesRef = useRef(places);
  const viewAsked = useRef(false);

  const notify = useCallback((text, action = null) => setNotice({ text, action, id: Date.now() }), []);

  const updatePlaces = useCallback((next) => {
    placesRef.current = next;
    setPlaces(next);
    savePlaces(next);
  }, []);

  // Places saved or removed in another window of the app are taken over here. Without this, the next
  // change made in this window would write its older list over them.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== PLACES_KEY) return;
      const latest = loadPlaces();
      placesRef.current = latest;
      setPlaces(latest);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // ----- focus -----
  const riderPoint = route ? route.points[Math.min(riderIdx, route.points.length - 1)] : null;
  const followingRider = focus.type === 'rider' && route !== null;

  const focusPlace = useMemo(() => {
    if (focus.type === 'rider' && riderPoint) {
      const km = riderPoint.distance.toFixed(1);
      return { lat: riderPoint.lat, lng: riderPoint.lng, title: `${route.name}, km ${km}`, shortTitle: `km ${km}`, place: `km ${km}` };
    }
    if (focus.type === 'pin') {
      const coordinates = `${focus.lat.toFixed(3)}, ${focus.lng.toFixed(3)}`;
      return {
        lat: focus.lat,
        lng: focus.lng,
        title: focus.name ?? 'Pinned point',
        place: focus.name ?? 'the pinned point',
        note: focus.name ? focus.region || coordinates : coordinates,
        zone: focus.zone,
      };
    }
    if (focus.type === 'me' && user) {
      return { lat: user.lat, lng: user.lng, title: 'My location', place: 'your location', note: 'Your GPS position.', zone: DEVICE_ZONE };
    }
    const place = places.find((p) => p.id === focus.id) ?? places[0];
    if (!place) return null;
    return { id: place.id, lat: place.lat, lng: place.lng, title: place.name, place: place.label || place.name, note: place.desc || place.region, zone: place.zone };
  }, [focus, riderPoint, route, user, places]);
  const focusedPlaceId = focusPlace?.id ?? null;

  // The time bar describes one fixed place. While following the rider that place is the start of the
  // route, so the bars answer "when should I leave" and do not change with every step of the ride.
  // With nothing in focus they describe the middle of the map.
  const barsSpot = followingRider ? route.points[0] : focusPlace;
  const barsLat = barsSpot?.lat ?? view?.center.lat ?? null;
  const barsLng = barsSpot?.lng ?? view?.center.lng ?? null;
  const barsPlace = followingRider ? 'the start' : focusPlace ? focusPlace.place : 'the centre of the map';
  const barsOptions = barsSpot ? POINT : undefined;

  // Times are shown in the local time of that place: the zone it is known to be in, or the zone of the
  // nearest forecast point, or (until one is loaded) the device's own.
  const knownZone = followingRider ? null : validZone(focusPlace?.zone);
  const zone = useMemo(() => {
    if (knownZone) return knownZone;
    return (barsLat !== null && validZone(wind.zoneAt(barsLat, barsLng))) || DEVICE_ZONE;
  }, [knownZone, wind, barsLat, barsLng]);

  // ----- time -----
  // the hour in progress, as that place's clock counts hours
  const hourBase = hourStart(nowSec, zone);
  const firstHour = hourBase - HOURS_BACK * HOUR;
  const lastHour = hourBase + HOURS_AHEAD * HOUR;

  // When the clock catches up with an hour that was picked in advance, go back to following the clock.
  const [seenHour, setSeenHour] = useState(hourBase);
  if (hourBase !== seenHour) {
    setSeenHour(hourBase);
    if (selectedTime !== null && selectedTime <= hourBase) setSelectedTime(null);
  }

  const followingNow = selectedTime === null;
  // the chosen hour as one of the bars
  const selectedHour = followingNow
    ? hourBase
    : clamp(hourBase + Math.round((selectedTime - hourBase) / HOUR) * HOUR, firstHour, lastHour);
  // The moment the map shows, in unix seconds. "Now" is the current minute, read between the two forecast
  // hours around it, not the last full hour.
  const shownTime = followingNow ? Math.floor(nowSec) : selectedHour;

  const selectHour = useCallback((time) => setSelectedTime(time === hourBase ? null : time), [hourBase]);

  useEffect(() => {
    if (!forecastPlaying) return undefined;
    const timer = setInterval(() => {
      setSelectedTime((prev) => {
        const current = prev === null ? hourBase : prev;
        const next = current >= lastHour ? hourBase : current + HOUR;
        return next === hourBase ? null : next;
      });
    }, 650);
    return () => clearInterval(timer);
  }, [forecastPlaying, hourBase, lastHour]);

  // ----- wind -----
  const frame = useMemo(() => wind.frame(shownTime), [wind, shownTime]);

  const routeNodes = useMemo(() => (route ? nodesAlong(route.points, ROUTE_MAX_POINTS) : []), [route]);
  const routeLevel = routeNodes.length > 0 ? routeNodes[0].level : 0;
  // the rider is somewhere else at every moment, so each point of a route is read at its own time
  const forecastAlong = useMemo(
    () => ({ sample: (lat, lng, hour) => wind.sample(lat, lng, hour * HOUR, { maxLevel: routeLevel, late: true }) }),
    [wind, routeLevel],
  );
  const analysis = useMemo(
    () => (route ? analyseRoute(route, forecastAlong, shownTime / HOUR, rideKmh) : null),
    [route, forecastAlong, shownTime, rideKmh],
  );
  // a route with no forecast for most of its length has no wind to colour it with
  const routeHasWind = analysis !== null && analysis.outsideKm < route.totalDistance * 0.5;
  const routeState = wind.state(routeNodes);

  // The same ride the other way round, at the same moment, when the wind makes it clearly easier. It
  // reads the same forecast points, so it costs no download. A route that comes back by the road it went
  // out on is the same ride either way, and is not offered the other way round at all.
  // (A route that has been turned round can always be turned back, whatever that test makes of it now.)
  const routeTurned = useMemo(() => (route && (route.reversed || !retracesItself(route)) ? reverseRoute(route) : null), [route]);
  const flipEasier = useMemo(() => {
    if (!routeTurned || !routeHasWind) return false;
    const turned = analyseRoute(routeTurned, forecastAlong, shownTime / HOUR, rideKmh);
    return turned.windScore <= analysis.windScore - FLIP_MARGIN;
  }, [routeTurned, routeHasWind, analysis, forecastAlong, shownTime, rideKmh]);

  // The ride as it would go leaving at each hour of the time bar. It is worked out again only when the
  // forecast for the part of the world the route is in changes, not with every download for the rest of
  // the map. The hour in progress has partly gone: a ride in it leaves now, worked out every minute.
  const leavingNow = Math.floor(nowSec);
  const routeBounds = useMemo(() => {
    if (!route) return null;
    // the forecast points around the route, at the coarsest lattice it reads from
    const margin = stepOf(routeLevel);
    const lats = route.points.map((p) => p.lat);
    const lngs = route.points.map((p) => p.lng);
    return {
      south: Math.min(...lats) - margin,
      north: Math.max(...lats) + margin,
      west: Math.min(...lngs) - margin,
      east: Math.max(...lngs) + margin,
    };
  }, [route, routeLevel]);
  const routeStamp = useMemo(() => (routeBounds ? wind.stamp(routeBounds) : ''), [wind, routeBounds]);
  // The plan of a ride is told on the clock of the place it starts from, also while the readout and the
  // time bar are on a place in another time zone.
  const routeStart = route ? route.points[0] : null;
  const routeZone = useMemo(() => {
    if (!routeStart) return zone;
    return validZone(wind.zoneAt(routeStart.lat, routeStart.lng)) || zone;
  }, [routeStart, wind, zone]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- routeStamp stands for what the scan reads
  const scanForecast = useMemo(() => forecastAlong, [routeStamp, routeLevel]);
  const hourly = useMemo(() => {
    if (!route) return null;
    const times = [];
    for (let time = firstHour; time <= lastHour; time += HOUR) times.push(time);
    return scanDepartures(route, scanForecast, times.map((time) => time / HOUR), rideKmh).map((ride, i) => ({
      ...ride,
      time: times[i],
      day: formatDay(times[i], routeZone),
      dark: darkChecks(route, times[i], rideKmh),
    }));
  }, [route, scanForecast, rideKmh, firstHour, lastHour, routeZone]);
  const departures = useMemo(() => {
    if (!hourly) return null;
    const [leaving] = scanDepartures(route, scanForecast, [leavingNow / HOUR], rideKmh);
    return hourly.map((ride) => {
      if (ride.time !== hourBase) return { ...ride, past: ride.time < hourBase };
      return { ...ride, ...leaving, time: ride.time, past: false, dark: darkChecks(route, leavingNow, rideKmh) };
    });
  }, [hourly, route, scanForecast, rideKmh, hourBase, leavingNow]);

  // The best time to leave today and tomorrow, and on the day after when the bar holds all of its light.
  const best = useMemo(() => {
    if (!departures) return { windows: [], unlit: false };
    const start = route.points[0];
    const days = [...new Set(departures.map((d) => d.day))];
    const today = formatDay(hourBase, routeZone);
    // the day that follows today on the bar, not the day 24 hours on: the two differ on the evening
    // before the clocks go forward
    const tomorrow = days[days.indexOf(today) + 1];
    const asked = days.filter((day, i) => {
      if (day === today || day === tomorrow) return true;
      if (i !== days.indexOf(tomorrow) + 1) return false;
      // The whole of its light is on the bar: after a dark hour comes a lit one, and after that a dark
      // one again. (Dusk alone will not do: far north in summer, the twilight of the evening before
      // runs past midnight.)
      const lit = departures.filter((d) => d.day === day).map((d) => isRidingLight(d.time, start.lat, start.lng));
      const dawn = lit.findIndex((on, j) => on && j > 0 && !lit[j - 1]);
      return dawn > 0 && lit.slice(dawn).includes(false);
    });
    const { windows, unlit } = bestWindows(departures, asked);
    const label = (time) => (time === hourBase ? 'now' : formatClock(time, routeZone));
    return {
      windows: windows.map((w) => ({
        ...w,
        dayLabel: w.day === today ? 'today' : w.day === tomorrow ? 'tomorrow' : w.day,
        fromLabel: label(w.from),
        toLabel: w.to === w.from ? null : label(w.to),
      })),
      // said while there is still light to see by: after dark it goes without saying
      unlit: unlit.includes(today) && isRidingLight(leavingNow, start.lat, start.lng),
    };
  }, [departures, route, hourBase, leavingNow, routeZone]);

  const routeStops = useMemo(() => {
    if (!route || !analysis || !routeHasWind) return null;
    return routeGradient(route, analysis.wind.map((w) => w.head), theme);
  }, [route, analysis, routeHasWind, theme]);

  const riderWind = analysis ? analysis.wind[Math.min(riderIdx, analysis.wind.length - 1)] : null;
  const onRoute = focus.type === 'rider' && riderPoint !== null && riderWind !== null;

  const focusNodes = useMemo(() => (barsSpot ? nodesAround(0, barsSpot.lat, barsSpot.lng) : []), [barsSpot]);

  const reading = useMemo(() => {
    if (onRoute) return riderWind.outside ? null : riderWind;
    return focusPlace ? wind.sample(focusPlace.lat, focusPlace.lng, shownTime, POINT) : null;
  }, [onRoute, riderWind, focusPlace, wind, shownTime]);

  // when the forecast behind the reading was downloaded
  const readingAge = useMemo(() => {
    if (!reading) return null;
    if (!onRoute) return reading.fetchedAt;
    return wind.sample(riderPoint.lat, riderPoint.lng, shownTime, { maxLevel: routeLevel, late: true })?.fetchedAt ?? null;
  }, [reading, onRoute, riderPoint, wind, shownTime, routeLevel]);

  const focusState = onRoute ? routeState : wind.state(focusNodes);
  const status = !focusPlace ? 'empty' : reading ? 'ready' : focusState === 'loading' ? 'loading' : focusState === 'failed' ? 'error' : 'none';
  const problem = wind.problem?.kind ?? null;
  // an old forecast that could not be renewed is still shown, and the readout says how old it is
  const readingStale = problem !== null && readingAge !== null && now - readingAge > STALE_MS;

  const riderInfo = useMemo(() => {
    if (!riderPoint || !riderWind) return null;
    return {
      lat: riderPoint.lat,
      lng: riderPoint.lng,
      bearing: riderPoint.bearing,
      // still air has no direction to draw
      from: routeHasWind && !riderWind.outside && riderWind.speed >= CALM_KMH ? riderWind.from : null,
      head: riderWind.head,
      cross: riderWind.cross,
      color: effectColor(riderWind.head, theme),
    };
  }, [riderPoint, riderWind, routeHasWind, theme]);

  // the time shown next to the place: for the rider, when they get to that point
  const whenLabel = useMemo(() => {
    // a clock that is not the reader's own says which one it is
    const stamp = (time) => {
      const offset = zoneLabel(time, zone);
      return `${formatDayClock(time, zone)}${offset && ` ${offset}`}`;
    };
    if (!onRoute) return stamp(shownTime);
    const arrival = stamp(shownTime + (riderPoint.distance / rideKmh) * HOUR);
    return riderPoint.distance < 0.05 ? `leaving ${arrival}` : `arriving ${arrival}`;
  }, [shownTime, zone, onRoute, riderPoint, rideKmh]);

  const spots = useMemo(() => places.map((place) => {
    const here = wind.sample(place.lat, place.lng, shownTime, POINT);
    return {
      id: place.id,
      label: place.label || place.name,
      lat: place.lat,
      lng: place.lng,
      anchor: place.anchor,
      speed: here?.speed,
      from: here?.from,
      selected: place.id === focusedPlaceId,
    };
  }), [places, wind, shownTime, focusedPlaceId]);

  const pin = useMemo(() => (focus.type === 'pin' ? { lat: focus.lat, lng: focus.lng } : null), [focus]);

  const series = useMemo(() => {
    const hours = [];
    for (let time = firstHour; time <= lastHour; time += HOUR) {
      const here = barsLat === null ? null : wind.sample(barsLat, barsLng, time, barsOptions);
      hours.push({
        time,
        speed: here ? here.speed : null,
        gust: here ? here.gust : null,
        from: here ? here.from : null,
        rain: here ? here.rain : NaN,
        rainChance: here ? here.rainChance : NaN,
      });
    }
    return hours;
  }, [wind, firstHour, lastHour, barsLat, barsLng, barsOptions]);
  const nowReading = followingNow && barsLat !== null ? wind.sample(barsLat, barsLng, shownTime, barsOptions) : null;

  // ----- what the store is asked to download -----
  useEffect(() => {
    store.want('focus', focusNodes);
  }, [store, focusNodes]);

  useEffect(() => {
    store.want('route', routeNodes);
  }, [store, routeNodes]);

  // ----- measured wind -----
  // What the nearest weather station measured, beside what the forecast said for that station and that
  // hour. Only while the readout shows the present: a measurement says nothing about tomorrow, nor about
  // a point of the route the rider only gets to later.
  const readingNow = followingNow && (focus.type !== 'rider' || (riderIdx === 0 && !ridePlaying));
  // readings older than that are left out, so a station nearby that has gone quiet gives way to the next one
  const measuredSince = Math.floor((nowSec - MEASURED_MAX_AGE) / 60) * 60;
  const station = useObserved(focusPlace?.lat, focusPlace?.lng, readingNow, measuredSince);
  // The forecast around the station is asked for when the station changes, not every minute: the station
  // is looked up afresh as the clock ticks, and each asking makes the store look at everything it holds.
  const stationLat = station ? station.lat : null;
  const stationLng = station ? station.lng : null;
  const stationNodes = useMemo(() => (stationLat === null ? [] : nodesAround(0, stationLat, stationLng)), [stationLat, stationLng]);
  useEffect(() => {
    store.want('station', stationNodes);
  }, [store, stationNodes]);
  const measured = useMemo(() => {
    if (!station || nowSec - station.time > MEASURED_MAX_AGE || station.time > nowSec + HOUR) return null;
    return {
      name: station.name,
      km: station.km,
      clock: formatClock(station.time, zone),
      speed: station.speed,
      from: station.from,
      forecast: wind.sample(station.lat, station.lng, station.time, POINT)?.speed ?? null,
    };
  }, [station, nowSec, zone, wind]);

  // The map view only counts once it has stopped moving. It is covered by the finest lattice that does
  // not take more points than the allowance for a view.
  const settledView = viewReady && !mapMoving ? view : null;
  const viewNodes = useMemo(() => {
    if (!settledView) return [];
    return nodesInBounds(levelForBounds(settledView.bounds, VIEW_MAX_POINTS), settledView.bounds);
  }, [settledView]);
  // the labels of the saved places in view carry their own wind, read as closely as a place in focus
  const placeNodes = useMemo(() => {
    if (!settledView) return [];
    const inView = places.filter((p) => inBounds(settledView.bounds, p.lat, p.lng)).slice(0, PLACES_WITH_WIND);
    return inView.flatMap((p) => nodesAround(0, p.lat, p.lng));
  }, [settledView, places]);

  // the view the app opens on is asked for at once; later ones once the map has settled
  useEffect(() => {
    const delay = viewAsked.current ? VIEW_SETTLE_MS : 0;
    store.want('view', viewNodes, delay);
    store.want('places', placeNodes, delay);
    if (viewNodes.length > 0) viewAsked.current = true;
  }, [store, viewNodes, placeNodes]);

  // how far the wind for the part of the map on screen is: 'ready' | 'loading' | 'failed'
  const viewState = wind.state(viewNodes);

  // ----- menus -----
  const closeMenu = useCallback((returnTo = null) => {
    setMenu(null);
    returnTo?.current?.focus();
  }, []);

  const toggleMenu = (name) => {
    if (menu !== name && name === 'routes') setRouteError(null);
    setMenu(menu === name ? null : name);
  };

  useEffect(() => {
    if (!menu) return undefined;
    const button = menu === 'places' ? placesButtonRef : routesButtonRef;
    const onKey = (e) => e.key === 'Escape' && closeMenu(button);
    // a tap on any panel closes the menu; a tap on the map is handled in handlePick so it does not also drop a pin
    const onPointerDown = (e) => {
      if (!e.target.closest('.toolbar-menu') && !e.target.closest('.wind-map')) closeMenu();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menu, closeMenu]);

  // ----- places -----
  const showPlace = (place, returnTo = null) => {
    viewClaimed.current = true;
    closeMenu(returnTo);
    setFocus({ type: 'place', id: place.id });
    mapRef.current?.focusOn(place.lat, place.lng, 11);
  };

  // a search result is a pinned point with a name, which can then be saved as a place
  const showResult = (result) => {
    viewClaimed.current = true;
    closeMenu(placesButtonRef);
    setFocus({
      type: 'pin',
      lat: result.lat,
      lng: result.lng,
      name: result.name ?? null,
      region: result.region || null,
      zone: validZone(result.zone),
    });
    mapRef.current?.focusOn(result.lat, result.lng, 11);
  };

  const saveFocus = (name) => {
    if (!focusPlace) return;
    const place = makePlace(name, focusPlace.lat, focusPlace.lng, {
      region: focus.type === 'pin' ? focus.region : null,
      zone: validZone(focusPlace.zone),
    });
    updatePlaces([...placesRef.current, place]);
    setFocus({ type: 'place', id: place.id });
  };

  const removeFocus = () => {
    const current = placesRef.current;
    const index = current.findIndex((p) => p.id === focusedPlaceId);
    if (index < 0) return;
    const place = current[index];
    updatePlaces(current.filter((p) => p !== place));
    // the point stays in focus as a pin, so the map and the readout do not jump somewhere else
    setFocus({ type: 'pin', lat: place.lat, lng: place.lng, name: place.name, region: place.region ?? null, zone: validZone(place.zone) });
    notify(`Removed ${place.name} from your places.`, {
      label: 'Undo',
      run: () => {
        const latest = placesRef.current;
        if (!latest.some((p) => p.id === place.id)) {
          const restored = [...latest];
          restored.splice(Math.min(index, restored.length), 0, place);
          updatePlaces(restored);
        }
        setFocus({ type: 'place', id: place.id });
        setNotice(null);
      },
    });
  };

  // ----- route -----
  const openRoute = useCallback((parsed) => {
    viewClaimed.current = true;
    rideRun.current++;
    // `track` tells the map one opened route from another, whichever way round it is ridden
    setRoute({ ...parsed, track: ++trackCount.current });
    setRiderIdx(0);
    setRidePlaying(false);
    setFocus(toRider);
    setRouteError(null);
    closeMenu(routesButtonRef);
  }, [closeMenu]);

  const loadPreset = useCallback(async (preset) => {
    // only the route asked for last is opened, however the downloads happen to finish
    const id = ++loadId.current;
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}routes/${preset.filename}`);
      if (!response.ok) throw new Error(`Could not load ${preset.name}.`);
      const parsed = parseGpxData(await response.text(), preset.name);
      parsed.id = preset.id;
      if (id === loadId.current) openRoute(parsed);
    } catch (err) {
      if (id !== loadId.current) return;
      setRouteError(err instanceof TypeError ? `Could not load ${preset.name}. Check your connection.` : err.message);
    }
  }, [openRoute]);

  const loadFile = useCallback(async (file) => {
    const id = ++loadId.current;
    if (!/\.gpx$/i.test(file.name)) {
      setRouteError('Only .gpx files can be opened.');
      setMenu('routes');
      return;
    }
    try {
      const parsed = parseGpxData(await file.text(), file.name.replace(/\.gpx$/i, '').replace(/[_-]+/g, ' ').trim());
      if (id === loadId.current) openRoute(parsed);
    } catch (err) {
      if (id !== loadId.current) return;
      setRouteError(err.message || 'Could not read this GPX file.');
      setMenu('routes');
    }
  }, [openRoute]);

  const clearRoute = () => {
    rideRun.current++;
    setRoute(null);
    setRidePlaying(false);
    if (focus.type !== 'rider') return;
    // the readout goes back to what it was on before the route
    const back = focus.back ?? { type: 'place', id: places[0]?.id };
    setFocus(back);
    const target = back.type === 'pin' ? back : back.type === 'me' ? user : places.find((p) => p.id === back.id) ?? places[0];
    // nothing to do when it is on the map already (which cannot be told while the map is still on its way somewhere)
    if (!target || (view && !mapMoving && inBounds(view.bounds, target.lat, target.lng))) return;
    // it is somewhere else: wait a frame, so the route panel is gone before the map measures the room it has
    requestAnimationFrame(() => mapRef.current?.focusOn(target.lat, target.lng, 10));
  };

  // the same route ridden the other way: the plan starts over from the new start
  const flipRoute = () => {
    if (!routeTurned) return;
    rideRun.current++;
    setRoute(routeTurned);
    setRiderIdx(0);
    setRidePlaying(false);
    setFocus(toRider);
  };

  // a best time to leave picked from the route panel: the plan is for then, and the readout is back on the rider
  const leaveAt = (time) => {
    selectHour(time);
    setFocus(toRider);
  };

  const lastRoutePoint = route ? route.points.length - 1 : 0;
  const isRiding = ridePlaying && route !== null && riderIdx < lastRoutePoint;

  useEffect(() => {
    riderIdxRef.current = riderIdx;
  }, [riderIdx]);

  // moving along the profile by hand always takes over from the playback
  const scrubRoute = useCallback((index) => {
    rideRun.current++;
    setRidePlaying(false);
    setRiderIdx(index);
    setFocus(toRider);
  }, []);

  const toggleRide = () => {
    rideRun.current++;
    if (isRiding) {
      setRidePlaying(false);
      return;
    }
    if (riderIdx >= lastRoutePoint) setRiderIdx(0);
    setFocus(toRider);
    setRidePlaying(true);
  };

  useEffect(() => {
    if (!isRiding) return undefined;
    const run = rideRun.current;
    const timer = setInterval(() => {
      // The rider was put somewhere else (a tap on the profile, another route) and this timer has not
      // been cleared yet: one more step from here would move them off that spot.
      if (run !== rideRun.current) return;
      const next = Math.min(lastRoutePoint, riderIdxRef.current + 1);
      riderIdxRef.current = next;
      setRiderIdx(next);
      if (next >= lastRoutePoint) setRidePlaying(false);
    }, Math.max(20, RIDE_TICK_MS / playbackRate));
    return () => clearInterval(timer);
  }, [isRiding, lastRoutePoint, playbackRate]);

  // a GPX file dropped anywhere on the window opens as a route
  useEffect(() => {
    const allow = (e) => e.preventDefault();
    const drop = (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file) loadFile(file);
    };
    window.addEventListener('dragover', allow);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', allow);
      window.removeEventListener('drop', drop);
    };
  }, [loadFile]);

  // ----- a route to the place in focus -----
  // Where the rider is: the last fix, or a fresh one. Rejects with what to tell the user.
  const whereAmI = () => new Promise((resolve, reject) => {
    if (user) {
      resolve(user);
      return;
    }
    if (!navigator.geolocation) {
      reject(new Error('This device does not share its location, so there is no start for the route.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const here = { lat: position.coords.latitude, lng: position.coords.longitude };
        setUser(here);
        resolve(here);
      },
      (error) => reject(new Error(error.code === GEO_TIMEOUT
        ? 'Still looking for your position. Try again in a moment.'
        : 'Could not get your location, which the route would start from. Check that location is switched on.')),
      GEO_PRECISE,
    );
  });

  // A road-bike route from where the rider is to the place in focus, by the roads a routing service picks,
  // opened like a GPX file: there, or there and back.
  const routeHere = async () => {
    if (!focusPlace || routing) return;
    // only the route asked for last is opened, like a file or a preset
    const id = ++loadId.current;
    setRouting(id);
    const to = { lat: focusPlace.lat, lng: focusPlace.lng };
    const name = roundTrip
      ? `${focusPlace.place[0].toUpperCase()}${focusPlace.place.slice(1)} and back`
      : `To ${focusPlace.place}`;
    try {
      const from = await whereAmI();
      if (id !== loadId.current) return;
      // the start is only ever one place: a ride that leaves from where the map was tapped is not one
      if (calculateDistance(from.lat, from.lng, to.lat, to.lng) < 0.05) throw new Error('You are there already.');
      const { gpx, by } = await fetchBikeRoute(roundTrip ? [from, to, from] : [from, to]);
      if (id !== loadId.current) return;
      const parsed = parseGpxData(gpx, name);
      parsed.routedBy = by;
      openRoute(parsed);
    } catch (error) {
      if (id !== loadId.current) return;
      notify(error instanceof RoutingError || error.message ? error.message : 'No route could be made.');
    } finally {
      setRouting((current) => (current === id ? 0 : current));
    }
  };

  const toggleRoundTrip = () => {
    setRoundTrip((on) => {
      try {
        localStorage.setItem(ROUND_TRIP_KEY, String(!on));
      } catch {
        // the choice just will not be remembered
      }
      return !on;
    });
  };

  // ----- location -----
  const showPosition = useCallback((lat, lng, onStart) => {
    setUser({ lat, lng });
    // a slow start-up fix must not pull the map away from what the user has opened meanwhile
    if (onStart && viewClaimed.current) return;
    viewClaimed.current = true;
    setFocus({ type: 'me' });
    mapRef.current?.focusOn(lat, lng, 13);
  }, []);

  const locate = () => {
    if (!navigator.geolocation) {
      notify('This device does not share its location.');
      return;
    }
    viewClaimed.current = true;
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setIsLocating(false);
        showPosition(position.coords.latitude, position.coords.longitude, false);
      },
      (error) => {
        setIsLocating(false);
        notify(error.code === GEO_TIMEOUT
          ? 'Still looking for your position. Try again in a moment.'
          : 'Could not get your location. Check that location is switched on.');
      },
      GEO_PRECISE,
    );
  };

  // Try once on start, quietly: if it works the map opens on the rider. The wind for the opening view
  // waits a moment for that answer, so it is not downloaded for a place the map is about to leave.
  useEffect(() => {
    if (!navigator.geolocation) return undefined;
    const release = () => setViewReady(true);
    const timer = setTimeout(release, START_HOLD_MS);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        showPosition(position.coords.latitude, position.coords.longitude, true);
        release();
      },
      release,
      GEO_QUICK,
    );
    return () => clearTimeout(timer);
  }, [showPosition]);

  // ----- map callbacks -----
  const handlePick = useCallback((lat, lng) => {
    if (menu) {
      // tapping the map with a menu open only closes the menu
      closeMenu();
      return;
    }
    viewClaimed.current = true;
    setFocus({ type: 'pin', lat, lng, name: null, region: null, zone: null });
  }, [menu, closeMenu]);

  const handleSpot = (id) => {
    const place = places.find((p) => p.id === id);
    if (place) showPlace(place);
  };

  // once the map has been moved by hand, a late GPS fix does not move it again
  const handleUserMove = useCallback(() => {
    viewClaimed.current = true;
  }, []);

  const handleMoveStart = useCallback(() => setMapMoving(true), []);

  const handleViewChange = useCallback((next) => {
    setView(next);
    setMapMoving(false);
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: next.center.lat, lng: next.center.lng, zoom: next.zoom }));
    } catch {
      // the view just will not be remembered
    }
  }, []);

  // room the floating panels take, so the map fits things into what is left
  const getPadding = useCallback(() => {
    const readout = readoutRef.current;
    const dockHeight = dockRef.current?.offsetHeight ?? 0;
    if (window.innerWidth <= NARROW_SCREEN) {
      return { top: (readout?.offsetHeight ?? 0) + 28, bottom: dockHeight + 76, left: 18, right: 18 };
    }
    return { top: 28, bottom: dockHeight + 36, left: (readout?.offsetWidth ?? 0) + 40, right: 60 };
  }, []);

  // where the floating panels are, so the map draws no wind arrow half under one of them
  const getCovered = useCallback(
    () => [readoutRef, toolbarRef, dockRef].map((panel) => panel.current?.getBoundingClientRect()).filter(Boolean),
    [],
  );

  // ----- page-level effects -----
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.setProperty('--tail', MAP_THEMES[theme].tail);
    root.style.setProperty('--head', MAP_THEMES[theme].head);
    root.style.setProperty('--cross', MAP_THEMES[theme].neutral);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', MAP_THEMES[theme].sea);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // the choice just will not be remembered
    }
  }, [theme]);

  // on a phone, the clock and the icons of the status bar are drawn to be read on the map shown
  useSystemBars(theme);

  // the place or point in focus is where the readout starts next time
  useEffect(() => {
    if (focus.type !== 'place' && focus.type !== 'pin') return;
    try {
      localStorage.setItem(FOCUS_KEY, JSON.stringify(focus));
    } catch {
      // it just will not be remembered
    }
  }, [focus]);

  useEffect(() => {
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify(folded));
    } catch {
      // it just will not be remembered
    }
  }, [folded]);

  // map controls sit above the dock, whatever its height
  useEffect(() => {
    const dock = dockRef.current;
    const observer = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--dock-h', `${dock.offsetHeight}px`);
    });
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), notice.action ? 9000 : 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const colors = MAP_THEMES[theme];
  // the place in focus can be saved, or removed if it already is one; the rider on a route is neither
  const savable = followingRider || !focusPlace ? null : {
    key: focusedPlaceId ? `place:${focusedPlaceId}` : focus.type === 'pin' ? `pin:${focus.lat},${focus.lng}` : 'me',
    saved: focusedPlaceId !== null,
    name: focus.type === 'pin' ? focus.name : null,
  };
  // a route can be asked for to a place or a pinned point, not to where the rider is or to the rider on a route
  const go = savable && focus.type !== 'me' ? {
    busy: routing !== 0,
    roundTrip,
    maxKm: ROUTE_MAX_KM,
    onGo: routeHere,
    onToggleRoundTrip: toggleRoundTrip,
  } : null;

  return (
    <div className="app">
      <WindMap
        ref={mapRef}
        theme={theme}
        initialView={startView}
        frame={frame}
        flowEnabled={flowEnabled}
        spots={spots}
        route={route}
        routeStops={routeStops}
        rider={riderInfo}
        pin={pin}
        user={user}
        onPick={handlePick}
        onSpot={handleSpot}
        onUserMove={handleUserMove}
        onMoveStart={handleMoveStart}
        onViewChange={handleViewChange}
        getPadding={getPadding}
        getCovered={getCovered}
      />

      <WindReadout
        ref={readoutRef}
        title={focusPlace ? focusPlace.title : 'Wind'}
        shortTitle={focusPlace?.shortTitle}
        when={focusPlace ? whenLabel : null}
        reading={reading}
        rider={onRoute && routeHasWind ? riderInfo : null}
        note={focusPlace?.note}
        status={status}
        problem={problem}
        updatedAt={readingAge ? formatDayClock(readingAge / 1000, zone) : null}
        stale={readingStale}
        quiet={isRiding || forecastPlaying}
        place={savable}
        go={go}
        measured={measured}
        onSave={saveFocus}
        onRemove={removeFocus}
        onRetry={store.retry}
        collapsed={folded.readout}
        onToggleCollapsed={() => setFolded((prev) => ({ ...prev, readout: !prev.readout }))}
      />

      <div className="toolbar" ref={toolbarRef}>
        <div className="toolbar-menu">
          <button
            ref={placesButtonRef}
            type="button"
            className="tool-button panel"
            aria-label="Search places"
            aria-expanded={menu === 'places'}
            aria-controls={PLACES_MENU_ID}
            onClick={() => toggleMenu('places')}
          >
            <MagnifyingGlass size={18} aria-hidden="true" />
            <span>Search</span>
          </button>
          {menu === 'places' && (
            <PlacesMenu
              id={PLACES_MENU_ID}
              places={places}
              activeId={focusedPlaceId}
              onPlace={(place) => showPlace(place, placesButtonRef)}
              onResult={showResult}
            />
          )}
        </div>
        <div className="toolbar-menu">
          <button
            ref={routesButtonRef}
            type="button"
            className="tool-button panel"
            aria-label="Routes"
            aria-expanded={menu === 'routes'}
            aria-controls={ROUTES_MENU_ID}
            onClick={() => toggleMenu('routes')}
          >
            <Path size={18} aria-hidden="true" />
            <span>Routes</span>
          </button>
          {menu === 'routes' && (
            <RoutesMenu id={ROUTES_MENU_ID} activeId={route?.id} error={routeError} onPreset={loadPreset} onFile={loadFile} />
          )}
        </div>
        <button
          type="button"
          className="tool-button panel"
          aria-label="Wind motion"
          aria-pressed={flowEnabled}
          title="Animate the wind on the map"
          onClick={() => setFlowEnabled((on) => !on)}
        >
          <Wind size={18} aria-hidden="true" />
          <span>Motion</span>
        </button>
        <button
          type="button"
          className="tool-button panel"
          aria-label={theme === 'dark' ? 'Switch to the day map' : 'Switch to the night map'}
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
          <span>{theme === 'dark' ? 'Day map' : 'Night map'}</span>
        </button>
        <button
          type="button"
          className="tool-button panel"
          aria-label="Locate me"
          aria-pressed={focus.type === 'me'}
          disabled={isLocating}
          onClick={locate}
        >
          <Crosshair size={18} aria-hidden="true" />
          <span>{isLocating ? 'Locating…' : 'Locate me'}</span>
        </button>
      </div>

      {/* the readout already says so when the place in focus could not be loaded either */}
      {(viewState === 'loading' || (viewState === 'failed' && status !== 'error')) && (
        <p className={`map-status panel ${viewState}`} role="status">
          {viewState === 'loading' ? 'Loading the wind…' : (
            <>
              The wind for this part of the map could not be loaded.{' '}
              <button type="button" className="text-button" onClick={store.retry}>Try again</button>
            </>
          )}
        </p>
      )}

      {notice && (
        <p key={notice.id} className="notice panel" role="status">
          {notice.text}
          {notice.action && (
            <>
              {' '}
              <button type="button" className="text-button" onClick={notice.action.run}>{notice.action.label}</button>
            </>
          )}
        </p>
      )}

      <div className="dock" ref={dockRef}>
        {route && (
          <RoutePanel
            route={route}
            analysis={analysis}
            windState={routeState}
            riderIdx={riderIdx}
            onScrub={scrubRoute}
            onClear={clearRoute}
            playing={isRiding}
            onTogglePlay={toggleRide}
            playbackRate={playbackRate}
            onPlaybackRate={setPlaybackRate}
            rideKmh={rideKmh}
            onRideKmh={setRideKmh}
            startLabel={followingNow ? `now (${formatClock(shownTime, routeZone)})` : formatDayClock(shownTime, routeZone)}
            bestTimes={best.windows}
            noLightToday={best.unlit}
            leavingAt={selectedHour}
            onLeaveAt={leaveAt}
            onFlip={routeTurned ? flipRoute : null}
            flipEasier={flipEasier}
            collapsed={folded.route}
            onToggleCollapsed={() => setFolded((prev) => ({ ...prev, route: !prev.route }))}
            colors={colors}
          />
        )}
        <TimeBar
          hours={series}
          bestTimes={followingRider ? best.windows : []}
          selected={selectedHour}
          nowTime={hourBase}
          shownTime={shownTime}
          nowReading={nowReading}
          onSelect={selectHour}
          playing={forecastPlaying}
          onTogglePlay={() => setForecastPlaying((playing) => !playing)}
          place={barsPlace}
          zone={zone}
          rideStart={followingRider}
          collapsed={folded.time}
          onToggleCollapsed={() => setFolded((prev) => ({ ...prev, time: !prev.time }))}
        />
      </div>
    </div>
  );
}

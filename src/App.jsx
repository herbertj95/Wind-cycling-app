import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Moon, Path, Sun, Wind } from '@phosphor-icons/react';
import WindMap from './components/WindMap';
import WindReadout from './components/WindReadout';
import TimeBar from './components/TimeBar';
import RoutePanel from './components/RoutePanel';
import RoutesMenu from './components/RoutesMenu';
import { useForecast, useNow } from './hooks/useForecast';
import { SPOTS, buildField, currentHourIndex, inCoverage, sampleField } from './utils/weatherApi';
import { analyseRoute } from './utils/routeAnalysis';
import { parseGpxData } from './utils/gpxParser';
import { CALM_KMH } from './utils/wind';
import { MAP_THEMES, effectColor, routeGradient } from './utils/mapStyle';
import { formatClock, formatDayClock } from './utils/time';
import './App.css';

// Hours of forecast shown on the time bar, relative to now
const HOURS_BACK = 2;
const HOURS_AHEAD = 45;

const DEFAULT_FOCUS = { type: 'spot', id: SPOTS[0].id };
const THEME_KEY = 'wind-theme';
const NARROW_SCREEN = 720;
// ms between rider steps at 1x: a 600-point route plays in a little over a minute
const RIDE_TICK_MS = 120;
const GEO_OPTIONS = { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 };
const MENU_ID = 'routes-menu';

function initialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // storage unavailable: fall through to the system setting
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export default function App() {
  const { forecast, error, loading, retry } = useForecast();
  const now = useNow();

  const [theme, setTheme] = useState(initialTheme);
  const [flowEnabled, setFlowEnabled] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // null follows the clock; otherwise the unix time (s) of the chosen forecast hour
  const [selectedTime, setSelectedTime] = useState(null);
  const [forecastPlaying, setForecastPlaying] = useState(false);

  // What the readout describes: a spot, a tapped point, the rider on the route, or the user's position
  const [focus, setFocus] = useState(DEFAULT_FOCUS);
  const [user, setUser] = useState(null);
  const [isLocating, setIsLocating] = useState(false);

  const [route, setRoute] = useState(null);
  const [riderIdx, setRiderIdx] = useState(0);
  const [ridePlaying, setRidePlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [rideKmh, setRideKmh] = useState(25);

  const [menuOpen, setMenuOpen] = useState(false);
  const [routeError, setRouteError] = useState(null);
  const [notice, setNotice] = useState(null);

  const mapRef = useRef(null);
  const readoutRef = useRef(null);
  const dockRef = useRef(null);
  const routesButtonRef = useRef(null);
  // true once the user (or a successful start-up GPS fix) has decided what the map shows
  const viewClaimed = useRef(false);
  const loadId = useRef(0);
  const riderIdxRef = useRef(0);

  const notify = useCallback((text) => setNotice({ text, id: Date.now() }), []);

  // ----- time -----
  const nowIndex = forecast ? currentHourIndex(forecast.hours, now) : 0;
  const windowStart = Math.max(0, nowIndex - HOURS_BACK);
  const windowEnd = forecast ? Math.min(forecast.hours.length - 1, nowIndex + HOURS_AHEAD) : 0;

  // When the clock catches up with an hour that was picked in advance, go back to following the clock.
  const [seenNowIndex, setSeenNowIndex] = useState(nowIndex);
  if (nowIndex !== seenNowIndex) {
    setSeenNowIndex(nowIndex);
    if (forecast && selectedTime !== null && selectedTime <= forecast.hours[nowIndex]) setSelectedTime(null);
  }

  const followingNow = selectedTime === null;
  const hourIndex = useMemo(() => {
    if (!forecast || selectedTime === null) return nowIndex;
    const i = forecast.hours.indexOf(selectedTime);
    return i < 0 ? nowIndex : clamp(i, windowStart, windowEnd);
  }, [forecast, selectedTime, nowIndex, windowStart, windowEnd]);

  // The moment the map shows, as a (possibly fractional) index into forecast.hours and as unix seconds.
  // "Now" is the current minute, blended between the two hours around it, not the last full hour.
  const hourValue = forecast && followingNow
    ? nowIndex + clamp((now / 1000 - forecast.hours[nowIndex]) / 3600, 0, 1)
    : hourIndex;
  const shownTime = forecast ? (followingNow ? Math.floor(now / 1000) : forecast.hours[hourIndex]) : null;

  const selectHour = useCallback((index) => {
    if (!forecast) return;
    setSelectedTime(index === nowIndex ? null : forecast.hours[index]);
  }, [forecast, nowIndex]);

  useEffect(() => {
    if (!forecastPlaying || !forecast) return undefined;
    const timer = setInterval(() => {
      setSelectedTime((prev) => {
        const current = prev === null ? nowIndex : forecast.hours.indexOf(prev);
        const next = current < 0 || current >= windowEnd ? nowIndex : current + 1;
        return next === nowIndex ? null : forecast.hours[next];
      });
    }, 650);
    return () => clearInterval(timer);
  }, [forecastPlaying, forecast, nowIndex, windowEnd]);

  // ----- wind -----
  const field = useMemo(() => (forecast ? buildField(forecast, hourValue) : null), [forecast, hourValue]);
  const analysis = useMemo(
    () => (route && forecast ? analyseRoute(route, forecast, hourValue, rideKmh) : null),
    [route, forecast, hourValue, rideKmh],
  );
  // a route that mostly lies outside the forecast grid has no wind to colour it with
  const routeHasWind = analysis !== null && analysis.outsideKm < route.totalDistance * 0.5;

  const routeStops = useMemo(() => {
    if (!route || !analysis || !routeHasWind) return null;
    return routeGradient(route, analysis.wind.map((w) => w.head), theme);
  }, [route, analysis, routeHasWind, theme]);

  // ----- focus -----
  const riderPoint = route ? route.points[Math.min(riderIdx, route.points.length - 1)] : null;
  const riderWind = analysis ? analysis.wind[Math.min(riderIdx, analysis.wind.length - 1)] : null;
  const onRoute = focus.type === 'rider' && riderPoint !== null && riderWind !== null;

  const focusPlace = useMemo(() => {
    if (focus.type === 'rider' && riderPoint) {
      const km = riderPoint.distance.toFixed(1);
      return { lat: riderPoint.lat, lng: riderPoint.lng, title: `${route.name}, km ${km}`, place: `km ${km}` };
    }
    if (focus.type === 'pin') {
      return { lat: focus.lat, lng: focus.lng, title: 'Pinned point', place: 'the pinned point', note: `${focus.lat.toFixed(3)}, ${focus.lng.toFixed(3)}` };
    }
    if (focus.type === 'me' && user) {
      return { lat: user.lat, lng: user.lng, title: 'My location', place: 'your location', note: 'Your GPS position.' };
    }
    const spot = SPOTS.find((s) => s.id === focus.id) ?? SPOTS[0];
    return { lat: spot.lat, lng: spot.lng, title: spot.name, place: spot.label, note: spot.desc };
  }, [focus, riderPoint, route, user]);

  const reading = useMemo(() => {
    if (onRoute) return riderWind;
    return field ? sampleField(field, focusPlace.lat, focusPlace.lng) : null;
  }, [onRoute, riderWind, field, focusPlace.lat, focusPlace.lng]);

  const riderInfo = useMemo(() => {
    if (!riderPoint || !riderWind) return null;
    return {
      lat: riderPoint.lat,
      lng: riderPoint.lng,
      bearing: riderPoint.bearing,
      // still air has no direction to draw
      from: routeHasWind && riderWind.speed >= CALM_KMH ? riderWind.from : null,
      head: riderWind.head,
      cross: riderWind.cross,
      color: effectColor(riderWind.head, theme),
    };
  }, [riderPoint, riderWind, routeHasWind, theme]);

  // the time shown next to the place: for the rider, when they get to that point
  const whenLabel = useMemo(() => {
    if (shownTime === null) return null;
    if (!onRoute) return formatDayClock(shownTime);
    const arrival = formatDayClock(shownTime + (riderPoint.distance / rideKmh) * 3600);
    return riderPoint.distance < 0.05 ? `leaving ${arrival}` : `arriving ${arrival}`;
  }, [shownTime, onRoute, riderPoint, rideKmh]);

  const spots = useMemo(() => SPOTS.map((spot) => {
    const wind = field ? sampleField(field, spot.lat, spot.lng) : null;
    return {
      id: spot.id,
      label: spot.label,
      lat: spot.lat,
      lng: spot.lng,
      anchor: spot.anchor,
      speed: wind?.speed,
      from: wind?.from,
      selected: focus.type === 'spot' && focus.id === spot.id,
    };
  }), [field, focus]);

  const pin = useMemo(() => (focus.type === 'pin' ? { lat: focus.lat, lng: focus.lng } : null), [focus]);

  // The time bar describes one fixed place. While following the rider that place is the start of the
  // route, so the bars answer "when should I leave" and do not change with every step of the ride.
  const barsAtStart = focus.type === 'rider' && route !== null;
  const barsLat = barsAtStart ? route.points[0].lat : focusPlace.lat;
  const barsLng = barsAtStart ? route.points[0].lng : focusPlace.lng;
  const series = useMemo(() => {
    if (!forecast) return [];
    const hours = [];
    for (let h = windowStart; h <= windowEnd; h++) {
      const wind = sampleField(buildField(forecast, h), barsLat, barsLng);
      hours.push({ index: h, time: forecast.hours[h], speed: wind.speed, gust: wind.gust });
    }
    return hours;
  }, [forecast, windowStart, windowEnd, barsLat, barsLng]);

  // ----- routes menu -----
  const closeMenu = useCallback((returnFocus = false) => {
    setMenuOpen(false);
    if (returnFocus) routesButtonRef.current?.focus();
  }, []);

  const toggleMenu = () => {
    if (!menuOpen) setRouteError(null);
    setMenuOpen(!menuOpen);
  };

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e) => e.key === 'Escape' && closeMenu(true);
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
  }, [menuOpen, closeMenu]);

  // ----- route -----
  const openRoute = useCallback((parsed) => {
    viewClaimed.current = true;
    setRoute(parsed);
    setRiderIdx(0);
    setRidePlaying(false);
    setFocus({ type: 'rider' });
    setRouteError(null);
    closeMenu(true);
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
      setMenuOpen(true);
      return;
    }
    try {
      const parsed = parseGpxData(await file.text(), file.name.replace(/\.gpx$/i, '').replace(/[_-]+/g, ' ').trim());
      if (id === loadId.current) openRoute(parsed);
    } catch (err) {
      if (id !== loadId.current) return;
      setRouteError(err.message || 'Could not read this GPX file.');
      setMenuOpen(true);
    }
  }, [openRoute]);

  const clearRoute = () => {
    setRoute(null);
    setRidePlaying(false);
    setFocus((prev) => (prev.type === 'rider' ? DEFAULT_FOCUS : prev));
    // wait a frame so the route panel is gone before the map measures the room it has
    requestAnimationFrame(() => mapRef.current?.fitCoverage());
  };

  const lastRoutePoint = route ? route.points.length - 1 : 0;
  const isRiding = ridePlaying && route !== null && riderIdx < lastRoutePoint;

  useEffect(() => {
    riderIdxRef.current = riderIdx;
  }, [riderIdx]);

  // moving along the profile by hand always takes over from the playback
  const scrubRoute = useCallback((index) => {
    setRidePlaying(false);
    setRiderIdx(index);
    setFocus((prev) => (prev.type === 'rider' ? prev : { type: 'rider' }));
  }, []);

  const toggleRide = () => {
    if (isRiding) {
      setRidePlaying(false);
      return;
    }
    if (riderIdx >= lastRoutePoint) setRiderIdx(0);
    setFocus({ type: 'rider' });
    setRidePlaying(true);
  };

  useEffect(() => {
    if (!isRiding) return undefined;
    const timer = setInterval(() => {
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

  // ----- location -----
  const showPosition = useCallback((lat, lng, onStart) => {
    setUser({ lat, lng });
    if (!inCoverage(lat, lng)) {
      // the dot is drawn, but the map stays on the area that has a forecast
      if (!onStart) notify('You are outside the forecast area, which covers greater Lisbon.');
      return;
    }
    // a slow start-up fix must not pull the map away from what the user has opened meanwhile
    if (onStart && viewClaimed.current) return;
    viewClaimed.current = true;
    setFocus({ type: 'me' });
    mapRef.current?.focusOn(lat, lng, 13);
  }, [notify]);

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
      () => {
        setIsLocating(false);
        notify('Could not get your location. Check that location is switched on.');
      },
      GEO_OPTIONS,
    );
  };

  // try once on start, quietly: if it works the map opens on the rider
  useEffect(() => {
    navigator.geolocation?.getCurrentPosition(
      (position) => showPosition(position.coords.latitude, position.coords.longitude, true),
      () => {},
      GEO_OPTIONS,
    );
  }, [showPosition]);

  // ----- map callbacks -----
  const handlePick = useCallback((lat, lng) => {
    if (menuOpen) {
      // tapping the map with the menu open only closes the menu
      closeMenu();
      return;
    }
    // only points with a forecast can be read
    if (!inCoverage(lat, lng)) return;
    viewClaimed.current = true;
    setFocus({ type: 'pin', lat, lng });
  }, [menuOpen, closeMenu]);

  const handleSpot = useCallback((id) => {
    const spot = SPOTS.find((s) => s.id === id);
    viewClaimed.current = true;
    closeMenu();
    setFocus({ type: 'spot', id });
    mapRef.current?.focusOn(spot.lat, spot.lng, 11);
  }, [closeMenu]);

  // once the map has been moved by hand, nothing automatic (late GPS fix, late forecast) moves it again
  const handleUserMove = useCallback(() => {
    viewClaimed.current = true;
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

  // Once the forecast is in, the time bar has its real height: fit the home view again around it,
  // unless the user or the GPS has already moved the map.
  const hasForecast = forecast !== null;
  useEffect(() => {
    if (!hasForecast) return undefined;
    const frame = requestAnimationFrame(() => {
      if (!viewClaimed.current) mapRef.current?.fitCoverage(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [hasForecast]);

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
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const status = forecast ? 'ready' : error && !loading ? 'error' : 'loading';
  const colors = MAP_THEMES[theme];

  return (
    <div className="app">
      <WindMap
        ref={mapRef}
        theme={theme}
        field={field}
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
        getPadding={getPadding}
      />

      <WindReadout
        ref={readoutRef}
        title={focusPlace.title}
        when={whenLabel}
        reading={reading}
        rider={onRoute && routeHasWind ? riderInfo : null}
        note={focusPlace.note}
        outside={reading?.outside}
        status={status}
        updatedAt={forecast ? formatClock(forecast.fetchedAt / 1000) : null}
        offlineSince={error && forecast ? formatDayClock(forecast.fetchedAt / 1000) : null}
        quiet={isRiding || forecastPlaying}
        onRetry={retry}
      />

      <div className="toolbar">
        <div className="toolbar-menu">
          <button
            ref={routesButtonRef}
            type="button"
            className="tool-button panel"
            aria-label="Routes"
            aria-expanded={menuOpen}
            aria-controls={MENU_ID}
            onClick={toggleMenu}
          >
            <Path size={18} aria-hidden="true" />
            <span>Routes</span>
          </button>
          {menuOpen && (
            <RoutesMenu id={MENU_ID} activeId={route?.id} error={routeError} onPreset={loadPreset} onFile={loadFile} />
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

      {notice && <p key={notice.id} className="notice panel" role="status">{notice.text}</p>}

      <div className="dock" ref={dockRef}>
        {route && (
          <RoutePanel
            route={route}
            analysis={analysis}
            riderIdx={riderIdx}
            onScrub={scrubRoute}
            onClear={clearRoute}
            playing={isRiding}
            onTogglePlay={toggleRide}
            playbackRate={playbackRate}
            onPlaybackRate={setPlaybackRate}
            rideKmh={rideKmh}
            onRideKmh={setRideKmh}
            startLabel={shownTime === null ? '' : followingNow ? `now (${formatClock(shownTime)})` : formatDayClock(shownTime)}
            colors={colors}
          />
        )}
        <TimeBar
          hours={series}
          selected={hourIndex}
          nowIndex={nowIndex}
          shownTime={shownTime}
          nowReading={followingNow && field ? sampleField(field, barsLat, barsLng) : null}
          onSelect={selectHour}
          playing={forecastPlaying}
          onTogglePlay={() => setForecastPlaying((playing) => !playing)}
          place={barsAtStart ? 'the start' : focusPlace.place}
          rideStart={barsAtStart}
        />
      </div>
    </div>
  );
}

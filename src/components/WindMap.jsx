import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createWindMap } from '../map/windMap';

/**
 * Full-screen wind map. The map is created once and kept for the life of the app; props are pushed
 * into it as they change, so switching hour, theme or route never rebuilds it or loses the view.
 * - initialView: { lat, lng, zoom } the map opens on (only read when the map is created)
 * - frame: the wind at the moment shown (see windStore.frame)
 */
export default function WindMap({
  ref,
  theme,
  initialView,
  frame,
  flowEnabled,
  spots,
  route,
  routeStops,
  rider,
  pin,
  user,
  onPick,
  onSpot,
  onUserMove,
  onMoveStart,
  onViewChange,
  getPadding,
  getCovered,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const initial = useRef({ theme, flowEnabled, view: initialView });
  const handlers = useRef({ onPick, onSpot, onUserMove, onMoveStart, onViewChange, getPadding, getCovered });
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    handlers.current = { onPick, onSpot, onUserMove, onMoveStart, onViewChange, getPadding, getCovered };
  });

  useEffect(() => {
    let controller;
    try {
      controller = createWindMap(containerRef.current, {
        theme: initial.current.theme,
        flowEnabled: initial.current.flowEnabled,
        view: initial.current.view,
        onPick: (lat, lng) => handlers.current.onPick(lat, lng),
        onSpot: (id) => handlers.current.onSpot(id),
        onUserMove: () => handlers.current.onUserMove(),
        onMoveStart: () => handlers.current.onMoveStart(),
        onViewChange: (view) => handlers.current.onViewChange(view),
        getPadding: () => handlers.current.getPadding(),
        getCovered: () => handlers.current.getCovered(),
      });
    } catch (error) {
      // MapLibre needs WebGL2. Without it the readout, time bar and route analysis still work.
      console.warn('Map unavailable:', error);
      const report = requestAnimationFrame(() => setUnavailable(true));
      return () => cancelAnimationFrame(report);
    }
    mapRef.current = controller;
    return () => {
      controller.destroy();
      mapRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    focusOn: (lat, lng, minZoom) => mapRef.current?.focusOn(lat, lng, minZoom),
  }), []);

  useEffect(() => {
    mapRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    mapRef.current?.setFrame(frame);
  }, [frame]);

  useEffect(() => {
    mapRef.current?.setFlowEnabled(flowEnabled);
  }, [flowEnabled]);

  useEffect(() => {
    mapRef.current?.setSpots(spots);
  }, [spots]);

  useEffect(() => {
    mapRef.current?.setRoute(route);
  }, [route]);

  useEffect(() => {
    if (routeStops) mapRef.current?.setRouteColors(routeStops);
  }, [routeStops]);

  useEffect(() => {
    mapRef.current?.setRider(rider);
  }, [rider]);

  useEffect(() => {
    mapRef.current?.setPin(pin);
  }, [pin]);

  useEffect(() => {
    mapRef.current?.setUser(user);
  }, [user]);

  return (
    <div ref={containerRef} className="wind-map" aria-label="Wind map">
      {unavailable && (
        <p className="map-unavailable">
          This device cannot draw the map. The wind readings, the time bar and the route analysis still work.
        </p>
      )}
    </div>
  );
}

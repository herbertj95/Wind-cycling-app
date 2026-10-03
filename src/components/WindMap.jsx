import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createWindMap } from '../map/windMap';

/**
 * Full-screen wind map. The map is created once and kept for the life of the app; props are pushed
 * into it as they change, so switching hour, theme or route never rebuilds it or loses the view.
 */
export default function WindMap({
  ref,
  theme,
  field,
  flowEnabled,
  spots,
  route,
  routeStops,
  rider,
  pin,
  user,
  onPick,
  onSpot,
  getPadding,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const initial = useRef({ theme, flowEnabled });
  const handlers = useRef({ onPick, onSpot, getPadding });
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    handlers.current = { onPick, onSpot, getPadding };
  });

  useEffect(() => {
    let controller;
    try {
      controller = createWindMap(containerRef.current, {
        theme: initial.current.theme,
        flowEnabled: initial.current.flowEnabled,
        onPick: (lat, lng) => handlers.current.onPick(lat, lng),
        onSpot: (id) => handlers.current.onSpot(id),
        getPadding: () => handlers.current.getPadding(),
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
    fitCoverage: (animate) => mapRef.current?.fitCoverage(animate),
  }), []);

  useEffect(() => {
    mapRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (field) mapRef.current?.setField(field);
  }, [field]);

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
    <div ref={containerRef} className="wind-map" aria-label="Wind map of the Lisbon area">
      {unavailable && (
        <p className="map-unavailable">
          This device cannot draw the map. The wind readings, the time bar and the route analysis still work.
        </p>
      )}
    </div>
  );
}

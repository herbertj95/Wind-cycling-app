import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, CircleMarker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getInterpolatedWeather } from '../utils/weatherApi';
import { classifyWindEffect } from '../utils/gpxParser';

// Map Controller: Fits map bounds exactly once on selection of a new route or spot
function MapController({ activeRoute, selectedSpot }) {
  const map = useMap();
  const prevRouteId = useRef(null);
  const prevSpotId = useRef(null);

  useEffect(() => {
    // 1. Zoom/Pan to activeRoute only once when route changes
    if (activeRoute && activeRoute.points && activeRoute.points.length > 0) {
      const currentRouteId = activeRoute.name + '-' + activeRoute.points.length;
      if (prevRouteId.current !== currentRouteId) {
        prevRouteId.current = currentRouteId;

        const lats = activeRoute.points.map(p => p.lat);
        const lngs = activeRoute.points.map(p => p.lng);
        const bounds = [
          [Math.min(...lats), Math.min(...lngs)],
          [Math.max(...lats), Math.max(...lngs)]
        ];

        map.fitBounds(bounds, { padding: [30, 30] });
      }
    } else {
      prevRouteId.current = null;
    }

    // 2. Zoom/Pan to selectedSpot only once when spot changes
    if (selectedSpot) {
      const currentSpotId = selectedSpot.id;
      if (prevSpotId.current !== currentSpotId) {
        prevSpotId.current = currentSpotId;
        map.setView([selectedSpot.lat, selectedSpot.lng], 13, { animate: true });
      }
    } else {
      prevSpotId.current = null;
    }
  }, [activeRoute, selectedSpot, map]);

  return null;
}

// Map Viewport Listener: Tracks visible map bounds and zoom levels in real-time
// Uses direct event binding and delayed retry to completely solve DOM initialization race conditions.
function MapViewportListener({ onBoundsChange, onZoomChange }) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;

    const updateBounds = () => {
      const bounds = map.getBounds();
      if (bounds && typeof bounds.getSouth === 'function') {
        onBoundsChange(bounds);
        onZoomChange(map.getZoom());
      }
    };

    // Bind multiple events for 100% reliability
    map.on('moveend zoomend resize load', updateBounds);

    // Run once immediately
    updateBounds();

    // Also run after standard intervals to capture final container settle states
    const timer1 = setTimeout(updateBounds, 100);
    const timer2 = setTimeout(updateBounds, 400);

    return () => {
      map.off('moveend zoomend resize load', updateBounds);
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [map, onBoundsChange, onZoomChange]);

  return null;
}

// Leaflet DivIcon creator for wind grid arrows
// Wind direction is defined as where it comes FROM (0 = North). 
// Since our base SVG arrow points DOWN (South), rotating it by exactly windDir
// makes it point perfectly in the direction the wind is BLOWING.
const createWindArrowIcon = (windDir, windSpeed, arrowSize = 14) => {
  let color = 'var(--color-safe)';
  if (windSpeed > 15) color = 'var(--color-dangerous)';
  else if (windSpeed > 10) color = 'var(--color-moderate)';
  else if (windSpeed > 5) color = 'var(--color-breeze)';

  // Thicker stroke for smaller arrows to ensure maximum readability
  const strokeWidth = arrowSize < 14 ? 4 : 3;

  const html = `
    <div class="map-wind-arrow" style="transform: rotate(${windDir}deg); color: ${color}; width: ${arrowSize}px; height: ${arrowSize}px;">
      <svg width="${arrowSize}" height="${arrowSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <polyline points="19 12 12 19 5 12"></polyline>
      </svg>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'wind-arrow-divicon',
    iconSize: [arrowSize, arrowSize],
    iconAnchor: [arrowSize / 2, arrowSize / 2]
  });
};

export default function WindMap({
  gridWeather,
  activeRoute,
  selectedSpot,
  simulatedState
}) {
  const [viewportBounds, setViewportBounds] = useState(null);
  const [mapZoom, setMapZoom] = useState(2);

  // Dynamic arrow scaling based on map zoom levels
  let arrowSize = 18;
  if (mapZoom <= 10) {
    arrowSize = 20;
  } else if (mapZoom === 11) {
    arrowSize = 18;
  } else if (mapZoom === 12) {
    arrowSize = 16;
  } else if (mapZoom === 13) {
    arrowSize = 14;
  } else if (mapZoom >= 14) {
    arrowSize = 12;
  }

  // Generate dynamic dense wind grid points mapped PERFECTLY inside the visible map viewport
  const getViewportGridPoints = () => {
    if (!gridWeather || gridWeather.length === 0) return [];

    // Default safe fallback bounds: Lisbon Area
    let south = 38.5;
    let north = 39.0;
    let west = -9.5;
    let east = -9.0;

    // Safety check: Only use dynamic viewport bounds if they are actually loaded, valid, and not zero-width (race condition protection)
    const isValidViewport = viewportBounds &&
      typeof viewportBounds.getSouth === 'function' &&
      (viewportBounds.getNorth() - viewportBounds.getSouth() > 0.001);

    if (isValidViewport) {
      const vSouth = viewportBounds.getSouth();
      const vNorth = viewportBounds.getNorth();
      const vWest = viewportBounds.getWest();
      const vEast = viewportBounds.getEast();

      // Safety threshold: Only use viewport boundaries if they are not zoomed out past Lisbon met limits
      if (mapZoom >= 11 && (vNorth - vSouth < 1.5)) {
        south = vSouth;
        north = vNorth;
        west = vWest;
        east = vEast;
      }
    }

    // We want a highly detailed 8x8 grid (64 arrows) covering the exact screen viewport
    const steps = 8;
    const points = [];

    for (let i = 0; i < steps; i++) {
      const lat = south + (north - south) * ((i + 0.5) / steps);
      for (let j = 0; j < steps; j++) {
        const lng = west + (east - west) * ((j + 0.5) / steps);

        // Clamp coordinates within general Lisbon Met Area bounds to guarantee smooth interpolation
        const clampedLat = Math.max(38.4, Math.min(39.1, lat));
        const clampedLng = Math.max(-9.6, Math.min(-8.9, lng));

        const interpolated = getInterpolatedWeather(clampedLat, clampedLng, gridWeather);
        points.push({
          ...interpolated,
          lat,
          lng
        });
      }
    }
    return points;
  };

  const denseWindPoints = getViewportGridPoints();

  // Get active location weather for external header panel
  let activeLocationName = "Lisbon Metropolitan Area";
  let activeLat = 38.73;
  let activeLng = -9.25;

  if (simulatedState) {
    activeLocationName = "Rider Position";
    activeLat = simulatedState.lat;
    activeLng = simulatedState.lng;
  } else if (selectedSpot) {
    activeLocationName = selectedSpot.name;
    activeLat = selectedSpot.lat;
    activeLng = selectedSpot.lng;
  } else if (activeRoute && activeRoute.points.length > 0) {
    activeLocationName = activeRoute.name;
    activeLat = activeRoute.points[0].lat;
    activeLng = activeRoute.points[0].lng;
  }

  const activeWeather = getInterpolatedWeather(activeLat, activeLng, gridWeather);

  const getRiderWindColor = () => {
    if (!simulatedState || !gridWeather || gridWeather.length === 0) return 'var(--color-safe)';
    const riderWeather = getInterpolatedWeather(simulatedState.lat, simulatedState.lng, gridWeather);
    const riderEffect = classifyWindEffect(simulatedState.bearing, riderWeather.windDir);

    if (riderEffect === 'headwind') {
      return 'var(--color-dangerous)';
    } else if (riderEffect === 'crosswind') {
      return riderWeather.windSpeed > 15 ? 'var(--color-dangerous)' : 'var(--color-moderate)';
    } else if (riderEffect === 'tailwind') {
      return 'var(--color-safe)';
    }
    return 'var(--color-safe)';
  };

  const riderWindColor = getRiderWindColor();

  return (
    <div className="map-view-container">
      {/* Real-time Weather HUD Header Panel (OUTSIDE the map) */}
      {activeWeather && (
        <div className="map-hud-header glass-panel">
          <div className="hud-header-loc">
            <span className="hud-header-dot pulsing"></span>
            <span className="hud-header-title">{activeLocationName} Telemetry</span>
          </div>

          <div className="hud-header-metrics">
            <div className="hud-header-metric">
              <span className="m-lbl">Wind Speed</span>
              <div className="m-val-container">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-safe)" strokeWidth="3" strokeLinecap="round">
                  <path d="M12.8 5.15a2.5 2.5 0 1 0-2.3 3.4h7.5a2.5 2.5 0 1 1-2.3 3.4H3" />
                  <path d="M20 17.5a2.5 2.5 0 0 1-2.5 2.5H3" />
                </svg>
                <span className="m-val">{activeWeather.windSpeed}<span className="m-unit">km/h</span></span>
              </div>
            </div>

            <div className="hud-header-divider"></div>

            <div className="hud-header-metric">
              <span className="m-lbl">Wind Gusts</span>
              <div className="m-val-container">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-dangerous)" strokeWidth="3" strokeLinecap="round">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                <span className="m-val">{activeWeather.windGusts}<span className="m-unit">km/h</span></span>
              </div>
            </div>

            <div className="hud-header-divider"></div>

            <div className="hud-header-metric">
              <span className="m-lbl">Temperature</span>
              <div className="m-val-container">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff9100" strokeWidth="3" strokeLinecap="round">
                  <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />
                </svg>
                <span className="m-val">{activeWeather.temp}°C <span className="feels-label">Feels {activeWeather.apparentTemp}°</span></span>
              </div>
            </div>

            <div className="hud-header-divider"></div>

            <div className="hud-header-metric">
              <span className="m-lbl">Direction</span>
              <div className="m-val-container">
                <span
                  className="arrow-rotate-container"
                  style={{ transform: `rotate(${activeWeather.windDir}deg)`, display: 'inline-block' }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <polyline points="19 12 12 19 5 12"></polyline>
                  </svg>
                </span>
                <span className="m-val">{activeWeather.windDir}°</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Interactive Map Box */}
      <div className="map-wrapper-card glass-panel">
        <MapContainer
          center={[38.73, -9.25]}
          zoom={9}
          scrollWheelZoom={true}
          style={{ width: '100%', height: '100%', borderRadius: '12px' }}
        >
          <MapController activeRoute={activeRoute} selectedSpot={selectedSpot} />
          <MapViewportListener onBoundsChange={setViewportBounds} onZoomChange={setMapZoom} />

          {/* Modern dark cartographic tiles from CartoDB */}
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          />

          {/* 1. Dynamic Wind Arrow Grid Overlay (High Density Viewport Grid) */}
          {denseWindPoints.map((pt, idx) => (
            <Marker
              key={`arrow-${idx}`}
              position={[pt.lat, pt.lng]}
              icon={createWindArrowIcon(pt.windDir, pt.windSpeed, arrowSize)}
            >
              <Popup>
                <div className="map-popup-container">
                  <span className="popup-title">Microclimate Grid Coordinate</span>
                  <div className="popup-grid">
                    <div className="popup-stat">
                      <span className="p-label">Wind Speed</span>
                      <span className="p-value" style={{
                        color: pt.windSpeed > 15 ? 'var(--color-dangerous)' : pt.windSpeed > 10 ? 'var(--color-moderate)' : 'var(--color-safe)'
                      }}>{pt.windSpeed} km/h</span>
                    </div>
                    <div className="popup-stat">
                      <span className="p-label">Gusts Max</span>
                      <span className="p-value">{pt.windGusts} km/h</span>
                    </div>
                    <div className="popup-stat">
                      <span className="p-label">Wind Dir</span>
                      <span className="p-value">{pt.windDir}° NW</span>
                    </div>
                    <div className="popup-stat">
                      <span className="p-label">Feels Like</span>
                      <span className="p-value">{pt.apparentTemp}°C</span>
                    </div>
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}

          {/* 2. GPX Route segments with vector physics segment coloring */}
          {activeRoute && activeRoute.points.length > 0 && (
            activeRoute.points.map((pt, idx) => {
              if (idx === 0) return null;
              const prev = activeRoute.points[idx - 1];

              // Interpolate wind data for this segment
              const segWeather = getInterpolatedWeather(pt.lat, pt.lng, gridWeather);
              const effect = classifyWindEffect(pt.bearing, segWeather.windDir);

              let color = 'var(--color-safe)';
              if (effect === 'headwind') color = 'var(--color-dangerous)';
              else if (effect === 'crosswind') color = 'var(--color-moderate)';

              return (
                <Polyline
                  key={`seg-${idx}`}
                  positions={[[prev.lat, prev.lng], [pt.lat, pt.lng]]}
                  color={color}
                  weight={5}
                  opacity={0.85}
                />
              );
            })
          )}

          {/* 3. Simulated rider marker if active */}
          {simulatedState && (
            <CircleMarker
              key={`main-rider-marker-${riderWindColor}`}
              center={[simulatedState.lat, simulatedState.lng]}
              radius={9}
              pathOptions={{
                fillColor: riderWindColor,
                fillOpacity: 0.95,
                color: '#ffffff',
                weight: 2.5
              }}
              className="rider-pulsing-marker"
            >
              <Popup>
                <div className="rider-popup">
                  <span className="rider-tag">RIDER HUD LIVE POSITION</span>
                  <span className="rider-distance">Dist: {simulatedState.distance.toFixed(1)} km</span>
                  <span className="rider-ele">Elevation: {simulatedState.ele}m</span>
                </div>
              </Popup>
            </CircleMarker>
          )}
        </MapContainer>
      </div>

      <style>{`
        .map-view-container {
          display: flex;
          flex-direction: column;
          gap: 12px;
          width: 100%;
        }

        .map-hud-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 16px;
          border-radius: 12px;
          background: rgba(10, 15, 26, 0.85);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid var(--border-color);
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
          flex-wrap: wrap;
          gap: 12px;
        }

        .hud-header-loc {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .hud-header-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--color-safe);
        }

        .hud-header-dot.pulsing {
          animation: header-pulse 2s infinite;
        }

        @keyframes header-pulse {
          0% { box-shadow: 0 0 0 0 rgba(0, 230, 118, 0.7); }
          70% { box-shadow: 0 0 0 8px rgba(0, 230, 118, 0); }
          100% { box-shadow: 0 0 0 0 rgba(0, 230, 118, 0); }
        }

        .hud-header-title {
          font-size: 0.82rem;
          font-weight: 800;
          color: var(--text-primary);
          text-transform: uppercase;
          letter-spacing: 0.8px;
        }

        .hud-header-metrics {
          display: flex;
          align-items: center;
          gap: 16px;
          flex-wrap: wrap;
        }

        .hud-header-metric {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 2px;
        }

        .m-lbl {
          font-size: 0.6rem;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .m-val-container {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .m-val {
          font-family: var(--font-mono);
          font-size: 0.88rem;
          font-weight: 800;
          color: var(--text-primary);
        }

        .m-unit {
          font-size: 0.65rem;
          color: var(--text-secondary);
          margin-left: 2px;
        }

        .feels-label {
          font-size: 0.72rem;
          color: var(--text-secondary);
          margin-left: 6px;
          font-weight: 600;
          font-family: var(--font-sans);
        }

        .hud-header-divider {
          width: 1px;
          height: 24px;
          background: rgba(255, 255, 255, 0.08);
        }

        .arrow-rotate-container {
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.4s ease;
        }

        .map-wrapper-card {
          width: 100%;
          height: 480px;
          position: relative;
          z-index: 1;
        }

        .map-wind-arrow {
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .wind-arrow-divicon {
          background: transparent !important;
          border: none !important;
        }

        .map-popup-container {
          font-family: var(--font-sans);
          min-width: 160px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .popup-title {
          font-size: 0.7rem;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          padding-bottom: 4px;
        }

        .popup-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 8px;
        }

        .popup-stat {
          display: flex;
          flex-direction: column;
          gap: 1px;
        }

        .p-label {
          font-size: 0.65rem;
          font-weight: 600;
          color: var(--text-secondary);
        }

        .p-value {
          font-family: var(--font-mono);
          font-size: 0.82rem;
          font-weight: 700;
          color: var(--text-primary);
        }

        .rider-popup {
          font-family: var(--font-sans);
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .rider-tag {
          font-size: 0.7rem;
          font-weight: 800;
          color: var(--color-safe);
          text-transform: uppercase;
        }

        .rider-distance, .rider-ele {
          font-size: 0.78rem;
          color: var(--text-primary);
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}

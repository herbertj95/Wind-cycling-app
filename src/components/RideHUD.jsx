import React, { useState, useEffect, useRef } from 'react';
import {
  Play,
  Pause,
  Clock,
  Compass as CompassIcon,
  Thermometer,
  Wind,
  TrendUp,
  MapPin,
  NavigationArrow,
  WarningCircle,
  Check
} from '@phosphor-icons/react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getCompassLabel, classifyWindEffect } from '../utils/gpxParser';
import { getInterpolatedWeather } from '../utils/weatherApi';

// Subcomponent to automatically pan and lock the map camera onto the rider's active simulated coordinate
function RiderTrackController({ lat, lng }) {
  const map = useMap();
  useEffect(() => {
    if (lat && lng) {
      const currentZoom = map.getZoom();
      map.setView([lat, lng], currentZoom, { animate: true });
    }
  }, [lat, lng, map]);
  return null;
}

// Leaflet DivIcon creator for localized wind arrows flowing around the rider
const createLocalWindArrowIcon = (windDir, windSpeed) => {
  let color = 'var(--color-safe)';
  if (windSpeed > 15) color = 'var(--color-dangerous)';
  else if (windSpeed > 10) color = 'var(--color-moderate)';
  else if (windSpeed > 5) color = 'var(--color-breeze)';

  const html = `
    <div class="map-wind-arrow" style="transform: rotate(${windDir}deg); color: ${color}; width: 14px; height: 14px;">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <polyline points="19 12 12 19 5 12"></polyline>
      </svg>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'wind-arrow-divicon',
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });
};

export default function RideHUD({
  activeRoute,
  gridWeather,
  simulatedState,
  setSimulatedState
}) {
  const [isSimulating, setIsSimulating] = useState(false);
  const [speedMultiplier, setSpeedMultiplier] = useState(1); // 1x, 2.5x, 5x speed
  const simulationTimer = useRef(null);

  // Fallback state if no route is loaded
  const fallbackLat = 38.73;
  const fallbackLng = -9.25;
  const fallbackBearing = 340; // NNW

  // Get current position coordinates and bearing
  const currentLat = simulatedState ? simulatedState.lat : fallbackLat;
  const currentLng = simulatedState ? simulatedState.lng : fallbackLng;
  const currentBearing = simulatedState ? simulatedState.bearing : fallbackBearing;
  const currentDistance = simulatedState ? simulatedState.distance : 0;
  const currentElevation = simulatedState ? simulatedState.ele : 45;
  const currentPointIndex = simulatedState ? simulatedState.index : 0;

  // Get weather at current position
  const weather = getInterpolatedWeather(currentLat, currentLng, gridWeather);
  const windEffect = classifyWindEffect(currentBearing, weather.windDir);

  // Handle simulation ticking
  useEffect(() => {
    if (isSimulating && activeRoute && activeRoute.points.length > 0) {
      const intervalMs = Math.max(100, 400 / speedMultiplier);
      simulationTimer.current = setInterval(() => {
        setSimulatedState(prev => {
          if (!prev) {
            const pt = activeRoute.points[0];
            return { index: 0, lat: pt.lat, lng: pt.lng, bearing: pt.bearing, ele: pt.ele, distance: pt.distance };
          }

          let nextIndex = prev.index + 1;
          if (nextIndex >= activeRoute.points.length) {
            setTimeout(() => setIsSimulating(false), 0);
            return prev;
          }

          const pt = activeRoute.points[nextIndex];
          return {
            index: nextIndex,
            lat: pt.lat,
            lng: pt.lng,
            bearing: pt.bearing,
            ele: pt.ele,
            distance: pt.distance
          };
        });
      }, intervalMs);
    } else {
      if (simulationTimer.current) {
        clearInterval(simulationTimer.current);
      }
    }

    return () => {
      if (simulationTimer.current) {
        clearInterval(simulationTimer.current);
      }
    };
  }, [isSimulating, activeRoute, speedMultiplier, setSimulatedState]);

  const toggleSimulation = () => {
    if (!activeRoute) return;
    setIsSimulating(!isSimulating);
  };

  const handleResetSimulation = () => {
    if (!activeRoute) return;
    setIsSimulating(false);
    const pt = activeRoute.points[0];
    setSimulatedState({
      index: 0,
      lat: pt.lat,
      lng: pt.lng,
      bearing: pt.bearing,
      ele: pt.ele,
      distance: pt.distance
    });
  };

  // Helper flags for granular simulation states
  const isAtEnd = activeRoute ? currentPointIndex >= activeRoute.points.length - 1 : false;
  const isPaused = !isSimulating && currentPointIndex > 0 && !isAtEnd;

  const handleMainButtonClick = () => {
    if (!activeRoute) return;
    if (isAtEnd) {
      handleResetSimulation();
    } else {
      toggleSimulation();
    }
  };

  const handleScrubberChange = (e) => {
    if (!activeRoute) return;
    const newIndex = parseInt(e.target.value, 10);
    const pt = activeRoute.points[newIndex];
    setSimulatedState({
      index: newIndex,
      lat: pt.lat,
      lng: pt.lng,
      bearing: pt.bearing,
      ele: pt.ele,
      distance: pt.distance
    });
  };

  // Math for relative wind angle
  // relativeAngle is where the wind hits the bike relative to its travel direction.
  // 0 = direct headwind, 180 = direct tailwind, 90/270 = crosswind.
  const relativeWindAngle = (weather.windDir - currentBearing + 360) % 360;

  // Visual text label for HUD
  let windEffectLabel = "STEADY BREEZE";
  let windEffectColor = "var(--color-safe)";
  if (windEffect === 'headwind') {
    windEffectLabel = "HEADWIND RESISTANCE";
    windEffectColor = "var(--color-dangerous)";
  } else if (windEffect === 'crosswind') {
    if (weather.windSpeed > 15) {
      windEffectLabel = "STRONG CROSSWIND DRIFT";
      windEffectColor = "var(--color-dangerous)";
    } else {
      windEffectLabel = "MODERATE CROSSWIND";
      windEffectColor = "var(--color-moderate)";
    }
  } else if (windEffect === 'tailwind') {
    windEffectLabel = "TAILWIND BOOST!";
    windEffectColor = "var(--color-safe)";
  }

  // Generate a beautiful, dynamic tracking wind grid dynamically centered around the rider's active position
  const getTrackingGridPoints = () => {
    if (!gridWeather || gridWeather.length === 0) return [];

    const steps = 7;
    const rangeLat = 0.012; // Viewport spread
    const rangeLng = 0.018; // Viewport spread

    const south = currentLat - rangeLat;
    const north = currentLat + rangeLat;
    const west = currentLng - rangeLng;
    const east = currentLng + rangeLng;

    const points = [];
    for (let i = 0; i < steps; i++) {
      const lat = south + (north - south) * ((i + 0.5) / steps);
      for (let j = 0; j < steps; j++) {
        const lng = west + (east - west) * ((j + 0.5) / steps);

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

  const trackingWindPoints = getTrackingGridPoints();

  return (
    <div className="ride-hud-container glass-panel">
      {/* Simulation Controller Panel */}
      <div className="hud-simulation-bar">
        {activeRoute ? (
          <>
            <div className="sim-controls">
              <button
                onClick={handleMainButtonClick}
                className={`sim-btn-primary ${isSimulating ? 'sim-btn-active' : ''}`}
              >
                {isSimulating ? (
                  <Pause size={18} weight="bold" />
                ) : isAtEnd ? (
                  <Check size={18} weight="bold" />
                ) : (
                  <Play size={18} weight="bold" />
                )}
                <span>
                  {isSimulating
                    ? 'Pause Ride'
                    : isAtEnd
                      ? 'End Ride'
                      : isPaused
                        ? 'Continue Ride'
                        : 'Start Ride Simulator'}
                </span>
              </button>

              <button onClick={handleResetSimulation} className="sim-btn-secondary">
                Reset
              </button>

              <div className="sim-speed-selector">
                <button
                  onClick={() => setSpeedMultiplier(1)}
                  className={`speed-pill ${speedMultiplier === 1 ? 'active' : ''}`}
                >
                  1x
                </button>
                <button
                  onClick={() => setSpeedMultiplier(2.5)}
                  className={`speed-pill ${speedMultiplier === 2.5 ? 'active' : ''}`}
                >
                  2.5x
                </button>
                <button
                  onClick={() => setSpeedMultiplier(5)}
                  className={`speed-pill ${speedMultiplier === 5 ? 'active' : ''}`}
                >
                  5x
                </button>
              </div>
            </div>

            <div className="sim-scrubber-container">
              <span className="scrubber-label">Start</span>
              <input
                type="range"
                className="sim-scrubber"
                min="0"
                max={activeRoute.points.length - 1}
                value={currentPointIndex}
                onChange={handleScrubberChange}
                aria-label="Route Simulation Scrubber"
              />
              <span className="scrubber-label">End</span>
            </div>
          </>
        ) : (
          <div className="sim-placeholder">
            <WarningCircle size={16} className="text-warn" />
            <span>Load or select a GPX Route to start the simulation</span>
          </div>
        )}
      </div>

      {/* Main Split-Screen Cockpit Dashboard */}
      <div className="hud-dashboard-grid">

        {/* Column 1: Live Interactive Tracking Map */}
        <div className="hud-map-column">
          <div className="hud-column-header">
            <span className="hud-header-label">Interactive Tracking Map</span>
          </div>

          <div className="hud-mini-map-card">
            {/* Floating Top Left Wind HUD Badge */}
            <MapContainer
              center={[currentLat, currentLng]}
              zoom={14}
              zoomControl={true}
              scrollWheelZoom={true}
              dragging={true}
              touchZoom={true}
              doubleClickZoom={true}
              style={{ width: '100%', height: '100%' }}
            >
              <RiderTrackController lat={currentLat} lng={currentLng} />

              {/* Dark cartographic tiles */}
              <TileLayer
                attribution='&copy; <a href="https://carto.com/attributions">CARTO</a>'
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              />

              {/* GPX Route Path segments */}
              {activeRoute && activeRoute.points && (
                <Polyline
                  positions={activeRoute.points.map(p => [p.lat, p.lng])}
                  color="rgba(0, 229, 255, 0.6)"
                  weight={3}
                />
              )}

              {/* Pulsing Active Rider Marker with dynamic pathOptions (rendered in markerPane to stay on top of the polyline) */}
              <CircleMarker
                key={`rider-marker-${windEffectColor}`}
                center={[currentLat, currentLng]}
                radius={8}
                pane="markerPane"
                pathOptions={{
                  fillColor: windEffectColor,
                  fillOpacity: 0.95,
                  color: '#ffffff',
                  weight: 2
                }}
                className="rider-pulsing-marker"
              />
            </MapContainer>
          </div>
        </div>

        {/* Column 2: Cockpit Dials and Telemetry Panel */}
        <div className="hud-controls-column">
          <div className="hud-column-header">
            <span className="hud-header-label">Cockpit Telemetry Console</span>
          </div>

          <div className="hud-console-layout">

            {/* Compass dial widget */}
            <div className="hud-widget compass-widget">
              <span className="widget-label">Relative Wind Angle</span>

              <div className="hud-compass-wrapper">
                {/* The outer compass is static (North always at the top) */}
                <div
                  className="hud-compass-dial"
                  style={{ transform: 'rotate(0deg)' }}
                >
                  <span className="hud-compass-marker n">N</span>
                  <span className="hud-compass-marker e">E</span>
                  <span className="hud-compass-marker s">S</span>
                  <span className="hud-compass-marker w">W</span>

                  {/* Wind indicator showing direction the wind is blowing TO on the compass dial */}
                  <div
                    className="wind-arrow-compass"
                    style={{
                      transform: `rotate(${weather.windDir}deg)`,
                      color: windEffectColor
                    }}
                  >
                    <div style={{
                      position: 'absolute',
                      top: '12px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transform: 'rotate(0deg)'
                    }}>
                      <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <polyline points="19 12 12 19 5 12"></polyline>
                      </svg>
                    </div>
                  </div>
                </div>

                {/* Central bike icon rotating dynamically based on the current travel bearing */}
                <div
                  className="bike-center-icon"
                  style={{
                    transform: `rotate(${currentBearing}deg)`,
                    transition: 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
                    color: 'var(--color-safe)'
                  }}
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <path d="M12 2L21 21L12 17L3 21L12 2Z" />
                  </svg>
                </div>

                <div className={`relative-glow-ring ${windEffect}`}></div>
              </div>

              <div className="compass-bearing-display" style={{ flexDirection: 'column', gap: '4px', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                  <span className="compass-bearing-num">{Math.round(currentBearing)}°</span>
                  <span className="compass-bearing-label">{getCompassLabel(currentBearing)}</span>
                </div>
                <div className="compass-wind-speed" style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.85rem',
                  fontWeight: '700',
                  color: windEffectColor,
                  background: 'rgba(0,0,0,0.2)',
                  padding: '4px 10px',
                  borderRadius: '20px',
                  border: '1px solid var(--border-color)',
                  marginTop: '2px'
                }}>
                  <Wind size={13} style={{ color: windEffectColor }} />
                  <span>{weather.windSpeed} km/h</span>
                </div>
              </div>
            </div>

            {/* Metrics HUD widget */}
            <div className="hud-widget metrics-widget">
              {/* Main alert banner */}
              <div className="hud-alert-banner" style={{
                borderColor: windEffectColor,
                background: `rgba(${windEffectColor === 'var(--color-dangerous)' ? '255, 23, 68' : windEffectColor === 'var(--color-moderate)' ? '255, 145, 0' : '0, 230, 118'}, 0.05)`
              }}>
                <TrendUp size={18} style={{ color: windEffectColor }} className="animate-pulse" />
                <span className="alert-banner-text" style={{ color: windEffectColor }}>
                  {windEffectLabel}
                </span>
              </div>

              <div className="metrics-layout-grid">
                <div className="telemetry-box">
                  <div className="telemetry-header">
                    <Wind size={14} className="text-secondary" />
                    <span>Wind Speed</span>
                  </div>
                  <div className="telemetry-value">
                    {weather.windSpeed}
                    <span className="telemetry-unit">km/h</span>
                  </div>
                  <span className="telemetry-footer">
                    Gusts: {weather.windGusts} km/h
                  </span>
                </div>

                <div className="telemetry-box">
                  <div className="telemetry-header">
                    <Thermometer size={14} className="text-secondary" />
                    <span>Temperature</span>
                  </div>
                  <div className="telemetry-value">
                    {weather.temp}°
                    <span className="telemetry-unit">C</span>
                  </div>
                  <span className="telemetry-footer">
                    Feels: {weather.apparentTemp}°C (Chill)
                  </span>
                </div>

                <div className="telemetry-box">
                  <div className="telemetry-header">
                    <MapPin size={14} className="text-secondary" />
                    <span>Distance Ridden</span>
                  </div>
                  <div className="telemetry-value">
                    {currentDistance.toFixed(2)}
                    <span className="telemetry-unit">km</span>
                  </div>
                  <span className="telemetry-footer">
                    Elev: {currentElevation}m
                  </span>
                </div>

                <div className="telemetry-box">
                  <div className="telemetry-header">
                    <Clock size={14} className="text-secondary" />
                    <span>Riding Status</span>
                  </div>
                  <div className="telemetry-value">
                    {isSimulating ? 'Live' : isAtEnd ? 'End' : isPaused ? 'Paused' : 'Start'}
                  </div>
                  <span className="telemetry-footer">
                    Point: {currentPointIndex}/{activeRoute ? activeRoute.points.length : 0}
                  </span>
                </div>
              </div>

            </div>

          </div>
        </div>

      </div>

      <style>{`
        .ride-hud-container {
          padding: 20px;
          background: var(--bg-panel);
          border: 1px solid var(--border-color);
          border-radius: 16px;
          display: flex;
          flex-direction: column;
          gap: 20px;
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
        }

        .hud-simulation-bar {
          background: rgba(0, 0, 0, 0.2);
          border: 1px solid var(--border-color);
          border-radius: 10px;
          padding: 10px 14px;
          max-width: 500px;
          margin: 0 auto;
          width: 100%;
        }

        .hud-map-wind-badge {
          position: absolute;
          top: 12px;
          left: 12px;
          z-index: 1000;
          padding: 8px 12px;
          border-radius: 8px;
          background: rgba(10, 10, 10, 0.85);
          border: 1px solid var(--border-color);
          display: flex;
          flex-direction: column;
          gap: 4px;
          pointer-events: none;
          box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5);
        }

        .badge-label {
          font-size: 0.62rem;
          font-weight: 800;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.8px;
          line-height: 1;
        }

        .badge-content {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .badge-arrow {
          transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .badge-value {
          font-size: 0.95rem;
          font-weight: 800;
          font-family: var(--font-sans);
          line-height: 1;
        }

        .badge-unit {
          font-size: 0.65rem;
          font-weight: 600;
          color: var(--text-muted);
        }

        .sim-controls {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 12px;
        }

        .sim-btn-primary {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          background: var(--color-safe);
          color: #000;
          border: none;
          font-family: var(--font-sans);
          font-size: 0.85rem;
          font-weight: 800;
          padding: 8px 16px;
          border-radius: 30px;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
          box-shadow: 0 4px 15px rgba(0, 230, 118, 0.25);
        }

        .sim-btn-primary:hover {
          transform: translateY(-1px);
          box-shadow: 0 6px 20px rgba(0, 230, 118, 0.35);
        }

        .sim-btn-active {
          background: #ff1744 !important;
          color: #fff !important;
          box-shadow: 0 4px 15px rgba(255, 23, 68, 0.25) !important;
        }

        .sim-btn-secondary {
          background: rgba(255, 255, 255, 0.05);
          color: var(--text-primary);
          border: 1px solid var(--border-color);
          font-family: var(--font-sans);
          font-size: 0.82rem;
          font-weight: 700;
          padding: 8px 16px;
          border-radius: 30px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .sim-btn-secondary:hover {
          background: rgba(255, 255, 255, 0.1);
        }

        .sim-speed-selector {
          display: flex;
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid var(--border-color);
          padding: 2px;
          border-radius: 20px;
        }

        .speed-pill {
          background: transparent;
          border: none;
          color: var(--text-secondary);
          font-family: var(--font-sans);
          font-size: 0.78rem;
          font-weight: 700;
          padding: 6px 12px;
          border-radius: 16px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .speed-pill.active {
          background: rgba(255, 255, 255, 0.1);
          color: var(--color-safe);
        }

        .sim-scrubber-container {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-top: 16px;
          padding: 0 4px;
        }

        .scrubber-label {
          font-size: 0.72rem;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
        }

        .sim-scrubber {
          flex: 1;
          -webkit-appearance: none;
          height: 4px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 4px;
          outline: none;
          cursor: pointer;
        }

        .sim-scrubber::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--color-safe);
          cursor: pointer;
          border: 2px solid var(--bg-surface);
          box-shadow: 0 0 8px rgba(0, 230, 118, 0.5);
          transition: transform 0.1s;
        }

        .sim-scrubber::-webkit-slider-thumb:hover {
          transform: scale(1.2);
        }

        .sim-scrubber::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--color-safe);
          cursor: pointer;
          border: 2px solid var(--bg-surface);
          box-shadow: 0 0 8px rgba(0, 230, 118, 0.5);
        }

        .sim-placeholder {
          display: flex;
          align-items: center;
          gap: 8px;
          color: var(--text-secondary);
          font-size: 0.85rem;
          font-weight: 500;
        }

        .hud-dashboard-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 24px;
        }

        @media (min-width: 992px) {
          .hud-dashboard-grid {
            grid-template-columns: 1fr 1fr;
          }
        }

        .hud-map-column {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .hud-column-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          padding-bottom: 8px;
        }

        .hud-header-label {
          font-size: 0.82rem;
          font-weight: 800;
          color: var(--text-primary);
          text-transform: uppercase;
          letter-spacing: 0.8px;
        }

        .live-gps-pill {
          font-size: 0.65rem;
          font-weight: 800;
          color: var(--color-safe);
          background: rgba(0, 230, 118, 0.1);
          padding: 3px 8px;
          border-radius: 20px;
          border: 1px solid rgba(0, 230, 118, 0.15);
          letter-spacing: 0.5px;
        }

        .hud-mini-map-card {
          width: 100%;
          height: 380px;
          border-radius: 12px;
          overflow: hidden;
          border: 1px solid var(--border-color);
          position: relative;
          z-index: 1;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        }

        .hud-controls-column {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .hud-console-layout {
          display: grid;
          grid-template-columns: 1fr;
          gap: 16px;
        }

        @media (min-width: 768px) {
          .hud-console-layout {
            grid-template-columns: 220px 1fr;
          }
        }

        .hud-widget {
          background: rgba(0, 0, 0, 0.2);
          border: 1px solid var(--border-color);
          border-radius: 12px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
        }

        .compass-widget {
          position: relative;
        }

        .widget-label {
          font-size: 0.72rem;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.8px;
        }

        .hud-compass-wrapper {
          position: relative;
          width: 150px;
          height: 150px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .hud-compass-dial {
          position: absolute;
          width: 100%;
          height: 100%;
          border-radius: 50%;
          border: 2px solid var(--border-color);
          background: rgba(0, 0, 0, 0.3);
          transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .hud-compass-marker {
          position: absolute;
          font-family: var(--font-sans);
          font-size: 0.82rem;
          font-weight: 800;
          color: var(--text-secondary);
        }

        .hud-compass-marker.n { top: 6px; left: 50%; transform: translateX(-50%); color: var(--color-dangerous); }
        .hud-compass-marker.s { bottom: 6px; left: 50%; transform: translateX(-50%); }
        .hud-compass-marker.e { right: 8px; top: 50%; transform: translateY(-50%); }
        .hud-compass-marker.w { left: 8px; top: 50%; transform: translateY(-50%); }

        .wind-arrow-compass {
          position: absolute;
          width: 100%;
          height: 100%;
          display: flex;
          justify-content: center;
          align-items: center;
          pointer-events: none;
          transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .wind-arrow-shaft {
          position: absolute;
          width: 3px;
          height: 48px;
          background: currentColor;
          top: 28px;
          opacity: 0.75;
        }

        .wind-arrow-tip {
          position: absolute;
          width: 0;
          height: 0;
          border-left: 6px solid transparent;
          border-right: 6px solid transparent;
          border-bottom: 12px solid currentColor;
          top: 18px;
          transform: rotate(180deg);
        }

        .bike-center-icon {
          position: absolute;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10;
          background: var(--bg-base);
          width: 44px;
          height: 44px;
          border-radius: 50%;
          border: 2px solid var(--border-color);
          box-shadow: 0 4px 10px rgba(0, 0, 0, 0.5);
        }

        .relative-glow-ring {
          position: absolute;
          width: 100%;
          height: 100%;
          border-radius: 50%;
          pointer-events: none;
          border: 2px dashed transparent;
          opacity: 0.15;
          animation: spin 30s linear infinite;
        }

        @keyframes spin {
          100% { transform: rotate(360deg); }
        }

        .relative-glow-ring.headwind {
          border-color: var(--color-dangerous);
          box-shadow: inset 0 0 15px rgba(255, 23, 68, 0.2);
        }

        .relative-glow-ring.crosswind {
          border-color: var(--color-moderate);
          box-shadow: inset 0 0 15px rgba(255, 145, 0, 0.2);
        }

        .relative-glow-ring.tailwind {
          border-color: var(--color-safe);
          box-shadow: inset 0 0 15px rgba(0, 230, 118, 0.2);
        }

        .compass-bearing-display {
          display: flex;
          align-items: baseline;
          gap: 6px;
        }

        .compass-bearing-num {
          font-family: var(--font-mono);
          font-size: 1.5rem;
          font-weight: 800;
          color: var(--text-primary);
        }

        .compass-bearing-label {
          font-size: 0.9rem;
          font-weight: 700;
          color: var(--color-safe);
        }

        .metrics-widget {
          align-items: stretch;
          gap: 16px;
        }

        .hud-alert-banner {
          border: 1px solid;
          border-radius: 8px;
          padding: 8px 12px;
          display: flex;
          align-items: center;
          gap: 10px;
          font-weight: 800;
          font-size: 0.82rem;
          letter-spacing: 0.5px;
          text-transform: uppercase;
        }

        .alert-banner-text {
          line-height: 1;
        }

        .metrics-layout-grid {
          display: grid;
          grid-template-columns: repeat(1, 1fr);
          gap: 12px;
        }

        @media (min-width: 480px) {
          .metrics-layout-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }

        .telemetry-box {
          background: rgba(0, 0, 0, 0.25);
          border: 1px solid rgba(255, 255, 255, 0.02);
          border-radius: 8px;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .telemetry-header {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.72rem;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .telemetry-value {
          font-family: var(--font-mono);
          font-size: 1.3rem;
          font-weight: 800;
          color: var(--text-primary);
        }

        .telemetry-unit {
          font-family: var(--font-sans);
          font-size: 0.75rem;
          font-weight: 700;
          color: var(--text-secondary);
          margin-left: 2px;
        }

        .telemetry-footer {
          font-size: 0.72rem;
          color: var(--text-secondary);
          margin-top: 2px;
          border-top: 1px solid rgba(255, 255, 255, 0.03);
          padding-top: 4px;
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
      `}</style>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import {
  Bicycle,
  MapTrifold,
  Gauge,
  CloudSun,
  Wind,
  ShieldCheck,
  Warning,
  ArrowRight,
  WaveTriangle,
  Crosshair
} from '@phosphor-icons/react';
import WindMap from './components/WindMap';
import RideHUD from './components/RideHUD';
import SpotShortcuts from './components/SpotShortcuts';
import GpxUploader from './components/GpxUploader';
import { fetchLisbonGridWeather, MICROCLIMATE_SPOTS } from './utils/weatherApi';
import { calculateDistance, classifyWindEffect } from './utils/gpxParser';
import { getInterpolatedWeather } from './utils/weatherApi';

export default function App() {
  const [activeTab, setActiveTab] = useState('map'); // 'map' or 'hud'
  const [gridWeather, setGridWeather] = useState([]);
  const [activeRoute, setActiveRoute] = useState(null);
  const [selectedSpot, setSelectedSpot] = useState(MICROCLIMATE_SPOTS[0]);

  // State for simulated rider HUD position
  const [simulatedState, setSimulatedState] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [forecastOffset, setForecastOffset] = useState(0);

  // Fetch weather when forecast offset changes
  useEffect(() => {
    async function loadWeather() {
      setIsLoading(true);
      const data = await fetchLisbonGridWeather('live', forecastOffset);
      setGridWeather(data);
      setIsLoading(false);
    }
    loadWeather();
  }, [forecastOffset]);

  // Attempt to locate user automatically on mount
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const lat = position.coords.latitude;
          const lng = position.coords.longitude;
          setSelectedSpot({
            id: 'user_location',
            name: 'My Location',
            lat: lat,
            lng: lng,
            isSheltered: false,
            rimWarning: false,
            desc: 'Your current GPS location.'
          });
        },
        (error) => {
          console.warn("Could not auto-locate on mount, falling back to default.", error);
        }
      );
    }
  }, []);

  // Set default simulated state when activeRoute changes
  useEffect(() => {
    if (activeRoute && activeRoute.points.length > 0) {
      const pt = activeRoute.points[0];
      setSimulatedState({
        index: 0,
        lat: pt.lat,
        lng: pt.lng,
        bearing: pt.bearing,
        ele: pt.ele,
        distance: pt.distance
      });
    } else {
      setSimulatedState(null);
    }
  }, [activeRoute]);

  const handleRouteLoaded = (route) => {
    setActiveRoute(route);
    setSelectedSpot(null);
  };

  const handleClearRoute = () => {
    setActiveRoute(null);
    setSimulatedState(null);
  };

  const handleSelectSpot = (spot) => {
    setSelectedSpot(spot);
  };

  // Helper: Get weather specifically at a spot
  const getSpotWeather = (spot) => {
    return getInterpolatedWeather(spot.lat, spot.lng, gridWeather);
  };

  const handleLocateMe = () => {
    if (navigator.geolocation) {
      setIsLoading(true);
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const lat = position.coords.latitude;
          const lng = position.coords.longitude;
          const userSpot = {
            id: 'user_location',
            name: 'My Location',
            lat: lat,
            lng: lng,
            isSheltered: false,
            rimWarning: false,
            desc: 'Your current GPS location.'
          };
          setSelectedSpot(userSpot);
          setActiveRoute(null);
          setSimulatedState(null);
          setActiveTab('map');
          setIsLoading(false);
        },
        (error) => {
          console.error("Error getting location", error);
          alert("Could not get your location.");
          setIsLoading(false);
        }
      );
    } else {
      alert("Geolocation is not supported by this browser.");
    }
  };

  // Analyze segments of active route
  const analyzeRoute = () => {
    if (!activeRoute || !activeRoute.points || activeRoute.points.length === 0) return null;

    let headwind = 0;
    let tailwind = 0;
    let crosswind = 0;

    let totalWindSpeed = 0;
    let maxWind = 0;

    const elevations = activeRoute.points.map(p => p.ele || 0);
    const maxEle = Math.max(...elevations);
    const minEle = Math.min(...elevations);

    for (let i = 1; i < activeRoute.points.length; i++) {
      const pt = activeRoute.points[i];
      const prev = activeRoute.points[i - 1];
      const stepDist = calculateDistance(prev.lat, prev.lng, pt.lat, pt.lng);

      const weather = getInterpolatedWeather(pt.lat, pt.lng, gridWeather);
      const effect = classifyWindEffect(pt.bearing, weather.windDir);

      if (effect === 'headwind') headwind += stepDist;
      else if (effect === 'tailwind') tailwind += stepDist;
      else crosswind += stepDist;

      totalWindSpeed += weather.windSpeed;
      if (weather.windSpeed > maxWind) {
        maxWind = weather.windSpeed;
      }
    }

    const total = headwind + tailwind + crosswind;
    const avgWind = parseFloat((totalWindSpeed / Math.max(1, activeRoute.points.length - 1)).toFixed(1));

    // Downsample points to exactly 30 for drawing the elevation profile
    const downsampledCount = 30;
    const step = Math.max(1, Math.floor(activeRoute.points.length / downsampledCount));
    const profilePoints = [];

    for (let i = 0; i < activeRoute.points.length; i += step) {
      const pt = activeRoute.points[i];
      const weather = getInterpolatedWeather(pt.lat, pt.lng, gridWeather);
      const effect = classifyWindEffect(pt.bearing, weather.windDir);
      profilePoints.push({
        distance: pt.distance,
        ele: pt.ele || 0,
        windEffect: effect,
        windSpeed: weather.windSpeed
      });
      if (profilePoints.length >= downsampledCount) break;
    }

    // Always include the last point to close the profile chart cleanly
    if (profilePoints.length > 0 && profilePoints[profilePoints.length - 1].distance !== activeRoute.points[activeRoute.points.length - 1].distance) {
      const lastPt = activeRoute.points[activeRoute.points.length - 1];
      const weather = getInterpolatedWeather(lastPt.lat, lastPt.lng, gridWeather);
      const effect = classifyWindEffect(lastPt.bearing, weather.windDir);
      profilePoints[profilePoints.length - 1] = {
        distance: lastPt.distance,
        ele: lastPt.ele || 0,
        windEffect: effect,
        windSpeed: weather.windSpeed
      };
    }

    return {
      headwind: parseFloat(headwind.toFixed(1)),
      tailwind: parseFloat(tailwind.toFixed(1)),
      crosswind: parseFloat(crosswind.toFixed(1)),
      total: parseFloat(total.toFixed(1)),
      pctHeadwind: Math.round((headwind / total) * 100) || 0,
      pctTailwind: Math.round((tailwind / total) * 100) || 0,
      pctCrosswind: Math.round((crosswind / total) * 100) || 0,
      avgWindSpeed: avgWind,
      maxWindSpeed: maxWind,
      maxElevation: maxEle,
      minElevation: minEle,
      profilePoints
    };
  };

  const routeAnalysis = analyzeRoute();
  const shouldHideRightColumn = activeTab === 'hud';

  return (
    <div className="app-viewport-container">
      {/* Header Bar */}
      <header className="app-header glass-panel">
        <div className="header-logo-section">
          <Bicycle size={28} className="text-safe" weight="fill" />
          <div className="brand-texts">
            <h1 className="logo-title">Wind Cycling</h1>
            <span className="logo-subtitle">Real-time Wind & Route Analysis for Cycling</span>
          </div>
        </div>

        {/* Live Weather Status Indicator and Locate Me */}
        <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button 
            onClick={handleLocateMe}
            className={`locate-me-btn ${selectedSpot?.id === 'user_location' ? 'active-locate' : ''}`}
          >
            <Crosshair size={16} />
            <span>LOCATE ME</span>
          </button>
          
          {/* Time Forecast Slider */}
          <div className="forecast-slider-container glass-panel">
            <span className="forecast-label">
              {forecastOffset === 0 ? "NOW" : `+${forecastOffset}H`}
            </span>
            <input 
              type="range" 
              min="0" 
              max="3" 
              step="1" 
              value={forecastOffset}
              onChange={(e) => setForecastOffset(parseInt(e.target.value))}
              className="forecast-slider"
            />
          </div>
          
          <div className="live-header-status">
            {forecastOffset === 0 ? (
              <>
                <span className="live-dot-pulse"></span>
                <span className="live-status-text">LIVE REAL-TIME WIND</span>
              </>
            ) : (
              <>
                <span className="live-dot-pulse" style={{ backgroundColor: 'var(--color-moderate)', animation: 'none', boxShadow: 'none' }}></span>
                <span className="live-status-text" style={{ color: 'var(--color-moderate)' }}>FORECAST (+{forecastOffset} HRS)</span>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Page Layout Grid */}
      <main className={`app-main-grid ${shouldHideRightColumn ? 'hud-active-grid' : ''}`}>
        {/* Left Column Controls */}
        <section className="controls-column">
          <GpxUploader
            activeRoute={activeRoute}
            onRouteLoaded={handleRouteLoaded}
            onClearRoute={handleClearRoute}
          />
        </section>

        {/* Middle Column Views */}
        <section className="views-column">
          {/* Tabs Menu */}
          <div className="tab-menu glass-panel">
            <button
              onClick={() => setActiveTab('map')}
              className={`tab-btn ${activeTab === 'map' ? 'active-tab' : ''}`}
            >
              <MapTrifold size={18} />
              <span>Interactive Wind Map</span>
            </button>
            <button
              onClick={() => setActiveTab('hud')}
              className={`tab-btn ${activeTab === 'hud' ? 'active-tab' : ''}`}
            >
              <Gauge size={18} />
              <span>Simulate Route</span>
            </button>
          </div>

          {/* Active Tab Component */}
          {isLoading ? (
            <div className="loading-card glass-panel">
              <span className="loader-element"></span>
              <span className="loading-text">Fetching high-res Open-Meteo wind grid...</span>
            </div>
          ) : (
            <div className="tab-content-container">
              {activeTab === 'map' ? (
                <div className="map-view-tab animate-fade-in">
                  <WindMap
                    gridWeather={gridWeather}
                    activeRoute={activeRoute}
                    selectedSpot={selectedSpot}
                    simulatedState={simulatedState}
                  />
                </div>
              ) : (
                <div className="hud-view-tab animate-fade-in">
                  <RideHUD
                    activeRoute={activeRoute}
                    gridWeather={gridWeather}
                    simulatedState={simulatedState}
                    setSimulatedState={setSimulatedState}
                  />
                </div>
              )}
            </div>
          )}
        </section>

        {/* Right Column Microclimates Panel (Hidden when in HUD simulator) */}
        {!shouldHideRightColumn && (
          <section className="microclimates-column">
            {activeRoute && routeAnalysis ? (
              <div className="spot-sidebar-panel glass-panel">
                <div className="sidebar-header-compact">
                  <span className="sidebar-title">Route Wind Impact</span>
                </div>

                <div className="sidebar-scroll-list" style={{ padding: '6px 0', display: 'flex', flexDirection: 'column', gap: '14px', overflowY: 'auto' }}>
                  <p className="analysis-text-summary" style={{ fontSize: '0.8rem', lineHeight: '1.4', margin: 0 }}>
                    Your {routeAnalysis.total} km route has{' '}
                    <span className="text-danger font-bold">{routeAnalysis.headwind} km</span> of headwind,{' '}
                    <span className="text-safe font-bold">{routeAnalysis.tailwind} km</span> of tailwind boost, and{' '}
                    <span className="text-warn font-bold">{routeAnalysis.crosswind} km</span> of side wind sweep.
                  </p>

                  {/* 1. Dynamic Elevation & Wind Profile Chart */}
                  <div className="chart-container-card">
                    <div className="chart-header-info">
                      <span>Elevation & Wind Profile</span>
                      <span className="chart-y-max">{routeAnalysis.maxElevation}m</span>
                    </div>

                    <div style={{ position: 'relative', width: '100%', height: '80px', marginTop: '4px' }}>
                      <svg viewBox="0 0 300 80" width="100%" height="100%" preserveAspectRatio="none" style={{ display: 'block' }}>
                        <defs>
                          <linearGradient id="eleGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="var(--color-safe)" stopOpacity="0.25" />
                            <stop offset="100%" stopColor="var(--color-safe)" stopOpacity="0.00" />
                          </linearGradient>
                        </defs>

                        {/* Chart elevation area fill */}
                        <path
                          d={(() => {
                            const pts = routeAnalysis.profilePoints;
                            const range = Math.max(1, routeAnalysis.maxElevation - routeAnalysis.minElevation);
                            let d = `M 0,60 `;
                            pts.forEach((pt, i) => {
                              const px = (i / (pts.length - 1)) * 300;
                              const py = 60 - ((pt.ele - routeAnalysis.minElevation) / range) * 50;
                              d += `L ${px},${py} `;
                            });
                            d += `L 300,60 Z`;
                            return d;
                          })()}
                          fill="url(#eleGrad)"
                        />

                        {/* Chart elevation top line */}
                        <path
                          d={(() => {
                            const pts = routeAnalysis.profilePoints;
                            const range = Math.max(1, routeAnalysis.maxElevation - routeAnalysis.minElevation);
                            let d = ``;
                            pts.forEach((pt, i) => {
                              const px = (i / (pts.length - 1)) * 300;
                              const py = 60 - ((pt.ele - routeAnalysis.minElevation) / range) * 50;
                              if (i === 0) d = `M ${px},${py} `;
                              else d += `L ${px},${py} `;
                            });
                            return d;
                          })()}
                          fill="none"
                          stroke="rgba(255,255,255,0.4)"
                          strokeWidth="1.5"
                        />

                        {/* Wind ribbon directly below elevation profile */}
                        {routeAnalysis.profilePoints.map((pt, i) => {
                          const rx = (i / routeAnalysis.profilePoints.length) * 300;
                          const rw = 300 / routeAnalysis.profilePoints.length;
                          let col = 'var(--color-safe)';
                          if (pt.windEffect === 'headwind') col = 'var(--color-dangerous)';
                          else if (pt.windEffect === 'crosswind') col = 'var(--color-moderate)';

                          return (
                            <rect
                              key={`bar-${i}`}
                              x={rx}
                              y={68}
                              width={rw + 0.5}
                              height={5}
                              fill={col}
                            />
                          );
                        })}
                      </svg>
                    </div>

                    <div className="chart-x-labels">
                      <span>0 km</span>
                      <span style={{ color: 'var(--text-muted)' }}>Wind Ribbon</span>
                      <span>{routeAnalysis.total} km</span>
                    </div>
                  </div>

                  {/* 2. Visual Segment Summary Progress Bars */}
                  <div className="analysis-bar-chart" style={{ minHeight: '24px', flexShrink: 0 }}>
                    <div
                      className="bar-segment bg-safe"
                      style={{ width: `${routeAnalysis.pctTailwind}%` }}
                    >
                      {routeAnalysis.pctTailwind > 5 && `${routeAnalysis.pctTailwind}%`}
                    </div>
                    <div
                      className="bar-segment bg-moderate"
                      style={{ width: `${routeAnalysis.pctCrosswind}%` }}
                    >
                      {routeAnalysis.pctCrosswind > 5 && `${routeAnalysis.pctCrosswind}%`}
                    </div>
                    <div
                      className="bar-segment bg-dangerous"
                      style={{ width: `${routeAnalysis.pctHeadwind}%` }}
                    >
                      {routeAnalysis.pctHeadwind > 5 && `${routeAnalysis.pctHeadwind}%`}
                    </div>
                  </div>

                  {/* 3. Metrics grid */}
                  <div className="analysis-stats-grid">
                    <div className="analysis-stat-box">
                      <span className="analysis-stat-lbl">Average Wind</span>
                      <span className="analysis-stat-val">
                        {routeAnalysis.avgWindSpeed}
                        <span className="analysis-stat-unit">km/h</span>
                      </span>
                    </div>
                    <div className="analysis-stat-box">
                      <span className="analysis-stat-lbl">Max Wind</span>
                      <span className="analysis-stat-val">
                        {routeAnalysis.maxWindSpeed}
                        <span className="analysis-stat-unit">km/h</span>
                      </span>
                    </div>
                    <div className="analysis-stat-box">
                      <span className="analysis-stat-lbl">Climbing Gain</span>
                      <span className="analysis-stat-val">
                        +{activeRoute.totalElevationGain}
                        <span className="analysis-stat-unit">m</span>
                      </span>
                    </div>
                    <div className="analysis-stat-box">
                      <span className="analysis-stat-lbl">Peak Elevation</span>
                      <span className="analysis-stat-val">
                        {routeAnalysis.maxElevation}
                        <span className="analysis-stat-unit">m</span>
                      </span>
                    </div>
                  </div>

                  {/* 4. Dynamic Ride Advisory Card */}
                  {(() => {
                    let title = "Optimal Conditions";
                    let adviceClass = "safe";
                    let text = "Balanced conditions along the route. Perfect for general training and climbing pacing.";
                    let Icon = ShieldCheck;

                    if (routeAnalysis.pctHeadwind > 40) {
                      title = "Heavy Resistance";
                      adviceClass = "dangerous";
                      text = "Over 40% of this route is hit by direct headwinds. Pace your climbs.";
                      Icon = Warning;
                    } else if (routeAnalysis.pctCrosswind > 35) {
                      title = "Rim Warning";
                      adviceClass = "moderate";
                      text = "High side winds swept across key sectors.";
                      Icon = Warning;
                    } else if (routeAnalysis.pctTailwind > 45) {
                      title = "Tailwind Boost";
                      adviceClass = "safe";
                      text = "Over 45% of tailwind boost! Perfect day for high-speed loops and chasing segments.";
                      Icon = ShieldCheck;
                    }

                    return (
                      <div className={`advice-badge-card ${adviceClass}`}>
                        <div className={`advice-badge-icon ${adviceClass}`}>
                          <Icon size={18} />
                        </div>
                        <div>
                          <h5 className="advice-badge-title">{title}</h5>
                          <p className="advice-badge-desc">{text}</p>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            ) : (
              <SpotShortcuts
                selectedSpot={selectedSpot}
                onSelectSpot={handleSelectSpot}
                gridWeather={gridWeather}
                getSpotWeather={getSpotWeather}
              />
            )}
          </section>
        )}
      </main>



      <style>{`
        .app-viewport-container {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          padding: 16px;
          gap: 16px;
          max-width: 1400px;
          margin: 0 auto;
          width: 100%;
        }

        .app-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 20px;
          flex-wrap: wrap;
          gap: 12px;
        }

        .header-logo-section {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .brand-texts {
          display: flex;
          flex-direction: column;
        }

        .logo-title {
          font-family: var(--font-sans);
          font-size: 1.4rem;
          font-weight: 900;
          color: var(--text-primary);
          letter-spacing: -0.5px;
          margin: 0;
          line-height: 1.1;
        }

        .logo-subtitle {
          font-size: 0.72rem;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .weather-preset-selector {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .preset-label {
          font-size: 0.72rem;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .app-main-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 16px;
          flex: 1;
          width: 100%;
        }

        @media (min-width: 768px) and (max-width: 1199px) {
          .app-main-grid {
            grid-template-columns: 320px 1fr;
          }
          .microclimates-column {
            grid-column: span 2;
          }
        }

        @media (min-width: 1200px) {
          .app-main-grid {
            grid-template-columns: 320px 1fr 340px;
          }
          .app-main-grid.hud-active-grid {
            grid-template-columns: 320px 1fr;
          }
        }

        .controls-column {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .views-column {
          display: flex;
          flex-direction: column;
          gap: 16px;
          min-width: 0;
        }

        .microclimates-column {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .tab-menu {
          display: flex;
          padding: 4px;
          gap: 4px;
          border-radius: 12px !important;
        }

        .tab-btn {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          background: transparent;
          border: none;
          outline: none;
          color: var(--text-secondary);
          font-family: var(--font-sans);
          font-size: 0.88rem;
          font-weight: 700;
          padding: 10px 16px;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .tab-btn:hover {
          background: rgba(255, 255, 255, 0.03);
          color: var(--text-primary);
        }

        .active-tab {
          background: rgba(255, 255, 255, 0.06) !important;
          color: var(--color-safe) !important;
        }

        .tab-content-container {
          flex: 1;
          display: flex;
          flex-direction: column;
        }

        .loading-card {
          padding: 40px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 16px;
          height: 380px;
        }

        .loader-element {
          width: 32px;
          height: 32px;
          border: 3px solid rgba(0, 230, 118, 0.1);
          border-radius: 50%;
          border-top-color: var(--color-safe);
          animation: spin 1s linear infinite;
        }

        .loading-text {
          font-size: 0.85rem;
          color: var(--text-secondary);
          font-weight: 500;
        }

        .route-analysis-card {
          padding: 16px;
          background: var(--bg-panel);
          border: 1px solid var(--border-color);
          border-radius: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .analysis-header {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .analysis-title {
          font-size: 0.95rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin: 0;
          color: var(--text-primary);
        }

        .analysis-text-summary {
          font-size: 0.88rem;
          color: var(--text-secondary);
          line-height: 1.45;
          margin: 0;
        }

        .font-bold {
          font-weight: 700;
        }

        .analysis-bar-chart {
          display: flex;
          height: 24px;
          border-radius: 12px;
          overflow: hidden;
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid var(--border-color);
          font-family: var(--font-sans);
          font-size: 0.72rem;
          font-weight: 800;
          color: #000;
        }

        .bar-segment {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          transition: width 0.5s ease;
          overflow: hidden;
          white-space: nowrap;
        }

        .bg-safe {
          background-color: var(--color-safe);
          color: #000 !important;
        }

        .bg-moderate {
          background-color: var(--color-moderate);
          color: #000 !important;
        }

        .bg-dangerous {
          background-color: var(--color-dangerous);
          color: #000 !important;
        }

        .analysis-legend {
          display: flex;
          flex-wrap: wrap;
          gap: 16px;
          margin-top: 4px;
        }

        .legend-item {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.75rem;
          color: var(--text-secondary);
          font-weight: 600;
        }

        .legend-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }

        .app-footer {
          text-align: center;
          padding: 16px 0;
          border-top: 1px solid rgba(255, 255, 255, 0.03);
        }

        .footer-credits {
          font-size: 0.72rem;
          color: var(--text-muted);
          font-weight: 500;
        }

        .animate-fade-in {
          animation: fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }

        @keyframes fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .live-header-status {
          display: flex;
          align-items: center;
          gap: 6px;
          background: rgba(0, 230, 118, 0.05);
          border: 1px solid rgba(0, 230, 118, 0.15);
          padding: 6px 14px;
          border-radius: 20px;
        }

        .live-status-text {
          font-size: 0.72rem;
          font-weight: 800;
          color: var(--color-safe);
          letter-spacing: 0.5px;
          font-family: var(--font-sans);
        }

        .locate-me-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.15);
          padding: 6px 14px;
          border-radius: 20px;
          color: var(--text-primary);
          font-family: var(--font-sans);
          font-size: 0.72rem;
          font-weight: 800;
          letter-spacing: 0.5px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .locate-me-btn:hover {
          background: rgba(255, 255, 255, 0.1);
          border-color: rgba(255, 255, 255, 0.25);
          color: var(--color-safe);
        }

        .locate-me-btn.active-locate {
          background: rgba(0, 230, 118, 0.15);
          border-color: rgba(0, 230, 118, 0.4);
          color: var(--color-safe);
          box-shadow: 0 0 10px rgba(0, 230, 118, 0.2);
        }

        .locate-me-btn svg {
          transition: color 0.2s ease;
        }
        
        .locate-me-btn:hover svg, .locate-me-btn.active-locate svg {
          color: var(--color-safe);
        }

        /* Premium Route Analysis Card sidebar specific styles */
        .spot-sidebar-panel {
          display: flex;
          flex-direction: column;
          gap: 12px;
          width: 100%;
          max-height: calc(100vh - 200px);
          overflow: hidden;
          padding: 16px;
        }

        .analysis-stats-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 8px;
          margin-top: 4px;
        }

        .analysis-stat-box {
          display: flex;
          flex-direction: column;
          gap: 2px;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid var(--border-color);
          border-radius: 8px;
          padding: 8px 10px;
          transition: border-color 0.2s ease;
        }

        .analysis-stat-box:hover {
          border-color: rgba(255, 255, 255, 0.08);
        }

        .analysis-stat-lbl {
          font-size: 0.58rem;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.3px;
        }

        .analysis-stat-val {
          font-family: var(--font-mono);
          font-size: 0.82rem;
          font-weight: 800;
          color: var(--text-primary);
        }

        .analysis-stat-unit {
          font-size: 0.6rem;
          color: var(--text-secondary);
          margin-left: 2px;
        }

        .advice-badge-card {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.05);
          background: rgba(255, 255, 255, 0.01);
          margin-top: 4px;
        }

        .advice-badge-card.safe {
          border-color: rgba(0, 230, 118, 0.15);
          background: rgba(0, 230, 118, 0.02);
        }

        .advice-badge-card.moderate {
          border-color: rgba(255, 145, 0, 0.15);
          background: rgba(255, 145, 0, 0.02);
        }

        .advice-badge-card.dangerous {
          border-color: rgba(255, 23, 68, 0.15);
          background: rgba(255, 23, 68, 0.02);
        }

        .advice-badge-icon {
          flex-shrink: 0;
          margin-top: 1px;
        }

        .advice-badge-icon.safe { color: var(--color-safe); }
        .advice-badge-icon.moderate { color: var(--color-moderate); }
        .advice-badge-icon.dangerous { color: var(--color-dangerous); }

        .advice-badge-title {
          font-size: 0.75rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--text-primary);
          margin: 0;
        }

        .advice-badge-desc {
          font-size: 0.68rem;
          color: var(--text-secondary);
          line-height: 1.35;
          margin: 3px 0 0 0;
        }

        .chart-container-card {
          background: rgba(0, 0, 0, 0.2);
          border: 1px solid var(--border-color);
          border-radius: 10px;
          padding: 10px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .chart-header-info {
          display: flex;
          justify-content: space-between;
          font-size: 0.62rem;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.3px;
        }

        .chart-y-max {
          color: var(--text-secondary);
        }

        .chart-x-labels {
          display: flex;
          justify-content: space-between;
          font-size: 0.58rem;
          font-family: var(--font-mono);
          color: var(--text-muted);
          margin-top: -2px;
        }
        .forecast-slider-container {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 6px 14px;
          border-radius: 20px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .forecast-label {
          font-family: var(--font-mono);
          font-size: 0.75rem;
          font-weight: 700;
          color: var(--text-primary);
          min-width: 32px;
        }

        .forecast-slider {
          -webkit-appearance: none;
          appearance: none;
          width: 100px;
          height: 4px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 2px;
          outline: none;
          cursor: pointer;
        }

        .forecast-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--color-safe);
          cursor: pointer;
          border: 2px solid #0a0c10;
        }

        .forecast-slider::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--color-safe);
          cursor: pointer;
          border: 2px solid #0a0c10;
        }
      `}</style>
    </div>
  );
}

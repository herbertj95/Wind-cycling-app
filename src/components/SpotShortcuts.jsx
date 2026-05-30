import React from 'react';
import { MICROCLIMATE_SPOTS } from '../utils/weatherApi';
import { Compass, ShieldCheck, Warning } from '@phosphor-icons/react';

export default function SpotShortcuts({ 
  selectedSpot, 
  onSelectSpot, 
  gridWeather, 
  getSpotWeather 
}) {
  return (
    <div className="spot-sidebar-panel glass-panel">
      <div className="sidebar-header-compact">
        <Compass size={18} className="icon-pulse text-safe" />
        <span className="sidebar-title">SPOTS</span>
      </div>
      
      <div className="sidebar-scroll-list">
        {MICROCLIMATE_SPOTS.map((spot) => {
          const weather = getSpotWeather(spot);
          const isSelected = selectedSpot?.id === spot.id;
          
          // Determine speed color index
          let windColor = 'var(--color-safe)';
          if (weather.windSpeed > 15) windColor = 'var(--color-dangerous)';
          else if (weather.windSpeed > 10) windColor = 'var(--color-moderate)';
          else if (weather.windSpeed > 5) windColor = 'var(--color-breeze)';

          return (
            <div
              key={spot.id}
              onClick={() => onSelectSpot(spot)}
              className={`spot-list-item ${isSelected ? 'active-item' : ''}`}
            >
              <div className="spot-item-header">
                <div className="spot-item-info">
                  <span className="spot-item-name">{spot.name}</span>
                  <span className="spot-item-desc-short">
                    {spot.isSheltered ? (
                      <span className="text-safe">🟢 Sheltered</span>
                    ) : spot.rimWarning ? (
                      <span className="text-danger">🔴 Severe Crosswinds</span>
                    ) : (
                      <span className="text-moderate">🟡 Exposed</span>
                    )}
                  </span>
                </div>
                
                <div className="spot-item-telemetry">
                  <span className="spot-item-speed" style={{ color: windColor }}>
                    {weather.windSpeed} <span className="speed-unit">km/h</span>
                  </span>
                  <span 
                    className="spot-item-arrow" 
                    style={{ transform: `rotate(${weather.windDir}deg)`, display: 'inline-block' }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"></line>
                      <polyline points="19 12 12 19 5 12"></polyline>
                    </svg>
                  </span>
                </div>
              </div>

              {isSelected && (
                <div className="spot-item-details animate-slide-down">
                  <div className="spot-safety-tags">
                    {spot.isSheltered ? (
                      <span className="safety-badge sheltered">
                        <ShieldCheck size={12} /> Shielded
                      </span>
                    ) : (
                      <span className="safety-badge exposed">
                        <Warning size={12} /> Fully Exposed
                      </span>
                    )}
                    {spot.rimWarning && (
                      <span className="safety-badge deep-rim">
                        <Warning size={12} /> No Deep Rims
                      </span>
                    )}
                  </div>
                  
                  <p className="spot-description">{spot.desc}</p>
                  
                  <div className="spot-stats-grid">
                    <div className="spot-stat">
                      <span className="spot-stat-label">Gusts Max</span>
                      <span className="spot-stat-value" style={{
                        color: weather.windGusts > 20 ? 'var(--color-dangerous)' : 'var(--text-primary)'
                      }}>
                        {weather.windGusts} <span className="stat-unit">km/h</span>
                      </span>
                    </div>

                    <div className="spot-stat">
                      <span className="spot-stat-label">Wind Dir</span>
                      <span className="spot-stat-value">
                        {weather.windDir}° <span className="stat-unit">NW</span>
                      </span>
                    </div>

                    <div className="spot-stat">
                      <span className="spot-stat-label">Feels Like</span>
                      <span className="spot-stat-value">
                        {weather.apparentTemp}°<span className="stat-unit">C</span>
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <style>{`
        .spot-sidebar-panel {
          display: flex;
          flex-direction: column;
          gap: 12px;
          width: 100%;
          max-height: calc(100vh - 200px);
          overflow: hidden;
          padding: 16px;
        }
        
        .sidebar-header-compact {
          display: flex;
          align-items: center;
          gap: 8px;
          padding-bottom: 8px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }

        .sidebar-title {
          font-size: 0.85rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--text-secondary);
        }

        .text-safe {
          color: var(--color-safe);
        }

        .sidebar-scroll-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
          overflow-y: auto;
          flex: 1;
          padding-right: 2px;
          scrollbar-width: thin;
        }

        .spot-list-item {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid var(--border-color);
          border-radius: 8px;
          padding: 10px 12px;
          cursor: pointer;
          transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .spot-list-item:hover {
          background: rgba(255, 255, 255, 0.05);
          border-color: rgba(255, 255, 255, 0.15);
        }

        .active-item {
          background: rgba(0, 230, 118, 0.04) !important;
          border-color: var(--color-safe) !important;
          box-shadow: inset 0 0 12px rgba(0, 230, 118, 0.03);
        }

        .spot-item-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          width: 100%;
        }

        .spot-item-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .spot-item-name {
          font-size: 0.82rem;
          font-weight: 700;
          color: var(--text-primary);
        }

        .spot-item-desc-short {
          font-size: 0.65rem;
          font-weight: 700;
          text-transform: uppercase;
        }

        .spot-item-telemetry {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .spot-item-speed {
          font-family: var(--font-mono);
          font-size: 0.85rem;
          font-weight: 800;
        }

        .speed-unit {
          font-size: 0.6rem;
          color: var(--text-secondary);
        }

        .spot-item-arrow {
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-secondary);
          transition: transform 0.4s ease;
        }

        .spot-item-details {
          padding-top: 10px;
          border-top: 1px solid rgba(255, 255, 255, 0.04);
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .spot-safety-tags {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }

        .safety-badge {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          font-size: 0.62rem;
          font-weight: 800;
          padding: 2px 6px;
          border-radius: 4px;
          text-transform: uppercase;
        }

        .safety-badge.sheltered {
          background: rgba(0, 230, 118, 0.08);
          color: var(--color-safe);
          border: 1px solid rgba(0, 230, 118, 0.15);
        }

        .safety-badge.exposed {
          background: rgba(255, 145, 0, 0.08);
          color: var(--color-moderate);
          border: 1px solid rgba(255, 145, 0, 0.15);
        }

        .safety-badge.deep-rim {
          background: rgba(255, 23, 68, 0.08);
          color: var(--color-dangerous);
          border: 1px solid rgba(255, 23, 68, 0.15);
        }

        .spot-description {
          font-size: 0.72rem;
          color: var(--text-secondary);
          line-height: 1.4;
          margin: 0;
        }

        .spot-stats-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 6px;
          margin-top: 4px;
        }

        .spot-stat {
          display: flex;
          flex-direction: column;
          gap: 2px;
          background: rgba(0, 0, 0, 0.15);
          border: 1px solid rgba(255, 255, 255, 0.02);
          border-radius: 6px;
          padding: 6px;
        }

        .spot-stat-label {
          font-size: 0.58rem;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.3px;
        }

        .spot-stat-value {
          font-family: var(--font-mono);
          font-size: 0.75rem;
          font-weight: 800;
          color: var(--text-primary);
        }

        .stat-unit {
          font-size: 0.58rem;
          color: var(--text-secondary);
        }

        @keyframes slide-down {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .animate-slide-down {
          animation: slide-down 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
      `}</style>
    </div>
  );
}

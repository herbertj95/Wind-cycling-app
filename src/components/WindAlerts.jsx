import React from 'react';
import { Warning, WarningCircle, ShieldCheck } from '@phosphor-icons/react';

export default function WindAlerts({ gridWeather }) {
  if (!gridWeather || gridWeather.length === 0) return null;

  // Find max gust in the region
  let maxGust = 0;
  let maxGustLocation = null;
  let unsafeCount = 0;

  gridWeather.forEach(pt => {
    if (pt.windGusts > maxGust) {
      maxGust = pt.windGusts;
      maxGustLocation = pt;
    }
    if (pt.windGusts > 20) {
      unsafeCount++;
    }
  });

  const hasHighGusts = maxGust >= 20;
  const isDangerous = maxGust >= 30;

  return (
    <div className={`wind-alerts-banner glass-panel ${hasHighGusts ? (isDangerous ? 'alert-danger' : 'alert-warn') : 'alert-safe'}`}>
      <div className="alert-header">
        {isDangerous ? (
          <Warning size={20} className="text-danger animate-pulse" />
        ) : hasHighGusts ? (
          <WarningCircle size={20} className="text-warn" />
        ) : (
          <ShieldCheck size={20} className="text-safe" />
        )}
        <div className="alert-headline-container">
          <span className="alert-label">
            {isDangerous ? 'GUST ALERT: DANGEROUS WINDS' : hasHighGusts ? 'WIND WARNING: ACTIVE GUSTS' : 'RIDE PROFILE: SAFE WINDS'}
          </span>
          <span className="alert-sub-label">
            {isDangerous 
              ? `Max gusts at ${maxGust} km/h in the area. Extreme handling risk!` 
              : hasHighGusts 
                ? `Active gusts up to ${maxGust} km/h. Solid crosswind drift.` 
                : `Winds are calm (max gust: ${maxGust} km/h). Perfect cycling weather.`}
          </span>
        </div>
      </div>

      {hasHighGusts && (
        <div className="alert-details-pane">
          <div className="warning-pill-group">
            <span className="warning-pill bg-dark-red">
              <span className="pulsing-dot"></span>
              <span>Carbon Deep Rims Unsafe (50mm+)</span>
            </span>
            <span className="warning-pill bg-dark-orange">
              <span>Handling Drift: High</span>
            </span>
          </div>
          <p className="alert-advice-text">
            {isDangerous 
              ? 'Recommendation: Avoid exposed sea cliffs like Guincho or high-elevation Sintra Peninha peaks. Seek cover in Monsanto Forest Park or stick to low inland routes.'
              : 'Recommendation: Hold handlebars firmly. Expect abrupt crosswind buffeting on Estrada Marginal. Avoid deep-rim carbon front wheels.'}
          </p>
        </div>
      )}

      <style>{`
        .wind-alerts-banner {
          padding: 12px 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          border-radius: 12px;
          border: 1px solid var(--border-color);
          margin-bottom: 20px;
          transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .alert-safe {
          border-left: 4px solid var(--color-safe);
          background: rgba(0, 230, 118, 0.02);
        }

        .alert-warn {
          border-left: 4px solid var(--color-moderate);
          background: rgba(255, 145, 0, 0.02);
          box-shadow: 0 0 15px rgba(255, 145, 0, 0.03);
        }

        .alert-danger {
          border-left: 4px solid var(--color-dangerous);
          background: rgba(255, 23, 68, 0.02);
          box-shadow: 0 0 20px rgba(255, 23, 68, 0.05);
        }

        .alert-header {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .alert-headline-container {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .alert-label {
          font-family: var(--font-sans);
          font-size: 0.85rem;
          font-weight: 900;
          letter-spacing: 0.5px;
        }

        .alert-sub-label {
          font-size: 0.78rem;
          color: var(--text-secondary);
        }

        .text-safe {
          color: var(--color-safe);
        }

        .text-warn {
          color: var(--color-moderate);
        }

        .text-danger {
          color: var(--color-dangerous);
        }

        .alert-details-pane {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding-top: 8px;
          border-top: 1px solid rgba(255, 255, 255, 0.04);
        }

        .warning-pill-group {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .warning-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 0.72rem;
          font-weight: 700;
          padding: 4px 10px;
          border-radius: 20px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          border: 1px solid rgba(255, 255, 255, 0.05);
        }

        .bg-dark-red {
          background: rgba(255, 23, 68, 0.15);
          color: var(--color-dangerous);
          border-color: rgba(255, 23, 68, 0.25) !important;
        }

        .bg-dark-orange {
          background: rgba(255, 145, 0, 0.15);
          color: var(--color-moderate);
          border-color: rgba(255, 145, 0, 0.25) !important;
        }

        .alert-advice-text {
          font-size: 0.78rem;
          color: var(--text-secondary);
          line-height: 1.45;
          margin: 0;
        }
      `}</style>
    </div>
  );
}

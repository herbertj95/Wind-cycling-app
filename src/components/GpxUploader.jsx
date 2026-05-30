import React, { useState, useRef } from 'react';
import { UploadSimple, FileCode, CheckCircle, WarningCircle, Bicycle } from '@phosphor-icons/react';
import { parseGpxData, PRESET_ROUTES } from '../utils/gpxParser';

export default function GpxUploader({
  activeRoute,
  onRouteLoaded,
  onClearRoute
}) {
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleChange = (e) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  const onButtonClick = () => {
    fileInputRef.current.click();
  };

  const processFile = (file) => {
    if (!file.name.endsWith('.gpx')) {
      setError("Only valid GPX files are supported");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        // Parse GPX
        const parsed = parseGpxData(text, file.name.replace('.gpx', ''));
        onRouteLoaded(parsed);
        setError(null);
      } catch (err) {
        setError(err.message || "Failed to parse GPX route structure");
      }
    };
    reader.readAsText(file);
  };

  const handleSelectPreset = async (preset) => {
    try {
      setError(null);
      const response = await fetch(`/routes/${preset.filename}`);
      if (!response.ok) {
        throw new Error(`Failed to load '${preset.filename}' from public/routes/`);
      }
      const gpxText = await response.text();
      const parsed = parseGpxData(gpxText, preset.name);
      parsed.id = preset.id; // Keep track of preset selection active-state in UI
      onRouteLoaded(parsed);
    } catch (err) {
      setError(err.message || "Failed to load preset route");
    }
  };

  return (
    <div className="gpx-uploader-container glass-card">
      <div className="uploader-header">
        <Bicycle size={20} className="text-safe" />
        <h3 className="uploader-title">GPX Route & Segments</h3>
      </div>

      {activeRoute ? (
        <div className="active-route-box">
          <div className="route-meta">
            <div className="route-icon-container">
              <CheckCircle size={22} className="text-safe" />
            </div>
            <div className="route-details">
              <span className="route-name-label">Active Route</span>
              <h4 className="route-display-name">{activeRoute.name}</h4>
              <p className="route-stats">
                {activeRoute.totalDistance.toFixed(1)} km | +{activeRoute.totalElevationGain}m elevation
              </p>
            </div>
          </div>
          <button onClick={onClearRoute} className="btn-clear">
            Clear Route
          </button>
        </div>
      ) : (
        <div
          className={`drop-zone ${dragActive ? "drag-active" : ""}`}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            className="input-file-hidden"
            accept=".gpx"
            onChange={handleChange}
          />

          <UploadSimple size={28} className="upload-icon text-secondary" />
          <p className="upload-prompt">
            Drag and drop your cycling .gpx file or{" "}
            <button type="button" className="btn-upload-trigger" onClick={onButtonClick}>
              browse files
            </button>
          </p>
          <span className="upload-subtext">Supports Strava, Garmin, and GPX format tracks</span>
        </div>
      )}

      {error && (
        <div className="error-message">
          <WarningCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="presets-section">
        <span className="presets-title">Quick presets (cycling loops)</span>
        <div className="presets-grid">
          {PRESET_ROUTES.map((preset) => {
            const isSelected = activeRoute?.id === preset.id;
            return (
              <button
                key={preset.id}
                onClick={() => handleSelectPreset(preset)}
                className={`preset-btn ${isSelected ? "preset-active" : ""}`}
              >
                <div className="preset-btn-inner">
                  <span className="preset-name">{preset.name}</span>
                  <span className="preset-desc">{preset.description}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <style>{`
        .gpx-uploader-container {
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 14px;
          background: var(--bg-card);
          border: 1px solid var(--border-color);
          border-radius: 12px;
        }

        .uploader-header {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .uploader-title {
          font-size: 0.95rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin: 0;
          color: var(--text-primary);
        }

        .active-route-box {
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: rgba(0, 230, 118, 0.03);
          border: 1px solid rgba(0, 230, 118, 0.2);
          border-radius: 8px;
          padding: 12px;
        }

        .route-meta {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .route-details {
          display: flex;
          flex-direction: column;
        }

        .route-name-label {
          font-size: 0.7rem;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .route-display-name {
          font-size: 0.95rem;
          font-weight: 700;
          color: var(--text-primary);
          margin: 2px 0;
        }

        .route-stats {
          font-size: 0.75rem;
          color: var(--text-secondary);
          font-family: var(--font-mono);
          margin: 0;
        }

        .btn-clear {
          background: rgba(255, 23, 68, 0.1);
          color: var(--color-dangerous);
          border: 1px solid rgba(255, 23, 68, 0.2);
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 0.8rem;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .btn-clear:hover {
          background: rgba(255, 23, 68, 0.18);
        }

        .drop-zone {
          border: 2px dashed var(--border-color);
          border-radius: 8px;
          padding: 20px;
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
          background: rgba(0, 0, 0, 0.1);
        }

        .drop-zone:hover, .drag-active {
          border-color: var(--color-safe);
          background: rgba(0, 230, 118, 0.02);
        }

        .input-file-hidden {
          display: none;
        }

        .upload-icon {
          margin-bottom: 4px;
        }

        .upload-prompt {
          font-size: 0.85rem;
          color: var(--text-secondary);
          margin: 0;
        }

        .btn-upload-trigger {
          background: none;
          border: none;
          color: var(--color-safe);
          font-weight: 700;
          text-decoration: underline;
          cursor: pointer;
          padding: 0;
        }

        .upload-subtext {
          font-size: 0.7rem;
          color: var(--text-muted);
        }

        .error-message {
          display: flex;
          align-items: center;
          gap: 6px;
          background: rgba(255, 23, 68, 0.08);
          color: var(--color-dangerous);
          border: 1px solid rgba(255, 23, 68, 0.2);
          border-radius: 6px;
          padding: 8px 12px;
          font-size: 0.8rem;
          font-weight: 600;
        }

        .presets-section {
          display: flex;
          flex-direction: column;
          gap: 8px;
          border-top: 1px solid var(--border-color);
          padding-top: 12px;
        }

        .presets-title {
          font-size: 0.75rem;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .presets-grid {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .preset-btn {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid var(--border-color);
          border-radius: 8px;
          padding: 8px 12px;
          text-align: left;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
          color: var(--text-primary);
        }

        .preset-btn:hover {
          background: rgba(255, 255, 255, 0.06);
          border-color: rgba(255, 255, 255, 0.15);
        }

        .preset-active {
          background: rgba(0, 230, 118, 0.04) !important;
          border-color: rgba(0, 230, 118, 0.3) !important;
        }

        .preset-btn-inner {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .preset-name {
          font-size: 0.82rem;
          font-weight: 700;
        }

        .preset-desc {
          font-size: 0.72rem;
          color: var(--text-secondary);
        }
      `}</style>
    </div>
  );
}

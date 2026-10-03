import { useRef } from 'react';
import { UploadSimple, WarningCircle } from '@phosphor-icons/react';
import { PRESET_ROUTES } from '../utils/gpxParser';

/**
 * Route picker: the bundled Lisbon routes plus your own GPX file.
 */
export default function RoutesMenu({ id, activeId, error, onPreset, onFile }) {
  const fileInputRef = useRef(null);

  const handleChange = (e) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
    e.target.value = '';
  };

  return (
    <div id={id} className="routes-menu panel">
      <button type="button" className="upload-button" onClick={() => fileInputRef.current.click()}>
        <UploadSimple size={18} aria-hidden="true" />
        <span>
          <b>Open a GPX file</b>
          <small>From Strava, Garmin or Komoot. You can also drop it on the map.</small>
        </span>
      </button>
      <input ref={fileInputRef} type="file" accept=".gpx,application/gpx+xml,application/xml,text/xml,application/octet-stream" hidden onChange={handleChange} />

      {error && (
        <p className="menu-error" role="alert">
          <WarningCircle size={16} aria-hidden="true" />
          {error}
        </p>
      )}

      <ul>
        {PRESET_ROUTES.map((preset) => (
          <li key={preset.id}>
            <button type="button" aria-current={activeId === preset.id} onClick={() => onPreset(preset)}>
              <b>{preset.name}</b>
              <small>{preset.description}</small>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

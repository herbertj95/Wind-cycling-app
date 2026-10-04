import { useState } from 'react';
import { BookmarkSimple, WifiSlash } from '@phosphor-icons/react';
import WindDial from './WindDial';
import { CALM_KMH, beaufortLabel, compassPoint, describeRiderWind, wholeDegrees } from '../utils/wind';

const PROBLEM_TEXT = {
  offline: 'The wind forecast could not be loaded. Check your connection.',
  service: 'The forecast service is not answering right now. Try again in a while.',
  limit: 'The free forecast service has had too many requests from this connection. Try again in a while.',
};
const STALE_TEXT = {
  offline: 'Offline.',
  service: 'The forecast service is not answering.',
  limit: 'The forecast service is busy.',
};

// a forecast point can come without a temperature: that is shown as missing, not as zero
const degrees = (value, unit = '') => (Number.isFinite(value) ? `${Math.round(value)}°${unit}` : '–');

/**
 * The reading for the place in focus: how strong, from where, and the gusts.
 * - status: 'ready' (there is a reading), 'loading', 'error', 'none' (no forecast for this point or moment)
 *   or 'empty' (no place is in focus)
 * - reading: { speed, from, gust, temp, feels } when status is 'ready'
 * - rider: { bearing, head, cross, color } when the focus is a point on the route
 * - problem: why the last download failed, 'offline' | 'service' | 'limit', or null
 * - updatedAt: when the forecast being shown was downloaded, e.g. "Sat 3, 18:42"
 * - stale: the forecast being shown is due for renewal and could not be renewed
 * - place: what can be done with the place in focus, or null when it cannot be saved (the rider on a route):
 *   { key, saved, name }. `name` is the name it would be saved under when it already has one.
 * - quiet: the numbers are changing continuously (playback), so screen readers are not told each step
 */
export default function WindReadout({ ref, title, when, reading, rider, note, status, problem, updatedAt, stale, quiet, place, onSave, onRemove, onRetry }) {
  // the key of the place whose name is being typed; a different place in focus closes the form by itself
  const [namingKey, setNamingKey] = useState(null);
  const [name, setName] = useState('');

  const hasReading = status === 'ready';
  const isCalm = hasReading && reading.speed < CALM_KMH;
  const speed = hasReading ? Math.round(reading.speed) : null;
  const spoken = hasReading && !isCalm ? `from the ${compassPoint(reading.from)}` : 'calm';
  const naming = place !== null && !place.saved && namingKey === place.key;

  const toggleSaved = () => {
    if (place.saved) onRemove();
    else if (place.name) onSave(place.name);
    else {
      setName('');
      setNamingKey(naming ? null : place.key);
    }
  };

  const submitName = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setNamingKey(null);
    onSave(name.trim());
  };

  return (
    <section ref={ref} className="readout panel">
      <div className={place ? 'readout-top can-save' : 'readout-top'}>
        <h1>{title}</h1>
        {when && <span>{when}</span>}
        {place && (
          <button
            type="button"
            className="icon-button readout-save"
            aria-pressed={place.saved}
            aria-label={place.saved ? 'Remove from my places' : 'Save to my places'}
            title={place.saved ? 'Remove from my places' : 'Save to my places'}
            onClick={toggleSaved}
          >
            <BookmarkSimple size={17} weight={place.saved ? 'fill' : 'regular'} aria-hidden="true" />
          </button>
        )}
      </div>

      {naming && (
        <form className="readout-name" onSubmit={submitName}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name this place"
            aria-label="Name for this place"
            maxLength={40}
            autoFocus
          />
          <button type="submit" className="pill-button" disabled={!name.trim()}>Save</button>
        </form>
      )}

      {status === 'empty' ? (
        <div className="readout-message">
          <p>Search for a place or tap the map to read the wind there.</p>
        </div>
      ) : status === 'error' ? (
        <div className="readout-message">
          <p>{PROBLEM_TEXT[problem] ?? PROBLEM_TEXT.offline}</p>
          <button type="button" className="text-button" onClick={onRetry}>Try again</button>
        </div>
      ) : status === 'loading' ? (
        <div className="readout-message"><p>Loading the wind forecast…</p></div>
      ) : !hasReading ? (
        <div className="readout-message">
          <p>There is no wind forecast for this point at this time.</p>
        </div>
      ) : (
        <>
          <div className="readout-main">
            <WindDial from={isCalm ? undefined : reading.from} bearing={rider?.bearing} />
            <div>
              <div className="readout-speed">
                {speed}
                <small>km/h</small>
              </div>
              <div className="readout-direction">
                {isCalm ? 'calm' : (
                  <>from the <b>{compassPoint(reading.from)}</b> <span>{wholeDegrees(reading.from)}°</span></>
                )}
              </div>
            </div>
            <div className="readout-side">
              gusts <b>{Math.round(reading.gust)}</b>
              <br />
              <b>{degrees(reading.temp)}</b>, feels <b>{degrees(reading.feels)}</b>
            </div>
          </div>

          <dl className="readout-stats">
            <div>
              <dt>Gusts</dt>
              <dd>{Math.round(reading.gust)} km/h</dd>
            </div>
            <div>
              <dt>Temperature</dt>
              <dd>{degrees(reading.temp, 'C')} <small>feels {degrees(reading.feels)}</small></dd>
            </div>
            <div>
              <dt>Beaufort</dt>
              <dd>{beaufortLabel(reading.speed)}</dd>
            </div>
          </dl>

          {rider && (
            <p className="readout-effect">
              <i className="swatch" style={{ background: rider.color }} />
              {describeRiderWind(rider.head, rider.cross)}
            </p>
          )}
          {note && !rider && <p className="readout-note">{note}</p>}
          <p className="readout-hint">
            Arrows point the way the wind blows, numbers are km/h. Tap the map to read any point.
            {updatedAt && !stale && ` Forecast updated ${updatedAt}.`}
          </p>
        </>
      )}

      {stale && hasReading && (
        <p className="readout-offline">
          <WifiSlash size={14} aria-hidden="true" />
          <span>
            {STALE_TEXT[problem] ?? STALE_TEXT.offline} Showing the forecast from {updatedAt}.{' '}
            <button type="button" className="text-button" onClick={onRetry}>Try again</button>
          </span>
        </p>
      )}

      {/* one whole sentence for screen readers, instead of every changing fragment above */}
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {hasReading && !quiet
          ? `${title}${when ? `, ${when}` : ''}: ${speed} kilometres per hour ${spoken}, gusts ${Math.round(reading.gust)}.${rider ? ` ${describeRiderWind(rider.head, rider.cross)}.` : ''}`
          : ''}
      </p>
    </section>
  );
}

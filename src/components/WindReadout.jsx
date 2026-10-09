import { useState } from 'react';
import { BookmarkSimple, CaretDown, CaretUp, Drop, Gauge, WifiSlash } from '@phosphor-icons/react';
import WindDial from './WindDial';
import { CALM_KMH, beaufortLabel, compassPoint, describeRiderWind, wholeDegrees } from '../utils/wind';
import { describeRain, formatRain, isWet } from '../utils/rain';
import { compareWithForecast } from '../utils/ipma';

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
 * The reading for the place in focus: how strong, from where, and the gusts; and the rain, when there is
 * any to speak of.
 * - shortTitle: what to call the place where there is little room (the kilometre, on a route); the title otherwise
 * - status: 'ready' (there is a reading), 'loading', 'error', 'none' (no forecast for this point or moment)
 *   or 'empty' (no place is in focus)
 * - reading: { speed, from, gust, temp, feels, rain, rainChance } when status is 'ready'
 * - rider: { bearing, head, cross, color } when the focus is a point on the route
 * - problem: why the last download failed, 'offline' | 'service' | 'limit', or null
 * - updatedAt: when the forecast being shown was downloaded, e.g. "Sat 3, 18:42"
 * - stale: the forecast being shown is due for renewal and could not be renewed
 * - place: what can be done with the place in focus, or null when it cannot be saved (the rider on a route):
 *   { key, saved, name }. `name` is the name it would be saved under when it already has one.
 * - measured: what the nearest weather station last measured, or null: { name, km, clock, speed, from,
 *   forecast }, with `from` null for a wind without a direction and `forecast` the km/h the forecast
 *   gave for that station and hour, or null
 * - quiet: the numbers are changing continuously (playback), so screen readers are not told each step
 * - collapsed: the reading is shown on one line, to leave the map free. It only folds while there is a
 *   reading: a message about a missing forecast is always shown whole.
 */
export default function WindReadout({ ref, title, shortTitle, when, reading, rider, note, status, problem, updatedAt, stale, quiet, place, measured, onSave, onRemove, onRetry, collapsed, onToggleCollapsed }) {
  // the key of the place whose name is being typed; a different place in focus closes the form by itself
  const [namingKey, setNamingKey] = useState(null);
  const [name, setName] = useState('');

  const hasReading = status === 'ready';
  const isCalm = hasReading && reading.speed < CALM_KMH;
  const speed = hasReading ? Math.round(reading.speed) : null;
  const spoken = hasReading && !isCalm ? `from the ${compassPoint(reading.from)}` : 'calm';
  const naming = place !== null && !place.saved && namingKey === place.key;
  const folded = collapsed && hasReading;
  // null on a dry hour: the panel only grows a line when rain is on the way
  const rain = hasReading ? describeRain(reading.rain, reading.rainChance) : null;
  // the wind a station nearby measured, and how the forecast for that station did
  const station = hasReading && measured ? {
    wind: `${Math.round(measured.speed)} km/h${measured.from !== null && measured.speed >= CALM_KMH ? ` ${compassPoint(measured.from)}` : ''}`,
    verdict: compareWithForecast(measured.speed, measured.forecast),
    km: `${measured.km < 1 ? 'under 1' : Math.round(measured.km)} km`,
  } : null;

  // the panel hangs from the top of the screen: it folds upwards and opens downwards
  const foldButton = hasReading && (
    <button
      type="button"
      className="icon-button readout-fold"
      onClick={onToggleCollapsed}
      aria-expanded={!folded}
      aria-label={folded ? 'Show the wind details' : 'Hide the wind details'}
      title={folded ? 'Show the wind details' : 'Hide the wind details'}
    >
      {folded ? <CaretDown size={16} aria-hidden="true" /> : <CaretUp size={16} aria-hidden="true" />}
    </button>
  );

  // one whole sentence for screen readers, instead of every changing fragment of the panel
  const spokenReading = (
    <p className="visually-hidden" aria-live="polite" aria-atomic="true">
      {hasReading && !quiet
        ? `${title}${when ? `, ${when}` : ''}: ${speed} kilometres per hour ${spoken}, gusts ${Math.round(reading.gust)}.${rider ? ` ${describeRiderWind(rider.head, rider.cross)}.` : ''}${rain ? ` ${rain}.` : ''}`
        : ''}
    </p>
  );

  if (folded) {
    return (
      <section ref={ref} className="readout panel folded">
        <div className="readout-brief">
          <WindDial from={isCalm ? undefined : reading.from} bearing={rider?.bearing} />
          <div className="readout-speed">
            {speed}
            <small>km/h</small>
          </div>
          <span className="readout-gist">
            {isCalm ? 'calm' : compassPoint(reading.from)}, gusts {Math.round(reading.gust)}
          </span>
          {isWet(reading.rain) && (
            <span className="readout-wet" title={rain}>
              <Drop size={12} weight="fill" aria-hidden="true" />
              {formatRain(reading.rain)} mm
            </span>
          )}
          {stale && <WifiSlash size={14} aria-label="This forecast could not be renewed" />}
          {/* on a route, the colour of what the wind does to the rider right there */}
          {rider && <i className="swatch" style={{ background: rider.color }} title={describeRiderWind(rider.head, rider.cross)} />}
          <h1 title={title}>{shortTitle ?? title}</h1>
          {foldButton}
        </div>
        {spokenReading}
      </section>
    );
  }

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
      <div className={`readout-top${place ? ' can-save' : ''}${hasReading ? ' can-fold' : ''}`}>
        <h1>{title}</h1>
        {when && <span>{when}</span>}
        {foldButton}
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
            <div className="readout-wind">
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

          {rain && (
            <p className="readout-rain">
              <Drop size={15} weight="fill" aria-hidden="true" />
              {rain}
            </p>
          )}

          {/* only where a weather station is near, and only for the present; on a phone it takes the
              place of the note, with the name of the station and the verdict in words left to the wider
              screens, and it gives way to what the wind does to the rider, which has no note to replace */}
          {station && (
            <p className={rider ? 'readout-measured beside-rider' : 'readout-measured'}>
              <Gauge size={15} aria-hidden="true" />
              <span>
                Measured <b>{station.wind}</b> at {measured.clock}
                {station.verdict === 'as forecast' && ', as forecast'}
                {station.verdict && station.verdict !== 'as forecast' && (
                  <>
                    <span className="measured-wide">, {station.verdict} (forecast {Math.round(measured.forecast)} km/h)</span>
                    <span className="measured-narrow">, forecast {Math.round(measured.forecast)} km/h</span>
                  </>
                )}
                {/* where the station stands: on its own line, or after a dot where the line runs on */}
                <small>
                  <span className="measured-joint"> · </span>
                  IPMA station <span className="measured-wide">{measured.name}, </span>{station.km} away
                </small>
              </span>
            </p>
          )}

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
          {note && !rider && <p className={station ? 'readout-note beside-measured' : 'readout-note'}>{note}</p>}
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

      {spokenReading}
    </section>
  );
}

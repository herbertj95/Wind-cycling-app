import { WifiSlash } from '@phosphor-icons/react';
import WindDial from './WindDial';
import { CALM_KMH, beaufortLabel, compassPoint, describeRiderWind, wholeDegrees } from '../utils/wind';

/**
 * The reading for the place in focus: how strong, from where, and the gusts.
 * - reading: { speed, from, gust, feels } or null while there is no forecast
 * - rider: { bearing, head, cross, color } when the focus is a point on the route
 * - updatedAt / offlineSince: when the forecast was downloaded, e.g. "Sat 3, 18:42"
 * - quiet: the numbers are changing continuously (playback), so screen readers are not told each step
 */
export default function WindReadout({ ref, title, when, reading, rider, note, outside, status, updatedAt, offlineSince, quiet, onRetry }) {
  const hasReading = status === 'ready' && reading && !outside;
  const isCalm = hasReading && reading.speed < CALM_KMH;
  const speed = hasReading ? Math.round(reading.speed) : null;
  const spoken = hasReading && !isCalm ? `from the ${compassPoint(reading.from)}` : 'calm';

  return (
    <section ref={ref} className="readout panel">
      <div className="readout-top">
        <h1>{title}</h1>
        {when && <span>{when}</span>}
      </div>

      {status === 'error' ? (
        <div className="readout-message">
          <p>The wind forecast could not be loaded. Check your connection.</p>
          <button type="button" className="text-button" onClick={onRetry}>Try again</button>
        </div>
      ) : status === 'loading' ? (
        <div className="readout-message"><p>Loading the wind forecast…</p></div>
      ) : !hasReading ? (
        <div className="readout-message">
          <p>Outside the forecast area. The forecast covers greater Lisbon, from Ericeira down to Arrábida.</p>
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
              <b>{Math.round(reading.temp)}°</b>, feels <b>{Math.round(reading.feels)}°</b>
            </div>
          </div>

          <dl className="readout-stats">
            <div>
              <dt>Gusts</dt>
              <dd>{Math.round(reading.gust)} km/h</dd>
            </div>
            <div>
              <dt>Temperature</dt>
              <dd>{Math.round(reading.temp)}°C <small>feels {Math.round(reading.feels)}°</small></dd>
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
            {updatedAt && !offlineSince && ` Forecast updated ${updatedAt}.`}
          </p>
        </>
      )}

      {offlineSince && status !== 'error' && (
        <p className="readout-offline">
          <WifiSlash size={14} aria-hidden="true" />
          <span>
            Offline. Showing the forecast from {offlineSince}.{' '}
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

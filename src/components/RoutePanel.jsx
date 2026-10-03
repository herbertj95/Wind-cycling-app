import { Pause, Play, Warning, Wind, X } from '@phosphor-icons/react';
import RouteChart from './RouteChart';
import { RIDE_SPEEDS } from '../utils/routeAnalysis';
import { formatDuration } from '../utils/time';

const PLAYBACK_RATES = [1, 2.5, 5];

function describePoint(point, wind) {
  const place = `km ${point.distance.toFixed(1)}, ${Math.round(point.ele)} m`;
  if (!wind) return place;
  const along = Math.round(Math.abs(wind.head));
  const across = Math.round(Math.abs(wind.cross));
  const alongText = along === 0 ? 'no head or tailwind' : `${along} km/h ${wind.head > 0 ? 'headwind' : 'tailwind'}`;
  const acrossText = across === 0 ? 'nothing across' : `${across} km/h across from the ${wind.cross > 0 ? 'right' : 'left'}`;
  return `${place}: ${alongText}, ${acrossText}`;
}

/**
 * Everything about the loaded route: how much of it is with, across and against the wind,
 * a plain-language verdict, and the profile you can ride along.
 * - analysis: from analyseRoute, or null while there is no forecast (the route itself is still shown)
 * - colors: { tail, neutral, head } for the current theme
 */
export default function RoutePanel({
  route,
  analysis,
  riderIdx,
  onScrub,
  onClear,
  playing,
  onTogglePlay,
  playbackRate,
  onPlaybackRate,
  rideKmh,
  onRideKmh,
  startLabel,
  colors,
}) {
  const total = route.totalDistance || 1;
  const index = Math.min(riderIdx, route.points.length - 1);
  // a route that mostly lies outside the forecast grid gets no wind verdict: there is no data to base one on
  const outside = analysis ? analysis.outsideKm >= total * 0.5 : false;
  const wind = analysis && !outside ? analysis.wind : null;
  const pointText = describePoint(route.points[index], wind?.[index]);

  return (
    <section className="route-panel panel">
      <div className="route-head">
        <h2 title={route.name}>{route.name}</h2>
        <span className="route-meta">{route.totalDistance.toFixed(1)} km, {route.totalElevationGain} m of climbing</span>
        <div className="route-actions">
          <button type="button" className="pill-button" onClick={onTogglePlay} aria-label={playing ? 'Pause the ride' : 'Ride the route'}>
            {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
            <span>{playing ? 'Pause' : 'Ride it'}</span>
          </button>
          <button
            type="button"
            className="speed-cycle"
            aria-label={`Playback speed ${playbackRate}x, tap to change`}
            onClick={() => onPlaybackRate(PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(playbackRate) + 1) % PLAYBACK_RATES.length])}
          >
            {playbackRate}x
          </button>
          <div className="segmented" role="group" aria-label="Playback speed">
            {PLAYBACK_RATES.map((rate) => (
              <button
                key={rate}
                type="button"
                aria-pressed={playbackRate === rate}
                onClick={() => onPlaybackRate(rate)}
              >
                {rate}x
              </button>
            ))}
          </div>
          <button type="button" className="icon-button" onClick={onClear} aria-label="Clear route">
            <X size={16} />
          </button>
        </div>
      </div>

      {!analysis && (
        <p className="route-plan">The wind along this route appears once the forecast has loaded.</p>
      )}

      {analysis && outside && (
        <p className="route-plan">This route is outside the forecast area, so there is no wind analysis for it.</p>
      )}

      {wind && (
        <>
          <p className="route-plan">
            Leaving {startLabel} at{' '}
            <select value={rideKmh} onChange={(e) => onRideKmh(Number(e.target.value))} aria-label="Average riding speed">
              {RIDE_SPEEDS.map((kmh) => (
                <option key={kmh} value={kmh}>{kmh} km/h</option>
              ))}
            </select>
            , about {formatDuration(analysis.durationHours)}.
            {analysis.beyondForecast && ' The ride ends after the forecast does.'}
            {analysis.outsideKm > total * 0.05 && ' Part of it lies outside the forecast area.'}
          </p>

          <Shares analysis={analysis} total={total} colors={colors} />
        </>
      )}

      <div className="route-point">{pointText}</div>
      <RouteChart
        route={route}
        wind={wind}
        riderIdx={index}
        onScrub={onScrub}
        headColor={colors.head}
        tailColor={colors.tail}
        valueText={pointText}
      />
    </section>
  );
}

function Shares({ analysis, total, colors }) {
  const { share, net, advisory } = analysis;
  const parts = [
    ['Tailwind', share.tail, colors.tail],
    ['Across or light', share.cross, colors.neutral],
    ['Headwind', share.head, colors.head],
  ];
  const AdviceIcon = advisory.tone === 'gusty' || advisory.tone === 'hard' ? Warning : Wind;

  return (
    <>
      <div className="share-bar" aria-hidden="true">
        {parts.map(([name, km, color]) => (
          <i key={name} style={{ flexGrow: Math.max(0.001, km), background: color }} />
        ))}
      </div>
      <div className="share-key">
        {parts.map(([name, km, color]) => (
          <span key={name}>
            <i className="swatch" style={{ background: color }} />
            {name} <b>{Math.round((km / total) * 100)}%</b>
            <i className="share-km">{Math.round(km)} km</i>
          </span>
        ))}
        <span className="share-net">
          {Math.abs(net) < 0.5
            ? 'Head and tailwind even out'
            : <>On balance <b>{Math.abs(net).toFixed(1)} km/h</b> {net > 0 ? 'against you' : 'behind you'}</>}
        </span>
        <span className="share-net">
          Wind averages <b>{Math.round(analysis.avgSpeed)} km/h</b>, gusts to <b>{Math.round(analysis.maxGust)}</b>
        </span>
      </div>

      <p className={`route-advice ${advisory.tone}`}>
        <AdviceIcon size={16} aria-hidden="true" />
        <span><b>{advisory.title}.</b> <span className="advice-text">{advisory.text}</span></span>
      </p>
    </>
  );
}

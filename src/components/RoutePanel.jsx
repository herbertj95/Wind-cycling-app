import { Fragment } from 'react';
import { ArrowsLeftRight, CaretDown, CaretUp, Drop, Pause, Play, Star, Warning, Wind, X } from '@phosphor-icons/react';
import RouteChart from './RouteChart';
import { RIDE_SPEEDS, windPeaks } from '../utils/routeAnalysis';
import { formatRain, isWet } from '../utils/rain';
import { formatDuration } from '../utils/time';

const PLAYBACK_RATES = [1, 2.5, 5];
const DETAILS_ID = 'route-details';

function describePoint(point, wind) {
  const place = `km ${point.distance.toFixed(1)}, ${Math.round(point.ele)} m`;
  if (!wind) return place;
  const along = Math.round(Math.abs(wind.head));
  const across = Math.round(Math.abs(wind.cross));
  const alongText = along === 0 ? 'no head or tailwind' : `${along} km/h ${wind.head > 0 ? 'headwind' : 'tailwind'}`;
  const acrossText = across === 0 ? 'nothing across' : `${across} km/h across from the ${wind.cross > 0 ? 'right' : 'left'}`;
  const rainText = isWet(wind.rain) ? `, rain ${formatRain(wind.rain)} mm/h` : '';
  return `${place}: ${alongText}, ${acrossText}${rainText}`;
}

const NO_WIND_TEXT = {
  loading: 'Loading the wind along this route…',
  failed: 'The wind along this route could not be loaded.',
  ready: 'There is no wind forecast for this route at this time.',
};

/**
 * Everything about the loaded route: how much of it is with, across and against the wind,
 * a plain-language verdict, and the profile you can ride along.
 * - analysis: from analyseRoute
 * - windState: how far the forecast along the route is, 'ready' | 'loading' | 'failed'
 * - bestTimes: the best hour to leave on each of the coming days, [{ time, day, clock }] with `day` as
 *   'today', 'tomorrow' or a date and `clock` as "09:00" or 'now'; leavingAt is the hour chosen now
 * - flipHint: what riding the route the other way round would be like at this hour, 'easier' | 'harder' | null
 * - collapsed: only the name, the buttons and the wind along the route as a low strip are shown, to
 *   leave the map free
 * - colors: { tail, neutral, head } for the current theme
 */
export default function RoutePanel({
  route,
  analysis,
  windState,
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
  bestTimes,
  leavingAt,
  onLeaveAt,
  onFlip,
  flipHint,
  collapsed,
  onToggleCollapsed,
  colors,
}) {
  const total = route.totalDistance || 1;
  const index = Math.min(riderIdx, route.points.length - 1);
  // a route with no forecast for most of its length gets no wind verdict: there is no data to base one on
  const wind = analysis.outsideKm < total * 0.5 ? analysis.wind : null;
  const pointText = describePoint(route.points[index], wind?.[index]);
  const parts = [
    ['Tailwind', analysis.share.tail, colors.tail],
    ['Across or light', analysis.share.cross, colors.neutral],
    ['Headwind', analysis.share.head, colors.head],
  ];
  const shareBar = (
    <div className="share-bar" aria-hidden="true">
      {parts.map(([name, km, color]) => (
        <i key={name} style={{ flexGrow: Math.max(0.001, km), background: color }} />
      ))}
    </div>
  );

  return (
    <section className={collapsed ? 'route-panel panel collapsed' : 'route-panel panel'}>
      <div className="route-head">
        <h2 title={route.name}>{route.name}</h2>
        <span className="route-meta">
          {route.totalDistance.toFixed(1)} km, {route.totalElevationGain} m of climbing{route.reversed && ', reversed'}
        </span>
        <button
          type="button"
          className="route-flip"
          onClick={onFlip}
          title="Ride this route the other way round"
          aria-label={flipHint ? `Reverse the route: ${flipHint} that way at this hour` : 'Reverse the route'}
        >
          <ArrowsLeftRight size={15} aria-hidden="true" />
          <span>Reverse</span>
          {flipHint && <small>{flipHint} that way</small>}
        </button>
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
          <button
            type="button"
            className="icon-button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls={DETAILS_ID}
            aria-label={collapsed ? 'Show the route details' : 'Hide the route details'}
            title={collapsed ? 'Show the route details' : 'Hide the route details'}
          >
            {collapsed ? <CaretUp size={16} aria-hidden="true" /> : <CaretDown size={16} aria-hidden="true" />}
          </button>
          <button type="button" className="icon-button" onClick={onClear} aria-label="Clear route">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* folded away, the wind along the route stays as a low strip under the name, with the strongest
          wind each way beside it; the strip can still be dragged along */}
      {collapsed ? (
        <div className="route-brief">
          <RouteChart
            compact
            route={route}
            wind={wind}
            riderIdx={index}
            onScrub={onScrub}
            headColor={colors.head}
            tailColor={colors.tail}
            valueText={pointText}
          />
          {wind && <Peaks wind={wind} colors={colors} rain={analysis.rain} />}
        </div>
      ) : (
        <div className="route-body" id={DETAILS_ID}>
          <div className="route-summary">
            {!wind && <p className="route-plan">{NO_WIND_TEXT[windState]}</p>}

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
                  {analysis.outsideKm > total * 0.05 && (windState === 'loading' ? ' Part of the wind is still loading.' : ' Part of it has no forecast.')}
                </p>

                {bestTimes.length > 0 && (
                  <p className="route-best">
                    <Star size={13} weight="fill" aria-hidden="true" />
                    <span>
                      Best time to leave:{' '}
                      {bestTimes.map((best, i) => {
                        const when = best.clock === 'now' ? 'now' : `${best.day} ${best.clock}`;
                        return (
                          <Fragment key={best.time}>
                            {i > 0 && ', '}
                            {/* the one the plan is for is not a button: there is nothing left to choose */}
                            {best.time === leavingAt
                              ? <b>{when}</b>
                              : <button type="button" className="text-button" onClick={() => onLeaveAt(best.time)}>{when}</button>}
                          </Fragment>
                        );
                      })}
                      .
                    </span>
                  </p>
                )}

                {shareBar}
                <Shares analysis={analysis} parts={parts} total={total} />
              </>
            )}
          </div>

          <div className="route-profile">
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
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The strongest headwind and tailwind of the route, as the key of the folded strip; and the heaviest
 * rain, on a ride that meets any (the line along the top of the strip says where).
 */
function Peaks({ wind, colors, rain }) {
  const peaks = windPeaks(wind);
  const rows = [
    ['Headwind', peaks.head, colors.head],
    ['Tailwind', peaks.tail, colors.tail],
  ];
  return (
    <div className="route-peaks">
      {rows.map(([name, kmh, color]) => (
        <span key={name}>
          <i className="swatch" style={{ background: color }} />
          <span className="visually-hidden">{name} </span>
          {Math.round(kmh) > 0 ? `up to ${Math.round(kmh)} km/h` : 'none'}
        </span>
      ))}
      {isWet(rain.max) && (
        <span className="route-peaks-rain">
          <Drop size={10} weight="fill" aria-hidden="true" />
          <span className="visually-hidden">Rain </span>
          up to {formatRain(rain.max)} mm/h
        </span>
      )}
    </div>
  );
}

function Shares({ analysis, parts, total }) {
  const { net, advisory } = analysis;
  const AdviceIcon = advisory.tone === 'gusty' || advisory.tone === 'hard' ? Warning : Wind;

  return (
    <>
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
        <span>
          <b>{advisory.title}.</b>
          {analysis.orderNote && <> <span className="advice-order">{analysis.orderNote}</span></>}
          {' '}
          <span className="advice-text">{advisory.text}</span>
        </span>
      </p>

      {/* only on a ride with rain, or a real chance of it */}
      {analysis.rainNote && (
        <p className="route-advice route-rain">
          <Drop size={16} weight="fill" aria-hidden="true" />
          <span>{analysis.rainNote}</span>
        </p>
      )}
    </>
  );
}

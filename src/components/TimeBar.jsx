import { useEffect, useMemo, useRef, useState } from 'react';
import { CaretDown, CaretUp, Pause, Play, Star } from '@phosphor-icons/react';
import { clockHour, formatDay, formatDayClock, zoneLabel } from '../utils/time';
import { LIKELY_PERCENT, formatRain, isWet, rainLevel } from '../utils/rain';
import { CALM_KMH, compassPoint } from '../utils/wind';

const HOUR = 3600;
// Hours moved by PageUp / PageDown
const PAGE_HOURS = 6;
const BARS_ID = 'timebar-hours';
// Arrows for the wind direction are drawn every so many hours, the fewest that keeps them this far apart
const ARROW_GAP_PX = 14;
const ARROW_EVERY = [1, 2, 3, 4, 6, 12];
// The columns of a ride are drawn against a round number of km/h, and at least this many
const RIDE_STEP_KMH = 5;

function relativeLabel(hoursFromNow) {
  if (hoursFromNow === 0) return 'now';
  return hoursFromNow > 0 ? `in ${hoursFromNow} h` : `${-hoursFromNow} h ago`;
}

// what a ride leaving at some hour meets, in words: [short, for the label; long, for screen readers]
function describeRide(ride) {
  if (!ride?.known) return null;
  const against = Math.round(ride.against);
  const behind = Math.round(ride.behind);
  const rain = ride.wet ? `, rain up to ${formatRain(ride.rain)} mm/h` : '';
  if (against === 0 && behind === 0) return [`hardly any wind along the road${rain}`, `hardly any wind along the road${rain}`];
  return [
    `${against} km/h against, ${behind} behind${rain}`,
    `on average ${against} km/h against you and ${behind} behind you along the route${rain}`,
  ];
}

/**
 * Two days of forecast, one bar per hour. Tap or drag to choose the hour shown on the map.
 * For a place, a bar is the wind speed there, with gusts as the paler cap. An hour with rain stands on
 * a teal foot, taller the harder it rains and paler when the rain is only possible.
 * For a route (`rides`), a bar is the whole ride setting off at that hour: red upwards for the wind
 * against the rider and blue downwards for the wind behind, averaged over the ride, like the wind
 * under the profile of the route. A ride that meets rain carries a teal line along its top.
 * Above the bars, arrows show which way the wind blows as the hours go by, and a star marks the best
 * hour to leave on each day.
 * - hours: [{ time, speed, gust, from, rain, rainChance }], one per hour; speed, gust and from are null
 *   while that hour is not loaded, and rain (mm in that hour) and its chance (percent) are not numbers
 *   where the forecast does not give them
 * - rides: null, or one entry per hour as App makes them from scanDepartures: { known, late, against,
 *   behind, wet, rain, rainChance }
 * - bestTimes: [{ time }] of the best hours to leave (see bestDepartures); only drawn with `rides`
 * - selected / nowTime: unix seconds of the chosen bar and of the bar for the hour in progress
 * - shownTime: unix seconds of the moment on the map (the current minute while following the clock)
 * - nowReading: { speed, gust, from, rain, rainChance } at that place for the current minute, used while following the clock
 * - place: where the bars are measured, e.g. "Lisboa"
 * - zone: time zone of that place; times are shown in its local time
 * - rideStart: the chosen hour is when a ride sets off
 * - collapsed: the bars are folded away and one line says which moment the map shows, to leave the map free
 */
export default function TimeBar({
  hours,
  rides,
  bestTimes,
  selected,
  nowTime,
  shownTime,
  nowReading,
  onSelect,
  playing,
  onTogglePlay,
  place,
  zone,
  rideStart,
  collapsed,
  onToggleCollapsed,
}) {
  const barsRef = useRef(null);
  const dragging = useRef(false);
  const [barsWidth, setBarsWidth] = useState(0);
  // a bar opens a new day when its date differs from the bar before it (clocks do not change at midnight everywhere)
  const days = useMemo(() => hours.map((h) => formatDay(h.time, zone)), [hours, zone]);
  const clockHours = useMemo(() => hours.map((h) => clockHour(h.time, zone)), [hours, zone]);

  useEffect(() => {
    const el = barsRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => setBarsWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [collapsed]);

  const first = hours[0].time;
  const last = hours[hours.length - 1].time;
  const at = Math.max(0, hours.findIndex((h) => h.time === selected));
  const current = hours[at];
  const scaleMax = Math.max(20, ...hours.map((h) => h.gust ?? 0));
  const isNow = selected === nowTime;

  // the strongest average of the two days, rounded up, is the full height of a column, upwards and downwards
  const rideScale = rides
    ? Math.max(RIDE_STEP_KMH, Math.ceil(Math.max(0, ...rides.map((r) => (r.known ? Math.max(r.against, r.behind) : 0))) / RIDE_STEP_KMH) * RIDE_STEP_KMH)
    : 0;
  const best = rides ? new Set(bestTimes.map((b) => b.time)) : null;

  // arrows on the hours of the clock that are a multiple of `every`, so they stay put as time passes
  const slot = barsWidth / hours.length;
  const every = slot > 0 ? ARROW_EVERY.find((n) => n * slot >= ARROW_GAP_PX) ?? 24 : 0;
  // an arrow gives way to a star that would touch it
  const crowded = (i) => best !== null && hours.some((h, j) => best.has(h.time) && j !== i && Math.abs(j - i) * slot < ARROW_GAP_PX);

  const pick = (clientX) => {
    const rect = barsRef.current.getBoundingClientRect();
    const index = Math.floor(((clientX - rect.left) / rect.width) * hours.length);
    onSelect(hours[Math.max(0, Math.min(hours.length - 1, index))].time);
  };

  const onKeyDown = (e) => {
    const move = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: PAGE_HOURS, PageDown: -PAGE_HOURS }[e.key];
    if (move) onSelect(Math.max(first, Math.min(last, selected + move * HOUR)));
    else if (e.key === 'Home') onSelect(nowTime);
    else if (e.key === 'End') onSelect(last);
    else return;
    e.preventDefault();
  };

  // a clock that is not the reader's own says which one it is
  const offset = zoneLabel(shownTime, zone);
  const label = `${formatDayClock(shownTime, zone)}${offset && ` ${offset}`}`;
  const hoursFromNow = Math.round((selected - nowTime) / HOUR);
  const when = relativeLabel(hoursFromNow);
  const quoted = isNow && nowReading ? nowReading : current;
  const chance = Number.isFinite(quoted.rainChance) ? ` (${Math.round(quoted.rainChance)}%)` : '';
  const rain = isWet(quoted.rain) ? `, rain ${formatRain(quoted.rain)} mm${chance}` : '';
  const from = Number.isFinite(quoted.from) && quoted.speed >= CALM_KMH ? ` ${compassPoint(quoted.from)}` : '';
  const wind = quoted.speed === null ? null : `${Math.round(quoted.speed)} km/h${from}, gusts ${Math.round(quoted.gust)}${rain}`;
  // with a route, the label is about the ride that leaves then, like the bars
  const ride = rides ? describeRide(rides[at]) : null;
  const isBest = best !== null && best.has(selected);
  const said = rides ? ride?.[0] ?? null : wind;
  const spoken = rides ? ride && `${ride[1]}${isBest ? ', the best time to leave that day' : ''}` : wind;

  return (
    <section className={collapsed ? 'timebar panel collapsed' : 'timebar panel'}>
      <button
        type="button"
        className="round-button"
        onClick={onTogglePlay}
        aria-label={playing ? 'Pause the forecast' : 'Play the forecast'}
      >
        {playing ? <Pause size={15} weight="fill" /> : <Play size={15} weight="fill" />}
      </button>

      <div className="timebar-label">
        <strong>{label}</strong>
        <span>
          {when}
          {rideStart && <span className="timebar-place">, start of the ride</span>}
          {said && `: ${said}`}
          {place && !rides && <span className="timebar-place"> at {place}</span>}
        </span>
        <div className="timebar-actions">
          {!isNow && (
            <button type="button" className="text-button" onClick={() => onSelect(nowTime)}>Back to now</button>
          )}
          <button
            type="button"
            className="icon-button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls={BARS_ID}
            aria-label={collapsed ? 'Show the hours' : 'Hide the hours'}
            title={collapsed ? 'Show the hours' : 'Hide the hours'}
          >
            {collapsed ? <CaretUp size={16} aria-hidden="true" /> : <CaretDown size={16} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div
          id={BARS_ID}
          ref={barsRef}
          className={rides ? 'timebar-bars rides' : 'timebar-bars'}
          role="slider"
          tabIndex={0}
          aria-label={rides ? 'Hour the ride starts' : 'Forecast hour'}
          aria-valuemin={Math.round((first - nowTime) / HOUR)}
          aria-valuemax={Math.round((last - nowTime) / HOUR)}
          aria-valuenow={hoursFromNow}
          aria-valuetext={`${label}, ${when}${spoken ? `: ${spoken}` : ''}${place && !rides ? ` at ${place}` : ''}`}
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            pick(e.clientX);
          }}
          onPointerMove={(e) => dragging.current && pick(e.clientX)}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onKeyDown={onKeyDown}
        >
          {hours.map((h, i) => {
            const startsDay = i > 0 && days[i] !== days[i - 1];
            const ridden = rides ? rides[i] : null;
            const empty = rides ? !ridden.known : h.speed === null;
            const classes = ['bar', h.time === selected && 'selected', h.time < nowTime && 'past', startsDay && 'day', empty && 'empty', ridden?.late && 'late']
              .filter(Boolean)
              .join(' ');
            const starred = best !== null && best.has(h.time);
            const arrow = !starred && every > 0 && clockHours[i] % every === 0 && h.speed !== null && !crowded(i);
            return (
              <div key={h.time} className={classes} data-day={startsDay ? days[i] : undefined}>
                {starred && <Star className="bar-best" size={11} weight="fill" aria-hidden="true" />}
                {arrow && (h.speed >= CALM_KMH ? (
                  // drawn pointing down and turned by where the wind comes from: it points the way the wind blows
                  <svg className="bar-wind" viewBox="0 0 12 12" aria-hidden="true" style={{ transform: `rotate(${Math.round(h.from)}deg)` }}>
                    <path d="M6 1v9.5M6 10.5L2.5 6.5M6 10.5l3.5-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : <b className="bar-calm" />)}
                {ridden && ridden.known && (
                  <>
                    <i className="against" style={{ height: `${(ridden.against / rideScale) * 50}%` }} />
                    <i className="behind" style={{ height: `${(ridden.behind / rideScale) * 50}%` }} />
                    {ridden.wet && <i className={`rain ${rainLevel(ridden.rain)}${ridden.rainChance > 0 && ridden.rainChance < LIKELY_PERCENT ? ' unlikely' : ''}`} />}
                  </>
                )}
                {!ridden && h.speed !== null && (
                  <>
                    <i className="gust" style={{ height: `${(h.gust / scaleMax) * 100}%` }} />
                    <i className="speed" style={{ height: `${Math.max(3, (h.speed / scaleMax) * 100)}%` }} />
                    {isWet(h.rain) && <i className={`rain ${rainLevel(h.rain)}${h.rainChance < LIKELY_PERCENT ? ' unlikely' : ''}`} />}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

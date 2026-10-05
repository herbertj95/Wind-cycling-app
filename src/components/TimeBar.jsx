import { useMemo, useRef } from 'react';
import { CaretDown, CaretUp, Pause, Play } from '@phosphor-icons/react';
import { formatDay, formatDayClock, zoneLabel } from '../utils/time';
import { LIKELY_PERCENT, formatRain, isWet, rainLevel } from '../utils/rain';

const HOUR = 3600;
// Hours moved by PageUp / PageDown
const PAGE_HOURS = 6;
const BARS_ID = 'timebar-hours';

function relativeLabel(hoursFromNow) {
  if (hoursFromNow === 0) return 'now';
  return hoursFromNow > 0 ? `in ${hoursFromNow} h` : `${-hoursFromNow} h ago`;
}

/**
 * Two days of forecast for one place, one bar per hour: wind speed, with gusts as the paler cap. An hour
 * with rain stands on a teal foot, taller the harder it rains and paler when the rain is only possible.
 * Tap or drag to choose the hour shown on the map.
 * - hours: [{ time, speed, gust, rain, rainChance }], one per hour; speed and gust are null while that
 *   hour is not loaded, and rain (mm in that hour) and its chance (percent) are not numbers where the
 *   forecast does not give them
 * - selected / nowTime: unix seconds of the chosen bar and of the bar for the hour in progress
 * - shownTime: unix seconds of the moment on the map (the current minute while following the clock)
 * - nowReading: { speed, gust, rain, rainChance } at that place for the current minute, used while following the clock
 * - place: where the bars are measured, e.g. "Lisboa"
 * - zone: time zone of that place; times are shown in its local time
 * - rideStart: the chosen hour is when a ride sets off
 * - collapsed: the bars are folded away and one line says which moment the map shows, to leave the map free
 */
export default function TimeBar({
  hours,
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
  // a bar opens a new day when its date differs from the bar before it (clocks do not change at midnight everywhere)
  const days = useMemo(() => hours.map((h) => formatDay(h.time, zone)), [hours, zone]);

  const first = hours[0].time;
  const last = hours[hours.length - 1].time;
  const current = hours.find((h) => h.time === selected) ?? hours[0];
  const scaleMax = Math.max(20, ...hours.map((h) => h.gust ?? 0));
  const isNow = selected === nowTime;

  const pick = (clientX) => {
    const rect = barsRef.current.getBoundingClientRect();
    const slot = Math.floor(((clientX - rect.left) / rect.width) * hours.length);
    onSelect(hours[Math.max(0, Math.min(hours.length - 1, slot))].time);
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
  const wind = quoted.speed === null ? null : `${Math.round(quoted.speed)} km/h, gusts ${Math.round(quoted.gust)}${rain}`;

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
          {wind && `: ${wind}`}
          {place && <span className="timebar-place"> at {place}</span>}
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
          className="timebar-bars"
          role="slider"
          tabIndex={0}
          aria-label="Forecast hour"
          aria-valuemin={Math.round((first - nowTime) / HOUR)}
          aria-valuemax={Math.round((last - nowTime) / HOUR)}
          aria-valuenow={hoursFromNow}
          aria-valuetext={`${label}, ${when}${wind ? `: ${wind}` : ''}${place ? ` at ${place}` : ''}`}
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
            const classes = ['bar', h.time === selected && 'selected', h.time < nowTime && 'past', startsDay && 'day', h.speed === null && 'empty']
              .filter(Boolean)
              .join(' ');
            return (
              <div key={h.time} className={classes} data-day={startsDay ? days[i] : undefined}>
                {h.speed !== null && (
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

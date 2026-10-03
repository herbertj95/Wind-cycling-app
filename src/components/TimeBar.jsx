import { useRef } from 'react';
import { Pause, Play } from '@phosphor-icons/react';
import { formatDay, formatDayClock, lisbonHour } from '../utils/time';

// Hours moved by PageUp / PageDown
const PAGE_HOURS = 6;

function relativeLabel(hoursFromNow) {
  if (hoursFromNow === 0) return 'now';
  return hoursFromNow > 0 ? `in ${hoursFromNow} h` : `${-hoursFromNow} h ago`;
}

/**
 * Two days of forecast for one place, one bar per hour: wind speed, with gusts as the paler cap.
 * Tap or drag to choose the hour shown on the map.
 * - hours: [{ index, time, speed, gust }]
 * - shownTime: unix seconds of the moment on the map (the current minute while following the clock)
 * - nowReading: { speed, gust } at that place for the current minute, used while following the clock
 * - place: where the bars are measured, e.g. "Lisboa"
 * - rideStart: the chosen hour is when a ride sets off
 */
export default function TimeBar({ hours, selected, nowIndex, shownTime, nowReading, onSelect, playing, onTogglePlay, place, rideStart }) {
  const barsRef = useRef(null);
  const dragging = useRef(false);

  if (hours.length === 0) return null;

  const first = hours[0].index;
  const last = hours[hours.length - 1].index;
  const current = hours.find((h) => h.index === selected) ?? hours[0];
  const scaleMax = Math.max(20, ...hours.map((h) => h.gust));

  const pick = (clientX) => {
    const rect = barsRef.current.getBoundingClientRect();
    const slot = Math.floor(((clientX - rect.left) / rect.width) * hours.length);
    onSelect(hours[Math.max(0, Math.min(hours.length - 1, slot))].index);
  };

  const onKeyDown = (e) => {
    const move = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: PAGE_HOURS, PageDown: -PAGE_HOURS }[e.key];
    if (move) onSelect(Math.max(first, Math.min(last, selected + move)));
    else if (e.key === 'Home') onSelect(nowIndex);
    else if (e.key === 'End') onSelect(last);
    else return;
    e.preventDefault();
  };

  const label = formatDayClock(shownTime ?? current.time);
  const when = relativeLabel(selected - nowIndex);
  const quoted = selected === nowIndex && nowReading ? nowReading : current;
  const wind = `${Math.round(quoted.speed)} km/h, gusts ${Math.round(quoted.gust)}`;

  return (
    <section className="timebar panel">
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
          {rideStart && <span className="timebar-place">, start of the ride</span>}: {wind}
          <span className="timebar-place"> at {place}</span>
        </span>
        {selected !== nowIndex && (
          <button type="button" className="text-button" onClick={() => onSelect(nowIndex)}>Back to now</button>
        )}
      </div>

      <div
        ref={barsRef}
        className="timebar-bars"
        role="slider"
        tabIndex={0}
        aria-label="Forecast hour"
        aria-valuemin={first}
        aria-valuemax={last}
        aria-valuenow={selected}
        aria-valuetext={`${label}, ${when}: ${wind} at ${place}`}
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
          const startsDay = i > 0 && lisbonHour(h.time) === 0;
          const classes = ['bar', h.index === selected && 'selected', h.index < nowIndex && 'past', startsDay && 'day'].filter(Boolean).join(' ');
          return (
            <div key={h.index} className={classes} data-day={startsDay ? formatDay(h.time) : undefined}>
              <i className="gust" style={{ height: `${(h.gust / scaleMax) * 100}%` }} />
              <i className="speed" style={{ height: `${Math.max(3, (h.speed / scaleMax) * 100)}%` }} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

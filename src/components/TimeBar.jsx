import { useEffect, useMemo, useRef, useState } from 'react';
import { CaretDown, CaretUp, Pause, Play } from '@phosphor-icons/react';
import { clockHour, formatClock, formatDay, markedHours, zoneLabel } from '../utils/time';
import { LIKELY_PERCENT, formatRain, isWet, rainLevel } from '../utils/rain';
import { CALM_KMH, compassPoint } from '../utils/wind';

const HOUR = 3600;
// Hours moved by PageUp / PageDown
const PAGE_HOURS = 6;
const BARS_ID = 'timebar-hours';
// Arrows for the wind direction are drawn every so many hours, the fewest that keeps them this far apart
const ARROW_GAP_PX = 14;
const ARROW_EVERY = [1, 2, 3, 4, 6, 12];
// The hour of the clock is written under every third bar, or every sixth where those would be closer than this
const HOUR_GAP_PX = 16;
const HOUR_EVERY = [3, 6, 12];
// Room the date takes under the first bars of a day, from the left edge of the first one; and what
// half a digit of an hour takes
const DATE_ROOM_PX = 46;
const HALF_DIGIT_PX = 3.1;

function relativeLabel(hoursFromNow) {
  if (hoursFromNow === 0) return 'now';
  return hoursFromNow > 0 ? `in ${hoursFromNow} h` : `${-hoursFromNow} h ago`;
}

/**
 * Two days of forecast, one bar per hour. Tap or drag to choose the hour shown on the map.
 * A bar is the wind speed at one place, with gusts as the paler cap. An hour with rain stands on a teal
 * foot, taller the harder it rains and paler when the rain is only possible. Above the bars, arrows show
 * which way the wind blows as the hours go by; under them stand the hours of the clock (9, 12, 15...) and,
 * where a day starts, its date. With a route, the place is its start, and a short line under the bars
 * marks the best time to leave on each day.
 * - hours: [{ time, speed, gust, from, rain, rainChance }], one per hour; speed, gust and from are null
 *   while that hour is not loaded, and rain (mm in that hour) and its chance (percent) are not numbers
 *   where the forecast does not give them
 * - bestTimes: [{ from, to }] of the best times to leave, unix seconds of the first and the last hour
 * - selected / nowTime: unix seconds of the chosen bar and of the bar for the hour in progress
 * - shownTime: unix seconds of the moment on the map (the current minute while following the clock)
 * - nowReading: { speed, gust, from, rain, rainChance } at that place for the current minute, used while following the clock
 * - place: where the bars are measured, e.g. "Lisboa"
 * - zone: time zone of that place; times are shown in its local time
 * - rideStart: the bars are the start of a route, and the chosen hour is when the ride sets off
 * - collapsed: the bars are folded away and one line says which moment the map shows, to leave the map free
 */
export default function TimeBar({
  hours,
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
  // where the best times to leave are on the bar, as indexes of the hours
  const bestSpans = bestTimes
    .map((b) => [hours.findIndex((h) => h.time === b.from), hours.findIndex((h) => h.time === b.to)])
    .filter(([from, to]) => from >= 0 && to >= 0);

  // arrows on the hours of the clock that are a multiple of `every`, so they stay put as time passes
  const slot = barsWidth / hours.length;
  const every = slot > 0 ? ARROW_EVERY.find((n) => n * slot >= ARROW_GAP_PX) ?? 24 : 0;
  const arrows = markedHours(clockHours, every);
  // The hours written under the bars. Midnight has the date instead, and so have the hours after it
  // that the date reaches under.
  const hourEvery = slot > 0 ? HOUR_EVERY.find((n) => n * slot >= HOUR_GAP_PX) ?? 24 : 0;
  const hourMarks = markedHours(clockHours, hourEvery);
  const opensDay = hours.map((h, i) => i > 0 && days[i] !== days[i - 1]);
  const numbered = hours.map((h, i) => {
    // how many bars back the date is; the first day on the bar has none
    const dated = opensDay.lastIndexOf(true, i);
    const sinceDate = dated < 0 ? Infinity : i - dated;
    const left = (sinceDate + 0.5) * slot - String(clockHours[i]).length * HALF_DIGIT_PX;
    return hourMarks[i] && sinceDate > 0 && left >= DATE_ROOM_PX;
  });

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
  const clock = `${formatClock(shownTime, zone)}${offset && ` ${offset}`}`;
  const label = `${formatDay(shownTime, zone)}, ${clock}`;
  const hoursFromNow = Math.round((selected - nowTime) / HOUR);
  const when = relativeLabel(hoursFromNow);
  const quoted = isNow && nowReading ? nowReading : current;
  const hasWind = quoted.speed !== null;
  const blowing = hasWind && Number.isFinite(quoted.from) && quoted.speed >= CALM_KMH;
  const point = blowing ? compassPoint(quoted.from) : null;
  const chance = Number.isFinite(quoted.rainChance) ? ` (${Math.round(quoted.rainChance)}%)` : '';
  const wet = isWet(quoted.rain);
  // The wind of that hour three ways: in full, short with the numbers first for a phone, and in words
  // for screen readers
  const wind = hasWind ? `${Math.round(quoted.speed)} km/h${point ? ` ${point}` : ''}, gusts ${Math.round(quoted.gust)}${wet ? `, rain ${formatRain(quoted.rain)} mm${chance}` : ''}` : null;
  const brief = hasWind ? `${Math.round(quoted.speed)}${point ? ` ${point}` : ' calm'}, gusts ${Math.round(quoted.gust)}${wet ? `, rain ${formatRain(quoted.rain)}` : ''}` : null;
  const spoken = hasWind
    ? `${Math.round(quoted.speed)} km/h ${point ? `from the ${point}` : 'calm'}, gusts ${Math.round(quoted.gust)}${wet ? `, rain ${formatRain(quoted.rain)} mm${chance}` : ''}`
    : null;
  const inBest = bestTimes.some((b) => selected >= b.from && selected <= b.to);
  const where = rideStart ? 'at the start of the ride' : place ? `at ${place}` : '';

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
        {/* where there is little room the date gives way, and the clock stays */}
        <strong>
          <span className="timebar-date">{formatDay(shownTime, zone)},</span>{' '}
          <span className="timebar-clock">{clock}</span>
        </strong>
        <span aria-hidden="true">
          <span className="timebar-wide">
            {when}
            {rideStart && <span className="timebar-place">, start of the ride</span>}
            {wind && `: ${wind}`}
            {place && !rideStart && <span className="timebar-place"> at {place}</span>}
          </span>
          <span className="timebar-narrow">{brief ? `${brief}${isNow ? ', now' : ''}` : when}</span>
        </span>
        <span className="visually-hidden">{`${when}${spoken ? `: ${spoken}` : ''} ${where}`}</span>
        <div className="timebar-actions">
          {!isNow && (
            <button type="button" className="text-button" onClick={() => onSelect(nowTime)} aria-label="Back to now">
              <span className="timebar-wide">Back to now</span>
              <span className="timebar-narrow">Now</span>
            </button>
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
          aria-label={rideStart ? 'Hour the ride starts' : 'Forecast hour'}
          aria-valuemin={Math.round((first - nowTime) / HOUR)}
          aria-valuemax={Math.round((last - nowTime) / HOUR)}
          aria-valuenow={hoursFromNow}
          aria-valuetext={`${label}, ${when}${spoken ? `: ${spoken}` : ''}${where ? ` ${where}` : ''}${inBest ? ', a good time to leave' : ''}`}
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
          {/* the best times to leave, as a short line under their bars; drawn first, so the dot of the
              chosen hour stays on top of it */}
          {bestSpans.map(([from, to]) => (
            <span
              key={from}
              className="bars-best"
              style={{ left: `${(from / hours.length) * 100}%`, width: `${((to - from + 1) / hours.length) * 100}%` }}
            />
          ))}
          {hours.map((h, i) => {
            const startsDay = i > 0 && days[i] !== days[i - 1];
            const empty = h.speed === null;
            const classes = ['bar', h.time === selected && 'selected', h.time < nowTime && 'past', startsDay && 'day', empty && 'empty']
              .filter(Boolean)
              .join(' ');
            const arrow = arrows[i] && !empty;
            return (
              <div key={h.time} className={classes} data-day={startsDay ? days[i] : undefined}>
                {arrow && (h.speed >= CALM_KMH ? (
                  // drawn pointing down and turned by where the wind comes from: it points the way the wind blows
                  <svg className="bar-wind" viewBox="0 0 12 12" aria-hidden="true" style={{ transform: `rotate(${Math.round(h.from)}deg)` }}>
                    <path d="M6 1v9.5M6 10.5L2.5 6.5M6 10.5l3.5-4" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : <b className="bar-calm" />)}
                {numbered[i] && <span className="bar-hour">{clockHours[i]}</span>}
                {!empty && (
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

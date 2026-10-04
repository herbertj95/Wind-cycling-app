import { useEffect, useMemo, useRef, useState } from 'react';
import { bandScale, windPeaks } from '../utils/routeAnalysis';

// Kilometres moved by PageUp / PageDown
const PAGE_KM = 5;
// Height in px kept free for a line of text, above the wind band and under it
const LABEL_ROOM = 14;
// The profile is never lower than this many px: its line would run through the label of its highest point
const MIN_PROFILE = 20;

/**
 * Two charts sharing the distance axis: the elevation profile and, below it, the wind along the route.
 * Above the line the wind is against the rider, below it the wind is helping. A hairline marks the
 * strongest wind each way, with its value written beside it ("headwind up to 12 km/h").
 * Drag along it (or use the arrow keys) to ride the route.
 * - wind: per-point analysis from analyseRoute, parallel to route.points; leave it out to draw the profile alone
 * - valueText: what the current position is, in words, for screen readers
 */
export default function RouteChart({ route, wind, riderIdx, onScrub, headColor, tailColor, valueText }) {
  const svgRef = useRef(null);
  const dragging = useRef(false);
  const [size, setSize] = useState({ width: 600, height: 118 });

  useEffect(() => {
    const el = svgRef.current;
    const observer = new ResizeObserver(() => {
      setSize({ width: el.clientWidth || 600, height: el.clientHeight || 118 });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { width, height } = size;
  const points = route.points;
  const total = route.totalDistance || 1;

  const shape = useMemo(() => {
    // Without wind the profile takes the whole height. With it, the two halve what is left once the
    // labels of the strongest winds have their room, above the band and under it.
    const elevationHeight = wind ? Math.max(MIN_PROFILE, (height - 2 * LABEL_ROOM) / 2) : height - 16;
    const windTop = elevationHeight + LABEL_ROOM;
    const windHeight = Math.max(0, height - windTop - LABEL_ROOM);
    const baseline = windTop + windHeight / 2;

    let eleMin = Infinity;
    let eleMax = -Infinity;
    points.forEach((p) => {
      eleMin = Math.min(eleMin, p.ele);
      eleMax = Math.max(eleMax, p.ele);
    });
    const eleRange = Math.max(20, eleMax - eleMin);

    const x = (p) => (p.distance / total) * width;
    const yEle = (p) => 4 + (elevationHeight - 6) * (1 - (p.ele - eleMin) / eleRange);
    const profile = points.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)} ${yEle(p).toFixed(1)}`).join('');

    let head = null;
    let tail = null;
    let peaks = null;
    if (wind) {
      const windScale = (windHeight / 2) / bandScale(wind);
      // one closed band per sign: +1 keeps the headwind part above the baseline, -1 the tailwind part below
      const band = (sign) =>
        `M0 ${baseline}${points.map((p, i) => `L${x(p).toFixed(1)} ${(baseline - Math.max(0, sign * wind[i].head) * windScale * sign).toFixed(1)}`).join('')}L${width} ${baseline}Z`;
      head = band(1);
      tail = band(-1);
      // the strongest wind each way in km/h, and the height in the band where it is reached
      const strongest = windPeaks(wind);
      peaks = {
        head: Math.round(strongest.head),
        tail: Math.round(strongest.tail),
        headY: baseline - strongest.head * windScale,
        tailY: baseline + strongest.tail * windScale,
      };
    }

    return { elevationHeight, windTop, windHeight, baseline, eleMax, profile, head, tail, peaks, x, yEle };
  }, [points, wind, total, width, height]);

  const scrub = (clientX) => {
    const rect = svgRef.current.getBoundingClientRect();
    const distance = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * total;
    let i = 0;
    while (i < points.length - 1 && points[i].distance < distance) i++;
    onScrub(i);
  };

  const indexAtKm = (km) => {
    const i = points.findIndex((p) => p.distance >= km);
    return i < 0 ? points.length - 1 : i;
  };

  const cursor = points[Math.min(riderIdx, points.length - 1)];

  const onKeyDown = (e) => {
    const stride = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onScrub(Math.min(points.length - 1, riderIdx + stride));
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onScrub(Math.max(0, riderIdx - stride));
    else if (e.key === 'PageUp') onScrub(indexAtKm(cursor.distance + PAGE_KM));
    else if (e.key === 'PageDown') onScrub(indexAtKm(Math.max(0, cursor.distance - PAGE_KM)));
    else if (e.key === 'Home') onScrub(0);
    else if (e.key === 'End') onScrub(points.length - 1);
    else return;
    e.preventDefault();
  };

  const cursorX = shape.x(cursor);
  const cursorBottom = wind ? shape.windTop + shape.windHeight : shape.elevationHeight;

  return (
    <svg
      ref={svgRef}
      className="route-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="slider"
      tabIndex={0}
      aria-label="Position along the route"
      aria-valuemin={0}
      aria-valuemax={Math.round(total)}
      aria-valuenow={Math.round(cursor.distance)}
      aria-valuetext={valueText}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        scrub(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging.current) scrub(e.clientX);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onKeyDown={onKeyDown}
    >
      <path d={`${shape.profile}L${width} ${shape.elevationHeight}L0 ${shape.elevationHeight}Z`} fill="var(--track)" />
      <path d={shape.profile} fill="none" stroke="var(--ink-2)" strokeWidth="1.5" />
      <text x={width - 2} y="12" textAnchor="end">up to {Math.round(shape.eleMax)} m</text>

      {wind && (
        <>
          <path d={shape.head} fill={headColor} />
          <path d={shape.tail} fill={tailColor} />
          <line x1="0" x2={width} y1={shape.baseline} y2={shape.baseline} stroke="var(--ink-3)" strokeWidth="1" />
          {/* The strongest wind each way: a hairline at the height it reaches and its value on the far
              side of that line from the band, where nothing is drawn. */}
          {shape.peaks.head > 0 && (
            <line x1="0" x2={width} y1={shape.peaks.headY} y2={shape.peaks.headY} stroke="var(--hair)" strokeWidth="1" />
          )}
          {shape.peaks.tail > 0 && (
            <line x1="0" x2={width} y1={shape.peaks.tailY} y2={shape.peaks.tailY} stroke="var(--hair)" strokeWidth="1" />
          )}
          <text x="4" y={shape.peaks.headY - 4}>
            {shape.peaks.head > 0 ? `headwind up to ${shape.peaks.head} km/h` : 'no headwind'}
          </text>
          <text x="4" y={shape.peaks.tailY + 12}>
            {shape.peaks.tail > 0 ? `tailwind up to ${shape.peaks.tail} km/h` : 'no tailwind'}
          </text>
        </>
      )}

      {/* the bottom left corner is left to the tailwind label, which comes down to it in a strong tailwind */}
      <text x={width} y={height - 1} textAnchor="end">{Math.round(total)} km</text>

      <line x1={cursorX} x2={cursorX} y1="0" y2={cursorBottom} stroke="var(--ink)" strokeWidth="1.5" />
      <circle cx={cursorX} cy={shape.yEle(cursor)} r="4" fill="var(--ink)" stroke="var(--page)" strokeWidth="2" />
    </svg>
  );
}

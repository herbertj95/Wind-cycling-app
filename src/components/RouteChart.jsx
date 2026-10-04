import { useEffect, useMemo, useRef, useState } from 'react';
import { bandScale } from '../utils/routeAnalysis';

// Kilometres moved by PageUp / PageDown
const PAGE_KM = 5;
// Below this height in px the two labels of the wind scale would print over each other
const MIN_LABELLED_BAND = 24;

/**
 * Two charts sharing the distance axis: the elevation profile and, below it, the wind along the route.
 * Above the line the wind is against the rider, below it the wind is helping. The two ends of that
 * scale carry their value on the axis side ("15 km/h") and their meaning at the far end ("headwind").
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
    // Without wind the profile takes the whole height. With it, the wind band gets the larger share:
    // its height is what gets read off against the scale.
    const elevationHeight = wind ? height * 0.4 : height - 16;
    const windTop = elevationHeight + 10;
    const windHeight = height - windTop - 14;
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
    // the km/h at the top and at the bottom of the wind band
    const windMax = wind ? bandScale(wind) : 0;
    if (wind) {
      const windScale = (windHeight / 2) / windMax;
      // one closed band per sign: +1 keeps the headwind part above the baseline, -1 the tailwind part below
      const band = (sign) =>
        `M0 ${baseline}${points.map((p, i) => `L${x(p).toFixed(1)} ${(baseline - Math.max(0, sign * wind[i].head) * windScale * sign).toFixed(1)}`).join('')}L${width} ${baseline}Z`;
      head = band(1);
      tail = band(-1);
    }

    return { elevationHeight, windTop, windHeight, windMax, baseline, eleMax, profile, head, tail, x, yEle };
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
          {/* The two ends of the scale: a hairline each, with how much wind the full height is at the
              axis end and which way it blows at the other. */}
          {shape.windHeight >= MIN_LABELLED_BAND && (
            <>
              <line x1="0" x2={width} y1={shape.windTop} y2={shape.windTop} stroke="var(--hair)" strokeWidth="1" />
              <line x1="0" x2={width} y1={shape.windTop + shape.windHeight} y2={shape.windTop + shape.windHeight} stroke="var(--hair)" strokeWidth="1" />
              <text x="4" y={shape.windTop + 11}>{shape.windMax} km/h</text>
              <text x="4" y={shape.windTop + shape.windHeight - 3}>{shape.windMax} km/h</text>
              <text x={width - 2} y={shape.windTop + 11} textAnchor="end">headwind</text>
              <text x={width - 2} y={shape.windTop + shape.windHeight - 3} textAnchor="end">tailwind</text>
            </>
          )}
        </>
      )}

      <text x="0" y={height - 1}>0 km</text>
      <text x={width} y={height - 1} textAnchor="end">{Math.round(total)} km</text>

      <line x1={cursorX} x2={cursorX} y1="0" y2={cursorBottom} stroke="var(--ink)" strokeWidth="1.5" />
      <circle cx={cursorX} cy={shape.yEle(cursor)} r="4" fill="var(--ink)" stroke="var(--page)" strokeWidth="2" />
    </svg>
  );
}

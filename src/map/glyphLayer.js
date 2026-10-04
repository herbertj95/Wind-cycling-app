// Wind as a reading: arrows that point the way the wind blows, longer when it is stronger,
// each with its speed in km/h. This is what stays on screen when the animation is off.
import { CALM_KMH } from '../utils/wind';

const FONT = '600 12px Barlow, system-ui, sans-serif';
const HEAD = 6.5; // arrowhead size in px
// Arrow length runs from MIN_LENGTH to MAX_LENGTH px between 0 and FULL_LENGTH_KMH, so a 45 km/h nortada
// still reads longer than a 30 km/h breeze
const MIN_LENGTH = 10;
const MAX_LENGTH = 44;
const FULL_LENGTH_KMH = 50;
// An arrow whose number would be cut by the edge ("15" reading as "5") is left out. The number sits upwind
// of the arrow, so it is checked on its own as well as the arrow's centre.
const EDGE_MARGIN = 26;
const LABEL_MARGIN = 10;
// and an arrow this close to a floating panel would run under it
const PANEL_MARGIN = 24;

// The lattice is laid out in Web Mercator, where 1 is the width of the world, so its cells are square on
// screen at any latitude. At zoom 9 there is an arrow every 0.125° of longitude, about 91 px.
const CELL_AT_ZOOM_9 = 0.125 / 360;
const MAX_LAT = 85;

const mercatorY = (lat) => 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
const latitudeAt = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/**
 * Draws the arrow lattice. The lattice is anchored to the ground (not the screen) so arrows stay put while panning,
 * and it gets denser by whole zoom levels so spacing stays between roughly 90 and 180 px.
 * - bounds: { south, north, west, east } of the visible map, so only the arrows in view are worked out;
 *   west and east may run past ±180 when the view crosses the date line
 * - sample(lat, lng): the wind there, or null where none is loaded (no arrow is drawn)
 * - avoid: screen points [x, y] (place labels) that arrows should not be drawn over
 * - covered: screen rectangles { left, top, right, bottom } (the floating panels) under which no arrow is
 *   drawn, so none is left half hidden by a panel's edge
 */
export function drawGlyphs(ctx, { width, height, zoom, bounds, project, sample, ink, halo, avoid = [], covered = [] }) {
  ctx.clearRect(0, 0, width, height);

  const level = Math.floor(zoom + 0.15);
  const cell = CELL_AT_ZOOM_9 / 2 ** (level - 9);
  const color = `rgb(${ink.join(',')})`;

  const top = mercatorY(Math.min(MAX_LAT, bounds.north));
  const bottom = mercatorY(Math.max(-MAX_LAT, bounds.south));
  const left = (bounds.west + 180) / 360;
  const right = (bounds.east + 180) / 360;
  if (top >= bottom || left >= right) return;

  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (let row = Math.floor(top / cell - 0.5); ; row++) {
    const y = (row + 0.5) * cell;
    if (y >= bottom) break;
    const lat = latitudeAt(y);
    // every other row is shifted half a step, which reads as a field rather than a table
    const shift = row % 2 ? 0.75 : 0.25;
    for (let col = Math.floor(left / cell - shift); ; col++) {
      const lng = (col + shift) * cell * 360 - 180;
      if (lng >= bounds.east) break;

      const p = project(lat, lng);
      if (p.x < EDGE_MARGIN || p.y < EDGE_MARGIN || p.x > width - EDGE_MARGIN || p.y > height - EDGE_MARGIN) continue;
      if (avoid.some(([x, y2]) => Math.abs(x - p.x) < 62 && Math.abs(y2 - p.y) < 24)) continue;
      if (covered.some((r) => p.x > r.left - PANEL_MARGIN && p.x < r.right + PANEL_MARGIN && p.y > r.top - PANEL_MARGIN && p.y < r.bottom + PANEL_MARGIN)) continue;

      const w = sample(lat, lng);
      if (!w) continue;
      const magnitude = Math.hypot(w.u, w.v);
      if (magnitude < CALM_KMH) {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        continue;
      }

      const dx = w.u / magnitude;
      const dy = -w.v / magnitude;
      const length = MIN_LENGTH + (MAX_LENGTH - MIN_LENGTH) * Math.min(1, w.speed / FULL_LENGTH_KMH);
      const tipX = p.x + (dx * length) / 2;
      const tipY = p.y + (dy * length) / 2;
      const tailX = p.x - (dx * length) / 2;
      const tailY = p.y - (dy * length) / 2;
      const nx = -dy;
      const ny = dx;
      // the number sits just behind the tail, upwind of the arrow
      const labelX = tailX - dx * 11;
      const labelY = tailY - dy * 11;
      if (labelX < LABEL_MARGIN || labelY < LABEL_MARGIN || labelX > width - LABEL_MARGIN || labelY > height - LABEL_MARGIN) continue;

      const trace = () => {
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(tipX, tipY);
        ctx.moveTo(tipX - dx * HEAD + nx * HEAD * 0.6, tipY - dy * HEAD + ny * HEAD * 0.6);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(tipX - dx * HEAD - nx * HEAD * 0.6, tipY - dy * HEAD - ny * HEAD * 0.6);
      };
      trace();
      ctx.strokeStyle = halo;
      ctx.lineWidth = 5;
      ctx.globalAlpha = 0.75;
      ctx.stroke();
      trace();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 1;
      ctx.stroke();

      const label = String(Math.round(w.speed));
      ctx.strokeStyle = halo;
      ctx.lineWidth = 3.5;
      ctx.globalAlpha = 0.9;
      ctx.strokeText(label, labelX, labelY);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.fillText(label, labelX, labelY);
    }
  }
}

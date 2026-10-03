// Wind as a reading: arrows that point the way the wind blows, longer when it is stronger,
// each with its speed in km/h. This is what stays on screen when the animation is off.
import { GRID, COVERAGE } from '../utils/weatherApi';
import { CALM_KMH } from '../utils/wind';

const FONT = '600 12px Barlow, system-ui, sans-serif';
const HEAD = 6.5; // arrowhead size in px
// Arrow length runs from MIN_LENGTH to MAX_LENGTH px between 0 and FULL_LENGTH_KMH, so a 45 km/h nortada
// still reads longer than a 30 km/h breeze
const MIN_LENGTH = 10;
const MAX_LENGTH = 44;
const FULL_LENGTH_KMH = 50;
// An arrow this close to the edge would have its number cut in half ("15" reading as "5"), so it is left out
const EDGE_MARGIN = 26;

/**
 * Draws the arrow lattice. The lattice is anchored to the ground (not the screen) so arrows stay put while panning,
 * and it gets denser by whole zoom levels so spacing stays between roughly 90 and 180 px.
 * - bounds: { south, north, west, east } of the visible map, so only the arrows in view are worked out
 * - avoid: screen points [x, y] (spot labels) that arrows should not be drawn over
 */
export function drawGlyphs(ctx, { width, height, zoom, bounds, project, sample, ink, halo, avoid = [] }) {
  ctx.clearRect(0, 0, width, height);

  const level = Math.min(16, Math.max(9, Math.floor(zoom + 0.15)));
  const stepLng = GRID.step / 2 ** (level - 9);
  const stepLat = stepLng * 0.78; // roughly square cells at this latitude
  const color = `rgb(${ink.join(',')})`;

  const south = Math.max(COVERAGE.south, bounds.south);
  const north = Math.min(COVERAGE.north, bounds.north);
  const west = Math.max(COVERAGE.west, bounds.west);
  const east = Math.min(COVERAGE.east, bounds.east);
  if (south >= north || west >= east) return;

  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const firstRow = Math.max(0, Math.floor((south - COVERAGE.south) / stepLat - 0.5));
  for (let row = firstRow; ; row++) {
    const lat = COVERAGE.south + (row + 0.5) * stepLat;
    if (lat >= north) break;
    // every other row is shifted half a step, which reads as a field rather than a table
    const shift = row % 2 ? 0.75 : 0.25;
    const firstCol = Math.max(0, Math.floor((west - COVERAGE.west) / stepLng - shift));
    for (let col = firstCol; ; col++) {
      const lng = COVERAGE.west + (col + shift) * stepLng;
      if (lng >= east) break;

      const p = project(lat, lng);
      if (p.x < EDGE_MARGIN || p.y < EDGE_MARGIN || p.x > width - EDGE_MARGIN || p.y > height - EDGE_MARGIN) continue;
      if (avoid.some(([x, y]) => Math.abs(x - p.x) < 62 && Math.abs(y - p.y) < 24)) continue;

      const w = sample(lat, lng);
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

      // the number sits just behind the tail, upwind of the arrow
      const label = String(Math.round(w.speed));
      const labelX = tailX - dx * 11;
      const labelY = tailY - dy * 11;
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

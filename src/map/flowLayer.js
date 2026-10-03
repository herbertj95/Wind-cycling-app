// Wind as motion: particles drifting across a canvas, following the interpolated wind field.
// Direction is where they travel, speed is how fast and how bright they are.

const CELL = 22;            // px between samples of the screen-space wind grid
const PX_PER_KMH = 0.05;    // px a particle moves per 60 fps frame for each km/h of wind
const TRAIL_FADE = 0.93;    // share of each trail kept per 60 fps frame
// The fade is applied every few frames in one stronger step. Canvas alpha is 8-bit: a gentle fade every
// frame rounds back up and leaves a permanent film of old streaks, worse on 120 Hz screens.
const FADE_EVERY_FRAMES = 3;
const MAX_PARTICLES = 1500;
const PX_PER_PARTICLE = 1300;

// [up to km/h, opacity, line width]: stronger wind draws brighter, slightly thicker streaks
const BINS = [[6, 0.3, 1], [12, 0.46, 1.1], [18, 0.62, 1.3], [26, 0.8, 1.5], [36, 0.92, 1.8], [Infinity, 1, 2.1]];

export function createFlowLayer(canvas) {
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let ink = [255, 255, 255];
  let enabled = true;
  let moving = false;
  let frame = 0;
  let lastTime = 0;
  let unfaded = 0;

  // wind sampled on a coarse screen grid, so each particle step is four array reads
  let cols = 0;
  let rows = 0;
  let gridU = null;
  let gridV = null;
  let gridSpeed = null;
  let gridInside = null;
  let box = [0, 0, 0, 0];
  let particles = [];

  const spawn = (p) => {
    p.x = box[0] + Math.random() * (box[2] - box[0]);
    p.y = box[1] + Math.random() * (box[3] - box[1]);
    p.age = 0;
    p.life = 50 + Math.random() * 90;
    return p;
  };

  const clear = () => ctx.clearRect(0, 0, width, height);

  const reseed = () => {
    const area = Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
    const count = Math.min(MAX_PARTICLES, Math.round(area / PX_PER_PARTICLE));
    particles = Array.from({ length: count }, () => spawn({}));
    clear();
  };

  const step = (time) => {
    frame = requestAnimationFrame(step);
    if (!enabled || moving || !gridU) return;

    const dt = Math.min(3, (time - (lastTime || time)) / 16.7) || 1;
    lastTime = time;

    // fade what is already drawn, then add this frame's segments
    unfaded += dt;
    if (unfaded >= FADE_EVERY_FRAMES) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = `rgba(0,0,0,${Math.pow(TRAIL_FADE, unfaded)})`;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
      unfaded = 0;
    }
    ctx.lineCap = 'round';

    const scale = PX_PER_KMH * dt;
    const segments = BINS.map(() => []);
    for (const p of particles) {
      const gx = p.x / CELL;
      const gy = p.y / CELL;
      const i = Math.floor(gx);
      const j = Math.floor(gy);
      const k = j * cols + i;
      if (p.age++ > p.life || i < 0 || j < 0 || i >= cols - 1 || j >= rows - 1 || !gridInside[k] || !gridInside[k + cols + 1]) {
        spawn(p);
        continue;
      }
      const tx = gx - i;
      const ty = gy - j;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const u = gridU[k] * w00 + gridU[k + 1] * w10 + gridU[k + cols] * w01 + gridU[k + cols + 1] * w11;
      const v = gridV[k] * w00 + gridV[k + 1] * w10 + gridV[k + cols] * w01 + gridV[k + cols + 1] * w11;
      const speed = gridSpeed[k] * w00 + gridSpeed[k + 1] * w10 + gridSpeed[k + cols] * w01 + gridSpeed[k + cols + 1] * w11;

      const nx = p.x + u * scale;
      const ny = p.y + v * scale;
      let bin = 0;
      while (speed > BINS[bin][0]) bin++;
      segments[bin].push(p.x, p.y, nx, ny);
      p.x = nx;
      p.y = ny;
    }

    segments.forEach((seg, bin) => {
      if (seg.length === 0) return;
      ctx.beginPath();
      for (let q = 0; q < seg.length; q += 4) {
        ctx.moveTo(seg[q], seg[q + 1]);
        ctx.lineTo(seg[q + 2], seg[q + 3]);
      }
      ctx.strokeStyle = `rgba(${ink[0]},${ink[1]},${ink[2]},${BINS[bin][1]})`;
      ctx.lineWidth = BINS[bin][2];
      ctx.stroke();
    });
  };

  frame = requestAnimationFrame(step);

  return {
    resize(w, h, dpr) {
      width = w;
      height = h;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },

    /**
     * Rebuilds the screen-space wind grid for the current view.
     * unproject(x, y) -> { lat, lng }; sample(lat, lng) -> { u, v, speed, outside }; bounds = [x0, y0, x1, y1] of the forecast area on screen.
     */
    update({ unproject, sample, bounds }) {
      if (!width) return;
      cols = Math.ceil(width / CELL) + 2;
      rows = Math.ceil(height / CELL) + 2;
      const n = cols * rows;
      gridU = new Float32Array(n);
      gridV = new Float32Array(n);
      gridSpeed = new Float32Array(n);
      gridInside = new Uint8Array(n);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const { lat, lng } = unproject(i * CELL, j * CELL);
          const w = sample(lat, lng);
          if (!w || w.outside) continue;
          const k = j * cols + i;
          gridU[k] = w.u;
          gridV[k] = -w.v; // screen y grows southwards
          gridSpeed[k] = w.speed;
          gridInside[k] = 1;
        }
      }
      box = [Math.max(0, bounds[0]), Math.max(0, bounds[1]), Math.min(width, bounds[2]), Math.min(height, bounds[3])];
    },

    reseed,
    clear,

    setInk(rgb) {
      ink = rgb;
    },

    setEnabled(on) {
      enabled = on;
      if (on) reseed();
      else clear();
    },

    // particles are in screen space, so they stop while the map is being moved
    setMoving(isMoving) {
      moving = isMoving;
      if (isMoving) clear();
    },

    destroy() {
      cancelAnimationFrame(frame);
    },
  };
}

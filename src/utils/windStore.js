// The wind that has been downloaded: forecast points on the world lattice, asked for as the app needs them
// (the place in focus, the route, the saved places, the map view) and kept while they are fresh.
import { MAX_LEVEL, cellAt, nodeKey, nodePosition, stepOf } from './lattice';
import { pointAt, blendAt } from './windField';

const MINUTE = 60000;
const HOUR = 3600000;
/** A point older than this is downloaded again the next time it is needed. */
export const STALE_MS = HOUR;
// positions per request, and requests under way at once
const CHUNK = 100;
const MAX_REQUESTS = 3;
// Open-Meteo's free allowance is 600 positions a minute and 5,000 an hour for one address. Staying well
// under both leaves room for the place search and for other apps behind the same address.
const PER_MINUTE = 400;
const PER_HOUR = 3600;
// points kept in memory, and points written to this device for the next start and for riding offline
const MAX_KEPT = 1500;
const MAX_SAVED = 260;
const STORAGE_KEY = 'wind-points-v1';
// the single-area forecast that versions before the world lattice kept
const OLD_STORAGE_KEY = 'wind-forecast-v2';
// which need is served first when not everything can be asked for at once
const ORDER = ['focus', 'route', 'places', 'view'];
const ALL_LEVELS = Array.from({ length: MAX_LEVEL + 1 }, (_, level) => level);

const deviceStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
};

function describe(error) {
  if (error?.status === 429) return { kind: 'limit', limit: error.limit || 'minute' };
  // a request that got no answer, or ran out of time, is a connection problem; anything else came from the service
  if (error instanceof TypeError || error?.name === 'AbortError' || error?.name === 'TimeoutError') return { kind: 'offline' };
  return { kind: 'service' };
}

function retryDelay(problem, failures) {
  if (problem.kind === 'limit') return { minute: 65000, hour: 5 * MINUTE, day: 30 * MINUTE }[problem.limit] ?? 65000;
  return Math.min(5 * MINUTE, 15000 * 2 ** (failures - 1));
}

/**
 * - fetchPoints(positions): downloads forecast points (see weatherApi)
 * - now(): current time in ms
 * - storage: { getItem, setItem, removeItem } for the copy kept on the device
 *
 * The store itself takes orders (want, retry, refresh). What it holds is read through `getSnapshot()`,
 * which gives a new object every time the wind changes, so it can be used as a dependency.
 */
export function createWindStore({ fetchPoints, now = () => Date.now(), storage = deviceStorage }) {
  // key -> forecast point, with its place on the lattice (level, row, col)
  const points = new Map();
  const perLevel = new Array(MAX_LEVEL + 1).fill(0);
  // levelsUpTo[m]: the levels up to m that hold any point, finest first
  let levelsUpTo = ALL_LEVELS.map(() => []);
  // need -> Map(key -> lattice point), and the moment each need may first be asked for
  const demands = new Map();
  const holdUntil = new Map();
  const pending = new Set();
  const failed = new Set();
  // [time, positions] of the requests of the last hour
  const spent = [];
  const listeners = new Set();
  let version = 0;
  let requests = 0;
  let failures = 0;
  let retryAt = 0;
  let problem = null;
  let pumpTimer = 0;
  let pumpAt = Infinity;
  let saveTimer = 0;
  let destroyed = false;
  let snapshot = null;

  const emit = () => {
    version++;
    snapshot = { ...reads, problem, version };
    listeners.forEach((listener) => listener());
  };

  function put(key, node, point) {
    if (!points.has(key)) perLevel[node.level]++;
    points.set(key, { ...point, level: node.level, row: node.row, col: node.col });
  }

  function remove(key) {
    const point = points.get(key);
    if (!point) return;
    perLevel[point.level]--;
    points.delete(key);
  }

  function refreshLevels() {
    const present = ALL_LEVELS.filter((level) => perLevel[level] > 0);
    levelsUpTo = ALL_LEVELS.map((max) => present.filter((level) => level <= max));
  }

  // every key some need asks for, most important first
  function wantedKeys() {
    const keys = new Set();
    for (const name of ORDER) {
      for (const key of demands.get(name)?.keys() ?? []) keys.add(key);
    }
    return keys;
  }

  // a point whose last hour has passed has nothing to say about now or later
  const expired = (point, t) => point.n > 0 && (point.t0 + point.n * 3600) * 1000 <= t;

  function prune(t) {
    let removed = false;
    for (const [key, point] of points) {
      if (expired(point, t)) {
        remove(key);
        removed = true;
      }
    }
    if (removed) refreshLevels();
    return removed;
  }

  // keeps memory bounded on a long session of looking around: the oldest points nobody needs go first
  function trim() {
    if (points.size <= MAX_KEPT) return;
    const wanted = wantedKeys();
    const spare = [...points.keys()]
      .filter((key) => !wanted.has(key))
      .sort((a, b) => points.get(a).fetchedAt - points.get(b).fetchedAt);
    spare.slice(0, points.size - MAX_KEPT + 200).forEach(remove);
  }

  function load() {
    try {
      storage.removeItem?.(OLD_STORAGE_KEY);
      const saved = JSON.parse(storage.getItem(STORAGE_KEY));
      if (saved?.v !== 1 || !Array.isArray(saved.points)) return;
      const t = now();
      for (const entry of saved.points) {
        if (!Array.isArray(entry)) continue;
        const [level, row, col, t0, zone, fetchedAt, speed, dir, gust, temp, feels] = entry;
        const series = [speed, dir, gust, temp, feels];
        if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL || !Number.isInteger(row) || !Number.isInteger(col)) continue;
        if (!Number.isFinite(t0) || !Number.isFinite(fetchedAt) || !series.every((s) => Array.isArray(s) && s.length === series[0].length)) continue;
        const point = { t0, n: speed.length, speed, dir, gust, temp, feels, zone: typeof zone === 'string' ? zone : null, fetchedAt };
        if (point.n === 0 || expired(point, t)) continue;
        put(nodeKey(level, row, col), { level, row, col }, point);
      }
      refreshLevels();
    } catch {
      // nothing saved, or storage unavailable: start empty
    }
  }

  function save() {
    // what the app is showing right now first, then the most recent of the rest
    const keys = [...wantedKeys()].filter((key) => points.get(key)?.n > 0);
    if (keys.length < MAX_SAVED) {
      const chosen = new Set(keys);
      const rest = [...points.keys()]
        .filter((key) => !chosen.has(key) && points.get(key).n > 0)
        .sort((a, b) => points.get(b).fetchedAt - points.get(a).fetchedAt);
      keys.push(...rest.slice(0, MAX_SAVED - keys.length));
    }
    const rows = keys.slice(0, MAX_SAVED).map((key) => {
      const p = points.get(key);
      return [p.level, p.row, p.col, p.t0, p.zone, p.fetchedAt, p.speed, p.dir, p.gust, p.temp, p.feels];
    });
    for (const count of [rows.length, Math.min(rows.length, 60)]) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, points: rows.slice(0, count) }));
        return;
      } catch {
        // storage full or unavailable: try a smaller copy, then give up. The wind still works for this session.
      }
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 1500);
  }

  function schedule(delay) {
    const at = now() + delay;
    if (pumpTimer && at >= pumpAt) return;
    clearTimeout(pumpTimer);
    pumpAt = at;
    pumpTimer = setTimeout(() => {
      pumpTimer = 0;
      pumpAt = Infinity;
      pump();
    }, Math.max(0, delay));
  }

  // positions that may still be asked for now without passing the allowance, this minute and this hour
  function allowance(t) {
    while (spent.length > 0 && t - spent[0][0] >= HOUR) spent.shift();
    let lastHour = 0;
    let lastMinute = 0;
    for (const [at, count] of spent) {
      lastHour += count;
      if (t - at < MINUTE) lastMinute += count;
    }
    return { minute: PER_MINUTE - lastMinute, hour: PER_HOUR - lastHour };
  }

  function send(batch, t) {
    requests++;
    spent.push([t, batch.length]);
    batch.forEach(([key]) => pending.add(key));
    fetchPoints(batch.map(([, node]) => nodePosition(node.level, node.row, node.col)))
      .then(
        (list) => {
          batch.forEach(([key, node], i) => {
            put(key, node, list[i]);
            failed.delete(key);
          });
          trim();
          refreshLevels();
          failures = 0;
          if (failed.size === 0) problem = null;
          if (!destroyed) scheduleSave();
        },
        (error) => {
          batch.forEach(([key]) => failed.add(key));
          failures++;
          problem = describe(error);
          retryAt = now() + retryDelay(problem, failures);
        },
      )
      .finally(() => {
        requests--;
        batch.forEach(([key]) => pending.delete(key));
        if (destroyed) return;
        emit();
        pump();
      });
  }

  /** Asks for whatever is needed and missing or stale. `force` also retries failed points before their waiting time is up. */
  function pump(force = false) {
    if (destroyed) return;
    const t = now();
    const need = [];
    const asked = new Set();
    const seen = new Set();
    let heldFor = Infinity;
    let waiting = false;
    let changed = false;
    // once the service has said its allowance ran out, nothing is asked of it until the wait is over:
    // what is needed meanwhile counts as failed, so the app can say why it is not coming
    const toldToWait = problem?.kind === 'limit' && !force && t < retryAt;
    for (const name of ORDER) {
      const wanted = demands.get(name);
      if (!wanted) continue;
      const hold = (holdUntil.get(name) ?? 0) - t;
      if (hold > 0) heldFor = Math.min(heldFor, hold);
      for (const [key, node] of wanted) {
        asked.add(key);
        if (hold > 0 || seen.has(key)) continue;
        seen.add(key);
        if (pending.has(key)) continue;
        const point = points.get(key);
        if (point && t - point.fetchedAt < STALE_MS) continue;
        if (toldToWait && !failed.has(key)) {
          failed.add(key);
          changed = true;
        }
        if (failed.has(key) && !force && t < retryAt) {
          waiting = true;
          continue;
        }
        need.push([key, node]);
      }
    }

    // a failure nobody is asking about any more is no longer a problem
    for (const key of failed) {
      if (!asked.has(key)) failed.delete(key);
    }
    if (failed.size === 0 && problem) {
      problem = null;
      changed = true;
    }

    const room = allowance(t);
    let free = Math.min(room.minute, room.hour);
    while (need.length > 0 && requests < MAX_REQUESTS && free > 0) {
      const batch = need.splice(0, Math.min(CHUNK, free));
      free -= batch.length;
      send(batch, t);
      changed = true;
    }

    // what could not be asked for yet is tried again when it can be; a finished request also calls back here
    let again = heldFor;
    if (need.length > 0 && free <= 0) {
      if (room.hour <= 0) {
        // The app's own allowance for the hour is spent. That can last a long while, so it is reported
        // like the service's own refusal instead of leaving the app looking as if it were still loading.
        need.forEach(([key]) => failed.add(key));
        problem = { kind: 'limit', limit: 'hour' };
        retryAt = t + 5 * MINUTE;
        waiting = true;
        changed = true;
      } else {
        const oldest = spent.find(([at]) => t - at < MINUTE);
        again = Math.min(again, oldest ? MINUTE - (t - oldest[0]) + 50 : MINUTE);
      }
    }
    if (waiting) again = Math.min(again, Math.max(1000, retryAt - t));
    if (again < Infinity) schedule(again);
    if (changed) emit();
  }

  // What a snapshot offers. `problem` is added to it: why the last download failed, while there are points
  // it could not get: { kind: 'offline' | 'service' | 'limit', limit? } or null.
  const reads = {
    /**
     * Wind at a position and a moment (unix seconds), or null when it is not loaded.
     * - maxLevel: the coarsest lattice level accepted; 0 only reads from points at most 0.125° apart
     * - late: also answer for moments after the forecast ends, with the last hour and `late: true`
     */
    sample(lat, lng, time, { maxLevel = MAX_LEVEL, late = false } = {}) {
      const value = blendAt(lat, lng, levelsUpTo[Math.min(MAX_LEVEL, maxLevel)], (key) => pointAt(points.get(key), time));
      return value && (late || !value.late) ? value : null;
    },

    /**
     * The wind at one moment, for reading many positions: { time, sample(lat, lng) }.
     * Each lattice point is worked out once, however many positions are read around it.
     */
    frame(time) {
      const levels = levelsUpTo[MAX_LEVEL];
      const cache = new Map();
      const valueAt = (key) => {
        let value = cache.get(key);
        if (value === undefined) {
          value = pointAt(points.get(key), time);
          if (value?.late) value = null;
          cache.set(key, value);
        }
        return value;
      };
      return { time, sample: (lat, lng) => blendAt(lat, lng, levels, valueAt) };
    },

    /** Time zone of the loaded forecast point nearest to a position, or null when none is loaded around it. */
    zoneAt(lat, lng) {
      for (const level of levelsUpTo[MAX_LEVEL]) {
        const { row, col, tx, ty } = cellAt(level, lat, lng);
        const rows = ty < 0.5 ? [row, row + 1] : [row + 1, row];
        const cols = tx < 0.5 ? [col, col + 1] : [col + 1, col];
        for (const r of rows) {
          for (const c of cols) {
            const zone = points.get(nodeKey(level, r, c))?.zone;
            if (zone) return zone;
          }
        }
      }
      return null;
    },

    /**
     * How far a set of lattice points is: 'ready' when all are here, 'failed' when one could not be
     * downloaded and is not being tried right now, otherwise 'loading'.
     */
    state(nodes) {
      let missing = false;
      for (const node of nodes) {
        const key = nodeKey(node.level, node.row, node.col);
        if (points.has(key)) continue;
        if (failed.has(key) && !pending.has(key)) return 'failed';
        missing = true;
      }
      return missing ? 'loading' : 'ready';
    },
  };

  load();
  snapshot = { ...reads, problem, version };

  return {
    /**
     * Says which lattice points a part of the app needs ([{ level, row, col }]), replacing what it needed before.
     * Names: 'focus', 'route', 'places', 'view'. `delay` (ms) waits before asking, for needs that change quickly.
     */
    want(name, nodes, delay = 0) {
      const wanted = new Map();
      for (const node of nodes) {
        // nothing is forecast beyond the poles
        if (Math.abs(node.row * stepOf(node.level)) > 90) continue;
        wanted.set(nodeKey(node.level, node.row, node.col), node);
      }
      demands.set(name, wanted);
      holdUntil.set(name, now() + delay);
      schedule(delay);
    },

    /** Tries the failed points again now. */
    retry() {
      pump(true);
    },

    /** Drops what has expired and asks again for what has gone stale. Meant to be called every minute or so. */
    refresh(force = false) {
      if (prune(now())) emit();
      pump(force);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** The wind as it is now: { sample, frame, zoneAt, state, problem, version }. */
    getSnapshot: () => snapshot,

    destroy() {
      destroyed = true;
      clearTimeout(pumpTimer);
      clearTimeout(saveTimer);
      listeners.clear();
    },
  };
}

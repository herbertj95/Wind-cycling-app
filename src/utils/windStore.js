// The wind that has been downloaded: forecast points on the world lattice, asked for as the app needs them
// (the place in focus, the route, the saved places, the map view) and kept while they are fresh.
import { MAX_LEVEL, cellAt, finestIndex, inBounds, nodeKey, nodePosition, stepOf } from './lattice';
import { pointAt, blendAt } from './windField';

const MINUTE = 60000;
const HOUR = 3600000;
/** A point older than this is downloaded again the next time it is needed. */
export const STALE_MS = HOUR;
// Positions per request, and requests under way at once. A map view is two or three requests side by
// side: the free service now and then takes seconds over one answer, and that should hold up a part of
// the map, not all of it.
const CHUNK = 50;
const MAX_REQUESTS = 4;
// Open-Meteo's free allowance is 600 positions a minute and 5,000 an hour for one address. Staying well
// under both leaves room for the place search and for other apps behind the same address.
const PER_MINUTE = 400;
const PER_HOUR = 3600;
// points kept in memory, and points written to this device for the next start and for riding offline
const MAX_KEPT = 1500;
const MAX_SAVED = 260;
const STORAGE_KEY = 'wind-points-v1';
// what was asked of the service in the last hour, so a restart does not start a fresh allowance
const SPENT_KEY = 'wind-spent-v1';
// the single-area forecast that versions before the world lattice kept
const OLD_STORAGE_KEY = 'wind-forecast-v2';
// which need is served first when not everything can be asked for at once
const ORDER = ['focus', 'route', 'station', 'places', 'view'];
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

// a point that came with no hours of wind: it is there, with nothing to read
const emptied = (point) => ({ ...point, n: 0, speed: [], dir: [], gust: [], temp: [], feels: [], rain: [], rainChance: [] });

/**
 * - fetchPoints(positions): downloads forecast points (see weatherApi)
 * - now(): current time in ms
 * - storage: { getItem, setItem, removeItem } for the copy kept on the device
 *
 * The store itself takes orders (want, retry, refresh). What it holds is read through `getSnapshot()`,
 * which gives a new object every time the wind changes, so it can be used as a dependency.
 */
export function createWindStore({ fetchPoints, now = () => Date.now(), storage = deviceStorage }) {
  // key -> forecast point, with its place on the finest lattice (row, col). A point serves every level
  // whose lattice it lies on, whichever level it was asked for.
  const points = new Map();
  // how many points lie on the lattice of each level
  const perLevel = new Array(MAX_LEVEL + 1).fill(0);
  // levelsUpTo[m]: the levels up to m that hold any point, finest first
  let levelsUpTo = ALL_LEVELS.map(() => []);
  // need -> Map(key -> lattice point), and the moment each need may first be asked for
  const demands = new Map();
  const holdUntil = new Map();
  const pending = new Set();
  const failed = new Set();
  // [time, positions] of the requests of the last hour
  let spent = [];
  const listeners = new Set();
  let version = 0;
  let requests = 0;
  // Failed attempts in a row, and when the next one is due. The requests of one attempt fail together
  // in one outage: only the first failure after the wait is over counts.
  let failures = 0;
  let retryAt = 0;
  let problem = null;
  // While the service says its allowance ran out, nothing is asked of it. This outlives the needs that
  // were refused: moving the map to somewhere else must not start asking again.
  let limitUntil = 0;
  let limitProblem = null;
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

  const onLattice = (point, level) => point.row % 2 ** level === 0 && point.col % 2 ** level === 0;

  function remove(key) {
    const point = points.get(key);
    if (!point) return;
    ALL_LEVELS.forEach((level) => {
      if (onLattice(point, level)) perLevel[level]--;
    });
    points.delete(key);
  }

  function put(key, node, point) {
    remove(key);
    const stored = { ...point, ...finestIndex(node.level, node.row, node.col) };
    points.set(key, stored);
    ALL_LEVELS.forEach((level) => {
      if (onLattice(stored, level)) perLevel[level]++;
    });
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
      const t = now();
      const charged = JSON.parse(storage.getItem(SPENT_KEY));
      if (Array.isArray(charged)) {
        spent = charged.filter((entry) => Array.isArray(entry) && Number.isFinite(entry[0]) && entry[1] > 0 && entry[0] <= t && t - entry[0] < HOUR);
      }
      const saved = JSON.parse(storage.getItem(STORAGE_KEY));
      if (saved?.v !== 1 || !Array.isArray(saved.points)) return;
      for (const entry of saved.points) {
        if (!Array.isArray(entry)) continue;
        const [level, row, col, t0, zone, fetchedAt, speed, dir, gust, temp, feels, rain, rainChance] = entry;
        const series = [speed, dir, gust, temp, feels];
        if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL || !Number.isInteger(row) || !Number.isInteger(col)) continue;
        if (!Number.isFinite(t0) || !Number.isFinite(fetchedAt) || !series.every((s) => Array.isArray(s) && s.length === series[0].length)) continue;
        const point = { t0, n: speed.length, speed, dir, gust, temp, feels, zone: typeof zone === 'string' ? zone : null, fetchedAt };
        // points saved before the app read the rain come without it: their wind is still good
        if ([rain, rainChance].every((s) => Array.isArray(s) && s.length === speed.length)) Object.assign(point, { rain, rainChance });
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
      // the 0 is the lattice level the row and the column are counted on
      return [0, p.row, p.col, p.t0, p.zone, p.fetchedAt, p.speed, p.dir, p.gust, p.temp, p.feels, p.rain ?? null, p.rainChance ?? null];
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

  function saveSpent() {
    try {
      storage.setItem(SPENT_KEY, JSON.stringify(spent));
    } catch {
      // the allowance is then only remembered until the app is closed
    }
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
    const charge = [t, batch.length];
    spent.push(charge);
    saveSpent();
    batch.forEach(([key]) => pending.add(key));
    fetchPoints(batch.map(([, node]) => nodePosition(node.level, node.row, node.col)))
      .then(
        (list) => {
          const arrived = now();
          batch.forEach(([key, node], i) => {
            // A forecast that is already over when it arrives (a device clock days ahead, an answer with a
            // hole in its first hours) is kept as a point with nothing to read. Dropped, it would be
            // asked for again every minute.
            put(key, node, expired(list[i], arrived) ? emptied(list[i]) : list[i]);
            failed.delete(key);
          });
          trim();
          refreshLevels();
          // the service is answering: whatever failed before need not wait any longer
          failures = 0;
          retryAt = 0;
          limitUntil = 0;
          if (failed.size === 0) problem = null;
          if (!destroyed) scheduleSave();
        },
        (error) => {
          batch.forEach(([key]) => failed.add(key));
          const failedAt = now();
          if (failedAt >= retryAt) failures++;
          problem = describe(error);
          retryAt = failedAt + retryDelay(problem, failures);
          if (problem.kind === 'limit') {
            limitUntil = retryAt;
            limitProblem = problem;
          }
          // a request that never got an answer did not reach the service: it is not held against the allowance
          if (error instanceof TypeError) {
            const at = spent.indexOf(charge);
            if (at >= 0) spent.splice(at, 1);
            saveSpent();
          }
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

  /**
   * Asks for whatever is needed and missing or stale.
   * - retryFailed: also try the points that failed before their waiting time is up
   * - ignoreLimit: also ask while the service says its allowance ran out (somebody pressed "Try again")
   */
  function pump({ retryFailed = false, ignoreLimit = false } = {}) {
    if (destroyed) return;
    const t = now();
    const need = [];
    const asked = new Set();
    const seen = new Set();
    let heldFor = Infinity;
    let waitFor = Infinity;
    let changed = false;
    // what is needed meanwhile counts as failed, so the app can say why it is not coming
    const toldToWait = !ignoreLimit && t < limitUntil;
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
        if (toldToWait) {
          if (!failed.has(key) || problem !== limitProblem) changed = true;
          failed.add(key);
          problem = limitProblem;
          waitFor = Math.min(waitFor, limitUntil - t);
          continue;
        }
        if (failed.has(key) && !retryFailed && t < retryAt) {
          waitFor = Math.min(waitFor, retryAt - t);
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
    let again = Math.min(heldFor, waitFor < Infinity ? Math.max(1000, waitFor) : Infinity);
    if (need.length > 0 && free <= 0) {
      if (room.hour <= 0) {
        // The app's own allowance for the hour is spent. That can last a long while, so it is reported
        // like the service's own refusal instead of leaving the app looking as if it were still loading.
        need.forEach(([key]) => failed.add(key));
        limitProblem = { kind: 'limit', limit: 'hour' };
        problem = limitProblem;
        // look again in five minutes, or as soon as the oldest request of the hour drops out of it
        const roomAt = spent.length > 0 ? spent[0][0] + HOUR + 50 : t;
        limitUntil = Math.max(t + 1000, Math.min(t + 5 * MINUTE, roomAt));
        again = Math.min(again, limitUntil - t);
        changed = true;
      } else {
        const oldest = spent.find(([at]) => t - at < MINUTE);
        again = Math.min(again, oldest ? MINUTE - (t - oldest[0]) + 50 : MINUTE);
      }
    }
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
     * Where both are there, a fresh forecast on a coarser lattice is preferred to an old one on a finer
     * lattice (a place looked at hours ago, or kept from the last time the app was open): the map should
     * not show yesterday's wind in one corner. The old one is still better than nothing.
     */
    frame(time) {
      const levels = levelsUpTo[MAX_LEVEL];
      const freshFrom = now() - STALE_MS;
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
      const freshAt = (key) => {
        const value = valueAt(key);
        return value && value.fetchedAt >= freshFrom ? value : null;
      };
      return { time, sample: (lat, lng) => blendAt(lat, lng, levels, freshAt) ?? blendAt(lat, lng, levels, valueAt) };
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
     * A short text that changes whenever a forecast point inside `bounds` arrives, is renewed or goes:
     * what is worked out from the wind of that part of the world alone needs working out again only
     * when it changes. `bounds` is { south, west, north, east } in degrees.
     */
    stamp(bounds) {
      let count = 0;
      let sum = 0;
      for (const point of points.values()) {
        const { lat, lng } = nodePosition(0, point.row, point.col);
        if (!inBounds(bounds, lat, lng)) continue;
        count++;
        sum += point.fetchedAt;
      }
      return `${count}:${sum}`;
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
     * Names: 'focus', 'route', 'station', 'places', 'view'. `delay` (ms) waits before asking, for needs that change quickly.
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

    /** Tries the failed points again now, also when the service has said to wait: somebody asked for it. */
    retry() {
      pump({ retryFailed: true, ignoreLimit: true });
    },

    /**
     * Drops what has expired and asks again for what has gone stale. Meant to be called every minute or so.
     * `eager` also retries what failed before its waiting time is up, for when the app comes back to the
     * front; it does not ask while the service says its allowance ran out.
     */
    refresh(eager = false) {
      if (prune(now())) emit();
      pump({ retryFailed: eager });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** The wind as it is now: { sample, frame, zoneAt, stamp, state, problem, version }. */
    getSnapshot: () => snapshot,

    destroy() {
      destroyed = true;
      clearTimeout(pumpTimer);
      clearTimeout(saveTimer);
      listeners.clear();
    },
  };
}

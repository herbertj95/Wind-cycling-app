import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWindStore, STALE_MS } from './windStore';
import { nodeKey, nodePosition, nodesAround, nodesInBounds } from './lattice';

const T0 = 1790985600; // 2026-10-03 00:00 UTC, in unix seconds
const HOUR = 3600;
const MINUTE_MS = 60000;
// the tests start at 00:20
const START = T0 * 1000 + 20 * MINUTE_MS;
const STORAGE_KEY = 'wind-points-v1';
const SPENT_KEY = 'wind-spent-v1';

/**
 * Stand-in for the forecast service. Every position gets `hours` hourly values starting three hours before
 * the hour in progress, like the real request: speed 10 km/h at the first hour and 1 km/h more each hour,
 * always from the north.
 * `fail` makes requests reject with that error; `gate` holds them until it resolves.
 */
function makeService(hours = 52) {
  const service = {
    calls: [],
    fail: null,
    gate: null,
    asked: () => service.calls.reduce((total, positions) => total + positions.length, 0),
    fetchPoints: vi.fn(async (positions) => {
      service.calls.push(positions);
      if (service.gate) await service.gate;
      if (service.fail) throw service.fail;
      const fetchedAt = Date.now();
      const t0 = Math.floor(fetchedAt / 3600000) * HOUR - 3 * HOUR;
      return positions.map((p) => ({
        t0,
        n: hours,
        speed: Array.from({ length: hours }, (_, h) => 10 + h),
        dir: new Array(hours).fill(0),
        gust: Array.from({ length: hours }, (_, h) => 20 + h),
        temp: new Array(hours).fill(18),
        feels: new Array(hours).fill(17),
        zone: p.lng < -6 ? 'Europe/Lisbon' : 'Europe/Madrid',
        fetchedAt,
      }));
    }),
  };
  return service;
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

const httpError = (status, extra = {}) => Object.assign(new Error(`Open-Meteo answered ${status}`), { status, ...extra });
// lets the timers that are due run, and the requests they start finish
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const nowSeconds = () => Date.now() / 1000;

// the four finest points around central Lisbon, and a block of them over the city
const LISBON = nodesAround(0, 38.73, -9.14);
const POINT = { maxLevel: 0 };
/** `count` neighbouring lattice points along the parallel `latRow` steps north of the equator. */
const row = (count, latRow = 100, level = 0) => Array.from({ length: count }, (_, i) => ({ level, row: latRow, col: i }));
const positions = (nodes) => nodes.map((n) => nodePosition(n.level, n.row, n.col));

let service;
let storage;
let store;
const newStore = () => createWindStore({ fetchPoints: service.fetchPoints, storage });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  service = makeService();
  storage = memoryStorage();
  store = newStore();
});

afterEach(() => {
  store.destroy();
  vi.useRealTimers();
});

describe('downloading what is needed', () => {
  it('asks for the wanted points and can then read the wind between them', async () => {
    store.want('focus', LISBON);
    expect(store.getSnapshot().state(LISBON)).toBe('loading');
    expect(store.getSnapshot().sample(38.73, -9.14, nowSeconds())).toBeNull();

    await settle();

    expect(service.fetchPoints).toHaveBeenCalledTimes(1);
    expect(service.calls[0]).toEqual(positions(LISBON));
    const wind = store.getSnapshot();
    expect(wind.state(LISBON)).toBe('ready');
    // 00:20 is 3 h 20 min after the first hour: 10 + 3.33 km/h, from the north
    const reading = wind.sample(38.73, -9.14, nowSeconds(), POINT);
    expect(reading.speed).toBeCloseTo(10 + 10 / 3, 6);
    expect(reading.from).toBeCloseTo(0, 6);
    expect(reading.gust).toBe(24);
    expect(reading.fetchedAt).toBe(START);
  });

  it('hands out a new snapshot and tells its listeners when points arrive', async () => {
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);

    store.want('focus', LISBON);
    await settle();

    expect(listener).toHaveBeenCalled();
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot().version).toBeGreaterThan(before.version);

    stop();
    listener.mockClear();
    store.want('focus', nodesAround(0, 41.98, 2.82));
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not ask again for points it already has', async () => {
    store.want('focus', LISBON);
    await settle();
    store.want('focus', LISBON);
    store.want('places', LISBON);
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(1);

    // a neighbouring place shares two of its four points: only the other two are asked for
    store.want('focus', nodesAround(0, 38.73, -9.3));
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
    expect(service.calls[1]).toHaveLength(2);
  });

  it('shares a download that is under way', async () => {
    let release;
    service.gate = new Promise((resolve) => {
      release = resolve;
    });
    store.want('focus', LISBON);
    await settle();
    store.want('places', LISBON);
    store.want('view', LISBON);
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(1);

    release();
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().state(LISBON)).toBe('ready');
  });

  it('does not download a position again for a coarser lattice that shares it', async () => {
    const bounds = { south: 38.5, north: 39, west: -9.5, east: -9 };
    const fine = nodesInBounds(0, bounds);
    const coarse = nodesInBounds(1, bounds);
    const coarser = nodesInBounds(2, bounds);
    store.want('view', fine);
    await settle();
    expect(service.asked()).toBe(fine.length);

    // every point of the coarser lattices over the same area is one the finest lattice has
    expect(store.getSnapshot().state(coarse)).toBe('ready');
    expect(store.getSnapshot().state(coarser)).toBe('ready');
    store.want('view', coarse);
    store.want('route', coarser);
    await settle();
    expect(service.asked()).toBe(fine.length);
    // and the wind can be read on the coarser lattice from them
    expect(store.getSnapshot().sample(38.7, -9.2, nowSeconds()).level).toBe(0);
  });

  it('asks only for the positions a finer lattice adds to a coarser one', async () => {
    const bounds = { south: 38.5, north: 39, west: -9.5, east: -9 };
    const coarse = nodesInBounds(1, bounds);
    const fine = nodesInBounds(0, bounds);
    store.want('view', coarse);
    await settle();
    store.want('view', fine);
    await settle();
    expect(service.asked()).toBe(fine.length);
    expect(service.calls[1]).toHaveLength(fine.length - coarse.length);
  });

  it('does not make a new need wait for a slow request that is under way', async () => {
    let release;
    service.gate = new Promise((resolve) => {
      release = resolve;
    });
    // the view is asked for, in two requests, and the service takes its time
    store.want('view', row(87, 200));
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);

    // a route is opened meanwhile: what it needs beyond the view goes out at once
    service.gate = null;
    const route = [...row(10, 200), ...row(6, 210)];
    store.want('route', route);
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(3);
    expect(service.calls[2]).toEqual(positions(row(6, 210)));
    // and so does a view the map has moved on to, once it has settled
    store.want('view', []);
    await settle(1000);
    store.want('view', [...row(40, 200), ...row(5, 220)], 350);
    await settle(400);
    expect(service.fetchPoints).toHaveBeenCalledTimes(4);
    expect(service.calls[3]).toEqual(positions(row(5, 220)));

    release();
    await settle();
    expect(store.getSnapshot().state(route)).toBe('ready');
    expect(service.fetchPoints).toHaveBeenCalledTimes(4);
  });

  it('never asks for a point beyond the poles', async () => {
    store.want('focus', [{ level: 0, row: 721, col: 0 }, { level: 5, row: -23, col: 0 }, { level: 0, row: 720, col: 0 }]);
    await settle();
    expect(service.calls).toEqual([[{ lat: 90, lng: 0 }]]);
  });

  it('stops asking once it is destroyed', async () => {
    store.want('focus', LISBON);
    store.destroy();
    await settle(5000);
    expect(service.fetchPoints).not.toHaveBeenCalled();
  });
});

describe('keeping the forecast fresh', () => {
  it('asks again for a point once it is an hour old, and keeps the old values meanwhile', async () => {
    store.want('focus', LISBON);
    await settle();

    await settle(STALE_MS - MINUTE_MS);
    store.refresh();
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(1);

    await settle(2 * MINUTE_MS);
    let release;
    service.gate = new Promise((resolve) => {
      release = resolve;
    });
    store.refresh();
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
    // still readable while the new download is under way
    expect(store.getSnapshot().sample(38.73, -9.14, nowSeconds(), POINT).fetchedAt).toBe(START);

    release();
    await settle();
    expect(store.getSnapshot().sample(38.73, -9.14, nowSeconds(), POINT).fetchedAt).toBe(Date.now());
  });

  it('does not keep asking for a point whose forecast is already over when it arrives', async () => {
    // an answer that only reaches two hours back from the first hour: nothing in it is about now
    store.destroy();
    service = makeService(2);
    store = newStore();
    store.want('focus', LISBON);
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().state(LISBON)).toBe('ready');
    expect(store.getSnapshot().sample(38.73, -9.14, nowSeconds(), { late: true })).toBeNull();

    // the minute ticks find nothing to drop and nothing to ask for
    for (let minute = 0; minute < 30; minute++) {
      await settle(MINUTE_MS);
      store.refresh();
    }
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(1);

    // an hour later it is due again, like any other point
    await settle(31 * MINUTE_MS);
    store.refresh();
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
  });

  it('only renews what is still needed', async () => {
    store.want('focus', LISBON);
    await settle();
    store.want('focus', nodesAround(0, 41.98, 2.82));
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);

    await settle(STALE_MS + MINUTE_MS);
    store.refresh();
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(3);
    expect(service.calls[2]).toEqual(service.calls[1]);
  });

  it('drops a point whose last hour has passed', async () => {
    service = makeService(6); // the forecast ends at 02:00 and counts until 03:00
    store.destroy();
    store = newStore();
    store.want('focus', LISBON);
    await settle();
    store.want('focus', []);
    const listener = vi.fn();
    store.subscribe(listener);
    const during = nowSeconds();

    await settle(2 * HOUR * 1000);
    store.refresh();
    expect(store.getSnapshot().sample(38.73, -9.14, during)).not.toBeNull();
    expect(listener).not.toHaveBeenCalled();

    await settle(HOUR * 1000);
    store.refresh();
    expect(store.getSnapshot().sample(38.73, -9.14, during)).toBeNull();
    expect(listener).toHaveBeenCalled();
  });
});

describe('staying inside the allowance of the service', () => {
  it('splits a large need into requests of at most 50 positions, four at a time', async () => {
    let release;
    service.gate = new Promise((resolve) => {
      release = resolve;
    });
    store.want('view', row(330));
    await settle();
    expect(service.calls.map((c) => c.length)).toEqual([50, 50, 50, 50]);

    release();
    await settle();
    expect(service.calls.map((c) => c.length)).toEqual([50, 50, 50, 50, 50, 50, 30]);
    expect(new Set(service.calls.flat().map((p) => `${p.lat},${p.lng}`)).size).toBe(330);
  });

  it('shows the part of a view that has arrived while another part is slow', async () => {
    // the second request of the view hangs; the first one is answered
    let release;
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const fetchPoints = service.fetchPoints;
    let call = 0;
    const flaky = vi.fn(async (list) => {
      call++;
      if (call === 2) await slow;
      return fetchPoints(list);
    });
    store.destroy();
    store = createWindStore({ fetchPoints: flaky, storage });
    const view = row(80, 200);
    store.want('view', view);
    await settle();
    const wind = store.getSnapshot();
    expect(wind.state(view)).toBe('loading');
    expect(wind.state(view.slice(0, 50))).toBe('ready');

    release();
    await settle();
    expect(store.getSnapshot().state(view)).toBe('ready');
  });

  it('asks for no more than 400 positions in a minute and for the rest afterwards', async () => {
    store.want('view', row(450));
    await settle();
    expect(service.asked()).toBe(400);
    expect(store.getSnapshot().state(row(450))).toBe('loading');

    await settle(59000);
    expect(service.asked()).toBe(400);

    await settle(2000);
    expect(service.asked()).toBe(450);
    expect(store.getSnapshot().state(row(450))).toBe('ready');
  });

  it('stops at 3,600 positions in an hour and says the allowance ran out instead of loading for ever', async () => {
    // nine minutes of looking around at full tilt: 400 new positions a minute
    for (let minute = 0; minute < 9; minute++) {
      store.want('view', row(400, 100 + minute));
      await settle(61000);
    }
    expect(service.asked()).toBe(3600);
    expect(store.getSnapshot().problem).toBeNull();

    const more = row(50, 300);
    store.want('view', more);
    await settle(61000);
    expect(service.asked()).toBe(3600);
    expect(store.getSnapshot().state(more)).toBe('failed');
    expect(store.getSnapshot().problem).toEqual({ kind: 'limit', limit: 'hour' });
    // asking it to try again does not get round the allowance
    store.retry();
    await settle();
    expect(service.asked()).toBe(3600);

    // an hour after the first requests there is room again
    await settle(52 * MINUTE_MS);
    expect(service.asked()).toBe(3650);
    expect(store.getSnapshot().state(more)).toBe('ready');
    expect(store.getSnapshot().problem).toBeNull();
  });

  it('remembers what was asked of the service across a restart', async () => {
    for (let minute = 0; minute < 9; minute++) {
      store.want('view', row(400, 100 + minute));
      await settle(61000);
    }
    expect(service.asked()).toBe(3600);
    expect(JSON.parse(storage.data[SPENT_KEY]).reduce((total, [, positions]) => total + positions, 0)).toBe(3600);

    // the app is closed and opened again: the hour's allowance is still spent
    store.destroy();
    store = newStore();
    const more = row(50, 300);
    store.want('view', more);
    await settle(1000);
    expect(service.asked()).toBe(3600);
    expect(store.getSnapshot().state(more)).toBe('failed');
    expect(store.getSnapshot().problem).toEqual({ kind: 'limit', limit: 'hour' });

    await settle(52 * MINUTE_MS);
    expect(service.asked()).toBe(3650);
    expect(store.getSnapshot().state(more)).toBe('ready');
  });

  it('ignores a record of the allowance that cannot be right', async () => {
    const future = START + 5 * MINUTE_MS;
    storage.data[SPENT_KEY] = JSON.stringify([[START - 2 * HOUR * 1000, 3000], [future, 3000], 'x', [START - 1000, -5], null]);
    store.destroy();
    store = newStore();
    store.want('view', row(400));
    await settle();
    expect(service.asked()).toBe(400);
  });

  it('does not charge the allowance for requests that never reached the service', async () => {
    service.fail = new TypeError('Failed to fetch');
    store.want('view', row(300));
    await settle();
    // out of coverage, pressing "Try again" over and over
    for (let i = 0; i < 20; i++) {
      store.retry();
      await settle(2000);
    }
    expect(service.asked()).toBeGreaterThan(3600);
    expect(store.getSnapshot().problem).toEqual({ kind: 'offline' });

    // back in coverage, everything is asked for at once
    service.fail = null;
    const before = service.asked();
    store.retry();
    await settle();
    expect(service.asked() - before).toBe(300);
    expect(store.getSnapshot().state(row(300))).toBe('ready');
    expect(store.getSnapshot().problem).toBeNull();
  });

  it('does charge it for requests the service answered with an error', async () => {
    service.fail = httpError(503);
    store.want('view', row(300));
    await settle();
    expect(service.asked()).toBe(300);

    // 100 positions are left for this minute, whatever is tried
    service.fail = null;
    store.retry();
    await settle();
    expect(service.asked()).toBe(400);
    await settle(61000);
    expect(service.asked()).toBe(600);
    expect(store.getSnapshot().state(row(300))).toBe('ready');
  });

  it('serves the place in focus before the route, the saved places and the view', async () => {
    store.want('view', row(396));
    await settle();
    expect(service.asked()).toBe(396);

    // room for four more positions this minute, and four needs competing for it
    store.want('view', row(30, 200));
    store.want('places', row(8, 300));
    store.want('route', row(8, 400));
    store.want('focus', LISBON);
    await settle();
    expect(service.calls.at(-1)).toEqual(positions(LISBON));
    expect(service.asked()).toBe(400);

    await settle(61000);
    const later = service.calls.at(-1);
    // the route came next, then the places, then the view
    expect(later.slice(0, 8)).toEqual(positions(row(8, 400)));
    expect(later.slice(8, 16)).toEqual(positions(row(8, 300)));
    expect(later.slice(16)).toEqual(positions(row(30, 200)));
    expect(service.asked()).toBe(400 + 46);
  });

  it('waits before asking for a need that changes quickly, and only asks for where it ended up', async () => {
    const first = nodesInBounds(0, { south: 38.4, north: 38.9, west: -9.5, east: -9 });
    const second = nodesInBounds(0, { south: 41.8, north: 42.2, west: 2.6, east: 3 });
    store.want('view', first, 350);
    // something else needing the service right now does not drag the waiting view along
    store.want('focus', LISBON);
    await settle(100);
    expect(service.asked()).toBe(4);

    // the map moved on before the wait was over
    store.want('view', []);
    await settle(100);
    store.want('view', second, 350);
    await settle(349);
    expect(service.asked()).toBe(4);

    await settle(1);
    expect(service.asked()).toBe(4 + second.length);
    expect(store.getSnapshot().state(second)).toBe('ready');
    // nothing of the view that was passed through was downloaded, apart from what the focus shares with it
    expect(store.getSnapshot().state(first)).toBe('loading');
  });
});

describe('when a download fails', () => {
  it('says the device is offline when the request got no answer', async () => {
    service.fail = new TypeError('Failed to fetch');
    store.want('focus', LISBON);
    await settle();
    const wind = store.getSnapshot();
    expect(wind.problem).toEqual({ kind: 'offline' });
    expect(wind.state(LISBON)).toBe('failed');
    expect(wind.sample(38.73, -9.14, nowSeconds())).toBeNull();
  });

  it('says the device is offline when the request ran out of time', async () => {
    service.fail = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    store.want('focus', LISBON);
    await settle();
    expect(store.getSnapshot().problem).toEqual({ kind: 'offline' });
  });

  it('blames the service for an error answer or a malformed one', async () => {
    service.fail = httpError(503);
    store.want('focus', LISBON);
    await settle();
    expect(store.getSnapshot().problem).toEqual({ kind: 'service' });

    service.fail = new Error('Unexpected forecast response');
    store.retry();
    await settle();
    expect(store.getSnapshot().problem).toEqual({ kind: 'service' });
  });

  it('reports which allowance of the service ran out', async () => {
    service.fail = httpError(429, { limit: 'hour' });
    store.want('focus', LISBON);
    await settle();
    expect(store.getSnapshot().problem).toEqual({ kind: 'limit', limit: 'hour' });
  });

  it('tries again by itself after a while, and the problem is gone once it works', async () => {
    service.fail = new TypeError('Failed to fetch');
    store.want('focus', LISBON);
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(1);

    // not before the wait is over, however often it is asked to look
    await settle(10000);
    store.refresh();
    store.want('focus', LISBON);
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(1);

    service.fail = null;
    await settle(5000);
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().problem).toBeNull();
    expect(store.getSnapshot().state(LISBON)).toBe('ready');
  });

  it('waits longer after every failure in a row', async () => {
    service.fail = new TypeError('Failed to fetch');
    store.want('focus', LISBON);
    await settle();
    await settle(15000);
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
    await settle(15000);
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
    await settle(15000);
    expect(service.fetchPoints).toHaveBeenCalledTimes(3);
  });

  it('counts an attempt once, however many requests it took', async () => {
    // 250 positions are five requests; all five fail in the same outage
    service.fail = new TypeError('Failed to fetch');
    store.want('view', row(250));
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(5);

    // The second attempt comes after 15 seconds, not after the minutes that five failures would mean.
    // It is the four requests that go out side by side; the rest follows once the service answers.
    await settle(14000);
    expect(service.fetchPoints).toHaveBeenCalledTimes(5);
    await settle(1500);
    expect(service.fetchPoints).toHaveBeenCalledTimes(9);
    // and the third after 30 more
    await settle(29000);
    expect(service.fetchPoints).toHaveBeenCalledTimes(9);
    await settle(1500);
    expect(service.fetchPoints).toHaveBeenCalledTimes(13);

    // the outage is over: the next attempt gets all of it, without another wait for the part beyond four requests
    service.fail = null;
    await settle(60000);
    expect(store.getSnapshot().state(row(250))).toBe('ready');
    expect(store.getSnapshot().problem).toBeNull();
  });

  it('waits out the allowance that ran out: over a minute for the one per minute', async () => {
    service.fail = httpError(429, { limit: 'minute' });
    store.want('focus', LISBON);
    await settle();
    await settle(60000);
    expect(service.fetchPoints).toHaveBeenCalledTimes(1);
    service.fail = null;
    await settle(6000);
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().problem).toBeNull();
  });

  it('tries again at once when told to', async () => {
    service.fail = new TypeError('Failed to fetch');
    store.want('focus', LISBON);
    await settle();
    service.fail = null;
    store.retry();
    expect(store.getSnapshot().state(LISBON)).toBe('loading');
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().state(LISBON)).toBe('ready');
    expect(store.getSnapshot().problem).toBeNull();
  });

  it('keeps showing the forecast it has when a renewal fails', async () => {
    store.want('focus', LISBON);
    await settle();
    await settle(STALE_MS + MINUTE_MS);
    service.fail = new TypeError('Failed to fetch');
    store.refresh();
    await settle();

    const wind = store.getSnapshot();
    expect(wind.problem).toEqual({ kind: 'offline' });
    expect(wind.state(LISBON)).toBe('ready');
    const reading = wind.sample(38.73, -9.14, nowSeconds(), POINT);
    expect(reading.fetchedAt).toBe(START);
    expect(reading.speed).toBeGreaterThan(10);
  });

  it('asks for nothing new while the service says its allowance ran out, and says so about what is needed', async () => {
    service.fail = httpError(429, { limit: 'hour' });
    store.want('focus', LISBON);
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(1);

    // the service would answer now, but the wait it asked for is not over
    service.fail = null;
    const elsewhere = nodesAround(0, 41.98, 2.82);
    store.want('focus', elsewhere);
    await settle(1000);
    expect(service.fetchPoints).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().state(elsewhere)).toBe('failed');
    expect(store.getSnapshot().problem).toEqual({ kind: 'limit', limit: 'hour' });

    // five minutes later it tries again by itself
    await settle(5 * MINUTE_MS);
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().state(elsewhere)).toBe('ready');
    expect(store.getSnapshot().problem).toBeNull();
  });

  it('keeps waiting when the map moves on from the view the service refused', async () => {
    store.want('focus', LISBON);
    await settle();
    service.fail = httpError(429, { limit: 'hour' });
    store.want('view', row(40, 200));
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
    service.fail = null;

    // ten pans in the next minute: the refused view is dropped each time and a new one is needed
    for (let pan = 0; pan < 10; pan++) {
      store.want('view', []);
      await settle(1000);
      store.want('view', row(40, 300 + pan), 350);
      await settle(5000);
    }
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().state(row(40, 309))).toBe('failed');
    expect(store.getSnapshot().problem).toEqual({ kind: 'limit', limit: 'hour' });
    // the place in focus was loaded before and is still read
    expect(store.getSnapshot().sample(38.73, -9.14, nowSeconds(), POINT)).not.toBeNull();

    // five minutes after the refusal the view on screen is asked for, once
    await settle(4 * MINUTE_MS);
    expect(service.fetchPoints).toHaveBeenCalledTimes(3);
    expect(service.calls.at(-1)).toEqual(positions(row(40, 309)));
    expect(store.getSnapshot().problem).toBeNull();
  });

  it('does not ask on coming back to the front while the service says to wait', async () => {
    service.fail = httpError(429, { limit: 'day' });
    store.want('focus', LISBON);
    await settle();
    service.fail = null;
    // the screen comes on again and again
    for (let i = 0; i < 5; i++) {
      store.refresh(true);
      await settle(MINUTE_MS);
    }
    expect(service.fetchPoints).toHaveBeenCalledTimes(1);
    // after the half hour a daily refusal asks for, it does
    await settle(26 * MINUTE_MS);
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().state(LISBON)).toBe('ready');
  });

  it('tries again on coming back to the front after an ordinary failure', async () => {
    service.fail = new TypeError('Failed to fetch');
    store.want('focus', LISBON);
    await settle();
    service.fail = null;
    store.refresh(true);
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().state(LISBON)).toBe('ready');
  });

  it('can be told to try before the wait the service asked for is over', async () => {
    service.fail = httpError(429, { limit: 'day' });
    store.want('focus', LISBON);
    await settle();
    service.fail = null;
    store.retry();
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().state(LISBON)).toBe('ready');
  });

  it('forgets a failure nobody is asking about any more', async () => {
    service.fail = new TypeError('Failed to fetch');
    store.want('view', row(20));
    await settle();
    expect(store.getSnapshot().problem).not.toBeNull();

    store.want('view', []);
    await settle();
    expect(store.getSnapshot().problem).toBeNull();
  });

  it('asks again for what failed as soon as the service answers something else', async () => {
    service.fail = new TypeError('Failed to fetch');
    store.want('view', row(20));
    await settle();
    expect(store.getSnapshot().state(row(20))).toBe('failed');

    // the connection is back, and a place is tapped before the wait for the view is over
    service.fail = null;
    store.want('focus', LISBON);
    await settle();
    const wind = store.getSnapshot();
    expect(wind.state(LISBON)).toBe('ready');
    expect(wind.state(row(20))).toBe('ready');
    expect(wind.problem).toBeNull();
    expect(service.fetchPoints).toHaveBeenCalledTimes(3);
  });

  it('does not let one failed area hide that another one loaded, nor hammer the one that keeps failing', async () => {
    // the service answers everything except the request for the view
    const fetchPoints = service.fetchPoints;
    const picky = vi.fn(async (list) => {
      if (list.length === 20) throw httpError(500);
      return fetchPoints(list);
    });
    store.destroy();
    store = createWindStore({ fetchPoints: picky, storage });
    store.want('view', row(20));
    await settle();
    store.want('focus', LISBON);
    await settle();
    const wind = store.getSnapshot();
    expect(wind.state(LISBON)).toBe('ready');
    // the view is still missing, so the problem stands
    expect(wind.state(row(20))).toBe('failed');
    expect(wind.problem).toEqual({ kind: 'service' });
    // it was tried once more when the other request went through, and then left to its wait
    expect(picky).toHaveBeenCalledTimes(3);
    await settle(10000);
    expect(picky).toHaveBeenCalledTimes(3);
    await settle(6000);
    expect(picky).toHaveBeenCalledTimes(4);
  });
});

describe('reading the wind', () => {
  it('does not show the last hour as a later one, unless asked to', async () => {
    store.destroy();
    service = makeService(6); // hours 21:00 to 02:00
    store = newStore();
    store.want('focus', LISBON);
    await settle();
    const wind = store.getSnapshot();
    const lastHour = T0 + 2 * HOUR;

    expect(wind.sample(38.73, -9.14, lastHour).speed).toBeCloseTo(15, 6);
    expect(wind.sample(38.73, -9.14, lastHour + 600)).toBeNull();
    const standIn = wind.sample(38.73, -9.14, lastHour + 600, { late: true });
    expect(standIn.speed).toBeCloseTo(15, 6);
    expect(standIn.late).toBe(true);
  });

  it('reads a place only from points as fine as asked for', async () => {
    // only a coarse view is loaded: points 1 degree apart
    const coarse = nodesAround(3, 38.73, -9.14);
    store.want('view', coarse);
    await settle();
    const wind = store.getSnapshot();
    expect(wind.sample(38.73, -9.14, nowSeconds()).level).toBe(3);
    expect(wind.sample(38.73, -9.14, nowSeconds(), POINT)).toBeNull();
    expect(wind.sample(38.73, -9.14, nowSeconds(), { maxLevel: 2 })).toBeNull();
    expect(wind.sample(38.73, -9.14, nowSeconds(), { maxLevel: 3 })).not.toBeNull();

    // once the fine points are there they are preferred
    store.want('focus', LISBON);
    await settle();
    expect(store.getSnapshot().sample(38.73, -9.14, nowSeconds()).level).toBe(0);
    // a few kilometres away only the coarse ones are known
    expect(store.getSnapshot().sample(38.4, -9.6, nowSeconds()).level).toBe(3);
  });

  it('gives the same wind through a frame as point by point', async () => {
    store.want('view', nodesInBounds(0, { south: 38.6, north: 38.8, west: -9.3, east: -9.1 }));
    await settle();
    const wind = store.getSnapshot();
    const time = nowSeconds() + 5 * HOUR + 1234;
    const frame = wind.frame(time);
    expect(frame.time).toBe(time);
    for (const [lat, lng] of [[38.7, -9.2], [38.61, -9.29], [38.79, -9.11], [38.625, -9.25]]) {
      const single = wind.sample(lat, lng, time);
      const framed = frame.sample(lat, lng);
      expect(framed.speed).toBeCloseTo(single.speed, 9);
      expect(framed.u).toBeCloseTo(single.u, 9);
      expect(framed.v).toBeCloseTo(single.v, 9);
    }
    // nothing is drawn where nothing is loaded, or after the forecast ends
    expect(frame.sample(41.98, 2.82)).toBeNull();
    expect(wind.frame(nowSeconds() + 60 * HOUR).sample(38.7, -9.2)).toBeNull();
  });

  it('draws the map from a fresh coarse forecast rather than an old fine one', async () => {
    // a place looked at two hours ago, and not needed since
    store.want('focus', LISBON);
    await settle();
    store.want('focus', []);
    await settle(2 * HOUR * 1000);
    // the map is now zoomed out over it
    store.want('view', nodesAround(3, 38.73, -9.14));
    await settle();
    const wind = store.getSnapshot();

    expect(wind.frame(nowSeconds()).sample(38.73, -9.14).level).toBe(3);
    expect(wind.frame(nowSeconds()).sample(38.73, -9.14).fetchedAt).toBe(Date.now());
    // a reading for the place itself is still taken from the points around it
    expect(wind.sample(38.73, -9.14, nowSeconds(), POINT).fetchedAt).toBe(START);
  });

  it('draws the map from an old forecast when there is nothing fresher', async () => {
    store.want('focus', LISBON);
    await settle();
    store.want('focus', []);
    await settle(2 * HOUR * 1000);
    const drawn = store.getSnapshot().frame(nowSeconds()).sample(38.73, -9.14);
    expect(drawn.level).toBe(0);
    expect(drawn.fetchedAt).toBe(START);
  });

  it('knows the time zone of the nearest loaded point', async () => {
    expect(store.getSnapshot().zoneAt(38.73, -9.14)).toBeNull();
    store.want('focus', [...LISBON, ...nodesAround(0, 41.98, 2.82)]);
    await settle();
    const wind = store.getSnapshot();
    expect(wind.zoneAt(38.73, -9.14)).toBe('Europe/Lisbon');
    expect(wind.zoneAt(41.98, 2.82)).toBe('Europe/Madrid');
    expect(wind.zoneAt(-33.9, 151.2)).toBeNull();
  });

  it('takes the zone from the nearest of the four points when they disagree', async () => {
    // the stand-in service puts the border at 6 degrees west: this cell straddles it
    const nodes = nodesAround(0, 40.05, -6.05);
    store.want('focus', nodes);
    await settle();
    const wind = store.getSnapshot();
    expect(wind.zoneAt(40.05, -6.12)).toBe('Europe/Lisbon');
    expect(wind.zoneAt(40.05, -6.01)).toBe('Europe/Madrid');
  });

  it('counts a point the service had no wind for as there, with nothing to read', async () => {
    store.destroy();
    service = makeService(0);
    store = newStore();
    store.want('focus', LISBON);
    await settle();
    const wind = store.getSnapshot();
    expect(wind.state(LISBON)).toBe('ready');
    expect(wind.sample(38.73, -9.14, nowSeconds())).toBeNull();
    // and it is not asked for again until it would be stale anyway
    store.want('focus', LISBON);
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(1);
  });
});

describe('the copy kept on the device', () => {
  it('is written after a download and read back by the next store', async () => {
    store.want('focus', LISBON);
    await settle();
    expect(storage.data[STORAGE_KEY]).toBeUndefined();
    await settle(1500);
    expect(JSON.parse(storage.data[STORAGE_KEY]).points).toHaveLength(4);

    const next = newStore();
    const wind = next.getSnapshot();
    expect(wind.state(LISBON)).toBe('ready');
    expect(wind.sample(38.73, -9.14, START / 1000, POINT).speed).toBeCloseTo(10 + 10 / 3, 6);
    expect(wind.zoneAt(38.73, -9.14)).toBe('Europe/Lisbon');
    // what it read back is still fresh: no request
    next.want('focus', LISBON);
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(1);
    next.destroy();
  });

  it('shows the saved forecast on the next start and renews it when it is stale', async () => {
    store.want('focus', LISBON);
    await settle(1500);

    await settle(3 * HOUR * 1000);
    const next = newStore();
    expect(next.getSnapshot().sample(38.73, -9.14, nowSeconds(), POINT).fetchedAt).toBe(START);
    next.want('focus', LISBON);
    await settle();
    expect(service.fetchPoints).toHaveBeenCalledTimes(2);
    expect(next.getSnapshot().sample(38.73, -9.14, nowSeconds(), POINT).fetchedAt).toBe(Date.now());
    next.destroy();
  });

  it('ignores a saved forecast whose last hour has passed', async () => {
    store.want('focus', LISBON);
    await settle(1500);
    await settle(72 * HOUR * 1000);
    const next = newStore();
    expect(next.getSnapshot().state(LISBON)).toBe('loading');
    expect(next.getSnapshot().sample(38.73, -9.14, nowSeconds(), { late: true })).toBeNull();
    next.destroy();
  });

  it('saves what the app is showing first when there is more than fits', async () => {
    store.want('view', row(300, 200));
    await settle();
    store.want('view', []);
    store.want('focus', LISBON);
    await settle(1500);
    const saved = JSON.parse(storage.data[STORAGE_KEY]).points;
    expect(saved).toHaveLength(260);
    const keys = saved.map(([level, r, c]) => nodeKey(level, r, c));
    for (const node of LISBON) expect(keys.slice(0, 4)).toContain(nodeKey(node.level, node.row, node.col));
  });

  it('keeps the readable points of a saved copy that is partly damaged', async () => {
    store.want('focus', LISBON);
    await settle(1500);
    const saved = JSON.parse(storage.data[STORAGE_KEY]);
    saved.points.splice(1, 0, null, 'x', [0, 1], [0, 309, -74, T0, 'Europe/Lisbon', START, [1, 2], [1], [1, 2], [1, 2], [1, 2]]);
    const next = createWindStore({ fetchPoints: service.fetchPoints, storage: memoryStorage({ [STORAGE_KEY]: JSON.stringify(saved) }) });
    expect(next.getSnapshot().state(LISBON)).toBe('ready');
    expect(next.getSnapshot().sample(38.73, -9.14, START / 1000, POINT).speed).toBeCloseTo(10 + 10 / 3, 6);
    next.destroy();
  });

  it('starts empty when what was saved cannot be read', () => {
    for (const bad of ['not json', '{"v":1}', '{"v":2,"points":[]}', '{"v":1,"points":[[0,1],"x",null]}', 'null']) {
      const broken = createWindStore({ fetchPoints: service.fetchPoints, storage: memoryStorage({ [STORAGE_KEY]: bad }) });
      expect(broken.getSnapshot().sample(38.73, -9.14, nowSeconds())).toBeNull();
      broken.destroy();
    }
  });

  it('works without storage', async () => {
    const failing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const bare = createWindStore({ fetchPoints: service.fetchPoints, storage: failing });
    bare.want('focus', LISBON);
    await settle(2000);
    expect(bare.getSnapshot().sample(38.73, -9.14, nowSeconds(), POINT)).not.toBeNull();
    bare.destroy();
  });

  it('clears the single-area forecast that earlier versions left behind', () => {
    const old = memoryStorage({ 'wind-forecast-v2': '{"hours":[]}', 'wind-theme': 'light' });
    createWindStore({ fetchPoints: service.fetchPoints, storage: old }).destroy();
    expect('wind-forecast-v2' in old.data).toBe(false);
    expect(old.data['wind-theme']).toBe('light');
  });
});

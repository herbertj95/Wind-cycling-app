import { useEffect, useState, useSyncExternalStore } from 'react';
import { fetchPoints } from '../utils/weatherApi';
import { createWindStore } from '../utils/windStore';

// One store for the life of the app: what has been downloaded is shared by the map, the readout and the route.
const windStore = createWindStore({ fetchPoints });

/**
 * The downloaded wind: `store` takes the orders, `wind` is what it holds right now (see windStore).
 * `wind` is a new object whenever points arrive, expire or fail, so it can stand in the dependency
 * lists of whatever is worked out from it.
 * While the app is in front the store is told every minute to renew what has gone stale, and failed
 * downloads are tried again as soon as the app comes back to the front or the connection returns.
 */
export function useWind() {
  const wind = useSyncExternalStore(windStore.subscribe, windStore.getSnapshot);

  useEffect(() => {
    const tick = () => document.visibilityState === 'visible' && windStore.refresh();
    const timer = setInterval(tick, 60000);
    const onVisible = () => document.visibilityState === 'visible' && windStore.refresh(true);
    const onOnline = () => windStore.retry();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  return { store: windStore, wind };
}

/**
 * Current time in ms, refreshed every minute so "now" keeps up with the clock by itself.
 */
export function useNow(intervalMs = 60000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, intervalMs);
    // timers are throttled while the app is in the background, so catch up when it returns
    const onVisible = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
  return now;
}

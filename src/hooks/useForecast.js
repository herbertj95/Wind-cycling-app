import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchForecast, loadCachedForecast } from '../utils/weatherApi';

const REFRESH_MS = 30 * 60 * 1000;

/**
 * Keeps the forecast fresh: loads it on start, every half hour, when the app comes back to the front
 * and as soon as the connection returns.
 * While a request fails, the last forecast saved on this device keeps being shown and `error` says why.
 */
export function useForecast() {
  const [state, setState] = useState(() => ({ forecast: loadCachedForecast(), error: null, loading: true }));
  const lastAttempt = useRef(0);
  const lastFailed = useRef(false);

  const load = useCallback(async () => {
    lastAttempt.current = Date.now();
    try {
      const forecast = await fetchForecast();
      lastFailed.current = false;
      setState({ forecast, error: null, loading: false });
    } catch (error) {
      lastFailed.current = true;
      setState((prev) => ({ forecast: prev.forecast, error: error.message || 'Network error', loading: false }));
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // after a failure try again straight away; otherwise only once the forecast is getting old
      if (lastFailed.current || Date.now() - lastAttempt.current > REFRESH_MS) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', load);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', load);
    };
  }, [load]);

  const retry = useCallback(() => {
    setState((prev) => ({ ...prev, loading: true }));
    load();
  }, [load]);

  return { ...state, retry };
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

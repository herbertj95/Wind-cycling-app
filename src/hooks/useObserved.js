import { useEffect, useMemo, useState } from 'react';
import { fetchObservations, inIpmaArea, loadObservations, nearestStation, saveObservations } from '../utils/ipma';

// IPMA publishes once an hour. Its file is asked for again when the copy here is this old, and after a
// failure once this long has passed.
const REFRESH_MS = 20 * 60000;
const RETRY_MS = 5 * 60000;

// One copy for the life of the app, whichever place is in focus; it starts from the one kept on the device
const kept = loadObservations();
const held = { stations: kept?.stations ?? null, at: kept?.at ?? 0, triedAt: 0, loading: null };

/**
 * The weather station nearest to a position, with the wind it last measured: { name, km, time, speed,
 * from } (see nearestStation), or null when there is none in range, nothing has been downloaded yet,
 * or `wanted` is false. Only stations whose last reading is from `since` (unix seconds) on are looked at.
 * The measurements are only downloaded for positions where IPMA has stations, and only while the app
 * is in front. A download that fails is tried again later without a word: this is an extra, and the
 * readout is complete without it.
 */
export function useObserved(lat, lng, wanted, since = 0) {
  const [stations, setStations] = useState(held.stations);
  const inArea = wanted && Number.isFinite(lat) && Number.isFinite(lng) && inIpmaArea(lat, lng);

  useEffect(() => {
    if (!inArea) return undefined;
    let alive = true;
    const renew = () => {
      const now = Date.now();
      if (document.visibilityState !== 'visible' || held.loading) return;
      if (now - held.at < REFRESH_MS || now - held.triedAt < RETRY_MS) return;
      held.triedAt = now;
      held.loading = fetchObservations()
        .then((list) => {
          held.stations = list;
          held.at = Date.now();
          saveObservations(list, held.at);
        })
        .catch(() => {
          // the readout simply goes without the measurement
        })
        .finally(() => {
          held.loading = null;
        });
    };
    // whoever started the download, this place takes over what it brought
    const adopt = () => held.loading?.then(() => alive && setStations(held.stations));
    const tick = () => {
      renew();
      // a download that finished while this place was not asking is taken over too
      if (alive) setStations(held.stations);
      adopt();
    };
    tick();
    const timer = setInterval(tick, 60000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [inArea]);

  return useMemo(
    () => (inArea && stations ? nearestStation(stations.filter((s) => s.time >= since), lat, lng) : null),
    [inArea, stations, lat, lng, since],
  );
}

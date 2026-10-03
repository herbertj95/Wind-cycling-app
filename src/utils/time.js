// Forecast times are shown in Lisbon time, whatever the device is set to.

const ZONE = 'Europe/Lisbon';
const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, weekday: 'short', day: 'numeric' });
const hourFormat = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' });
const hourOfDayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: 'numeric', hourCycle: 'h23' });

/** "Sat 3" for a unix time in seconds */
export const formatDay = (unixSeconds) => dayFormat.format(unixSeconds * 1000);

/** "19:00" for a unix time in seconds */
export const formatClock = (unixSeconds) => hourFormat.format(unixSeconds * 1000);

/** "Sat 3, 19:00" */
export const formatDayClock = (unixSeconds) => `${formatDay(unixSeconds)}, ${formatClock(unixSeconds)}`;

/** Hour of the day in Lisbon, 0 to 23 */
export const lisbonHour = (unixSeconds) => Number(hourOfDayFormat.format(unixSeconds * 1000));

/** "2 h 30 min" for a duration in hours */
export function formatDuration(hours) {
  const minutes = Math.round(hours * 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

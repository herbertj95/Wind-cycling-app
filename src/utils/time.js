// Forecast times are shown in the local time of the place they are for, whatever the device is set to.

export const DEVICE_ZONE = new Intl.DateTimeFormat().resolvedOptions().timeZone;

const formats = new Map();

function build(zone) {
  return {
    day: new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric' }),
    clock: new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' }),
    parts: new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }),
  };
}

// Formatters for a zone (an IANA name such as "Europe/Lisbon"). No zone, or a name this device does not
// know, gives the device's own zone.
function formatsFor(zone) {
  const name = zone || DEVICE_ZONE;
  let entry = formats.get(name);
  if (entry === undefined) {
    try {
      entry = build(name);
    } catch {
      entry = null;
    }
    formats.set(name, entry);
  }
  if (entry) return entry;
  return name === DEVICE_ZONE ? build(undefined) : formatsFor(DEVICE_ZONE);
}

/** The zone name if this device can format times in it, otherwise null. */
export function validZone(zone) {
  if (typeof zone !== 'string' || zone === '') return null;
  formatsFor(zone);
  return formats.get(zone) ? zone : null;
}

/** "Sat 3" for a unix time in seconds */
export const formatDay = (unixSeconds, zone) => formatsFor(zone).day.format(unixSeconds * 1000);

/** "19:00" for a unix time in seconds */
export const formatClock = (unixSeconds, zone) => formatsFor(zone).clock.format(unixSeconds * 1000);

/** "Sat 3, 19:00" */
export const formatDayClock = (unixSeconds, zone) => `${formatDay(unixSeconds, zone)}, ${formatClock(unixSeconds, zone)}`;

/** Seconds the zone is ahead of UTC at that moment (3600 for Lisbon in summer, 19800 for India). */
export function zoneOffset(unixSeconds, zone) {
  const whole = Math.floor(unixSeconds);
  const parts = {};
  formatsFor(zone).parts.formatToParts(whole * 1000).forEach((p) => {
    parts[p.type] = Number(p.value);
  });
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000 - whole;
}

/** Start of the local hour that contains a moment, in unix seconds. Not a whole UTC hour where clocks run 30 or 45 minutes off. */
export function hourStart(unixSeconds, zone) {
  const offset = zoneOffset(unixSeconds, zone);
  return Math.floor((unixSeconds + offset) / 3600) * 3600 - offset;
}

/** Hour of the day in the zone, 0 to 23 */
export function hourOfDay(unixSeconds, zone) {
  const local = Math.floor(unixSeconds) + zoneOffset(unixSeconds, zone);
  return Math.floor((((local % 86400) + 86400) % 86400) / 3600);
}

/**
 * "GMT+2" when the zone's clock differs from this device's at that moment, otherwise an empty string:
 * a time is only labelled with its zone when it could be mistaken for the reader's own.
 */
export function zoneLabel(unixSeconds, zone) {
  const offset = zoneOffset(unixSeconds, zone);
  if (offset === zoneOffset(unixSeconds, DEVICE_ZONE)) return '';
  const minutes = Math.round(Math.abs(offset) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `GMT${offset < 0 ? '-' : '+'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** "2 h 30 min" for a duration in hours */
export function formatDuration(hours) {
  const minutes = Math.round(hours * 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

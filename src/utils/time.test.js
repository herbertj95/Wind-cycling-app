import { describe, it, expect } from 'vitest';
import { DEVICE_ZONE, formatClock, formatDay, formatDayClock, formatDuration, hourOfDay, hourStart, validZone, zoneLabel, zoneOffset } from './time';

// Saturday 3 October 2026, 18:42:10 UTC. Lisbon is on summer time (UTC+1), Madrid on UTC+2.
const MOMENT = Date.UTC(2026, 9, 3, 18, 42, 10) / 1000;
// Thursday 15 January 2026, 12:00 UTC: winter time
const WINTER = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
const HOUR = 3600;

describe('formatting in the time of a place', () => {
  it('shows the clock of the zone asked for, not of the device', () => {
    expect(formatClock(MOMENT, 'Europe/Lisbon')).toBe('19:42');
    expect(formatClock(MOMENT, 'Europe/Madrid')).toBe('20:42');
    expect(formatClock(MOMENT, 'Asia/Tokyo')).toBe('03:42');
    expect(formatClock(MOMENT, 'America/Bogota')).toBe('13:42');
    expect(formatClock(MOMENT, 'Asia/Kathmandu')).toBe('00:27');
  });

  it('shows the day of the zone too', () => {
    expect(formatDay(MOMENT, 'Europe/Lisbon')).toBe('Sat 3');
    // already Sunday in Tokyo
    expect(formatDay(MOMENT, 'Asia/Tokyo')).toBe('Sun 4');
    expect(formatDayClock(MOMENT, 'Asia/Tokyo')).toBe('Sun 4, 03:42');
    expect(formatDayClock(MOMENT, 'Europe/Lisbon')).toBe('Sat 3, 19:42');
  });

  it('understands the zone names Open-Meteo gives to points at sea', () => {
    // "Etc/GMT+3" is three hours BEHIND Greenwich
    expect(formatClock(MOMENT, 'Etc/GMT+3')).toBe('15:42');
    expect(formatClock(MOMENT, 'GMT')).toBe('18:42');
  });

  it('falls back on the device zone without a zone or with one it does not know', () => {
    const own = formatDayClock(MOMENT, DEVICE_ZONE);
    expect(formatDayClock(MOMENT)).toBe(own);
    expect(formatDayClock(MOMENT, null)).toBe(own);
    expect(formatDayClock(MOMENT, '')).toBe(own);
    expect(formatDayClock(MOMENT, 'Mars/Olympus_Mons')).toBe(own);
  });
});

describe('validZone', () => {
  it('accepts the names this device can format', () => {
    expect(validZone('Europe/Lisbon')).toBe('Europe/Lisbon');
    expect(validZone('Asia/Kathmandu')).toBe('Asia/Kathmandu');
    expect(validZone('Etc/GMT+3')).toBe('Etc/GMT+3');
    expect(validZone(DEVICE_ZONE)).toBe(DEVICE_ZONE);
  });

  it('refuses anything else', () => {
    expect(validZone('Mars/Olympus_Mons')).toBeNull();
    expect(validZone('')).toBeNull();
    expect(validZone(null)).toBeNull();
    expect(validZone(undefined)).toBeNull();
    expect(validZone(3600)).toBeNull();
  });
});

describe('zoneOffset', () => {
  it('is the seconds a zone is ahead of UTC at that moment', () => {
    expect(zoneOffset(MOMENT, 'Europe/Lisbon')).toBe(3600);
    expect(zoneOffset(MOMENT, 'Europe/Madrid')).toBe(7200);
    expect(zoneOffset(MOMENT, 'America/Bogota')).toBe(-18000);
    expect(zoneOffset(MOMENT, 'Etc/GMT+3')).toBe(-10800);
    expect(zoneOffset(MOMENT, 'GMT')).toBe(0);
  });

  it('follows summer and winter time', () => {
    expect(zoneOffset(WINTER, 'Europe/Lisbon')).toBe(0);
    expect(zoneOffset(WINTER, 'Europe/Madrid')).toBe(3600);
  });

  it('knows the zones that run 30 and 45 minutes off', () => {
    expect(zoneOffset(MOMENT, 'Asia/Kolkata')).toBe(19800);
    expect(zoneOffset(MOMENT, 'Asia/Kathmandu')).toBe(20700);
  });

  it('copes with a moment that is not a whole second', () => {
    expect(zoneOffset(MOMENT + 0.123, 'Europe/Lisbon')).toBe(3600);
  });
});

describe('hourStart', () => {
  it('is the whole UTC hour for zones a whole number of hours from Greenwich', () => {
    const start = Date.UTC(2026, 9, 3, 18, 0, 0) / 1000;
    expect(hourStart(MOMENT, 'Europe/Lisbon')).toBe(start);
    expect(hourStart(MOMENT, 'Asia/Tokyo')).toBe(start);
    expect(hourStart(start, 'Europe/Lisbon')).toBe(start);
    expect(hourStart(start + HOUR - 1, 'Europe/Lisbon')).toBe(start);
  });

  it('is the local hour where clocks run 30 minutes off: 18:42 UTC is 00:12 in India, in the hour from 18:30 UTC', () => {
    expect(hourStart(MOMENT, 'Asia/Kolkata')).toBe(Date.UTC(2026, 9, 3, 18, 30, 0) / 1000);
    expect(formatClock(hourStart(MOMENT, 'Asia/Kolkata'), 'Asia/Kolkata')).toBe('00:00');
  });

  it('is the local hour where clocks run 45 minutes off: 18:42 UTC is 00:27 in Nepal, in the hour from 18:15 UTC', () => {
    expect(hourStart(MOMENT, 'Asia/Kathmandu')).toBe(Date.UTC(2026, 9, 3, 18, 15, 0) / 1000);
    expect(formatClock(hourStart(MOMENT, 'Asia/Kathmandu'), 'Asia/Kathmandu')).toBe('00:00');
  });
});

describe('hourOfDay', () => {
  it('is the hour on the clock of the zone, 0 to 23', () => {
    expect(hourOfDay(MOMENT, 'Europe/Lisbon')).toBe(19);
    expect(hourOfDay(MOMENT, 'Asia/Tokyo')).toBe(3);
    expect(hourOfDay(MOMENT, 'America/Bogota')).toBe(13);
    expect(hourOfDay(MOMENT, 'Asia/Kathmandu')).toBe(0);
  });

  it('is 0 at local midnight, which is where the time bar starts a new day', () => {
    const lisbonMidnight = Date.UTC(2026, 9, 3, 23, 0, 0) / 1000;
    expect(hourOfDay(lisbonMidnight, 'Europe/Lisbon')).toBe(0);
    expect(hourOfDay(lisbonMidnight - HOUR, 'Europe/Lisbon')).toBe(23);
    expect(hourOfDay(lisbonMidnight, 'Europe/Madrid')).toBe(1);
  });
});

describe('zoneLabel', () => {
  it('says nothing about the device\'s own zone', () => {
    expect(zoneLabel(MOMENT, DEVICE_ZONE)).toBe('');
    expect(zoneLabel(MOMENT)).toBe('');
  });

  it('names the offset of a zone whose clock differs from the device\'s', () => {
    const ownOffset = zoneOffset(MOMENT, DEVICE_ZONE);
    const cases = [
      ['Asia/Tokyo', 32400, 'GMT+9'],
      ['America/Bogota', -18000, 'GMT-5'],
      ['Asia/Kathmandu', 20700, 'GMT+5:45'],
      ['Asia/Kolkata', 19800, 'GMT+5:30'],
      ['Europe/Madrid', 7200, 'GMT+2'],
      ['GMT', 0, 'GMT+0'],
    ];
    for (const [zone, offset, label] of cases) {
      expect(zoneLabel(MOMENT, zone), zone).toBe(offset === ownOffset ? '' : label);
    }
  });

  it('says nothing about another zone that happens to show the same time', () => {
    // whatever the device zone is, a fixed-offset zone with its current offset reads the same clock
    const hours = zoneOffset(MOMENT, DEVICE_ZONE) / 3600;
    if (!Number.isInteger(hours)) return;
    const twin = hours === 0 ? 'Etc/GMT' : `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
    expect(zoneLabel(MOMENT, twin)).toBe('');
  });
});

describe('formatDuration', () => {
  it('writes minutes, hours, or both', () => {
    expect(formatDuration(0.5)).toBe('30 min');
    expect(formatDuration(2)).toBe('2 h');
    expect(formatDuration(2.5)).toBe('2 h 30 min');
    expect(formatDuration(0)).toBe('0 min');
  });

  it('rounds to the minute and carries a full hour over', () => {
    expect(formatDuration(1.999)).toBe('2 h');
    expect(formatDuration(1.26)).toBe('1 h 16 min');
    expect(formatDuration(59.6 / 60)).toBe('1 h');
  });
});

import { describe, it, expect } from 'vitest';
import { DEVICE_ZONE, clockHour, formatClock, formatDay, formatDayClock, formatDuration, hourStart, validZone, zoneLabel, zoneOffset } from './time';

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

describe('the days of a run of hours', () => {
  // what the time bar does: a bar opens a new day when its date differs from the bar before it
  const dayStarts = (from, count, zone) => {
    const starts = [];
    let previous = formatDay(hourStart(from, zone), zone);
    for (let i = 1; i < count; i++) {
      const time = hourStart(from, zone) + i * HOUR;
      const day = formatDay(time, zone);
      if (day !== previous) starts.push(`${day} ${formatClock(time, zone)}`);
      previous = day;
    }
    return starts;
  };

  it('opens each day at local midnight', () => {
    expect(dayStarts(MOMENT, 48, 'Europe/Lisbon')).toEqual(['Sun 4 00:00', 'Mon 5 00:00']);
    expect(dayStarts(MOMENT, 48, 'Asia/Tokyo')).toEqual(['Mon 5 00:00', 'Tue 6 00:00']);
    // 18:42 UTC is 00:27 on Sunday in Nepal: the 48 hours from 00:00 hold one more midnight
    expect(dayStarts(MOMENT, 48, 'Asia/Kathmandu')).toEqual(['Mon 5 00:00']);
  });

  it('opens each day once where clocks go back at midnight: the Azores have two hours called 00:00 that night', () => {
    const before = Date.UTC(2026, 9, 24, 20, 0, 0) / 1000;
    expect(dayStarts(before, 30, 'Atlantic/Azores')).toEqual(['Sun 25 00:00', 'Mon 26 00:00']);
  });

  it('still opens the day where clocks go forward at midnight and there is no 00:00: Santiago, Cairo', () => {
    expect(dayStarts(Date.UTC(2026, 8, 5, 20, 0, 0) / 1000, 30, 'America/Santiago')).toEqual(['Sun 6 01:00']);
    expect(dayStarts(Date.UTC(2027, 3, 29, 12, 0, 0) / 1000, 30, 'Africa/Cairo')).toEqual(['Fri 30 01:00']);
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

describe('clockHour', () => {
  // 2026-10-05 12:00 UTC
  const noon = Date.UTC(2026, 9, 5, 12) / 1000;

  it('is the hour on the clock of the zone, not of UTC', () => {
    expect(clockHour(noon, 'UTC')).toBe(12);
    expect(clockHour(noon, 'Europe/Lisbon')).toBe(13); // summer time
    expect(clockHour(noon, 'America/New_York')).toBe(8);
    expect(clockHour(noon, 'Asia/Tokyo')).toBe(21);
  });

  it('goes round at midnight, on either side of UTC', () => {
    expect(clockHour(noon + 3 * 3600, 'Asia/Tokyo')).toBe(0);
    expect(clockHour(noon - 12 * 3600 - 1, 'UTC')).toBe(23);
    expect(clockHour(noon - 9 * 3600, 'America/New_York')).toBe(23);
  });

  it('counts whole hours where clocks run half an hour off, and through the minutes of an hour', () => {
    // India is 5:30 ahead: 12:00 UTC is 17:30 there
    expect(clockHour(noon, 'Asia/Kolkata')).toBe(17);
    expect(clockHour(noon + 1800, 'Asia/Kolkata')).toBe(18);
    expect(clockHour(noon + 3599, 'UTC')).toBe(12);
  });

  it('follows the change of clocks', () => {
    // Lisbon goes back an hour on 25 October 2026 at 01:00 UTC
    expect(clockHour(Date.UTC(2026, 9, 25, 0, 30) / 1000, 'Europe/Lisbon')).toBe(1);
    expect(clockHour(Date.UTC(2026, 9, 25, 1, 30) / 1000, 'Europe/Lisbon')).toBe(1);
    expect(clockHour(Date.UTC(2026, 9, 25, 2, 30) / 1000, 'Europe/Lisbon')).toBe(2);
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

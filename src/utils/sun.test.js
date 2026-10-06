import { describe, it, expect } from 'vitest';
import { sunAltitude, isDaylight, isRidingLight, darkChecks } from './sun';

const utc = (text) => Date.parse(`${text}Z`) / 1000;
const LISBON = [38.72, -9.14];
const MINUTE = 60;

describe('sunAltitude', () => {
  it('is on the horizon at the times of sunrise and sunset another calculator gives for Lisbon', () => {
    // times in UTC as sunrise-sunset.org gave them for 38.72, -9.14 (looked up in October 2026)
    const onHorizon = [
      '2026-06-21T05:10', // sunrise on the longest day, 06:10 summer time
      '2026-06-21T20:06', // sunset
      '2026-12-21T07:49', // sunrise on the shortest day
      '2026-12-21T17:20', // sunset
      '2026-03-20T06:38', // sunrise at the equinox
      '2026-03-20T18:50', // sunset
    ];
    for (const moment of onHorizon) {
      // the sun climbs about a degree in five minutes there: within a degree is within five minutes
      expect(Math.abs(sunAltitude(utc(moment), ...LISBON) + 0.833)).toBeLessThan(1);
    }
  });

  it('stands highest at local noon, as high as the latitude and the season say', () => {
    // at the June solstice the sun is 23.44 degrees north: 90 - 38.72 + 23.44 = 74.72 over Lisbon
    let highest = -90;
    for (let t = utc('2026-06-21T11:00'); t <= utc('2026-06-21T14:00'); t += MINUTE) {
      highest = Math.max(highest, sunAltitude(t, ...LISBON));
    }
    expect(highest).toBeCloseTo(74.72, 0);
    // and at the December solstice 90 - 38.72 - 23.44 = 27.84
    let lowest = -90;
    for (let t = utc('2026-12-21T11:00'); t <= utc('2026-12-21T14:00'); t += MINUTE) {
      lowest = Math.max(lowest, sunAltitude(t, ...LISBON));
    }
    expect(lowest).toBeCloseTo(27.84, 0);
  });

  it('is almost overhead on the equator at noon of the equinox', () => {
    expect(sunAltitude(utc('2026-03-20T12:07'), 0, 0)).toBeGreaterThan(89);
    // and the same moment is the middle of the night on the other side of the world
    expect(sunAltitude(utc('2026-03-20T12:07'), 0, 180)).toBeLessThan(-89);
  });

  it('follows the longitude: the sun is up in Tokyo while Lisbon still sleeps', () => {
    const moment = utc('2026-10-05T01:00');
    expect(sunAltitude(moment, 35.68, 139.69)).toBeGreaterThan(30);
    expect(sunAltitude(moment, ...LISBON)).toBeLessThan(-30);
  });
});

describe('isDaylight', () => {
  it('tells day from night through an October day in Lisbon', () => {
    // sunrise about 07:36 and sunset about 19:14 summer time, an hour ahead of UTC
    expect(isDaylight(utc('2026-10-05T05:00'), ...LISBON)).toBe(false);
    expect(isDaylight(utc('2026-10-05T06:20'), ...LISBON)).toBe(false);
    expect(isDaylight(utc('2026-10-05T07:00'), ...LISBON)).toBe(true);
    expect(isDaylight(utc('2026-10-05T12:00'), ...LISBON)).toBe(true);
    expect(isDaylight(utc('2026-10-05T18:00'), ...LISBON)).toBe(true);
    expect(isDaylight(utc('2026-10-05T18:30'), ...LISBON)).toBe(false);
    expect(isDaylight(utc('2026-10-05T23:00'), ...LISBON)).toBe(false);
  });

  it('holds for any moment, also one that is not a whole hour', () => {
    expect(isDaylight(utc('2026-10-05T06:10:30'), ...LISBON)).toBe(false);
    expect(isDaylight(utc('2026-10-05T06:59:59'), ...LISBON)).toBe(true);
  });

  it('has no day in the polar night and no night under the midnight sun', () => {
    const tromso = [69.65, 18.96];
    for (let hour = 0; hour < 24; hour++) {
      const clock = String(hour).padStart(2, '0');
      expect(isDaylight(utc(`2026-12-21T${clock}:00`), ...tromso)).toBe(false);
      expect(isDaylight(utc(`2026-06-21T${clock}:00`), ...tromso)).toBe(true);
    }
  });
});

describe('isRidingLight', () => {
  it('lasts through civil twilight, half an hour or so either side of the sun on the horizon', () => {
    // an October day in Lisbon: the sun is up from about 06:36 to 18:14 UTC, and the sky light from about
    // 06:10 to 18:40
    expect(isRidingLight(utc('2026-10-05T06:00'), ...LISBON)).toBe(false);
    expect(isRidingLight(utc('2026-10-05T06:20'), ...LISBON)).toBe(true);
    expect(isRidingLight(utc('2026-10-05T18:30'), ...LISBON)).toBe(true);
    expect(isRidingLight(utc('2026-10-05T18:50'), ...LISBON)).toBe(false);
  });
});

describe('darkChecks', () => {
  // Lisbon to Cascais, about 24.5 km: an hour at 25 km/h
  const route = {
    totalDistance: 24.5,
    points: [{ lat: 38.72, lng: -9.14, distance: 0 }, { lat: 38.7, lng: -9.42, distance: 24.5 }],
  };
  // 100 km there and back, past the end of the light
  const long = { totalDistance: 100, points: [{ lat: 38.72, lng: -9.14, distance: 0 }, { lat: 38.72, lng: -9.14, distance: 100 }] };

  it('finds no dark on a ride in the light from start to finish', () => {
    expect(darkChecks(route, utc('2026-10-05T08:00'), 25)).toBe(0);
    expect(darkChecks(route, utc('2026-10-05T17:30'), 25)).toBe(0);
  });

  it('notices a ride that sets off in the dark, or that the dark catches up with', () => {
    expect(darkChecks(route, utc('2026-10-05T05:00'), 25)).toBe(2);
    expect(darkChecks(route, utc('2026-10-05T06:00'), 25)).toBe(1);
    expect(darkChecks(route, utc('2026-10-05T18:00'), 25)).toBe(1);
  });

  it('looks at every full hour of a long ride, and counts how much of it is in the dark', () => {
    // 5 hours at 20 km/h from 16:00 UTC: at 16, 17, 18, 19, 20 and 21; the last three are dark
    expect(darkChecks(long, utc('2026-10-05T16:00'), 20)).toBe(3);
    expect(darkChecks(long, utc('2026-10-05T08:00'), 20)).toBe(0);
  });

  it('looks where the rider is at each of those moments', () => {
    // setting off in Lisbon at noon and finishing an hour later on the far side of the world, where it is night
    const far = { totalDistance: 20, points: [{ lat: 38.72, lng: -9.14, distance: 0 }, { lat: -38.72, lng: 170.86, distance: 20 }] };
    expect(darkChecks(far, utc('2026-10-05T12:00'), 20)).toBe(1);
  });
});

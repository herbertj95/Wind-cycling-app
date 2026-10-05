import { describe, it, expect } from 'vitest';
import { WET_MM, LIKELY_PERCENT, isWet, rainLevel, formatRain, describeRain } from './rain';

describe('isWet', () => {
  it('counts an hour as wet from a tenth of a millimetre', () => {
    expect(WET_MM).toBe(0.1);
    expect(isWet(0)).toBe(false);
    expect(isWet(0.05)).toBe(false);
    expect(isWet(0.1)).toBe(true);
    expect(isWet(3)).toBe(true);
  });

  it('does not count an amount the forecast does not give', () => {
    expect(isWet(NaN)).toBe(false);
    expect(isWet(undefined)).toBe(false);
    expect(isWet(null)).toBe(false);
  });
});

describe('rainLevel', () => {
  it('goes from none through light and moderate to heavy', () => {
    expect(rainLevel(0)).toBe('none');
    expect(rainLevel(0.09)).toBe('none');
    expect(rainLevel(0.1)).toBe('light');
    expect(rainLevel(2.4)).toBe('light');
    expect(rainLevel(2.5)).toBe('moderate');
    expect(rainLevel(7.4)).toBe('moderate');
    expect(rainLevel(7.5)).toBe('heavy');
    expect(rainLevel(30)).toBe('heavy');
  });

  it('is none for an unknown amount', () => {
    expect(rainLevel(NaN)).toBe('none');
  });
});

describe('formatRain', () => {
  it('keeps one decimal under 10 mm and none above', () => {
    expect(formatRain(0.1)).toBe('0.1');
    expect(formatRain(0.44)).toBe('0.4');
    expect(formatRain(2)).toBe('2.0');
    expect(formatRain(9.94)).toBe('9.9');
    expect(formatRain(10)).toBe('10');
    expect(formatRain(12.6)).toBe('13');
  });
});

describe('describeRain', () => {
  it('says how hard it rains, how much and how likely', () => {
    expect(describeRain(0.4, 60)).toBe('Light rain, 0.4 mm/h (60% chance)');
    expect(describeRain(3.2, 85.4)).toBe('Moderate rain, 3.2 mm/h (85% chance)');
    expect(describeRain(12, 97)).toBe('Heavy rain, 12 mm/h (97% chance)');
  });

  it('calls an amount that few runs of the model agree on only possible', () => {
    expect(describeRain(0.4, 3)).toBe('Light rain possible, 0.4 mm/h (3% chance)');
    expect(describeRain(3, 29)).toBe('Moderate rain possible, 3.0 mm/h (29% chance)');
    expect(describeRain(3, 30)).toBe('Moderate rain, 3.0 mm/h (30% chance)');
    expect(describeRain(9, 0)).toBe('Heavy rain possible, 9.0 mm/h (0% chance)');
  });

  it('leaves the chance out when the forecast does not give one', () => {
    expect(describeRain(0.4, NaN)).toBe('Light rain, 0.4 mm/h');
    expect(describeRain(0.4, undefined)).toBe('Light rain, 0.4 mm/h');
  });

  it('mentions a real chance of rain in an hour with no amount forecast', () => {
    expect(LIKELY_PERCENT).toBe(30);
    expect(describeRain(0, 30)).toBe('30% chance of rain');
    expect(describeRain(0.05, 55)).toBe('55% chance of rain');
    expect(describeRain(NaN, 40)).toBe('40% chance of rain');
  });

  it('has nothing to say about a dry hour, or one the forecast says nothing about', () => {
    expect(describeRain(0, 0)).toBeNull();
    expect(describeRain(0, 29)).toBeNull();
    expect(describeRain(0, NaN)).toBeNull();
    expect(describeRain(NaN, NaN)).toBeNull();
    expect(describeRain(undefined, undefined)).toBeNull();
  });
});

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { groupByDate, animalCount, vetReferralRate } = require('../public/analytics');

describe('groupByDate()', () => {
  test('groups sessions by ISO date', () => {
    const sessions = [
      { timestamp: '2024-03-01T09:00:00Z' },
      { timestamp: '2024-03-01T14:30:00Z' },
      { timestamp: '2024-03-02T08:00:00Z' },
    ];
    const result = groupByDate(sessions);
    assert.strictEqual(result['2024-03-01'], 2);
    assert.strictEqual(result['2024-03-02'], 1);
  });

  test('skips sessions with no timestamp', () => {
    const sessions = [
      { timestamp: '2024-03-01T09:00:00Z' },
      {},
      { timestamp: null },
    ];
    const result = groupByDate(sessions);
    assert.strictEqual(result['2024-03-01'], 1);
    assert.strictEqual(Object.keys(result).length, 1);
  });

  test('returns empty object for empty array', () => {
    assert.deepStrictEqual(groupByDate([]), {});
  });
});

describe('animalCount()', () => {
  test('counts cattle and cow as the same category', () => {
    const sessions = [
      { animal: 'cattle' },
      { animal: 'cow' },
      { animal: 'Cattle' },
      { animal: 'COW' },
    ];
    const result = animalCount(sessions);
    assert.strictEqual(result.cattle, 4);
    assert.strictEqual(result.poultry, 0);
    assert.strictEqual(result.pigs, 0);
    assert.strictEqual(result.rabbit, 0);
  });

  test('counts poultry, pigs, and rabbit correctly', () => {
    const sessions = [
      { animal: 'poultry' },
      { animal: 'Poultry' },
      { animal: 'pigs' },
      { animal: 'rabbit' },
      { animal: 'rabbit' },
    ];
    const result = animalCount(sessions);
    assert.strictEqual(result.cattle, 0);
    assert.strictEqual(result.poultry, 2);
    assert.strictEqual(result.pigs, 1);
    assert.strictEqual(result.rabbit, 2);
  });

  test('ignores unknown animal values', () => {
    const sessions = [{ animal: 'goat' }, { animal: '' }, {}];
    const result = animalCount(sessions);
    assert.strictEqual(result.cattle, 0);
    assert.strictEqual(result.poultry, 0);
    assert.strictEqual(result.pigs, 0);
    assert.strictEqual(result.rabbit, 0);
  });

  test('returns zero counts for empty array', () => {
    const result = animalCount([]);
    assert.deepStrictEqual(result, { cattle: 0, poultry: 0, pigs: 0, rabbit: 0 });
  });
});

describe('vetReferralRate()', () => {
  test('returns correct percentage', () => {
    const sessions = [
      { outcome: 'vet_referral' },
      { outcome: 'vet_referral' },
      { outcome: 'advice' },
      { outcome: 'advice' },
    ];
    assert.strictEqual(vetReferralRate(sessions), 50);
  });

  test('rounds to nearest integer', () => {
    const sessions = [
      { outcome: 'vet_referral' },
      { outcome: 'advice' },
      { outcome: 'advice' },
    ];
    assert.strictEqual(vetReferralRate(sessions), 33);
  });

  test('returns 0 for empty array', () => {
    assert.strictEqual(vetReferralRate([]), 0);
  });

  test('returns 100 when all sessions are vet referrals', () => {
    const sessions = [
      { outcome: 'vet_referral' },
      { outcome: 'vet_referral' },
    ];
    assert.strictEqual(vetReferralRate(sessions), 100);
  });

  test('returns 0 when no sessions are vet referrals', () => {
    const sessions = [{ outcome: 'advice' }, { outcome: 'advice' }];
    assert.strictEqual(vetReferralRate(sessions), 0);
  });
});

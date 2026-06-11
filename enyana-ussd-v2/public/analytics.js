'use strict';

/**
 * Pure aggregation helpers shared between the dashboard inline script
 * and the Node test suite (tests/analytics.test.js).
 *
 * All functions are side-effect-free and work in both browser and Node.
 */

function groupByDate(sessions) {
  const counts = {};
  for (const s of sessions) {
    if (!s.timestamp) continue;
    const date = new Date(s.timestamp).toISOString().slice(0, 10);
    counts[date] = (counts[date] || 0) + 1;
  }
  return counts;
}

function animalCount(sessions) {
  const counts = { cattle: 0, poultry: 0, pigs: 0, rabbit: 0 };
  for (const s of sessions) {
    const a = (s.animal || '').toLowerCase();
    if      (a === 'cattle' || a === 'cow') counts.cattle++;
    else if (a === 'poultry')               counts.poultry++;
    else if (a === 'pigs')                  counts.pigs++;
    else if (a === 'rabbit')                counts.rabbit++;
  }
  return counts;
}

function vetReferralRate(sessions) {
  if (!sessions.length) return 0;
  const n = sessions.filter(s => s.outcome === 'vet_referral').length;
  return Math.round((n / sessions.length) * 100);
}

if (typeof module !== 'undefined') {
  module.exports = { groupByDate, animalCount, vetReferralRate };
}

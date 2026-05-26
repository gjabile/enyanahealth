/**
 * services/db.js
 * Dashboard-facing Firestore queries: vets collection, session status updates,
 * and read helpers for the /api/* endpoints in index.js.
 *
 * Uses admin.app() to share the Firebase instance initialised by firestore.js.
 * Every function returns empty data (never throws) so the dashboard never
 * crashes if Firestore is unreachable.
 */

'use strict';

const admin = require('firebase-admin');

function getDb() {
  try {
    return admin.app().firestore();
  } catch {
    return null;
  }
}

// Convert Firestore Timestamps (and plain Dates) to ISO strings for JSON
function toDate(val) {
  if (!val) return null;
  if (typeof val.toDate === 'function') return val.toDate().toISOString();
  if (val instanceof Date) return val.toISOString();
  return val;
}

function serializeDoc(id, data) {
  return {
    id,
    ...data,
    timestamp:   toDate(data.timestamp),
    createdAt:   toDate(data.createdAt),
    firstSeen:   toDate(data.firstSeen),
    lastSeen:    toDate(data.lastSeen),
    forwardedAt: toDate(data.forwardedAt),
    resolvedAt:  toDate(data.resolvedAt),
  };
}

// ---------------------------------------------------------------------------
// Vets collection
// ---------------------------------------------------------------------------

async function getVets() {
  const db = getDb();
  if (!db) return [];
  try {
    const snap = await db.collection('vets').get();
    return snap.docs.map(d => serializeDoc(d.id, d.data()));
  } catch (err) {
    console.error('[db] getVets error:', err.message);
    return [];
  }
}

async function addVet(vetData) {
  const db = getDb();
  if (!db) return null;
  try {
    const ref = await db.collection('vets').add({
      name:        vetData.name,
      phone:       vetData.phone,
      region:      vetData.region,
      animals:     vetData.animals,
      activeCases: 0,
      createdAt:   new Date(),
    });
    const doc = await ref.get();
    return serializeDoc(doc.id, doc.data());
  } catch (err) {
    console.error('[db] addVet error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session status management
// ---------------------------------------------------------------------------

async function updateSessionStatus(sessionId, status, vetId) {
  const db = getDb();
  if (!db) return false;
  try {
    const update = { status };
    if (vetId !== undefined && vetId !== null) update.assignedVet = vetId;
    if (status === 'forwarded') update.forwardedAt = new Date();
    if (status === 'resolved')  update.resolvedAt  = new Date();
    await db.collection('sessions').doc(sessionId).update(update);
    return true;
  } catch (err) {
    console.error('[db] updateSessionStatus error:', err.message);
    return false;
  }
}

async function getSessionById(sessionId) {
  const db = getDb();
  if (!db) return null;
  try {
    const doc = await db.collection('sessions').doc(sessionId).get();
    if (!doc.exists) return null;
    return serializeDoc(doc.id, doc.data());
  } catch (err) {
    console.error('[db] getSessionById error:', err.message);
    return null;
  }
}

async function adjustVetCases(vetId, delta) {
  const db = getDb();
  if (!db) return false;
  try {
    await db.collection('vets').doc(vetId).update({
      activeCases: admin.firestore.FieldValue.increment(delta),
    });
    return true;
  } catch (err) {
    console.error('[db] adjustVetCases error:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read helpers for dashboard API
// ---------------------------------------------------------------------------

async function getAllSessions() {
  const db = getDb();
  if (!db) return [];
  try {
    const [sessionsSnap, farmersSnap] = await Promise.all([
      db.collection('sessions').orderBy('timestamp', 'desc').get(),
      db.collection('farmers').get(),
    ]);
    const farmerMap = {};
    farmersSnap.docs.forEach(d => {
      const fd = d.data();
      farmerMap[d.id] = { name: fd.name, isTest: fd.isTest || false, isVet: fd.isVet || false };
    });
    return sessionsSnap.docs.map(d => {
      const data = d.data();
      const fm   = farmerMap[data.phoneNumber] || {};
      return { ...serializeDoc(d.id, data), farmerName: fm.name || data.name || null, isTest: fm.isTest || false, isVet: fm.isVet || false };
    });
  } catch (err) {
    console.error('[db] getAllSessions error:', err.message);
    return [];
  }
}

async function getPendingSessions() {
  const db = getDb();
  if (!db) return [];
  try {
    const snap = await db.collection('sessions').where('status', '==', 'pending').get();
    if (snap.empty) return [];
    const docs = snap.docs.map(d => serializeDoc(d.id, d.data()));

    // Fetch farmer flags for unique phone numbers so callers can filter vet/test
    const phones = [...new Set(docs.map(d => d.phoneNumber).filter(Boolean))];
    const farmerMap = {};
    await Promise.all(phones.map(async phone => {
      try {
        const doc = await db.collection('farmers').doc(phone).get();
        if (doc.exists) {
          const fd = doc.data();
          farmerMap[phone] = { isVet: fd.isVet || false, isTest: fd.isTest || false };
        }
      } catch {}
    }));

    return docs
      .map(s => ({ ...s, isVet: (farmerMap[s.phoneNumber] || {}).isVet || false, isTest: (farmerMap[s.phoneNumber] || {}).isTest || false }))
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  } catch (err) {
    console.error('[db] getPendingSessions error:', err.message);
    return [];
  }
}

async function getAllFarmers() {
  const db = getDb();
  if (!db) return [];
  try {
    const snap = await db.collection('farmers').orderBy('lastSeen', 'desc').get();
    return snap.docs.map(d => serializeDoc(d.id, d.data()));
  } catch (err) {
    console.error('[db] getAllFarmers error:', err.message);
    return [];
  }
}

async function getFarmerById(phoneNumber) {
  const db = getDb();
  if (!db) return null;
  try {
    const [farmerDoc, sessionsSnap] = await Promise.all([
      db.collection('farmers').doc(phoneNumber).get(),
      db.collection('sessions').where('phoneNumber', '==', phoneNumber).get(),
    ]);
    if (!farmerDoc.exists) return null;
    const sessions = sessionsSnap.docs
      .map(d => serializeDoc(d.id, d.data()))
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    return { ...serializeDoc(farmerDoc.id, farmerDoc.data()), sessions };
  } catch (err) {
    console.error('[db] getFarmerById error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Aggregated stats
// ---------------------------------------------------------------------------

function defaultStats() {
  return {
    totalFarmers:        0,
    totalSessions:       0,
    pendingReferrals:    0,
    highRiskSessions:    0,
    sessionsByAnimal:    { cow: 0, poultry: 0, pig: 0, rabbit: 0 },
    sessionsByOutcome:   { advice: 0, vet_referral: 0 },
    sessionsByRisk:      { LOW: 0, MEDIUM: 0, HIGH: 0 },
    sessionsByCommunity: { nyakayojo: 0, gulu: 0 },
  };
}

async function getStats() {
  const db = getDb();
  if (!db) return defaultStats();
  try {
    const [farmersSnap, sessionsSnap] = await Promise.all([
      db.collection('farmers').get(),
      db.collection('sessions').get(),
    ]);

    const excludedPhones = new Set();
    let realFarmerCount = 0;
    farmersSnap.docs.forEach(d => {
      const fd = d.data();
      if (fd.isVet || fd.isTest) excludedPhones.add(d.id);
      else realFarmerCount++;
    });

    const stats = { ...defaultStats(), totalFarmers: realFarmerCount, totalSessions: 0 };
    const animalMap = { cattle: 'cow', poultry: 'poultry', pigs: 'pig', rabbit: 'rabbit' };

    sessionsSnap.docs.forEach(d => {
      const s = d.data();
      if (excludedPhones.has(s.phoneNumber)) return;
      stats.totalSessions++;
      if (s.status === 'pending')         stats.pendingReferrals++;
      if (s.highestRiskLevel === 'HIGH')  stats.highRiskSessions++;

      const ak = animalMap[s.animal];
      if (ak && stats.sessionsByAnimal[ak]   !== undefined) stats.sessionsByAnimal[ak]++;
      if (s.outcome && stats.sessionsByOutcome[s.outcome]       !== undefined) stats.sessionsByOutcome[s.outcome]++;
      if (s.highestRiskLevel && stats.sessionsByRisk[s.highestRiskLevel] !== undefined) stats.sessionsByRisk[s.highestRiskLevel]++;
      if (s.community && stats.sessionsByCommunity[s.community]         !== undefined) stats.sessionsByCommunity[s.community]++;
    });

    return stats;
  } catch (err) {
    console.error('[db] getStats error:', err.message);
    return defaultStats();
  }
}

module.exports = {
  getVets,
  addVet,
  updateSessionStatus,
  getSessionById,
  adjustVetCases,
  getAllSessions,
  getPendingSessions,
  getAllFarmers,
  getFarmerById,
  getStats,
};

'use strict';

/**
 * services/session.js
 * Firestore-backed USSD session store.
 *
 * Stores sessions in the `ussd_sessions` collection so they survive
 * across Vercel serverless invocations. Sessions expire after 5 minutes
 * of inactivity (same as Africa's Talking's own timeout).
 *
 * Requires firebase-admin to already be initialized (done by services/firestore.js).
 */

const SESSION_TTL_MS = 5 * 60 * 1000;

function getDb() {
  return require('firebase-admin').firestore();
}

async function getSession(sessionId) {
  try {
    const doc = await getDb().collection('ussd_sessions').doc(sessionId).get();
    if (!doc.exists) return null;

    const { data, lastActive } = doc.data();
    if (Date.now() - lastActive > SESSION_TTL_MS) {
      getDb().collection('ussd_sessions').doc(sessionId).delete().catch(() => {});
      return null;
    }
    return data;
  } catch (err) {
    console.error(`[session] getSession failed: ${err.message}`);
    return null;
  }
}

async function setSession(sessionId, data) {
  try {
    await getDb().collection('ussd_sessions').doc(sessionId).set({
      data,
      lastActive: Date.now(),
    });
  } catch (err) {
    console.error(`[session] setSession failed: ${err.message}`);
  }
}

async function clearSession(sessionId) {
  try {
    await getDb().collection('ussd_sessions').doc(sessionId).delete();
  } catch (err) {
    console.error(`[session] clearSession failed: ${err.message}`);
  }
}

module.exports = { getSession, setSession, clearSession };

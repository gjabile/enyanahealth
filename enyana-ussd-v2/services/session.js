'use strict';

/**
 * services/session.js
 * Firestore-backed USSD session store — NOT used by handlers/ussd.js.
 *
 * The main handler is stateless: it derives the current state by replaying
 * the full "*"-delimited text string that Africa's Talking sends on every
 * request, so no cross-request session storage is needed.
 *
 * This file is retained for local simulator tooling or future use cases that
 * require explicit session state (e.g. rate limiting, mid-session admin flags).
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

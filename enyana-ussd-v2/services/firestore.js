/**
 * services/firestore.js
 * Firebase Admin SDK initialization and Firestore operations for farmer registration.
 *
 * Handles:
 * - Checking if a farmer exists by phone number
 * - Creating new farmer records on first registration
 * - Updating lastSeen and totalSessions for returning farmers
 * - Graceful error handling (never crashes the USSD flow)
 */

'use strict';

require('dotenv').config();

let db = null;

/**
 * Initialize Firebase Admin SDK.
 * Called once at startup if FIREBASE_CREDENTIALS_PATH is set.
 */
function initializeFirebase() {
  const credsPath = process.env.FIREBASE_CREDENTIALS_PATH;

  if (!credsPath) {
    console.warn('[firestore] FIREBASE_CREDENTIALS_PATH not set — Firestore disabled');
    return;
  }

  try {
    const admin = require('firebase-admin');
    const serviceAccount = require(credsPath);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    db = admin.firestore();
    console.log('[firestore] Firebase initialized successfully');
  } catch (err) {
    console.error(`[firestore] Failed to initialize Firebase: ${err.message}`);
  }
}

/**
 * Check if a farmer exists in Firestore by phone number.
 * Returns the farmer record if found, null otherwise.
 * Never throws — logs and returns null on error.
 */
async function getFarmer(phoneNumber) {
  if (!db) {
    return null;
  }

  try {
    const doc = await db.collection('farmers').doc(phoneNumber).get();
    return doc.exists ? doc.data() : null;
  } catch (err) {
    console.error(`[firestore] Error checking farmer ${phoneNumber}: ${err.message}`);
    return null;
  }
}

/**
 * Create a new farmer record in Firestore.
 * Called after name collection during first-time registration.
 * Never throws — logs and returns false on error.
 */
async function createFarmer(phoneNumber, name, community, language) {
  if (!db) {
    console.warn(`[firestore] Firestore disabled — skipping farmer creation for ${phoneNumber}`);
    return false;
  }

  try {
    const now = new Date();
    await db.collection('farmers').doc(phoneNumber).set({
      phoneNumber,
      name,
      community,
      language,
      firstSeen: now,
      lastSeen: now,
      totalSessions: 1,
    });
    console.log(`[firestore] New farmer created: ${phoneNumber}`);
    return true;
  } catch (err) {
    console.error(`[firestore] Error creating farmer ${phoneNumber}: ${err.message}`);
    return false;
  }
}

/**
 * Update returning farmer's lastSeen and totalSessions.
 * Called when a returning farmer enters the system.
 * Never throws — logs and returns false on error.
 */
async function updateReturningFarmer(phoneNumber) {
  if (!db) {
    console.warn(`[firestore] Firestore disabled — skipping farmer update for ${phoneNumber}`);
    return false;
  }

  try {
    const now = new Date();
    await db.collection('farmers').doc(phoneNumber).update({
      lastSeen: now,
      totalSessions: require('firebase-admin').firestore.FieldValue.increment(1),
    });
    console.log(`[firestore] Farmer updated: ${phoneNumber}`);
    return true;
  } catch (err) {
    console.error(`[firestore] Error updating farmer ${phoneNumber}: ${err.message}`);
    return false;
  }
}

// Initialize on require
initializeFirebase();

module.exports = {
  getFarmer,
  createFarmer,
  updateReturningFarmer,
};

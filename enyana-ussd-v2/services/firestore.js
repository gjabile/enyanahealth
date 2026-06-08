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
 * Guards against re-initialization on Vercel serverless cold starts by checking
 * admin.apps.length before calling initializeApp.
 */
function initializeFirebase() {
  const credsPath    = process.env.FIREBASE_CREDENTIALS_PATH;
  const projectId    = process.env.FIREBASE_PROJECT_ID;
  const clientEmail  = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey   = process.env.FIREBASE_PRIVATE_KEY;

  try {
    const admin = require('firebase-admin');

    if (!admin.apps.length) {
      if (credsPath) {
        // Service account JSON file on disk
        admin.initializeApp({ credential: admin.credential.cert(require(credsPath)) });
      } else if (projectId && clientEmail && privateKey) {
        // Individual env vars — private key may have literal \n from .env file
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey: privateKey.replace(/\\n/g, '\n'),
          }),
        });
      } else {
        console.warn('[firestore] No Firebase credentials found — Firestore disabled');
        return;
      }
    }

    db = admin.firestore();
    // Shorter deadline than the gRPC default (88 s on Vercel cold starts)
    db.settings({ timeout: 10000 });
    console.log('[firestore] Firebase initialized successfully');
  } catch (err) {
    console.error(`[firestore] Failed to initialize Firebase: ${err.message}`);
  }
}

/**
 * Run a Firestore write; retry once after 2 s if DEADLINE_EXCEEDED.
 * Used by saveTriageSession and saveVetContactSession.
 */
async function withRetry(fn, label) {
  try {
    return await fn();
  } catch (err) {
    if (err.message && err.message.includes('DEADLINE_EXCEEDED')) {
      console.warn(`[firestore] ${label} DEADLINE_EXCEEDED — retrying in 2 s`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return await fn();
    }
    throw err;
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

/**
 * Save a completed triage session to Firestore and update the farmer record.
 * Retries once on DEADLINE_EXCEEDED. Never throws — logs on error.
 *
 * @param {object} session - The full session object after triage completes
 */
async function saveTriageSession(session) {
  if (!db) {
    console.warn('[firestore] Firestore disabled — skipping triage session save');
    return false;
  }

  try {
    const now = new Date();

    await withRetry(
      () => db.collection('sessions').add({
        language:         session.language,
        community:        session.community,
        phoneNumber:      session.phoneNumber,
        name:             session.name,
        animal:           session.animal,
        symptoms:         session.symptoms || {},
        diseaseScores:    session.diseaseScores || {},
        highestRiskLevel: session.highestRiskLevel,
        outcome:          session.outcome,
        timestamp:        now,
        status:           session.outcome === 'vet_referral' ? 'pending' : 'resolved',
        assignedVet:      null,
        forwardedAt:      null,
        resolvedAt:       null,
      }),
      'saveTriageSession'
    );

    if (session.phoneNumber) {
      const admin = require('firebase-admin');
      await withRetry(
        () => db.collection('farmers').doc(session.phoneNumber).update({
          lastSeen:      now,
          totalSessions: admin.firestore.FieldValue.increment(1),
        }),
        'saveTriageSession farmer update'
      );
    }

    console.log(`[firestore] Triage session saved for ${session.phoneNumber}`);
    return true;
  } catch (err) {
    console.error(`[firestore] Error saving triage session: ${err.message}`);
    return false;
  }
}

/**
 * Save a direct vet-contact session (non-triage) to Firestore.
 * Called from notify.js before the Twilio call so the dashboard shows
 * the referral even if Twilio fails or Vercel freezes the function.
 * Retries once on DEADLINE_EXCEEDED. Never throws — logs on error.
 *
 * @param {object} session - Session object with phoneNumber, name, community, vetAnimal
 * @param {string} problem - Farmer's free-text problem description
 */
async function saveVetContactSession(session, problem) {
  if (!db) {
    console.warn('[firestore] Firestore disabled — skipping vet contact session save');
    return false;
  }

  try {
    const now = new Date();
    await withRetry(
      () => db.collection('sessions').add({
        language:    session.language,
        community:   session.community,
        phoneNumber: session.phoneNumber,
        name:        session.name,
        animal:      session.vetAnimal || null,
        problem:     problem,
        outcome:     'vet_referral',
        timestamp:   now,
        status:      'pending',
        assignedVet: null,
        forwardedAt: null,
        resolvedAt:  null,
      }),
      'saveVetContactSession'
    );
    if (session.phoneNumber) {
      const admin = require('firebase-admin');
      db.collection('farmers').doc(session.phoneNumber).update({
        lastSeen:      now,
        totalSessions: admin.firestore.FieldValue.increment(1),
      }).catch(err => console.error(`[firestore] saveVetContactSession farmer update failed: ${err.message}`));
    }

    console.log(`[firestore] Vet contact session saved for ${session.phoneNumber}`);
    return true;
  } catch (err) {
    console.error(`[firestore] Error saving vet contact session: ${err.message}`);
    return false;
  }
}

/**
 * Save a feedback submission to Firestore.
 * Fire-and-forget — never throws, farmer always sees the thank-you screen.
 *
 * @param {object} session - Current session object
 * @param {string} message - Farmer's feedback text
 */
function saveFeedback(session, message) {
  if (!db) {
    console.warn('[firestore] Firestore disabled — skipping feedback save');
    return;
  }
  db.collection('feedback').add({
    phoneNumber: session.phoneNumber,
    name:        session.name,
    community:   session.community,
    language:    session.language,
    message:     message,
    timestamp:   new Date(),
  }).catch(err => console.error(`[firestore] Feedback save failed: ${err.message}`));
}

// Initialize on require
initializeFirebase();

module.exports = {
  getFarmer,
  createFarmer,
  updateReturningFarmer,
  saveTriageSession,
  saveVetContactSession,
  saveFeedback,
};

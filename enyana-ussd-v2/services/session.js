/**
 * services/session.js
 * In-memory session store for USSD sessions.
 *
 * Uses a plain JS Map — zero dependencies, fast for local dev.
 * Sessions auto-expire after SESSION_TTL_MS of inactivity (default: 5 minutes),
 * matching Africa's Talking's own session timeout.
 *
 * Production note: for a multi-process deployment (e.g. Vercel serverless),
 * replace this Map with Redis so sessions survive across invocations.
 */

'use strict';

const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Internal store: Map<sessionId, { data: Object, lastActive: number }>
const store = new Map();

/**
 * Retrieve session data by sessionId.
 * Returns null if the session does not exist or has expired.
 */
function getSession(sessionId) {
  const entry = store.get(sessionId);
  if (!entry) return null;

  // Prune expired sessions on access rather than via a background timer
  if (Date.now() - entry.lastActive > SESSION_TTL_MS) {
    store.delete(sessionId);
    return null;
  }

  // Refresh the TTL on every successful read
  entry.lastActive = Date.now();
  return entry.data;
}

/**
 * Create or overwrite session data for a given sessionId.
 */
function setSession(sessionId, data) {
  store.set(sessionId, { data, lastActive: Date.now() });
}

/**
 * Delete a session immediately.
 * Called when a USSD flow reaches an END state so memory is freed right away.
 */
function clearSession(sessionId) {
  store.delete(sessionId);
}

module.exports = { getSession, setSession, clearSession };

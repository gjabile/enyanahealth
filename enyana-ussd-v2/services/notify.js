/**
 * services/notify.js
 * Sends WhatsApp alerts to the on-call vet via Twilio when a farmer
 * requests help through the "Connect a Vet" menu option.
 *
 * Design decisions:
 * - Twilio is required lazily (not in package.json) so the server starts
 *   without it installed. Run `npm install twilio` only when you need live alerts.
 * - If credentials are missing or look like placeholders, a warning is logged
 *   and the function returns silently — keeping local testing crash-free.
 * - Twilio timeout is passed at constructor time via RequestClient — post-construction
 *   property assignment is ignored by the SDK.
 * - Promise.race with a 500 ms drain resolves this function quickly so Vercel
 *   serverless does not hold the invocation open waiting for Twilio's HTTP round-trip.
 *   The Firestore save (always awaited first) guarantees dashboard visibility even
 *   if Vercel freezes the process before Twilio completes.
 */

'use strict';

require('dotenv').config();

/**
 * Send a WhatsApp message to the vet alerting them to a new farmer case.
 *
 * @param {object} session - Session object with phoneNumber, name, community, vetAnimal
 * @param {string} problem - Farmer's free-text problem description
 */
async function sendVetAlert(session, problem) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.WHATSAPP_FROM;
  const to    = process.env.WHATSAPP_TO;

  const message = [
    '🐄 Enyana Health Alert',
    `Farmer: ${session.name || 'Unknown'}`,
    `Phone: ${session.phoneNumber}`,
    `Community: ${session.community || 'Unknown'}`,
    `Animal: ${session.vetAnimal || 'Unknown'}`,
    `Problem: ${problem}`,
  ].join('\n');

  // Persist to Firestore first — dashboard shows the referral even if Twilio
  // fails or Vercel freezes the function before the WhatsApp call completes.
  const { saveVetContactSession } = require('./firestore');
  await saveVetContactSession(session, problem).catch(err =>
    console.error('[notify] Firestore save failed:', err.message)
  );

  // Guard: skip if credentials are missing or still set to placeholder values
  if (!sid || !token || sid === 'your_twilio_sid' || token === 'your_twilio_token') {
    console.warn('[notify] Twilio credentials not configured — skipping WhatsApp alert.');
    console.log(`[notify] Alert payload:\n${message}`);
    return;
  }

  // Lazy-require so the app starts without twilio installed
  let twilio;
  try {
    twilio = require('twilio');
  } catch (e) {
    console.warn('[notify] Twilio SDK not installed. Run: npm install twilio');
    return;
  }

  // Pass timeout at construction time — assigning client.httpClient.timeout after
  // construction is ignored by the SDK (the Axios instance is already configured).
  const client = twilio(sid, token, {
    httpClient: new twilio.RequestClient({ timeout: 10000 }),
  });

  // Promise.race: the 500 ms drain resolves this async function quickly so Vercel
  // does not hold the invocation open for the full Twilio round-trip.
  // The Twilio call continues in the background; the Firestore record above
  // ensures the dashboard always reflects the referral regardless of outcome.
  const call = client.messages.create({ body: message, from, to })
    .then(() => console.log(`[notify] WhatsApp alert sent to vet at ${to}`));
  await Promise.race([call, new Promise(resolve => setTimeout(resolve, 500))]);
}

/**
 * Send a structured triage case file to the vet via WhatsApp.
 * Called automatically for HIGH-risk outcomes, or on farmer request for LOW/MEDIUM.
 *
 * @param {object} session - Full session after triage: must have animal, symptoms,
 *                           diseaseScores, highestRiskLevel
 */
async function sendTriageVetAlert(session) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.WHATSAPP_FROM;
  const to    = process.env.WHATSAPP_TO;

  const TRIAGE_CONFIG = require('../config/triage');
  const config   = TRIAGE_CONFIG[session.animal] || {};
  const symptoms = session.symptoms || {};
  const scores   = session.diseaseScores || {};

  // Diseases flagged (MEDIUM or HIGH only)
  const flaggedLines = Object.entries(scores)
    .filter(([, d]) => d.level !== 'LOW')
    .map(([name, d]) => `${name}: ${d.score}/${d.maxPossible} — ${d.level}`);

  // Symptom list in question order
  const sym = val => (val ? '✅' : '❌');
  const symptomLines = (config.questions || []).map(qId => {
    const label = (config.labels || {})[qId] || qId;
    return `${sym(symptoms[qId])} ${label}`;
  });

  const message = [
    '🐄 Enyana Health Alert',
    `Farmer: ${session.name || 'Unknown'}`,
    `Phone: ${session.phoneNumber}`,
    `Community: ${session.community || 'Unknown'}`,
    `Animal: ${session.animal}`,
    `Risk Level: ${session.highestRiskLevel}`,
    '',
    'Diseases flagged:',
    ...(flaggedLines.length ? flaggedLines : ['None above LOW']),
    '',
    'Symptoms reported:',
    ...symptomLines,
  ].join('\n');

  if (!sid || !token || sid === 'your_twilio_sid' || token === 'your_twilio_token') {
    console.warn('[notify] Twilio credentials not configured — skipping triage WhatsApp alert.');
    console.log(`[notify] Triage alert payload:\n${message}`);
    return;
  }

  let twilio;
  try {
    twilio = require('twilio');
  } catch (e) {
    console.warn('[notify] Twilio SDK not installed. Run: npm install twilio');
    return;
  }

  const client = twilio(sid, token, {
    httpClient: new twilio.RequestClient({ timeout: 10000 }),
  });

  const call = client.messages.create({ body: message, from, to })
    .then(() => console.log(`[notify] Triage WhatsApp alert sent to vet at ${to}`));
  await Promise.race([call, new Promise(resolve => setTimeout(resolve, 500))]);
}

module.exports = { sendVetAlert, sendTriageVetAlert };

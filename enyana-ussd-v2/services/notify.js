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
 * - The caller should fire-and-forget (no await) so the farmer is not made to
 *   wait for Twilio's HTTP round-trip before seeing the confirmation screen.
 */

'use strict';

require('dotenv').config();

/**
 * Send a WhatsApp message to the vet alerting them to a new farmer case.
 *
 * @param {string} phoneNumber - Farmer's MSISDN (e.g. "+256700000000")
 * @param {string} animal      - Animal category ("cattle", "poultry", "pigs")
 * @param {string} problem     - Farmer's free-text problem description
 */
async function sendVetAlert(phoneNumber, animal, problem) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.WHATSAPP_FROM;
  const to    = process.env.WHATSAPP_TO;

  // Guard: skip if credentials are missing or still set to placeholder values
  if (!sid || !token || sid === 'your_twilio_sid' || token === 'your_twilio_token') {
    console.warn('[notify] Twilio credentials not configured — skipping WhatsApp alert.');
    console.log(`[notify] Alert payload — Farmer: ${phoneNumber} | Animal: ${animal} | Problem: ${problem}`);
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

  const client  = twilio(sid, token);
  const animalLine = animal ? `\nAnimal: ${animal}` : '';
  const message = `🐄 Enyana Health Alert\nFarmer: ${phoneNumber}${animalLine}\nProblem: ${problem}`;

  await client.messages.create({ body: message, from, to });
  console.log(`[notify] WhatsApp alert sent to vet at ${to}`);
}

/**
 * Send a structured triage case file to the vet via WhatsApp.
 * Called automatically for HIGH-risk outcomes, or on farmer request for LOW/MEDIUM.
 *
 * @param {object} session - The full session object after triage is complete
 */
async function sendTriageVetAlert(session) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.WHATSAPP_FROM;
  const to    = process.env.WHATSAPP_TO;

  const sym = val => (val ? '✅' : '❌');
  const s   = session.symptoms || {};
  const message = [
    '🐄 Enyana Health Alert',
    `Farmer: ${session.name || 'Unknown'}`,
    `Phone: ${session.phoneNumber}`,
    `Community: ${session.community || 'Unknown'}`,
    'Animal: Cow',
    `Duration: ${session.duration || 'Unknown'}`,
    `Still eating/drinking: ${session.stillEating ? 'Yes' : 'No'}`,
    `Risk Level: ${session.triageLevel}`,
    `Score: ${session.triageScore}/7`,
    '',
    'Symptoms reported:',
    `${sym(s.milkColor)} Milk different color`,
    `${sym(s.teatsSwollen)} Swollen/tender teats`,
    `${sym(s.resistsMilking)} Resists being milked`,
    `${sym(s.udderHot)} Udder hot/swollen/hard`,
    `${sym(s.oneTeat)} Only one teat affected`,
    `${sym(s.udderDark)} Udder dark blue/black`,
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

  const client = twilio(sid, token);
  await client.messages.create({ body: message, from, to });
  console.log(`[notify] Triage WhatsApp alert sent to vet at ${to}`);
}

module.exports = { sendVetAlert, sendTriageVetAlert };

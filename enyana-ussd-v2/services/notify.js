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
  const message = `🐄 Enyana Health Alert\nFarmer: ${phoneNumber}\nAnimal: ${animal}\nProblem: ${problem}`;

  await client.messages.create({ body: message, from, to });
  console.log(`[notify] WhatsApp alert sent to vet at ${to}`);
}

module.exports = { sendVetAlert };

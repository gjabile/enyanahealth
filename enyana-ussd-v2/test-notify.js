/**
 * test-notify.js
 * Simple test script to verify Twilio WhatsApp alerts work with configured credentials.
 * Run this after setting up .env with real Twilio values.
 */

'use strict';

require('dotenv').config();

const { sendVetAlert } = require('./services/notify');

async function testAlert() {
  console.log('Sending test WhatsApp alert...');

  try {
    await sendVetAlert('+256700000000', 'cattle', 'Test alert from local simulator - verifying Twilio setup works!');
    console.log('✅ Test alert sent successfully! Check WhatsApp at the number in WHATSAPP_TO.');
  } catch (error) {
    console.error('❌ Failed to send test alert:', error.message);
  }
}

testAlert();
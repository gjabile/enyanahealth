/**
 * index.js
 * Entry point for the Enyana Health USSD server.
 * Starts Express, registers middleware, mounts routes, and serves the simulator.
 *
 * Routes:
 *   POST /ussd  — Africa's Talking (or simulator) sends every keypress here
 *   GET  /      — Serves the browser-based USSD simulator for local testing
 */

'use strict';

// Load .env variables before anything else so handlers see them at require-time
require('dotenv').config();

const express = require('express');
const path    = require('path');

const { handleUSSD } = require('./handlers/ussd');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Africa's Talking sends POST bodies as URL-encoded form data
app.use(express.urlencoded({ extended: false }));

// Accept JSON bodies too (useful for direct API callers or future tooling)
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// USSD endpoint — Africa's Talking will POST here on every keypress
app.post('/ussd', async (req, res) => {
  try {
    await handleUSSD(req, res);
  } catch (err) {
    console.error('[server] Unhandled error in /ussd:', err);
    res.send('END An unexpected error occurred. Please dial again.');
  }
});

// Simulator — browser-based USSD test UI (no AT account needed for dev)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'simulator', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`\nEnyana Health USSD server running on http://localhost:${PORT}`);
  console.log(`Pilot   : ${process.env.PILOT || 'nyakayojo'}`);
  console.log(`Open    : http://localhost:${PORT}  (simulator)\n`);
});

// Export for Vercel serverless handler
module.exports = app;

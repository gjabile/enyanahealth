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
const {
  getAllSessions, getPendingSessions,
  getAllFarmers,  getFarmerById,
  getVets,        addVet,
  updateSessionStatus, getSessionById,
  adjustVetCases, getStats,
} = require('./services/db');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskPhone(phone) {
  if (!phone || phone.length <= 7) return phone;
  return phone.slice(0, 7) + 'XXXX';
}

function dashboardAuth(req, res, next) {
  if (req.headers['x-dashboard-password'] !== 'enyana2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Africa's Talking sends POST bodies as URL-encoded form data
app.use(express.urlencoded({ extended: false }));

// Accept JSON bodies too (useful for direct API callers or future tooling)
app.use(express.json());

// CORS for dashboard API — must come before routes
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-password');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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
// Dashboard API
// ---------------------------------------------------------------------------

app.get('/api/sessions', dashboardAuth, async (req, res) => {
  const sessions = await getAllSessions();
  res.json(sessions.map(s => ({ ...s, phoneNumber: maskPhone(s.phoneNumber) })));
});

app.get('/api/sessions/pending', dashboardAuth, async (req, res) => {
  const sessions = await getPendingSessions();
  res.json(sessions.map(s => ({ ...s, phoneNumber: maskPhone(s.phoneNumber) })));
});

app.get('/api/farmers', dashboardAuth, async (req, res) => {
  const farmers = await getAllFarmers();
  res.json(farmers.map(f => ({ ...f, phoneNumber: maskPhone(f.phoneNumber) })));
});

app.get('/api/farmers/:phoneNumber', dashboardAuth, async (req, res) => {
  const farmer = await getFarmerById(req.params.phoneNumber);
  if (!farmer) return res.status(404).json({ error: 'Not found' });
  res.json({
    ...farmer,
    phoneNumber: maskPhone(farmer.phoneNumber),
    sessions: (farmer.sessions || []).map(s => ({ ...s, phoneNumber: maskPhone(s.phoneNumber) })),
  });
});

app.get('/api/vets', dashboardAuth, async (req, res) => {
  res.json(await getVets());
});

app.post('/api/vets', dashboardAuth, async (req, res) => {
  const { name, phone, region, animals } = req.body;
  const vet = await addVet({ name, phone, region, animals });
  if (!vet) return res.status(500).json({ error: 'Could not create vet' });
  res.status(201).json(vet);
});

app.patch('/api/sessions/:sessionId', dashboardAuth, async (req, res) => {
  const { sessionId } = req.params;
  const { status, vetId } = req.body;

  // For resolved status, find the currently assigned vet to decrement their count
  let resolvedVetId = vetId;
  if (status === 'resolved' && !resolvedVetId) {
    const current = await getSessionById(sessionId);
    if (current) resolvedVetId = current.assignedVet;
  }

  await updateSessionStatus(sessionId, status, vetId);

  if (resolvedVetId) {
    const delta = status === 'forwarded' ? 1 : status === 'resolved' ? -1 : 0;
    if (delta !== 0) await adjustVetCases(resolvedVetId, delta);
  }

  res.json({ success: true });
});

app.get('/api/stats', dashboardAuth, async (req, res) => {
  res.json(await getStats());
});

// ---------------------------------------------------------------------------
// Dashboard UI
// ---------------------------------------------------------------------------

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
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

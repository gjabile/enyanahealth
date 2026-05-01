/**
 * handlers/ussd.js
 * Core USSD state machine. Processes every POST from Africa's Talking (or the
 * browser simulator). Loads the pilot's flow JSON, looks up the session, reads
 * user input, advances to the next state, and returns a CON or END response.
 *
 * Response format (required by Africa's Talking):
 *   CON <text>  — session continues, user can type another input
 *   END <text>  — session terminates, text shown as final screen
 *
 * State machine design:
 *   - Current state is stored in session (never derived from text history)
 *   - Input = last "*"-delimited segment of the `text` field
 *   - Invalid input re-shows the current screen without advancing state
 *   - See CLAUDE.md for the full state routing table
 */

'use strict';

require('dotenv').config();

const path = require('path');
const fs   = require('fs');

const { getSession, setSession, clearSession } = require('../services/session');
const { sendVetAlert }                          = require('../services/notify');

// ---------------------------------------------------------------------------
// Load the flow JSON once at startup — restart the server to pick up changes
// ---------------------------------------------------------------------------

const PILOT    = process.env.PILOT || 'nyakayojo';
const flowPath = path.join(__dirname, '..', 'flows', `${PILOT}.json`);

let flow;
try {
  flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  console.log(`[ussd] Pilot: ${PILOT} | States loaded: ${Object.keys(flow.states).length}`);
} catch (err) {
  console.error(`[ussd] Cannot load flow file at "${flowPath}": ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the localised prompt for a state, falling back to English. */
function getPrompt(stateName, language) {
  const state = flow.states[stateName];
  if (!state) return `[Error: state "${stateName}" not found in flow]`;
  return state.prompt[language] || state.prompt.english;
}

/** Re-display the current screen (called when the user enters an invalid choice). */
function reshowCurrent(res, stateName, language) {
  return res.send(`CON ${getPrompt(stateName, language)}`);
}

// ---------------------------------------------------------------------------
// Main handler — exported and mounted in index.js
// ---------------------------------------------------------------------------

async function handleUSSD(req, res) {
  const {
    sessionId,
    phoneNumber,
    text        = '',
    serviceCode,
  } = req.body;

  // Africa's Talking sends an empty string on the very first request of a session
  const isNewSession = (text === '' || text === undefined || text === null);

  // Current input is the last segment of the "*"-delimited text history
  // e.g. text "1*2*3" → segments ["1","2","3"] → input "3"
  const segments = text ? text.split('*') : [];
  const input    = isNewSession ? '' : (segments[segments.length - 1] || '');

  // -------------------------------------------------------------------------
  // NEW SESSION — initialise state and show the language-selection screen
  // -------------------------------------------------------------------------
  if (isNewSession) {
    const freshSession = {
      state:       'selectLanguage',
      language:    'english',   // overwritten once the user picks a language
      animal:      null,        // set at selectAnimal
      phoneNumber,
      inputs:      [],
    };
    setSession(sessionId, freshSession);
    return res.send(`CON ${getPrompt('selectLanguage', 'english')}`);
  }

  // -------------------------------------------------------------------------
  // RETURNING SESSION — look it up (may have expired after 5 min of inactivity)
  // -------------------------------------------------------------------------
  let session = getSession(sessionId);

  if (!session) {
    // Session expired — restart cleanly rather than returning a bare error
    const freshSession = {
      state:       'selectLanguage',
      language:    'english',
      animal:      null,
      phoneNumber,
      inputs:      [],
    };
    setSession(sessionId, freshSession);
    return res.send(
      `CON Your session expired. Starting over...\n\n${getPrompt('selectLanguage', 'english')}`
    );
  }

  // Track all inputs for debugging (not used by the state machine itself)
  session.inputs.push(input);

  const currentState = session.state;
  let nextState      = null;

  // -------------------------------------------------------------------------
  // STATE MACHINE
  //
  // Each case:
  //   1. Validates user input
  //   2. Updates session side-effects (language, animal, etc.)
  //   3. Sets nextState — the handler then fetches the prompt and responds
  //
  // Invalid input returns early via reshowCurrent() without changing state.
  // -------------------------------------------------------------------------

  switch (currentState) {

    // ── Language selection ──────────────────────────────────────────────────
    case 'selectLanguage':
      if (input === '1') {
        session.language = 'english';
        nextState = 'selectAnimal';
      } else if (input === '2') {
        // Pilot's second language is the second entry in flow.metadata.languages
        session.language = (flow.metadata.languages && flow.metadata.languages[1]) || 'english';
        nextState = 'selectAnimal';
      } else {
        return reshowCurrent(res, 'selectLanguage', session.language);
      }
      break;

    // ── Animal selection ────────────────────────────────────────────────────
    case 'selectAnimal':
      if      (input === '1') { session.animal = 'cattle';  nextState = 'selectTopic'; }
      else if (input === '2') { session.animal = 'poultry'; nextState = 'selectTopic'; }
      else if (input === '3') { session.animal = 'pigs';    nextState = 'selectTopic'; }
      else { return reshowCurrent(res, 'selectAnimal', session.language); }
      break;

    // ── Topic selection ─────────────────────────────────────────────────────
    // Routes to {animal}_{topic} states using the animal stored in session.
    // State names are explicit strings (e.g. "cattle_disease") — not counters.
    case 'selectTopic':
      if      (input === '1') nextState = `${session.animal}_disease`;
      else if (input === '2') nextState = `${session.animal}_nutrition`;
      else if (input === '3') nextState = `${session.animal}_breeding`;
      else if (input === '4') nextState = 'connectVet';
      else { return reshowCurrent(res, 'selectTopic', session.language); }
      break;

    // ── Vet connection — farmer types their problem as free text ─────────────
    case 'connectVet':
      if (!input || !input.trim()) {
        return reshowCurrent(res, 'connectVet', session.language);
      }
      // Fire-and-forget: do not await so the farmer is not held waiting for Twilio
      sendVetAlert(phoneNumber, session.animal || 'unknown', input).catch(err => {
        console.error('[ussd] Vet alert failed:', err.message);
      });
      nextState = 'vetConfirm';
      break;

    // ── Catch-all ────────────────────────────────────────────────────────────
    // Reaching here means session.state holds a value the switch doesn't know
    // about (e.g. a stale session from an old code version). Reset gracefully.
    default:
      console.error(`[ussd] Unknown state "${currentState}" for session ${sessionId}`);
      clearSession(sessionId);
      return res.send('END Something went wrong. Please dial again.');
  }

  // -------------------------------------------------------------------------
  // Advance session and build response
  // -------------------------------------------------------------------------
  session.state = nextState;
  setSession(sessionId, session);

  const stateData = flow.states[nextState];
  if (!stateData) {
    // nextState was set to a value that doesn't exist in the flow JSON
    console.error(`[ussd] State "${nextState}" not found in ${PILOT}.json`);
    clearSession(sessionId);
    return res.send('END State not found. Please dial again.');
  }

  const prompt = stateData.prompt[session.language] || stateData.prompt.english;

  if (stateData.isEnd) {
    clearSession(sessionId);
    return res.send(`END ${prompt}`);
  }

  return res.send(`CON ${prompt}`);
}

module.exports = { handleUSSD };

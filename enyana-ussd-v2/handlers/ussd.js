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
const { sendVetAlert, sendTriageVetAlert }       = require('../services/notify');
const { getFarmer, createFarmer, updateReturningFarmer, saveTriageSession } = require('../services/firestore');

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
function getPrompt(stateName, language, session) {
  const state = flow.states[stateName];
  if (!state) return `[Error: state "${stateName}" not found in flow]`;
  let prompt = state.prompt[language] || state.prompt.english;
  if (session && session.name) prompt = prompt.replace(/\{\{name\}\}/g, session.name);
  return prompt;
}

/** Re-display the current screen (called when the user enters an invalid choice). */
function reshowCurrent(res, stateName, language, session) {
  return res.send(`CON ${getPrompt(stateName, language, session)}`);
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
      state:               'selectLanguage',
      language:            'english',
      phoneNumber,
      community:           null,
      name:                null,
      isReturningFarmer:   false,
      animal:              null,
      inputs:              [],
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
      state:               'selectLanguage',
      language:            'english',
      phoneNumber,
      community:           null,
      name:                null,
      isReturningFarmer:   false,
      animal:              null,
      inputs:              [],
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
    // Show all 3 languages and check Firestore for farmer status
    case 'selectLanguage':
      if (input === '1') {
        session.language = 'english';
      } else if (input === '2') {
        session.language = 'runyankole';
      } else if (input === '3') {
        session.language = 'acholi';
      } else {
        return reshowCurrent(res, 'selectLanguage', session.language, session);
      }

      // Check Firestore to see if this farmer is new or returning
      try {
        const existingFarmer = await getFarmer(phoneNumber);
        if (existingFarmer) {
          // Returning farmer
          session.isReturningFarmer = true;
          session.name = existingFarmer.name;
          session.community = existingFarmer.community;
          // Update lastSeen and totalSessions in Firestore (fire-and-forget)
          updateReturningFarmer(phoneNumber).catch(err => {
            console.error('[ussd] Failed to update returning farmer:', err.message);
          });
          nextState = 'welcomeReturning';
        } else {
          // New farmer
          session.isReturningFarmer = false;
          nextState = 'selectCommunity';
        }
      } catch (err) {
        console.error('[ussd] Firestore check failed:', err.message);
        // Default to new farmer flow if Firestore fails
        session.isReturningFarmer = false;
        nextState = 'selectCommunity';
      }
      break;

    // ── Community selection (first-time only) ────────────────────────────────
    case 'selectCommunity':
      if (input === '1') {
        session.community = 'nyakayojo';
        nextState = 'enterName';
      } else if (input === '2') {
        session.community = 'gulu';
        nextState = 'enterName';
      } else {
        return reshowCurrent(res, 'selectCommunity', session.language, session);
      }
      break;

    // ── Name collection (first-time only) ────────────────────────────────────
    case 'enterName':
      if (!input || !input.trim()) {
        return reshowCurrent(res, 'enterName', session.language, session);
      }
      session.name = input.trim();
      // Save new farmer to Firestore (fire-and-forget)
      createFarmer(phoneNumber, session.name, session.community, session.language).catch(err => {
        console.error('[ussd] Failed to create farmer:', err.message);
      });
      nextState = 'welcomeNewFarmer';
      break;

    // ── Welcome screen for new farmers ───────────────────────────────────────
    case 'welcomeNewFarmer':
      if (input === '1') {
        nextState = 'mainMenu';
      } else if (input === '2') {
        nextState = 'mainMenu';
      } else {
        return reshowCurrent(res, 'welcomeNewFarmer', session.language, session);
      }
      break;

    // ── Welcome screen for returning farmers ─────────────────────────────────
    case 'welcomeReturning':
      if (input === '1') {
        nextState = 'mainMenu';
      } else if (input === '2') {
        nextState = 'mainMenu';
      } else {
        return reshowCurrent(res, 'welcomeReturning', session.language, session);
      }
      break;

    // ── Main menu ────────────────────────────────────────────────────────────
    case 'mainMenu':
      if (input === '1') {
        nextState = 'selectAnimal';
      } else if (input === '2') {
        nextState = 'informationMenu';
      } else if (input === '3') {
        nextState = 'connectVet';
      } else {
        return reshowCurrent(res, 'mainMenu', session.language, session);
      }
      break;

    // ── Information menu placeholder ─────────────────────────────────────────
    case 'informationMenu':
      nextState = 'mainMenu';
      break;

    // ── Vet contact — farmer describes their problem ──────────────────────────
    case 'describeVetProblem':
      if (!input || !input.trim()) {
        return reshowCurrent(res, 'describeVetProblem', session.language, session);
      }
      session.problem = input.trim();
      sendVetAlert(phoneNumber, null, session.problem).catch(err => {
        console.error('[ussd] Vet alert failed:', err.message);
      });
      nextState = 'vetAlertSent';
      break;

    // ── Animal selection ────────────────────────────────────────────────────
    case 'selectAnimal':
      if (input === '1') {
        session.animal      = 'cow';
        session.triageScore = 0;
        session.symptoms    = {};
        nextState = 'cow_triage_duration';
      } else if (input === '2') {
        session.animal = 'goat';
        nextState = 'animalComingSoon';
      } else if (input === '3') {
        session.animal = 'pig';
        nextState = 'animalComingSoon';
      } else if (input === '4') {
        session.animal = 'chicken';
        nextState = 'animalComingSoon';
      } else {
        return reshowCurrent(res, 'selectAnimal', session.language, session);
      }
      break;

    // ── Animal coming soon placeholder ───────────────────────────────────────
    case 'animalComingSoon':
      if (input === '1') {
        nextState = 'connectVet';
      } else {
        return reshowCurrent(res, 'animalComingSoon', session.language, session);
      }
      break;

    // ── Cow triage Q1: Duration ──────────────────────────────────────────────
    case 'cow_triage_duration':
      if (input === '1') {
        session.duration = 'Started today';
      } else if (input === '2') {
        session.duration = '2-3 days';
      } else if (input === '3') {
        session.duration = 'More than 3 days';
      } else {
        return reshowCurrent(res, 'cow_triage_duration', session.language, session);
      }
      nextState = 'cow_triage_eating';
      break;

    // ── Cow triage Q2: Eating/drinking ───────────────────────────────────────
    case 'cow_triage_eating':
      if (input === '1') {
        session.stillEating = true;
      } else if (input === '2') {
        session.stillEating = false;
        session.triageScore += 1;
      } else {
        return reshowCurrent(res, 'cow_triage_eating', session.language, session);
      }
      nextState = 'cow_triage_s1';
      break;

    // ── Cow triage symptom 1: Milk color ─────────────────────────────────────
    case 'cow_triage_s1':
      if (input === '1') {
        session.symptoms.milkColor = true;
        session.triageScore += 1;
      } else if (input === '2') {
        session.symptoms.milkColor = false;
      } else {
        return reshowCurrent(res, 'cow_triage_s1', session.language, session);
      }
      nextState = 'cow_triage_s2';
      break;

    // ── Cow triage symptom 2: Teats swollen/tender ───────────────────────────
    case 'cow_triage_s2':
      if (input === '1') {
        session.symptoms.teatsSwollen = true;
        session.triageScore += 1;
      } else if (input === '2') {
        session.symptoms.teatsSwollen = false;
      } else {
        return reshowCurrent(res, 'cow_triage_s2', session.language, session);
      }
      nextState = 'cow_triage_s3';
      break;

    // ── Cow triage symptom 3: Resists milking ────────────────────────────────
    case 'cow_triage_s3':
      if (input === '1') {
        session.symptoms.resistsMilking = true;
        session.triageScore += 1;
      } else if (input === '2') {
        session.symptoms.resistsMilking = false;
      } else {
        return reshowCurrent(res, 'cow_triage_s3', session.language, session);
      }
      nextState = 'cow_triage_s4';
      break;

    // ── Cow triage symptom 4: Udder hot/swollen/hard ─────────────────────────
    case 'cow_triage_s4':
      if (input === '1') {
        session.symptoms.udderHot = true;
        session.triageScore += 1;
      } else if (input === '2') {
        session.symptoms.udderHot = false;
      } else {
        return reshowCurrent(res, 'cow_triage_s4', session.language, session);
      }
      nextState = 'cow_triage_s5';
      break;

    // ── Cow triage symptom 5: Only one teat ──────────────────────────────────
    case 'cow_triage_s5':
      if (input === '1') {
        session.symptoms.oneTeat = true;
        session.triageScore += 1;
      } else if (input === '2') {
        session.symptoms.oneTeat = false;
      } else {
        return reshowCurrent(res, 'cow_triage_s5', session.language, session);
      }
      nextState = 'cow_triage_s6';
      break;

    // ── Cow triage symptom 6: Udder dark — then calculate outcome ────────────
    case 'cow_triage_s6': {
      if (input === '1') {
        session.symptoms.udderDark = true;
        session.triageScore += 1;
      } else if (input === '2') {
        session.symptoms.udderDark = false;
      } else {
        return reshowCurrent(res, 'cow_triage_s6', session.language, session);
      }

      const score = session.triageScore;
      if (score >= 5) {
        session.triageLevel = 'HIGH';
        session.outcome = 'vet_referral';
        sendTriageVetAlert(session).catch(err => {
          console.error('[ussd] Triage vet alert failed:', err.message);
        });
        saveTriageSession(session).catch(err => {
          console.error('[ussd] Triage session save failed:', err.message);
        });
        nextState = 'cow_triage_high';
      } else if (score >= 3) {
        session.triageLevel = 'MEDIUM';
        nextState = 'cow_triage_medium';
      } else {
        session.triageLevel = 'LOW';
        nextState = 'cow_triage_low';
      }
      break;
    }

    // ── Cow triage outcome: LOW ──────────────────────────────────────────────
    case 'cow_triage_low':
      if (input === '1') {
        session.outcome = 'vet_referral';
        sendTriageVetAlert(session).catch(err => {
          console.error('[ussd] Triage vet alert failed:', err.message);
        });
        saveTriageSession(session).catch(err => {
          console.error('[ussd] Triage session save failed:', err.message);
        });
        nextState = 'cow_triage_vet_sent';
      } else if (input === '2') {
        session.outcome = 'advice';
        saveTriageSession(session).catch(err => {
          console.error('[ussd] Triage session save failed:', err.message);
        });
        nextState = 'cow_triage_no_vet';
      } else {
        return reshowCurrent(res, 'cow_triage_low', session.language, session);
      }
      break;

    // ── Cow triage outcome: MEDIUM ───────────────────────────────────────────
    case 'cow_triage_medium':
      if (input === '1') {
        session.outcome = 'vet_referral';
        sendTriageVetAlert(session).catch(err => {
          console.error('[ussd] Triage vet alert failed:', err.message);
        });
        saveTriageSession(session).catch(err => {
          console.error('[ussd] Triage session save failed:', err.message);
        });
        nextState = 'cow_triage_vet_sent';
      } else if (input === '2') {
        session.outcome = 'advice';
        saveTriageSession(session).catch(err => {
          console.error('[ussd] Triage session save failed:', err.message);
        });
        nextState = 'cow_triage_no_vet';
      } else {
        return reshowCurrent(res, 'cow_triage_medium', session.language, session);
      }
      break;

    // ── Topic selection ─────────────────────────────────────────────────────
    // Routes to {animal}_{topic} states using the animal stored in session.
    // State names are explicit strings (e.g. "cattle_disease") — not counters.
    case 'selectTopic':
      if      (input === '1') nextState = `${session.animal}_disease`;
      else if (input === '2') nextState = `${session.animal}_nutrition`;
      else if (input === '3') nextState = `${session.animal}_breeding`;
      else if (input === '4') nextState = 'connectVet';
      else { return reshowCurrent(res, 'selectTopic', session.language, session); }
      break;

    // ── Vet connection — farmer types their problem as free text ─────────────
    case 'connectVet':
      if (!input || !input.trim()) {
        return reshowCurrent(res, 'connectVet', session.language, session);
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

  const prompt = getPrompt(nextState, session.language, session);

  if (stateData.isEnd) {
    clearSession(sessionId);
    return res.send(`END ${prompt}`);
  }

  return res.send(`CON ${prompt}`);
}

module.exports = { handleUSSD };

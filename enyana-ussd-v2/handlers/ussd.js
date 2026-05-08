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
 *   - Triage question states ({animal}_q{N}) are handled by a single generic
 *     block before the switch to avoid one case per question (58 questions total)
 *   - See CLAUDE.md for the full state routing table
 */

'use strict';

require('dotenv').config();

const path = require('path');
const fs   = require('fs');

const { getSession, setSession, clearSession }                             = require('../services/session');
const { sendVetAlert, sendTriageVetAlert }                                 = require('../services/notify');
const { getFarmer, createFarmer, updateReturningFarmer, saveTriageSession } = require('../services/firestore');
const TRIAGE_CONFIG                                                        = require('../config/triage');

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

/** Return the localised prompt for a state, falling back to English.
 *  Uses promptReturning when the farmer is returning and that key exists. */
function getPrompt(stateName, language, session) {
  const state = flow.states[stateName];
  if (!state) return `[Error: state "${stateName}" not found in flow]`;
  const isReturning = session && session.isReturningFarmer;
  const promptObj   = (isReturning && state.promptReturning) ? state.promptReturning : state.prompt;
  let prompt = promptObj[language] || promptObj.english;
  if (session && session.name) prompt = prompt.replace(/\{\{name\}\}/g, session.name);
  return prompt;
}

/** Re-display the current screen (called when the user enters an invalid choice). */
function reshowCurrent(res, stateName, language, session) {
  return res.send(`CON ${getPrompt(stateName, language, session)}`);
}

/**
 * Map a score to a risk level using the disease's threshold config.
 * thresholds: { MEDIUM: N, HIGH: M } — score >= HIGH → HIGH, etc.
 */
function getLevel(score, thresholds) {
  if (score >= thresholds.HIGH)   return 'HIGH';
  if (score >= thresholds.MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/**
 * Calculate per-disease scores and the overall highest risk level
 * from the recorded symptom answers.
 *
 * Returns { diseaseScores, highestRiskLevel }.
 */
function calculateScores(animal, symptoms) {
  const config     = TRIAGE_CONFIG[animal];
  const RANK       = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  const diseaseScores = {};
  let highestRiskLevel = 'LOW';

  for (const [disease, dc] of Object.entries(config.scoring)) {
    const score      = dc.questions.reduce((n, qId) => n + (symptoms[qId] ? 1 : 0), 0);
    const level      = getLevel(score, dc.thresholds);
    const maxPossible = dc.questions.length;
    diseaseScores[disease] = { score, maxPossible, level };
    if (RANK[level] > RANK[highestRiskLevel]) highestRiskLevel = level;
  }

  return { diseaseScores, highestRiskLevel };
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
      state:             'selectLanguage',
      language:          'english',
      phoneNumber,
      community:         null,
      name:              null,
      isReturningFarmer: false,
      animal:            null,
      inputs:            [],
    };
    await setSession(sessionId, freshSession);
    return res.send(`CON ${getPrompt('selectLanguage', 'english')}`);
  }

  // -------------------------------------------------------------------------
  // RETURNING SESSION — look it up (may have expired after 5 min of inactivity)
  // -------------------------------------------------------------------------
  let session = await getSession(sessionId);

  if (!session) {
    // Session expired — restart cleanly rather than returning a bare error
    const freshSession = {
      state:             'selectLanguage',
      language:          'english',
      phoneNumber,
      community:         null,
      name:              null,
      isReturningFarmer: false,
      animal:            null,
      inputs:            [],
    };
    await setSession(sessionId, freshSession);
    return res.send(
      `CON Your session expired. Starting over...\n\n${getPrompt('selectLanguage', 'english')}`
    );
  }

  // Track all inputs for debugging (not used by the state machine itself)
  session.inputs.push(input);

  const currentState = session.state;
  let nextState      = null;

  // -------------------------------------------------------------------------
  // TRIAGE QUESTION STATES — generic handler
  //
  // Matches states of the form "{animal}_q{N}" (e.g. cattle_q5, rabbit_q1).
  // All 58 symptom questions across all 4 animals are handled here rather than
  // with individual switch cases. Falls through to the common response logic
  // at the bottom of this function after setting nextState.
  // -------------------------------------------------------------------------
  const triageMatch = currentState.match(/^(cattle|poultry|pigs|rabbit)_q(\d+)$/);

  if (triageMatch) {
    const animal  = triageMatch[1];
    const qNum    = parseInt(triageMatch[2], 10);
    const config  = TRIAGE_CONFIG[animal];
    const qId     = config.questions[qNum - 1];

    if (input !== '1' && input !== '2') {
      return reshowCurrent(res, currentState, session.language, session);
    }

    const answered = (input === '1');
    if (!session.symptoms) session.symptoms = {};
    session.symptoms[qId] = answered;

    // Special rule: rabbit R1=Yes — rabbit found dead — skip all remaining
    // questions and route directly to HIGH outcome
    if (config.immediateHigh === qId && answered) {
      const { diseaseScores } = calculateScores(animal, session.symptoms);
      session.diseaseScores    = diseaseScores;
      session.highestRiskLevel = 'HIGH';
      session.outcome          = 'vet_referral';
      sendTriageVetAlert(session).catch(e => console.error('[ussd] Alert failed:', e.message));
      saveTriageSession(session).catch(e => console.error('[ussd] Save failed:', e.message));
      nextState = 'triage_outcome_high';

    } else if (qNum < config.questions.length) {
      // More questions remain — advance to next
      nextState = `${animal}_q${qNum + 1}`;

    } else {
      // All questions answered — calculate outcome
      const { diseaseScores, highestRiskLevel } = calculateScores(animal, session.symptoms);
      session.diseaseScores    = diseaseScores;
      session.highestRiskLevel = highestRiskLevel;

      if (highestRiskLevel === 'HIGH') {
        session.outcome = 'vet_referral';
        sendTriageVetAlert(session).catch(e => console.error('[ussd] Alert failed:', e.message));
        saveTriageSession(session).catch(e => console.error('[ussd] Save failed:', e.message));
        nextState = 'triage_outcome_high';
      } else if (highestRiskLevel === 'MEDIUM') {
        nextState = 'triage_outcome_medium';
      } else {
        nextState = 'triage_outcome_low';
      }
    }

  } else {
    // -----------------------------------------------------------------------
    // NAMED STATE SWITCH — registration, menu, vet contact, triage outcomes
    // -----------------------------------------------------------------------

    switch (currentState) {

      // ── Language selection ────────────────────────────────────────────────
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
            session.isReturningFarmer = true;
            session.name              = existingFarmer.name;
            session.community         = existingFarmer.community;
            updateReturningFarmer(phoneNumber).catch(err => {
              console.error('[ussd] Failed to update returning farmer:', err.message);
            });
            nextState = 'mainMenu';
          } else {
            session.isReturningFarmer = false;
            nextState = 'selectCommunity';
          }
        } catch (err) {
          console.error('[ussd] Firestore check failed:', err.message);
          session.isReturningFarmer = false;
          nextState = 'selectCommunity';
        }
        break;

      // ── Community selection (first-time only) ─────────────────────────────
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

      // ── Name collection (first-time only) ─────────────────────────────────
      case 'enterName':
        if (!input || !input.trim()) {
          return reshowCurrent(res, 'enterName', session.language, session);
        }
        session.name = input.trim();
        createFarmer(phoneNumber, session.name, session.community, session.language).catch(err => {
          console.error('[ussd] Failed to create farmer:', err.message);
        });
        nextState = 'mainMenu';
        break;

      // ── Main menu ──────────────────────────────────────────────────────────
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

      // ── Information menu placeholder ───────────────────────────────────────
      case 'informationMenu':
        nextState = 'mainMenu';
        break;

      // ── Vet contact — farmer describes their problem (legacy path) ─────────
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

      // ── Animal selection ───────────────────────────────────────────────────
      case 'selectAnimal':
        if (input === '1') {
          session.animal   = 'cattle';
          session.symptoms = {};
          nextState = 'cattle_q1';
        } else if (input === '2') {
          session.animal   = 'poultry';
          session.symptoms = {};
          nextState = 'poultry_q1';
        } else if (input === '3') {
          session.animal   = 'pigs';
          session.symptoms = {};
          nextState = 'pigs_q1';
        } else if (input === '4') {
          session.animal   = 'rabbit';
          session.symptoms = {};
          nextState = 'rabbit_q1';
        } else {
          return reshowCurrent(res, 'selectAnimal', session.language, session);
        }
        break;

      // ── Triage outcome: MEDIUM — ask farmer before sending alert ───────────
      case 'triage_outcome_medium':
        if (input === '1') {
          session.outcome = 'vet_referral';
          sendTriageVetAlert(session).catch(e => console.error('[ussd] Alert failed:', e.message));
          saveTriageSession(session).catch(e => console.error('[ussd] Save failed:', e.message));
          nextState = 'triage_vet_sent';
        } else if (input === '2') {
          session.outcome = 'advice';
          saveTriageSession(session).catch(e => console.error('[ussd] Save failed:', e.message));
          nextState = 'triage_no_vet';
        } else {
          return reshowCurrent(res, 'triage_outcome_medium', session.language, session);
        }
        break;

      // ── Triage outcome: LOW — ask farmer before sending alert ──────────────
      case 'triage_outcome_low':
        if (input === '1') {
          session.outcome = 'vet_referral';
          sendTriageVetAlert(session).catch(e => console.error('[ussd] Alert failed:', e.message));
          saveTriageSession(session).catch(e => console.error('[ussd] Save failed:', e.message));
          nextState = 'triage_vet_sent';
        } else if (input === '2') {
          session.outcome = 'advice';
          saveTriageSession(session).catch(e => console.error('[ussd] Save failed:', e.message));
          nextState = 'triage_no_vet';
        } else {
          return reshowCurrent(res, 'triage_outcome_low', session.language, session);
        }
        break;

      // ── Vet connection — farmer types their problem as free text ───────────
      case 'connectVet':
        if (!input || !input.trim()) {
          return reshowCurrent(res, 'connectVet', session.language, session);
        }
        sendVetAlert(phoneNumber, session.animal || 'unknown', input).catch(err => {
          console.error('[ussd] Vet alert failed:', err.message);
        });
        nextState = 'vetConfirm';
        break;

      // ── Catch-all ──────────────────────────────────────────────────────────
      // Reaching here means session.state holds a value the switch doesn't know
      // about (e.g. a stale session from an old code version). Reset gracefully.
      default:
        console.error(`[ussd] Unknown state "${currentState}" for session ${sessionId}`);
        await clearSession(sessionId);
        return res.send('END Something went wrong. Please dial again.');
    }
  }

  // -------------------------------------------------------------------------
  // Advance session and build response
  // -------------------------------------------------------------------------
  session.state = nextState;
  await setSession(sessionId, session);

  const stateData = flow.states[nextState];
  if (!stateData) {
    console.error(`[ussd] State "${nextState}" not found in ${PILOT}.json`);
    await clearSession(sessionId);
    return res.send('END State not found. Please dial again.');
  }

  const prompt = getPrompt(nextState, session.language, session);

  if (stateData.isEnd) {
    await clearSession(sessionId);
    return res.send(`END ${prompt}`);
  }

  return res.send(`CON ${prompt}`);
}

module.exports = { handleUSSD };

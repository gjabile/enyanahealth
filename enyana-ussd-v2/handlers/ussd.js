'use strict';

/**
 * handlers/ussd.js
 * Core USSD state machine. Processes every POST from Africa's Talking (or the
 * browser simulator). Loads the pilot's flow JSON, derives the current state by
 * replaying the full "*"-delimited input history sent on every AT request, then
 * advances to the next state and returns a CON or END response.
 *
 * Response format (required by Africa's Talking):
 *   CON <text>  — session continues, user can type another input
 *   END <text>  — session terminates, text shown as final screen
 *
 * State machine design:
 *   - AT sends the full accumulated text on every request: "" → "1" → "1*2" → ...
 *   - Current state is DERIVED by replaying inputs[0..n-2] through advanceStateSilent
 *   - Only the last input (inputs[n-1]) triggers side effects (Firestore writes, alerts)
 *   - Invalid input re-shows the current screen without advancing state
 *   - Triage question states ({animal}_q{N}) are handled by a single generic block
 *   - See CLAUDE.md for the full state routing table
 */

require('dotenv').config();

const path = require('path');
const fs   = require('fs');

const { sendVetAlert, sendTriageVetAlert }                                  = require('../services/notify');
const { getFarmer, createFarmer, updateReturningFarmer, saveTriageSession } = require('../services/firestore');
const TRIAGE_CONFIG                                                         = require('../config/triage');

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

function getPrompt(stateName, language, session) {
  const state = flow.states[stateName];
  if (!state) return `[Error: state "${stateName}" not found in flow]`;
  const isReturning = session && session.isReturningFarmer;
  const promptObj   = (isReturning && state.promptReturning) ? state.promptReturning : state.prompt;
  let prompt = promptObj[language] || promptObj.english;
  if (session && session.name) prompt = prompt.replace(/\{\{name\}\}/g, session.name);
  return prompt;
}

function reshowCurrent(res, stateName, language, session) {
  return res.send(`CON ${getPrompt(stateName, language, session)}`);
}

function getLevel(score, thresholds) {
  if (score >= thresholds.HIGH)   return 'HIGH';
  if (score >= thresholds.MEDIUM) return 'MEDIUM';
  return 'LOW';
}

function calculateScores(animal, symptoms) {
  const config        = TRIAGE_CONFIG[animal];
  const RANK          = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  const diseaseScores = {};
  let highestRiskLevel = 'LOW';

  for (const [disease, dc] of Object.entries(config.scoring)) {
    const score       = dc.questions.reduce((n, qId) => n + (symptoms[qId] ? 1 : 0), 0);
    const level       = getLevel(score, dc.thresholds);
    const maxPossible = dc.questions.length;
    diseaseScores[disease] = { score, maxPossible, level };
    if (RANK[level] > RANK[highestRiskLevel]) highestRiskLevel = level;
  }

  return { diseaseScores, highestRiskLevel };
}

function makeEmptySession(phoneNumber) {
  return {
    state:             'selectLanguage',
    language:          'english',
    phoneNumber,
    community:         null,
    name:              null,
    isReturningFarmer: false,
    animal:            null,
    vetAnimal:         null,
    symptoms:          {},
    diseaseScores:     null,
    highestRiskLevel:  null,
    outcome:           null,
    problem:           null,
  };
}

function sendStateResponse(res, stateName, session) {
  const stateData = flow.states[stateName];
  if (!stateData) {
    console.error(`[ussd] State "${stateName}" not found in ${PILOT}.json`);
    return res.send('END State not found. Please dial again.');
  }
  const prompt = getPrompt(stateName, session.language, session);
  return res.send(stateData.isEnd ? `END ${prompt}` : `CON ${prompt}`);
}

// ---------------------------------------------------------------------------
// Stateless state machine — advance one step WITHOUT side effects.
//
// Used to replay inputs[0..n-2] and rebuild the current session state from
// the full text string AT sends on every request. No Firestore writes, no
// alerts. farmerData is the pre-fetched getFarmer() result (null = new farmer).
//
// Returns the new session, or the original session if the input is invalid.
// ---------------------------------------------------------------------------
function advanceStateSilent(session, input, farmerData) {
  const currentState = session.state;

  // Triage question states  {animal}_q{N}
  const triageMatch = currentState.match(/^(cattle|poultry|pigs|rabbit)_q(\d+)$/);
  if (triageMatch) {
    if (input !== '1' && input !== '2') return session;

    const animal   = triageMatch[1];
    const qNum     = parseInt(triageMatch[2], 10);
    const config   = TRIAGE_CONFIG[animal];
    const qId      = config.questions[qNum - 1];
    const answered = (input === '1');
    const symptoms = { ...session.symptoms, [qId]: answered };
    const base     = { ...session, symptoms };

    if (config.immediateHigh === qId && answered) {
      const { diseaseScores } = calculateScores(animal, symptoms);
      return { ...base, diseaseScores, highestRiskLevel: 'HIGH', outcome: 'vet_referral', state: 'triage_outcome_high' };
    }
    if (qNum < config.questions.length) {
      return { ...base, state: `${animal}_q${qNum + 1}` };
    }
    const { diseaseScores, highestRiskLevel } = calculateScores(animal, symptoms);
    const nextState = highestRiskLevel === 'HIGH'   ? 'triage_outcome_high'
                    : highestRiskLevel === 'MEDIUM' ? 'triage_outcome_medium'
                    :                                 'triage_outcome_low';
    return { ...base, diseaseScores, highestRiskLevel, state: nextState };
  }

  const next = { ...session };

  switch (currentState) {
    case 'selectLanguage': {
      if      (input === '1') next.language = 'english';
      else if (input === '2') next.language = 'runyankole';
      else if (input === '3') next.language = 'acholi';
      else return session;
      if (farmerData) {
        next.isReturningFarmer = true;
        next.name              = farmerData.name;
        next.community         = farmerData.community;
        next.state             = 'mainMenu';
      } else {
        next.state = 'selectCommunity';
      }
      return next;
    }

    case 'selectCommunity':
      if      (input === '1') { next.community = 'nyakayojo'; next.state = 'enterName'; }
      else if (input === '2') { next.community = 'gulu';      next.state = 'enterName'; }
      else return session;
      return next;

    case 'enterName':
      if (!input || !input.trim()) return session;
      next.name  = input.trim();
      next.state = 'mainMenu';
      return next;

    case 'mainMenu':
      if      (input === '1') next.state = 'selectAnimal';
      else if (input === '2') next.state = 'informationMenu';
      else if (input === '3') next.state = 'selectVetAnimal';
      else return session;
      return next;

    case 'informationMenu':
      if (input !== '1') return session;
      next.state = 'mainMenu';
      return next;

    case 'selectAnimal':
      if      (input === '1') { next.animal = 'cattle';  next.symptoms = {}; next.state = 'cattle_q1';  }
      else if (input === '2') { next.animal = 'poultry'; next.symptoms = {}; next.state = 'poultry_q1'; }
      else if (input === '3') { next.animal = 'pigs';    next.symptoms = {}; next.state = 'pigs_q1';    }
      else if (input === '4') { next.animal = 'rabbit';  next.symptoms = {}; next.state = 'rabbit_q1';  }
      else return session;
      return next;

    case 'triage_outcome_medium':
      if      (input === '1') { next.outcome = 'vet_referral'; next.state = 'triage_vet_sent'; }
      else if (input === '2') { next.outcome = 'advice';       next.state = 'triage_no_vet';   }
      else return session;
      return next;

    case 'triage_outcome_low':
      if      (input === '1') { next.outcome = 'vet_referral'; next.state = 'triage_vet_sent'; }
      else if (input === '2') { next.outcome = 'advice';       next.state = 'triage_no_vet';   }
      else return session;
      return next;

    case 'selectVetAnimal':
      if      (input === '1') { next.vetAnimal = 'cow';     next.state = 'describeVetProblem'; }
      else if (input === '2') { next.vetAnimal = 'poultry'; next.state = 'describeVetProblem'; }
      else if (input === '3') { next.vetAnimal = 'pig';     next.state = 'describeVetProblem'; }
      else if (input === '4') { next.vetAnimal = 'rabbit';  next.state = 'describeVetProblem'; }
      else return session;
      return next;

    case 'describeVetProblem':
      if (!input || !input.trim()) return session;
      next.problem = input.trim();
      next.state   = 'vetConfirm';
      return next;

    default:
      return session;
  }
}

// ---------------------------------------------------------------------------
// Replay all prior inputs to derive the session we're currently in.
// Pure — no side effects.
// ---------------------------------------------------------------------------
function deriveSession(priorInputs, phoneNumber, farmerData) {
  let session = makeEmptySession(phoneNumber);
  for (const input of priorInputs) {
    session = advanceStateSilent(session, input, farmerData);
  }
  return session;
}

// ---------------------------------------------------------------------------
// Main handler — exported and mounted in index.js
// ---------------------------------------------------------------------------

async function handleUSSD(req, res) {
  const { phoneNumber, text = '' } = req.body;

  const inputs = text ? text.split('*') : [];

  // First ping: AT sends empty text — show language selection
  if (inputs.length === 0) {
    return res.send(`CON ${getPrompt('selectLanguage', 'english', {})}`);
  }

  // Pre-fetch farmer record once — used by both the replay and the final step
  let farmerData = null;
  try {
    farmerData = await getFarmer(phoneNumber);
  } catch (err) {
    console.error('[ussd] getFarmer failed:', err.message);
  }

  // Replay all prior inputs to determine the current session state
  const session      = deriveSession(inputs.slice(0, -1), phoneNumber, farmerData);
  const currentState = session.state;
  const input        = inputs[inputs.length - 1];

  // -------------------------------------------------------------------------
  // TRIAGE QUESTION STATES — generic handler (with side effects)
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
    const symptoms = { ...session.symptoms, [qId]: answered };
    let   updated  = { ...session, symptoms };
    let   nextState;

    if (config.immediateHigh === qId && answered) {
      const { diseaseScores } = calculateScores(animal, symptoms);
      updated   = { ...updated, diseaseScores, highestRiskLevel: 'HIGH', outcome: 'vet_referral' };
      sendTriageVetAlert(updated).catch(e => console.error('[ussd] Alert failed:', e.message));
      saveTriageSession(updated).catch(e => console.error('[ussd] Save failed:', e.message));
      nextState = 'triage_outcome_high';

    } else if (qNum < config.questions.length) {
      nextState = `${animal}_q${qNum + 1}`;

    } else {
      const { diseaseScores, highestRiskLevel } = calculateScores(animal, symptoms);
      updated = { ...updated, diseaseScores, highestRiskLevel };
      if (highestRiskLevel === 'HIGH') {
        updated   = { ...updated, outcome: 'vet_referral' };
        sendTriageVetAlert(updated).catch(e => console.error('[ussd] Alert failed:', e.message));
        saveTriageSession(updated).catch(e => console.error('[ussd] Save failed:', e.message));
        nextState = 'triage_outcome_high';
      } else {
        nextState = highestRiskLevel === 'MEDIUM' ? 'triage_outcome_medium' : 'triage_outcome_low';
      }
    }

    return sendStateResponse(res, nextState, updated);
  }

  // -------------------------------------------------------------------------
  // NAMED STATE SWITCH (with side effects)
  // -------------------------------------------------------------------------
  let nextState      = null;
  let sessionUpdates = {};

  switch (currentState) {

    case 'selectLanguage': {
      let language;
      if      (input === '1') language = 'english';
      else if (input === '2') language = 'runyankole';
      else if (input === '3') language = 'acholi';
      else return reshowCurrent(res, 'selectLanguage', session.language, session);

      sessionUpdates.language = language;
      if (farmerData) {
        sessionUpdates.isReturningFarmer = true;
        sessionUpdates.name              = farmerData.name;
        sessionUpdates.community         = farmerData.community;
        updateReturningFarmer(phoneNumber).catch(err =>
          console.error('[ussd] Failed to update returning farmer:', err.message)
        );
        nextState = 'mainMenu';
      } else {
        nextState = 'selectCommunity';
      }
      break;
    }

    case 'selectCommunity':
      if      (input === '1') { sessionUpdates.community = 'nyakayojo'; nextState = 'enterName'; }
      else if (input === '2') { sessionUpdates.community = 'gulu';      nextState = 'enterName'; }
      else return reshowCurrent(res, 'selectCommunity', session.language, session);
      break;

    case 'enterName':
      if (!input || !input.trim()) return reshowCurrent(res, 'enterName', session.language, session);
      sessionUpdates.name = input.trim();
      createFarmer(phoneNumber, input.trim(), session.community, session.language).catch(err =>
        console.error('[ussd] Failed to create farmer:', err.message)
      );
      nextState = 'mainMenu';
      break;

    case 'mainMenu':
      if      (input === '1') nextState = 'selectAnimal';
      else if (input === '2') nextState = 'informationMenu';
      else if (input === '3') nextState = 'selectVetAnimal';
      else return reshowCurrent(res, 'mainMenu', session.language, session);
      break;

    case 'informationMenu':
      if (input !== '1') return reshowCurrent(res, 'informationMenu', session.language, session);
      nextState = 'mainMenu';
      break;

    case 'selectAnimal':
      if      (input === '1') { sessionUpdates.animal = 'cattle';  nextState = 'cattle_q1';  }
      else if (input === '2') { sessionUpdates.animal = 'poultry'; nextState = 'poultry_q1'; }
      else if (input === '3') { sessionUpdates.animal = 'pigs';    nextState = 'pigs_q1';    }
      else if (input === '4') { sessionUpdates.animal = 'rabbit';  nextState = 'rabbit_q1';  }
      else return reshowCurrent(res, 'selectAnimal', session.language, session);
      break;

    case 'triage_outcome_medium': {
      const outcome = input === '1' ? 'vet_referral' : input === '2' ? 'advice' : null;
      if (!outcome) return reshowCurrent(res, 'triage_outcome_medium', session.language, session);
      const saved = { ...session, outcome };
      if (outcome === 'vet_referral') sendTriageVetAlert(saved).catch(e => console.error('[ussd] Alert failed:', e.message));
      saveTriageSession(saved).catch(e => console.error('[ussd] Save failed:', e.message));
      nextState = outcome === 'vet_referral' ? 'triage_vet_sent' : 'triage_no_vet';
      break;
    }

    case 'triage_outcome_low': {
      const outcome = input === '1' ? 'vet_referral' : input === '2' ? 'advice' : null;
      if (!outcome) return reshowCurrent(res, 'triage_outcome_low', session.language, session);
      const saved = { ...session, outcome };
      if (outcome === 'vet_referral') sendTriageVetAlert(saved).catch(e => console.error('[ussd] Alert failed:', e.message));
      saveTriageSession(saved).catch(e => console.error('[ussd] Save failed:', e.message));
      nextState = outcome === 'vet_referral' ? 'triage_vet_sent' : 'triage_no_vet';
      break;
    }

    case 'selectVetAnimal':
      if      (input === '1') { sessionUpdates.vetAnimal = 'cow';     nextState = 'describeVetProblem'; }
      else if (input === '2') { sessionUpdates.vetAnimal = 'poultry'; nextState = 'describeVetProblem'; }
      else if (input === '3') { sessionUpdates.vetAnimal = 'pig';     nextState = 'describeVetProblem'; }
      else if (input === '4') { sessionUpdates.vetAnimal = 'rabbit';  nextState = 'describeVetProblem'; }
      else return reshowCurrent(res, 'selectVetAnimal', session.language, session);
      break;

    case 'describeVetProblem':
      if (!input || !input.trim()) return reshowCurrent(res, 'describeVetProblem', session.language, session);
      sendVetAlert(session, input.trim()).catch(err =>
        console.error('[ussd] Vet alert failed:', err.message)
      );
      nextState = 'vetConfirm';
      break;

    default:
      console.error(`[ussd] Unknown state "${currentState}" for phone ${phoneNumber}`);
      return res.send('END Something went wrong. Please dial again.');
  }

  return sendStateResponse(res, nextState, { ...session, ...sessionUpdates });
}

module.exports = { handleUSSD };

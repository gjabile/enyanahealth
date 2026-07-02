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
 *   - Triage question states (triage_{qIndex}) are handled by a single generic block
 *   - See CLAUDE.md for the full state routing table
 */

require('dotenv').config();

const path = require('path');
const fs   = require('fs');

const { sendVetAlert, sendTriageVetAlert }                                  = require('../services/notify');
const { getFarmer, createFarmer, updateReturningFarmer, saveTriageSession, saveFeedback } = require('../services/firestore');
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

// Tracks AT sessionIds that started registration in this process lifetime.
// Prevents the returning-farmer shortcut from firing mid-registration when
// Firestore already has a record for this phone (created at enterName).
const registrationSessions = new Set();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPrompt(stateName, language, session) {
  // Triage question states are generated dynamically from config — not in flow JSON
  if (stateName.match(/^triage_\d+$/)) {
    const index      = parseInt(stateName.replace('triage_', ''), 10);
    const mergedFlow = getMergedFlow(session.animal);
    const qId        = mergedFlow[index];
    const question   = TRIAGE_CONFIG.questions[qId];

    let promptText = (question.text[language] || question.text.english);

    if (question.type === 'yes_no') {
      promptText += '\n\n1. Yes\n2. No';
    } else if (question.type === 'multiple_choice') {
      question.options.forEach((opt, i) => {
        promptText += `\n${i + 1}. ${getOptionLabel(opt, language)}`;
      });
    } else {
      promptText += '\n(Type your answer)';
    }

    return promptText;
  }

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

function getMergedFlow(animal) {
  const universal = TRIAGE_CONFIG.universalFlow;
  const species   = TRIAGE_CONFIG.speciesFlow[animal] || [];
  return [...universal, ...species];
}

function shouldAskQuestion(qId, session) {
  const q = TRIAGE_CONFIG.questions[qId];
  if (!q.conditional) return true;
  const { question, answer } = q.conditional;
  return session.answers[question] === answer;
}

function getOptionLabel(opt, language) {
  const labels = TRIAGE_CONFIG.optionLabels;
  return (labels[language] && labels[language][opt]) || labels.english[opt] || opt;
}

function calculateScores(animal, answers) {
  const diseases   = TRIAGE_CONFIG.diseases[animal];
  const scoring    = TRIAGE_CONFIG.scoring;
  const riskOrder  = ['LOW', 'MEDIUM', 'HIGH'];
  const diseaseScores = {};
  let highestRiskLevel = 'LOW';

  for (const [disease, config] of Object.entries(diseases)) {
    let score = 0;
    for (const qId of config.questions) {
      const answer = answers[qId];
      if (!answer) continue;
      if (scoring[qId]) {
        score += scoring[qId][answer] || 0;
      } else {
        if (answer === 'yes') score += 1;
      }
    }
    const level = getLevel(score, config.thresholds);
    diseaseScores[disease] = { score, maxPossible: config.questions.length, level };
    if (riskOrder.indexOf(level) > riskOrder.indexOf(highestRiskLevel)) {
      highestRiskLevel = level;
    }
  }

  return { diseaseScores, highestRiskLevel };
}

function getParentTopicSelector(base) {
  const animal = base.split('_')[1];
  return {
    cattle:  'infoSelectTopic_cattle',
    poultry: 'infoSelectTopic_poultry',
    pigs:    'infoSelectTopic_pigs',
    rabbit:  'infoSelectTopic_rabbit',
    goat:    'infoSelectTopic_goat',
    sheep:   'infoSelectTopic_sheep',
    dog:     'infoSelectTopic_dog',
  }[animal] || 'infoSelectAnimal';
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
    answers:           {},
    triageIndex:       0,
    diseaseScores:     null,
    highestRiskLevel:  null,
    outcome:           null,
    problem:           null,
  };
}

function sendStateResponse(res, stateName, session) {
  // Triage question states are always CON — generated from config, not flow JSON
  if (stateName.match(/^triage_\d+$/)) {
    const prompt = getPrompt(stateName, session.language, session);
    return res.send(`CON ${prompt}`);
  }

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

  // Info care content — paginated navigation
  const infoMatch = currentState.match(/^(info_.+)_(\d+)$/);
  if (infoMatch) {
    const base     = infoMatch[1];
    const num      = parseInt(infoMatch[2], 10);
    const nextPage = `${base}_${num + 1}`;
    const hasNext  = !!flow.states[nextPage];
    if      (input === '1') return { ...session, state: hasNext ? nextPage : getParentTopicSelector(base) };
    else if (input === '2') return { ...session, state: getParentTopicSelector(base) };
    return session;
  }

  // Triage question states — triage_{qIndex}
  const triageMatch = currentState.match(/^triage_(\d+)$/);
  if (triageMatch) {
    const index      = parseInt(triageMatch[1], 10);
    const mergedFlow = getMergedFlow(session.animal);
    const qId        = mergedFlow[index];
    const question   = TRIAGE_CONFIG.questions[qId];

    let answer = null;
    if (question.type === 'yes_no') {
      if      (input === '1') answer = 'yes';
      else if (input === '2') answer = 'no';
      else return session;
    } else if (question.type === 'multiple_choice') {
      const optionIndex = parseInt(input, 10) - 1;
      if (optionIndex >= 0 && optionIndex < question.options.length) {
        answer = question.options[optionIndex];
      } else {
        return session;
      }
    } else {
      if (input && input.trim()) {
        answer = input.trim();
      } else {
        return session;
      }
    }

    const newAnswers = { ...session.answers, [qId]: answer };
    const tempBase   = { ...session, answers: newAnswers };

    // Find next non-skipped question
    let nextIndex = index + 1;
    while (nextIndex < mergedFlow.length) {
      if (shouldAskQuestion(mergedFlow[nextIndex], tempBase)) break;
      nextIndex++;
    }

    if (nextIndex < mergedFlow.length) {
      return { ...tempBase, triageIndex: nextIndex, state: `triage_${nextIndex}` };
    }

    // All questions answered — calculate scores
    const { diseaseScores, highestRiskLevel } = calculateScores(session.animal, newAnswers);
    const nextState = highestRiskLevel === 'HIGH'   ? 'triage_outcome_high'
                    : highestRiskLevel === 'MEDIUM' ? 'triage_outcome_medium'
                    :                                 'triage_outcome_low';
    return { ...tempBase, diseaseScores, highestRiskLevel, state: nextState };
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
      else if (input === '3') { next.community = 'nwoya';     next.state = 'enterName'; }
      else if (input === '4') { next.community = 'amuru';     next.state = 'enterName'; }
      else if (input === '5') { next.community = 'pader';     next.state = 'enterName'; }
      else if (input === '6') { next.community = 'kitgum';    next.state = 'enterName'; }
      else return session;
      return next;

    case 'enterName':
      if (!input || !input.trim()) return session;
      next.name  = input.trim();
      next.state = 'mainMenu';
      return next;

    case 'mainMenu':
      if      (input === '1') next.state = 'selectAnimal';
      else if (input === '2') next.state = 'infoSelectAnimal';
      else if (input === '3') next.state = 'selectVetAnimal';
      else if (input === '4') next.state = 'giveFeedback';
      else return session;
      return next;

    case 'giveFeedback':
      if (input && input.trim()) {
        next.feedback = input.trim();
        next.state    = 'feedbackConfirm';
      }
      return next;

    case 'infoSelectAnimal':
      if      (input === '1') next.state = 'infoSelectTopic_cattle';
      else if (input === '2') next.state = 'infoSelectTopic_poultry';
      else if (input === '3') next.state = 'infoSelectTopic_pigs';
      else if (input === '4') next.state = 'infoSelectTopic_rabbit';
      else if (input === '5') next.state = 'infoSelectTopic_goat';
      else if (input === '6') next.state = 'infoSelectTopic_sheep';
      else if (input === '7') next.state = 'infoSelectTopic_dog';
      else return session;
      return next;

    case 'infoSelectTopic_cattle':
      if      (input === '1') next.state = 'info_cattle_nutrition_1';
      else if (input === '2') next.state = 'info_cattle_prevention_1';
      else if (input === '3') next.state = 'info_cattle_ticks_1';
      else if (input === '4') next.state = 'info_cattle_breeding_1';
      else return session;
      return next;

    case 'infoSelectTopic_poultry':
      if      (input === '1') next.state = 'info_poultry_nutrition_1';
      else if (input === '2') next.state = 'info_poultry_care_1';
      else if (input === '3') next.state = 'info_poultry_breeds_1';
      else return session;
      return next;

    case 'infoSelectTopic_pigs':
      if      (input === '1') next.state = 'info_pigs_nutrition_1';
      else if (input === '2') next.state = 'info_pigs_prevention_1';
      else if (input === '3') next.state = 'info_pigs_breeding_1';
      else return session;
      return next;

    case 'infoSelectTopic_rabbit':
      if      (input === '1') next.state = 'info_rabbit_nutrition_1';
      else if (input === '2') next.state = 'info_rabbit_prevention_1';
      else if (input === '3') next.state = 'info_rabbit_breeds_1';
      else return session;
      return next;

    case 'infoSelectTopic_goat':
      if      (input === '1') next.state = 'info_goat_nutrition_1';
      else if (input === '2') next.state = 'info_goat_care_1';
      else if (input === '3') next.state = 'info_goat_prevention_1';
      else if (input === '4') next.state = 'info_goat_ticks_1';
      else if (input === '5') next.state = 'info_goat_breeding_1';
      else return session;
      return next;

    case 'infoSelectTopic_sheep':
      if      (input === '1') next.state = 'info_sheep_nutrition_1';
      else if (input === '2') next.state = 'info_sheep_care_1';
      else if (input === '3') next.state = 'info_sheep_prevention_1';
      else if (input === '4') next.state = 'info_sheep_ticks_1';
      else if (input === '5') next.state = 'info_sheep_breeding_1';
      else return session;
      return next;

    case 'infoSelectTopic_dog':
      if      (input === '1') next.state = 'info_dog_care_1';
      else if (input === '2') next.state = 'info_dog_prevention_1';
      else if (input === '3') next.state = 'info_dog_breeding_1';
      else return session;
      return next;

    case 'selectAnimal': {
      const animals = { '1':'cattle','2':'poultry','3':'pigs','4':'rabbit','5':'goat','6':'sheep','7':'dog' };
      const animal  = animals[input];
      if (!animal) return session;
      next.animal      = animal;
      next.answers     = {};
      next.triageIndex = 0;
      next.state       = 'triage_0';
      return next;
    }

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
  const { sessionId, phoneNumber, text = '' } = req.body;

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

  // If this AT session started registration (createFarmer was called), suppress
  // the returning-farmer shortcut during replay so mid-registration inputs are
  // not mistakenly treated as a returning farmer's fresh dial.
  const isRegistrationSession = registrationSessions.has(sessionId);
  const replayFarmerData      = isRegistrationSession ? null : farmerData;

  // Replay all prior inputs to determine the current session state
  const session      = deriveSession(inputs.slice(0, -1), phoneNumber, replayFarmerData);
  const currentState = session.state;
  const input        = inputs[inputs.length - 1];

  // -------------------------------------------------------------------------
  // TRIAGE QUESTION STATES — generic handler (with side effects)
  // -------------------------------------------------------------------------
  const triageMatch = currentState.match(/^triage_(\d+)$/);

  if (triageMatch) {
    const index      = parseInt(triageMatch[1], 10);
    const mergedFlow = getMergedFlow(session.animal);
    const qId        = mergedFlow[index];
    const question   = TRIAGE_CONFIG.questions[qId];

    let answer = null;
    if (question.type === 'yes_no') {
      if      (input === '1') answer = 'yes';
      else if (input === '2') answer = 'no';
      else return reshowCurrent(res, currentState, session.language, session);
    } else if (question.type === 'multiple_choice') {
      const optionIndex = parseInt(input, 10) - 1;
      if (optionIndex >= 0 && optionIndex < question.options.length) {
        answer = question.options[optionIndex];
      } else {
        return reshowCurrent(res, currentState, session.language, session);
      }
    } else {
      if (input && input.trim()) {
        answer = input.trim();
      } else {
        return reshowCurrent(res, currentState, session.language, session);
      }
    }

    const newAnswers = { ...session.answers, [qId]: answer };
    const tempBase   = { ...session, answers: newAnswers };

    // Find next non-skipped question
    let nextIndex = index + 1;
    while (nextIndex < mergedFlow.length) {
      if (shouldAskQuestion(mergedFlow[nextIndex], tempBase)) break;
      nextIndex++;
    }

    let sessionUpdates = { answers: newAnswers };
    let nextState;

    if (nextIndex < mergedFlow.length) {
      sessionUpdates.triageIndex = nextIndex;
      nextState = `triage_${nextIndex}`;
    } else {
      // All questions answered — calculate scores
      const { diseaseScores, highestRiskLevel } = calculateScores(session.animal, newAnswers);
      sessionUpdates.diseaseScores     = diseaseScores;
      sessionUpdates.highestRiskLevel  = highestRiskLevel;

      if (highestRiskLevel === 'HIGH') {
        sessionUpdates.outcome = 'vet_referral';
        nextState = 'triage_outcome_high';
        sendTriageVetAlert({ ...session, ...sessionUpdates })
          .catch(e => console.error('[ussd] Triage alert failed:', e.message));
      } else {
        nextState = highestRiskLevel === 'MEDIUM' ? 'triage_outcome_medium' : 'triage_outcome_low';
      }
    }

    return sendStateResponse(res, nextState, { ...session, ...sessionUpdates });
  }

  // -------------------------------------------------------------------------
  // INFO CARE CONTENT — generic paginated navigation (no side effects)
  // -------------------------------------------------------------------------
  const infoMatch = currentState.match(/^(info_.+)_(\d+)$/);
  if (infoMatch) {
    const base     = infoMatch[1];
    const num      = parseInt(infoMatch[2], 10);
    const nextPage = `${base}_${num + 1}`;
    const hasNext  = !!flow.states[nextPage];
    if      (input === '1') return sendStateResponse(res, hasNext ? nextPage : getParentTopicSelector(base), session);
    else if (input === '2') return sendStateResponse(res, getParentTopicSelector(base), session);
    return reshowCurrent(res, currentState, session.language, session);
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
      else if (input === '3') { sessionUpdates.community = 'nwoya';     nextState = 'enterName'; }
      else if (input === '4') { sessionUpdates.community = 'amuru';     nextState = 'enterName'; }
      else if (input === '5') { sessionUpdates.community = 'pader';     nextState = 'enterName'; }
      else if (input === '6') { sessionUpdates.community = 'kitgum';    nextState = 'enterName'; }
      else return reshowCurrent(res, 'selectCommunity', session.language, session);
      break;

    case 'enterName':
      if (!input || !input.trim()) return reshowCurrent(res, 'enterName', session.language, session);
      sessionUpdates.name = input.trim();
      try {
        await createFarmer(phoneNumber, input.trim(), session.community, session.language);
        registrationSessions.add(sessionId);
      } catch (err) {
        console.error('[ussd] Failed to create farmer:', err.message);
      }
      nextState = 'mainMenu';
      break;

    case 'mainMenu':
      if      (input === '1') nextState = 'selectAnimal';
      else if (input === '2') nextState = 'infoSelectAnimal';
      else if (input === '3') nextState = 'selectVetAnimal';
      else if (input === '4') nextState = 'giveFeedback';
      else return reshowCurrent(res, 'mainMenu', session.language, session);
      break;

    case 'giveFeedback':
      if (!input || !input.trim()) return reshowCurrent(res, 'giveFeedback', session.language, session);
      saveFeedback(session, input.trim());
      nextState = 'feedbackConfirm';
      break;

    case 'infoSelectAnimal':
      if      (input === '1') nextState = 'infoSelectTopic_cattle';
      else if (input === '2') nextState = 'infoSelectTopic_poultry';
      else if (input === '3') nextState = 'infoSelectTopic_pigs';
      else if (input === '4') nextState = 'infoSelectTopic_rabbit';
      else if (input === '5') nextState = 'infoSelectTopic_goat';
      else if (input === '6') nextState = 'infoSelectTopic_sheep';
      else if (input === '7') nextState = 'infoSelectTopic_dog';
      else return reshowCurrent(res, 'infoSelectAnimal', session.language, session);
      break;

    case 'infoSelectTopic_cattle':
      if      (input === '1') nextState = 'info_cattle_nutrition_1';
      else if (input === '2') nextState = 'info_cattle_prevention_1';
      else if (input === '3') nextState = 'info_cattle_ticks_1';
      else if (input === '4') nextState = 'info_cattle_breeding_1';
      else return reshowCurrent(res, 'infoSelectTopic_cattle', session.language, session);
      break;

    case 'infoSelectTopic_poultry':
      if      (input === '1') nextState = 'info_poultry_nutrition_1';
      else if (input === '2') nextState = 'info_poultry_care_1';
      else if (input === '3') nextState = 'info_poultry_breeds_1';
      else return reshowCurrent(res, 'infoSelectTopic_poultry', session.language, session);
      break;

    case 'infoSelectTopic_pigs':
      if      (input === '1') nextState = 'info_pigs_nutrition_1';
      else if (input === '2') nextState = 'info_pigs_prevention_1';
      else if (input === '3') nextState = 'info_pigs_breeding_1';
      else return reshowCurrent(res, 'infoSelectTopic_pigs', session.language, session);
      break;

    case 'infoSelectTopic_rabbit':
      if      (input === '1') nextState = 'info_rabbit_nutrition_1';
      else if (input === '2') nextState = 'info_rabbit_prevention_1';
      else if (input === '3') nextState = 'info_rabbit_breeds_1';
      else return reshowCurrent(res, 'infoSelectTopic_rabbit', session.language, session);
      break;

    case 'infoSelectTopic_goat':
      if      (input === '1') nextState = 'info_goat_nutrition_1';
      else if (input === '2') nextState = 'info_goat_care_1';
      else if (input === '3') nextState = 'info_goat_prevention_1';
      else if (input === '4') nextState = 'info_goat_ticks_1';
      else if (input === '5') nextState = 'info_goat_breeding_1';
      else return reshowCurrent(res, 'infoSelectTopic_goat', session.language, session);
      break;

    case 'infoSelectTopic_sheep':
      if      (input === '1') nextState = 'info_sheep_nutrition_1';
      else if (input === '2') nextState = 'info_sheep_care_1';
      else if (input === '3') nextState = 'info_sheep_prevention_1';
      else if (input === '4') nextState = 'info_sheep_ticks_1';
      else if (input === '5') nextState = 'info_sheep_breeding_1';
      else return reshowCurrent(res, 'infoSelectTopic_sheep', session.language, session);
      break;

    case 'infoSelectTopic_dog':
      if      (input === '1') nextState = 'info_dog_care_1';
      else if (input === '2') nextState = 'info_dog_prevention_1';
      else if (input === '3') nextState = 'info_dog_breeding_1';
      else return reshowCurrent(res, 'infoSelectTopic_dog', session.language, session);
      break;

    case 'selectAnimal': {
      const animals = { '1':'cattle','2':'poultry','3':'pigs','4':'rabbit','5':'goat','6':'sheep','7':'dog' };
      const animal  = animals[input];
      if (!animal) return reshowCurrent(res, 'selectAnimal', session.language, session);
      sessionUpdates.animal      = animal;
      sessionUpdates.answers     = {};
      sessionUpdates.triageIndex = 0;
      nextState = 'triage_0';
      break;
    }

    case 'triage_outcome_medium': {
      const outcome = input === '1' ? 'vet_referral' : input === '2' ? 'advice' : null;
      if (!outcome) return reshowCurrent(res, 'triage_outcome_medium', session.language, session);
      const saved = { ...session, outcome };
      if (outcome === 'vet_referral') sendTriageVetAlert(saved).catch(e => console.error('[ussd] Alert failed:', e.message));
      else saveTriageSession(saved).catch(e => console.error('[ussd] Save failed:', e.message));
      nextState = outcome === 'vet_referral' ? 'triage_vet_sent' : 'triage_no_vet';
      break;
    }

    case 'triage_outcome_low': {
      const outcome = input === '1' ? 'vet_referral' : input === '2' ? 'advice' : null;
      if (!outcome) return reshowCurrent(res, 'triage_outcome_low', session.language, session);
      const saved = { ...session, outcome };
      if (outcome === 'vet_referral') sendTriageVetAlert(saved).catch(e => console.error('[ussd] Alert failed:', e.message));
      else saveTriageSession(saved).catch(e => console.error('[ussd] Save failed:', e.message));
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

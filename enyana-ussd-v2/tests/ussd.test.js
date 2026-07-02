'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

// ── Mocks ─────────────────────────────────────────────────────────────────────
// Install into require.cache BEFORE requiring the handler so the handler's
// top-level destructuring binds to our stubs, not the real modules.

const firestorePath = require.resolve(path.join(__dirname, '../services/firestore'));
const notifyPath    = require.resolve(path.join(__dirname, '../services/notify'));

let feedbackCalls = [];
let getFarmerImpl = async () => null;

require.cache[firestorePath] = {
  id: firestorePath, filename: firestorePath, loaded: true,
  exports: {
    getFarmer:             (...a) => getFarmerImpl(...a),
    createFarmer:          async () => true,
    updateReturningFarmer: async () => true,
    saveTriageSession:     async () => true,
    saveVetContactSession: async () => true,
    saveFeedback:          (session, msg) => { feedbackCalls.push({ session, message: msg }); },
  },
};

require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true,
  exports: {
    sendVetAlert:       async () => {},
    sendTriageVetAlert: async () => {},
  },
};

process.env.PILOT = 'nyakayojo';

const { handleUSSD } = require('../handlers/ussd');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(text, phoneNumber = '+256700000001', sessionId = 'test-sess') {
  return { body: { sessionId, phoneNumber, text } };
}

function makeRes() {
  const res = { _sent: null };
  res.send = (v) => { res._sent = v; };
  return res;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Feedback flow', () => {
  beforeEach(() => {
    feedbackCalls = [];
    getFarmerImpl = async () => null;
  });

  test('1. mainMenu option 4 routes to giveFeedback', async () => {
    // Returning farmer: input '1' at selectLanguage jumps straight to mainMenu.
    // Then input '4' from mainMenu should advance to giveFeedback.
    getFarmerImpl = async () => ({ name: 'Alice', community: 'nyakayojo' });

    const res = makeRes();
    await handleUSSD(makeReq('1*4'), res);

    assert.ok(res._sent, 'res.send should be called');
    assert.match(res._sent, /^CON /, 'giveFeedback should be a CON (session continues)');
    assert.ok(
      res._sent.includes('Enyana Health'),
      `giveFeedback prompt should mention Enyana Health, got: ${res._sent}`
    );
  });

  test('2. giveFeedback non-empty input routes to feedbackConfirm', async () => {
    getFarmerImpl = async () => ({ name: 'Alice', community: 'nyakayojo' });

    const res = makeRes();
    await handleUSSD(makeReq('1*4*Great service'), res);

    assert.ok(res._sent, 'res.send should be called');
    assert.match(res._sent, /^END /, 'feedbackConfirm should be an END response');
    assert.ok(
      res._sent.includes('Thank you'),
      `feedbackConfirm should include thank-you text, got: ${res._sent}`
    );
    assert.strictEqual(feedbackCalls.length, 1, 'saveFeedback should be called exactly once');
    assert.strictEqual(feedbackCalls[0].message, 'Great service', 'saved message should match input');
  });

  test('3. giveFeedback empty input re-shows giveFeedback', async () => {
    // '1*4*' → inputs ['1','4',''] → last segment is '' → re-show giveFeedback
    getFarmerImpl = async () => ({ name: 'Alice', community: 'nyakayojo' });

    const res = makeRes();
    await handleUSSD(makeReq('1*4*'), res);

    assert.ok(res._sent, 'res.send should be called');
    assert.match(res._sent, /^CON /, 'empty input should keep session open (CON)');
    assert.ok(
      res._sent.includes('Enyana Health'),
      `giveFeedback should be re-shown, got: ${res._sent}`
    );
    assert.strictEqual(feedbackCalls.length, 0, 'saveFeedback should not be called on empty input');
  });

  test('4. Returning farmer full feedback flow', async () => {
    const farmerRecord = { name: 'Bob', community: 'gulu' };
    getFarmerImpl = async () => farmerRecord;

    const phone = '+256700000099';
    const sid   = 'test-sess-bob';

    // Step 1: text='1' — language selection; returning farmer skips registration → mainMenu
    {
      const res = makeRes();
      await handleUSSD(makeReq('1', phone, sid), res);
      assert.match(res._sent, /^CON /, 'step 1: mainMenu should be CON');
      assert.ok(res._sent.includes('Bob'),  'step 1: farmer name should appear in greeting');
      assert.ok(res._sent.includes('4'),    'step 1: option 4 should be listed on mainMenu');
    }

    // Step 2: text='1*4' — select option 4 → giveFeedback
    {
      const res = makeRes();
      await handleUSSD(makeReq('1*4', phone, sid), res);
      assert.match(res._sent, /^CON /, 'step 2: giveFeedback should be CON');
      assert.ok(
        res._sent.includes('Enyana Health'),
        `step 2: giveFeedback prompt should appear, got: ${res._sent}`
      );
    }

    // Step 3: text='1*4*Great service' — submit feedback → feedbackConfirm
    {
      const res = makeRes();
      await handleUSSD(makeReq('1*4*Great service', phone, sid), res);
      assert.match(res._sent, /^END /, 'step 3: feedbackConfirm should be END');
      assert.ok(
        res._sent.includes('Thank you'),
        `step 3: should contain thank-you text, got: ${res._sent}`
      );
      assert.strictEqual(feedbackCalls.length, 1, 'step 3: saveFeedback should be called once');
      assert.strictEqual(feedbackCalls[0].message, 'Great service', 'step 3: saved message should match');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Triage flow
// All tests use a returning farmer: input '1' (lang) goes straight to mainMenu.
// Nav prefix: 1 (lang→mainMenu) * 1 (mainMenu→selectAnimal) * N (selectAnimal→triage)
// ─────────────────────────────────────────────────────────────────────────────

describe('Triage flow', () => {
  beforeEach(() => {
    feedbackCalls = [];
    getFarmerImpl = async () => ({ name: 'Alice', community: 'nyakayojo' });
  });

  test('1. selectAnimal input 1 (cattle) → triage_0 (first universal question)', async () => {
    const res = makeRes();
    await handleUSSD(makeReq('1*1*1'), res);
    assert.match(res._sent, /^CON /, 'should be CON');
    assert.ok(
      res._sent.includes('How old is the animal?'),
      `should show tq_age question, got: ${res._sent}`
    );
  });

  test('2. selectAnimal input 5 (goat) → triage_0 (same first universal question)', async () => {
    const res = makeRes();
    await handleUSSD(makeReq('1*1*5'), res);
    assert.match(res._sent, /^CON /, 'should be CON');
    assert.ok(
      res._sent.includes('How old is the animal?'),
      `should show tq_age question for goat, got: ${res._sent}`
    );
  });

  test('3. triage_0 (tq_age, free_text) answered → advances to triage_1 (tq_breed)', async () => {
    const res = makeRes();
    await handleUSSD(makeReq('1*1*1*3 years'), res);
    assert.match(res._sent, /^CON /, 'should be CON');
    assert.ok(
      res._sent.includes('What breed is the animal?'),
      `should show tq_breed question, got: ${res._sent}`
    );
  });

  test('4. triage_3 (tq_eating, multiple_choice) input 1 → not_eating → triage_4 (tq_duration)', async () => {
    // Reach triage_3: lang(1) main(1) animal(1) age(3 years) breed(Ankole) reproduced(1=yes) eating(1=not_eating)
    const res = makeRes();
    await handleUSSD(makeReq('1*1*1*3 years*Ankole*1*1'), res);
    assert.match(res._sent, /^CON /, 'should be CON');
    assert.ok(
      res._sent.includes('How long has the animal been sick?'),
      `should show tq_duration question, got: ${res._sent}`
    );
  });

  test('5. tq_water answered no → skips tq_urine and tq_urine_color → shows tq_standing', async () => {
    // Reach triage_5 (tq_water) and answer no (2)
    // Prior: lang age(2) breed(Ankole) reproduced(1) eating(3=normal) duration(3)
    const res = makeRes();
    await handleUSSD(makeReq('1*1*1*2*Ankole*1*3*3*2'), res);
    assert.match(res._sent, /^CON /, 'should be CON');
    assert.ok(
      res._sent.includes('Can the animal stand up on its own?'),
      `should show tq_standing (conditional skip worked), got: ${res._sent}`
    );
    assert.ok(
      !res._sent.includes('Is the animal urinating?'),
      `should NOT show tq_urine, got: ${res._sent}`
    );
  });

  test('6. Full cattle triage with high-risk answers → triage_outcome_high (END)', async () => {
    // Full sequence: lang + mainMenu + cattle + all 41 questions answered with high-risk values
    // Conditionals triggered: water=yes→urine, urine=yes→urine_color, standing=no→getup,
    //   getup=no→lying_duration, walking=no→walk_type+limping, diarrhea=yes→stool,
    //   swollen=yes→swollen_part, wounds=yes→wound_part, secretions=yes→secretion_type+secretion_from,
    //   skin=yes→skin_desc, reproduced=yes→reproduction, reproduction=no→repro_problem
    const fullText = [
      '1',        // lang: english (returning farmer → mainMenu)
      '1',        // mainMenu: triage
      '1',        // selectAnimal: cattle → triage_0
      '2',        // triage_0 tq_age (free_text): "2"
      'Ankole',   // triage_1 tq_breed (free_text)
      '1',        // triage_2 tq_reproduced: yes
      '1',        // triage_3 tq_eating: not_eating
      '3',        // triage_4 tq_duration (free_text): "3"
      '1',        // triage_5 tq_water: yes → tq_urine asked
      '1',        // triage_6 tq_urine: yes → tq_urine_color asked
      '1',        // triage_7 tq_urine_color: bloody
      '2',        // triage_8 tq_standing: no → tq_getup asked
      '2',        // triage_9 tq_getup: no → tq_lying_duration asked
      '2',        // triage_10 tq_lying_duration (free_text): "2"
      '2',        // triage_11 tq_walking: no → tq_walk_type + tq_limping asked
      '1',        // triage_12 tq_walk_type: circles
      '1',        // triage_13 tq_limping: yes
      '1',        // triage_14 tq_cough: yes
      '1',        // triage_15 tq_diarrhea: yes → tq_stool asked
      '1',        // triage_16 tq_stool: bloody
      '1',        // triage_17 tq_swollen: yes → tq_swollen_part asked
      'neck',     // triage_18 tq_swollen_part (free_text)
      '1',        // triage_19 tq_lymph: yes
      '1',        // triage_20 tq_wounds: yes → tq_wound_part asked
      'mouth',    // triage_21 tq_wound_part (free_text)
      '1',        // triage_22 tq_secretions: yes → tq_secretion_type + tq_secretion_from asked
      '1',        // triage_23 tq_secretion_type: blood
      'nose',     // triage_24 tq_secretion_from (free_text)
      '1',        // triage_25 tq_skin: yes → tq_skin_desc asked
      'patches',  // triage_26 tq_skin_desc (free_text)
      '1',        // triage_27 tq_vomiting: yes
      '1',        // triage_28 tq_sudden_death: yes
      '1',        // triage_29 tq_noise: yes
      '1',        // triage_30 tq_sight: yes
      '1',        // triage_31 tq_hair_loss: yes
      'FMD',      // triage_32 tq_vaccination (free_text)
      '1',        // triage_33 tq_udder: yes
      '1',        // triage_34 tq_milk: stopped
      '2',        // triage_35 tq_reproduction: no (cond: reproduced=yes → asked)
      'failed',   // triage_36 tq_repro_problem (cond: reproduction=no → asked)
      '1',        // triage_37 tq_feed: yes
      '1',        // triage_38 tq_shelter: yes
      '1',        // triage_39 tq_ectoparasites: yes
      '1',        // triage_40 tq_deworm: yes (LAST question → triggers scoring)
    ].join('*');

    const res = makeRes();
    await handleUSSD(makeReq(fullText), res);
    assert.match(
      res._sent, /^END /,
      `triage_outcome_high should be END (HIGH risk auto-refers to vet), got: ${res._sent}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Animal care info flow
// All tests use a returning farmer so that input '1' goes straight to mainMenu.
// ─────────────────────────────────────────────────────────────────────────────

describe('Animal care info flow', () => {
  beforeEach(() => {
    feedbackCalls = [];
    getFarmerImpl = async () => ({ name: 'Alice', community: 'nyakayojo' });
  });

  test('1. mainMenu option 2 → infoSelectAnimal', async () => {
    const res = makeRes();
    await handleUSSD(makeReq('1*2'), res);
    assert.match(res._sent, /^CON /, 'should be CON');
    assert.ok(
      res._sent.includes('Which animal do you need help with'),
      `should show infoSelectAnimal prompt, got: ${res._sent}`
    );
  });

  test('2. infoSelectAnimal option 1 → infoSelectTopic_cattle', async () => {
    const res = makeRes();
    await handleUSSD(makeReq('1*2*1'), res);
    assert.match(res._sent, /^CON /, 'should be CON');
    assert.ok(
      res._sent.includes('Cattle'),
      `should show cattle topic menu, got: ${res._sent}`
    );
  });

  test('3. infoSelectTopic_cattle option 1 → info_cattle_nutrition_1', async () => {
    const res = makeRes();
    await handleUSSD(makeReq('1*2*1*1'), res);
    assert.match(res._sent, /^CON /, 'should be CON');
    assert.ok(
      res._sent.includes('Cattle Feed (1/5)'),
      `should show nutrition page 1, got: ${res._sent}`
    );
  });

  test('4. info_cattle_nutrition_1 option 1 → info_cattle_nutrition_2 (Next)', async () => {
    const res = makeRes();
    await handleUSSD(makeReq('1*2*1*1*1'), res);
    assert.match(res._sent, /^CON /, 'should be CON');
    assert.ok(
      res._sent.includes('Cattle Feed (2/5)'),
      `should show nutrition page 2, got: ${res._sent}`
    );
  });

  test('5. info_cattle_nutrition_1 option 2 → infoSelectTopic_cattle (Back)', async () => {
    const res = makeRes();
    await handleUSSD(makeReq('1*2*1*1*2'), res);
    assert.match(res._sent, /^CON /, 'should be CON');
    assert.ok(
      res._sent.includes('Cattle'),
      `should return to cattle topic menu, got: ${res._sent}`
    );
    assert.ok(
      !res._sent.includes('Cattle Feed'),
      `should NOT show a feed slide, got: ${res._sent}`
    );
  });

  test('6. info_cattle_nutrition_5 option 1 → infoSelectTopic_cattle (Final screen back)', async () => {
    // Navigate: language(1) → infoSelectAnimal(2) → cattle(1) → nutrition(1) → Next×4 → final Back(1)
    const res = makeRes();
    await handleUSSD(makeReq('1*2*1*1*1*1*1*1*1'), res);
    assert.match(res._sent, /^CON /, 'final slide back should return to CON topic menu');
    assert.ok(
      res._sent.includes('Cattle'),
      `should return to cattle topic menu, got: ${res._sent}`
    );
    assert.ok(
      !res._sent.includes('Cattle Feed'),
      `should NOT show a feed slide, got: ${res._sent}`
    );
  });
});

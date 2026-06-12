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

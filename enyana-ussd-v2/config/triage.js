'use strict';

/**
 * config/triage.js
 * Triage scoring configuration for all four animals.
 *
 * Schema per animal:
 *   questions   - ordered array of question IDs (matches state suffix, e.g. 'c1')
 *   labels      - short English description per question ID (used in vet alert)
 *   scoring     - map of disease → { questions: [qId,...], thresholds: {MEDIUM,HIGH} }
 *   immediateHigh - (optional) if this question ID is answered Yes, skip remaining
 *                   questions and force the overall outcome to HIGH immediately
 *
 * Threshold logic: score >= HIGH → HIGH; score >= MEDIUM → MEDIUM; else → LOW
 */

module.exports = {

  // ---------------------------------------------------------------------------
  // CATTLE  (13 questions, 4 diseases)
  // ---------------------------------------------------------------------------
  cattle: {
    questions: ['c1','c2','c3','c4','c5','c6','c7','c8','c9','c10','c11','c12','c13'],
    labels: {
      c1:  'Very high fever',
      c2:  'Stopped eating or became very weak quickly',
      c3:  'Difficulty breathing',
      c4:  'Swollen lumps on neck, chest or legs',
      c5:  'Milk looks different — watery, lumpy or bloody',
      c6:  'Udder hot, swollen or hard',
      c7:  'Kicks or refuses to be milked',
      c8:  'Cracks, wounds or darkening on teats',
      c9:  'Sores or blisters in mouth, drooling heavily',
      c10: 'Limping badly or refusing to stand',
      c11: 'Lost calf early, or dead/weak calf at birth',
      c12: 'Failed to get pregnant again after giving birth',
      c13: 'Bull has swollen testicles',
    },
    scoring: {
      Mastitis: {
        questions:  ['c5','c6','c7','c8'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Brucellosis: {
        questions:  ['c11','c12','c13'],
        thresholds: { MEDIUM: 1, HIGH: 2 },
      },
      ECF: {
        questions:  ['c1','c2','c3','c4'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      FMD: {
        questions:  ['c1','c2','c5','c9','c10'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
    },
  },

  // ---------------------------------------------------------------------------
  // POULTRY  (11 questions, 3 diseases)
  // ---------------------------------------------------------------------------
  poultry: {
    questions: ['p1','p2','p3','p4','p5','p6','p7','p8','p9','p10','p11'],
    labels: {
      p1:  'Birds died suddenly with no warning',
      p2:  'Head, face or wattles swollen and dark purple',
      p3:  'Birds stopped eating or laying eggs',
      p4:  'Watery or bloody diarrhea',
      p5:  'Gasping for air, coughing or gurgling sounds',
      p6:  'Twisting neck or walking in circles',
      p7:  'Diarrhea bright green in color',
      p8:  'Egg production dropped suddenly',
      p9:  'Birds look hunched, fluffed up and dull',
      p10: 'Chicks not growing and losing weight fast',
      p11: 'Birds drinking a lot but refusing to eat',
    },
    scoring: {
      'Avian Flu': {
        questions:  ['p1','p2','p3','p4','p8'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Newcastle: {
        questions:  ['p1','p3','p5','p6','p7','p8'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Coccidiosis: {
        questions:  ['p3','p4','p9','p10','p11'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
    },
  },

  // ---------------------------------------------------------------------------
  // PIGS  (16 questions, 6 diseases)
  // ---------------------------------------------------------------------------
  pigs: {
    questions: [
      'pg1','pg2','pg3','pg4','pg5','pg6','pg7','pg8',
      'pg9','pg10','pg11','pg12','pg13','pg14','pg15','pg16',
    ],
    labels: {
      pg1:  'Pigs died suddenly, spreading through the herd fast',
      pg2:  'High fever and refuses to move',
      pg3:  'Red or purple patches on skin',
      pg4:  'Diarrhea with blood',
      pg5:  'Sow gave birth to dead or very weak piglets',
      pg6:  'Piglets died within days of birth',
      pg7:  'Coughing or struggling to breathe',
      pg8:  'Ears turning bluish or purple',
      pg9:  'Sores in mouth, drooling and refusing to eat',
      pg10: 'Limping or refusing to walk',
      pg11: 'Blisters on snout or between hooves',
      pg12: 'Watery diarrhea with blood and mucus',
      pg13: 'Losing weight rapidly',
      pg14: 'Swollen belly, especially in young pigs',
      pg15: 'Worms visible in feces',
      pg16: 'Diamond-shaped red patches on skin',
    },
    scoring: {
      ASF: {
        questions:  ['pg1','pg2','pg3','pg4'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      PRRS: {
        questions:  ['pg5','pg6','pg7','pg8'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      FMD: {
        questions:  ['pg2','pg9','pg10','pg11','pg13'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Erysipelas: {
        questions:  ['pg1','pg2','pg3','pg10','pg16'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Dysentery: {
        questions:  ['pg4','pg12','pg13'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Ascariasis: {
        questions:  ['pg7','pg13','pg14','pg15'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
    },
  },

  // ---------------------------------------------------------------------------
  // RABBIT  (18 questions, 6 diseases)
  // ---------------------------------------------------------------------------
  rabbit: {
    questions: [
      'r1','r2','r3','r4','r5','r6','r7','r8','r9',
      'r10','r11','r12','r13','r14','r15','r16','r17','r18',
    ],
    labels: {
      r1:  'Rabbit found dead with no prior signs of illness',
      r2:  'Bleeding from the nose or mouth',
      r3:  'Sudden extreme weakness or seizures',
      r4:  'Stopped eating and drinking completely',
      r5:  'Watery or bloody droppings',
      r6:  'Swollen pot-belly',
      r7:  'Hunched in a corner and not moving',
      r8:  'Thick white or yellow discharge from nose',
      r9:  'Sneezing constantly',
      r10: 'Front paws wet and matted',
      r11: 'Eyes watery or crusty',
      r12: 'Puffy swelling around eyes, ears or nose',
      r13: 'Fluid-filled lumps under the skin',
      r14: 'Shaking head or scratching ears constantly',
      r15: 'Brown crusty discharge inside the ears',
      r16: 'Head tilting to one side',
      r17: 'Abdomen feels hard or bloated',
      r18: 'Grinding teeth',
    },
    scoring: {
      RHD: {
        questions:  ['r1','r2','r3'],
        thresholds: { MEDIUM: 1, HIGH: 2 },
      },
      Coccidiosis: {
        questions:  ['r4','r5','r6','r7'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Snuffles: {
        questions:  ['r8','r9','r10','r11'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Myxomatosis: {
        questions:  ['r4','r11','r12','r13'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      'Ear Mites': {
        questions:  ['r14','r15','r16'],
        thresholds: { MEDIUM: 1, HIGH: 2 },
      },
      'GI Stasis': {
        questions:  ['r4','r6','r7','r17','r18'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
    },
    // r1=Yes alone is sufficient for an immediate HIGH outcome — skip all other questions
    immediateHigh: 'r1',
  },

};

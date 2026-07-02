'use strict';

/**
 * config/triage.js
 * Vet-approved triage question flow and disease scoring matrix.
 *
 * Structure:
 *   questions    - definitions for every question ID (type, text, conditional)
 *   universalFlow - ordered question IDs asked to every animal
 *   speciesFlow   - additional question IDs asked per species, appended after universal
 *   diseases      - per-species disease definitions with scoring questions and thresholds
 *   scoring       - explicit score values for multiple-choice questions and reversed yes/no;
 *                   yes/no questions not listed here default to: yes=1, no=0
 *
 * Threshold logic: score >= HIGH → HIGH; score >= MEDIUM → MEDIUM; else → LOW
 * Conditional questions are skipped (score 0) when the parent answer does not match.
 */

module.exports = {

  // ---------------------------------------------------------------------------
  // QUESTION DEFINITIONS
  // ---------------------------------------------------------------------------
  questions: {

    // ── Universal ─────────────────────────────────────────────────────────────

    tq_age: {
      id: 'tq_age',
      text: 'How old is the animal?',
      type: 'free_text',
      scoringQuestion: false,
      conditional: null,
    },
    tq_breed: {
      id: 'tq_breed',
      text: 'What breed is the animal?',
      type: 'free_text',
      scoringQuestion: false,
      conditional: null,
    },
    tq_reproduced: {
      id: 'tq_reproduced',
      text: 'Has this animal ever given birth or reproduced?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_eating: {
      id: 'tq_eating',
      text: 'How is the animal eating?',
      type: 'multiple_choice',
      options: ['not_eating', 'eats_less', 'normal'],
      scoringQuestion: true,
      conditional: null,
    },
    tq_duration: {
      id: 'tq_duration',
      text: 'How long has the animal been sick?',
      type: 'free_text',
      scoringQuestion: false,
      conditional: null,
    },
    tq_water: {
      id: 'tq_water',
      text: 'Is the animal drinking water?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_urine: {
      id: 'tq_urine',
      text: 'Is the animal urinating?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: { question: 'tq_water', answer: 'yes' },
    },
    tq_urine_color: {
      id: 'tq_urine_color',
      text: 'What colour is the urine?',
      type: 'multiple_choice',
      options: ['bloody', 'very_dark', 'colourless', 'normal'],
      scoringQuestion: true,
      conditional: { question: 'tq_urine', answer: 'yes' },
    },
    tq_standing: {
      id: 'tq_standing',
      text: 'Can the animal stand up on its own?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_getup: {
      id: 'tq_getup',
      text: 'Can the animal get up if you help it?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: { question: 'tq_standing', answer: 'no' },
    },
    tq_lying_duration: {
      id: 'tq_lying_duration',
      text: 'How long has it been unable to get up?',
      type: 'free_text',
      scoringQuestion: false,
      conditional: { question: 'tq_getup', answer: 'no' },
    },
    tq_walking: {
      id: 'tq_walking',
      text: 'Can the animal walk normally?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_walk_type: {
      id: 'tq_walk_type',
      text: 'How is the animal moving?',
      type: 'multiple_choice',
      options: ['circles', 'stumbling', 'not_walking', 'straight'],
      scoringQuestion: true,
      conditional: { question: 'tq_walking', answer: 'no' },
    },
    tq_limping: {
      id: 'tq_limping',
      text: 'Is the animal limping?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: { question: 'tq_walking', answer: 'no' },
    },
    tq_cough: {
      id: 'tq_cough',
      text: 'Is the animal coughing?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_diarrhea: {
      id: 'tq_diarrhea',
      text: 'Does the animal have diarrhea?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_stool: {
      id: 'tq_stool',
      text: 'What does the stool look like?',
      type: 'multiple_choice',
      options: ['bloody', 'watery', 'hard', 'normal'],
      scoringQuestion: true,
      conditional: { question: 'tq_diarrhea', answer: 'yes' },
    },
    tq_swollen: {
      id: 'tq_swollen',
      text: 'Is any part of the body swollen?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_swollen_part: {
      id: 'tq_swollen_part',
      text: 'Which part of the body is swollen?',
      type: 'free_text',
      scoringQuestion: false,
      conditional: { question: 'tq_swollen', answer: 'yes' },
    },
    tq_lymph: {
      id: 'tq_lymph',
      text: 'Are the lymph nodes (glands on the neck or legs) swollen?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_wounds: {
      id: 'tq_wounds',
      text: 'Does the animal have any wounds or sores?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_wound_part: {
      id: 'tq_wound_part',
      text: 'Where are the wounds or sores?',
      type: 'free_text',
      scoringQuestion: false,
      conditional: { question: 'tq_wounds', answer: 'yes' },
    },
    tq_secretions: {
      id: 'tq_secretions',
      text: 'Does the animal have any discharge or secretions?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_secretion_type: {
      id: 'tq_secretion_type',
      text: 'What type of discharge?',
      type: 'multiple_choice',
      options: ['blood', 'pus', 'froth', 'mucus'],
      scoringQuestion: true,
      conditional: { question: 'tq_secretions', answer: 'yes' },
    },
    tq_secretion_from: {
      id: 'tq_secretion_from',
      text: 'Where is the discharge coming from?',
      type: 'free_text',
      scoringQuestion: false,
      conditional: { question: 'tq_secretions', answer: 'yes' },
    },
    tq_skin: {
      id: 'tq_skin',
      text: 'Does the animal have any skin problems (rash, patches or lesions)?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_skin_desc: {
      id: 'tq_skin_desc',
      text: 'Describe the skin problem.',
      type: 'free_text',
      scoringQuestion: false,
      conditional: { question: 'tq_skin', answer: 'yes' },
    },
    tq_vomiting: {
      id: 'tq_vomiting',
      text: 'Is the animal vomiting?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_sudden_death: {
      id: 'tq_sudden_death',
      text: 'Have any animals in the group died suddenly?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_noise: {
      id: 'tq_noise',
      text: 'Is the animal making unusual sounds or crying out?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_sight: {
      id: 'tq_sight',
      text: 'Does the animal seem to have problems with its eyesight?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_hair_loss: {
      id: 'tq_hair_loss',
      text: 'Is the animal losing hair or wool?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_vaccination: {
      id: 'tq_vaccination',
      text: 'What vaccinations has the animal received?',
      type: 'free_text',
      scoringQuestion: false,
      conditional: null,
    },

    // ── Species-specific ──────────────────────────────────────────────────────

    tq_udder: {
      id: 'tq_udder',
      text: 'Is the udder swollen, hard or painful?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: null,
    },
    tq_milk: {
      id: 'tq_milk',
      text: 'How is milk production?',
      type: 'multiple_choice',
      options: ['stopped', 'different', 'less', 'normal'],
      scoringQuestion: true,
      conditional: null,
    },
    tq_reproduction: {
      id: 'tq_reproduction',
      text: 'Has the animal reproduced successfully since the last time?',
      type: 'yes_no',
      scoringQuestion: true,
      conditional: { question: 'tq_reproduced', answer: 'yes' },
    },
    tq_repro_problem: {
      id: 'tq_repro_problem',
      text: 'Describe the reproductive problem.',
      type: 'free_text',
      scoringQuestion: false,
      conditional: { question: 'tq_reproduction', answer: 'no' },
    },
    tq_eggs: {
      id: 'tq_eggs',
      text: 'How is egg production?',
      type: 'multiple_choice',
      options: ['stopped', 'less', 'normal'],
      scoringQuestion: true,
      conditional: null,
    },
    tq_feed: {
      id: 'tq_feed',
      text: 'Is the animal getting adequate feed?',
      type: 'yes_no',
      scoringQuestion: false,
      conditional: null,
    },
    tq_shelter: {
      id: 'tq_shelter',
      text: 'Does the animal have adequate shelter?',
      type: 'yes_no',
      scoringQuestion: false,
      conditional: null,
    },
    tq_ectoparasites: {
      id: 'tq_ectoparasites',
      text: 'Does the animal have visible ticks, lice or mites?',
      type: 'yes_no',
      scoringQuestion: false,
      conditional: null,
    },
    tq_deworm: {
      id: 'tq_deworm',
      text: 'Has the animal been dewormed in the last 3 months?',
      type: 'yes_no',
      scoringQuestion: false,
      conditional: null,
    },
  },

  // ---------------------------------------------------------------------------
  // UNIVERSAL FLOW — asked for every animal, in this order
  // ---------------------------------------------------------------------------
  universalFlow: [
    'tq_age',
    'tq_breed',
    'tq_reproduced',
    'tq_eating',
    'tq_duration',
    'tq_water',
    'tq_urine',
    'tq_urine_color',
    'tq_standing',
    'tq_getup',
    'tq_lying_duration',
    'tq_walking',
    'tq_walk_type',
    'tq_limping',
    'tq_cough',
    'tq_diarrhea',
    'tq_stool',
    'tq_swollen',
    'tq_swollen_part',
    'tq_lymph',
    'tq_wounds',
    'tq_wound_part',
    'tq_secretions',
    'tq_secretion_type',
    'tq_secretion_from',
    'tq_skin',
    'tq_skin_desc',
    'tq_vomiting',
    'tq_sudden_death',
    'tq_noise',
    'tq_sight',
    'tq_hair_loss',
    'tq_vaccination',
  ],

  // ---------------------------------------------------------------------------
  // SPECIES FLOW — appended after universalFlow for each animal
  // ---------------------------------------------------------------------------
  speciesFlow: {
    cattle: [
      'tq_udder',
      'tq_milk',
      'tq_reproduction',
      'tq_repro_problem',
      'tq_feed',
      'tq_shelter',
      'tq_ectoparasites',
      'tq_deworm',
    ],
    poultry: [
      'tq_eggs',
      'tq_feed',
      'tq_shelter',
      'tq_ectoparasites',
      'tq_deworm',
    ],
    pigs: [
      'tq_feed',
      'tq_shelter',
      'tq_ectoparasites',
      'tq_deworm',
    ],
    rabbit: [
      'tq_feed',
      'tq_shelter',
      'tq_ectoparasites',
      'tq_deworm',
    ],
    goat: [
      'tq_udder',
      'tq_milk',
      'tq_reproduction',
      'tq_repro_problem',
      'tq_feed',
      'tq_shelter',
      'tq_ectoparasites',
      'tq_deworm',
    ],
    sheep: [
      'tq_reproduction',
      'tq_repro_problem',
      'tq_feed',
      'tq_shelter',
      'tq_ectoparasites',
      'tq_deworm',
    ],
    dog: [
      'tq_feed',
      'tq_shelter',
      'tq_ectoparasites',
      'tq_deworm',
    ],
  },

  // ---------------------------------------------------------------------------
  // DISEASE SCORING MATRIX
  // ---------------------------------------------------------------------------
  diseases: {

    cattle: {
      Mastitis: {
        questions:  ['tq_udder', 'tq_milk', 'tq_secretions', 'tq_limping'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Brucellosis: {
        questions:  ['tq_reproduction', 'tq_reproduced', 'tq_udder'],
        thresholds: { MEDIUM: 1, HIGH: 2 },
      },
      ECF: {
        questions:  ['tq_lymph', 'tq_eating', 'tq_cough', 'tq_swollen'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      FMD: {
        questions:  ['tq_limping', 'tq_secretions', 'tq_wounds', 'tq_milk', 'tq_vomiting'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
    },

    poultry: {
      'Avian Flu': {
        questions:  ['tq_sudden_death', 'tq_swollen', 'tq_eating', 'tq_diarrhea'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Newcastle: {
        questions:  ['tq_cough', 'tq_walk_type', 'tq_eggs', 'tq_diarrhea'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Coccidiosis: {
        questions:  ['tq_diarrhea', 'tq_stool', 'tq_eating', 'tq_water'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
    },

    pigs: {
      ASF: {
        questions:  ['tq_sudden_death', 'tq_skin', 'tq_standing', 'tq_diarrhea'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      PRRS: {
        questions:  ['tq_reproduced', 'tq_reproduction', 'tq_cough'],
        thresholds: { MEDIUM: 1, HIGH: 2 },
      },
      FMD: {
        questions:  ['tq_secretions', 'tq_limping', 'tq_wounds', 'tq_vomiting'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Erysipelas: {
        questions:  ['tq_skin', 'tq_limping', 'tq_sudden_death'],
        thresholds: { MEDIUM: 1, HIGH: 2 },
      },
      'Swine Dysentery': {
        questions:  ['tq_diarrhea', 'tq_stool', 'tq_standing'],
        thresholds: { MEDIUM: 1, HIGH: 2 },
      },
      Ascariasis: {
        questions:  ['tq_cough', 'tq_swollen', 'tq_eating'],
        thresholds: { MEDIUM: 1, HIGH: 2 },
      },
    },

    rabbit: {
      Coccidiosis: {
        questions:  ['tq_diarrhea', 'tq_swollen', 'tq_eating', 'tq_standing'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Snuffles: {
        questions:  ['tq_secretions', 'tq_secretion_type'],
        thresholds: { MEDIUM: 1, HIGH: 2 },
      },
      Myxomatosis: {
        questions:  ['tq_swollen', 'tq_lymph', 'tq_skin', 'tq_eating'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      'Ear Mites': {
        questions:  ['tq_noise', 'tq_skin', 'tq_sight'],
        thresholds: { MEDIUM: 1, HIGH: 2 },
      },
      RHD: {
        questions:  ['tq_sudden_death', 'tq_secretions'],
        thresholds: { MEDIUM: 1, HIGH: 2 },
      },
      'GI Stasis': {
        questions:  ['tq_eating', 'tq_diarrhea', 'tq_swollen', 'tq_vomiting'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
    },

    goat: {
      Helminthosis: {
        questions:  ['tq_eating', 'tq_standing', 'tq_diarrhea', 'tq_swollen', 'tq_hair_loss'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      FMD: {
        questions:  ['tq_limping', 'tq_wounds', 'tq_secretions', 'tq_milk'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Brucellosis: {
        questions:  ['tq_reproduction', 'tq_udder'],
        thresholds: { MEDIUM: 1, HIGH: 2 },
      },
      Clostridial: {
        questions:  ['tq_sudden_death', 'tq_standing', 'tq_walking', 'tq_vomiting'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
    },

    sheep: {
      Helminthosis: {
        questions:  ['tq_eating', 'tq_standing', 'tq_diarrhea', 'tq_swollen', 'tq_hair_loss'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      FMD: {
        questions:  ['tq_limping', 'tq_wounds', 'tq_secretions'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Brucellosis: {
        questions:  ['tq_reproduction', 'tq_reproduced'],
        thresholds: { MEDIUM: 1, HIGH: 2 },
      },
      Clostridial: {
        questions:  ['tq_sudden_death', 'tq_standing', 'tq_walking', 'tq_vomiting'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
    },

    dog: {
      Rabies: {
        questions:  ['tq_noise', 'tq_sight', 'tq_walking', 'tq_vomiting', 'tq_sudden_death'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Worms: {
        questions:  ['tq_eating', 'tq_swollen', 'tq_hair_loss', 'tq_diarrhea'],
        thresholds: { MEDIUM: 2, HIGH: 3 },
      },
      Mange: {
        questions:  ['tq_skin', 'tq_hair_loss'],
        thresholds: { MEDIUM: 1, HIGH: 2 },
      },
    },

  },

  // ---------------------------------------------------------------------------
  // SCORING VALUES
  // Multiple-choice questions and reversed yes/no questions are listed here.
  // All other yes/no questions default to: yes = 1, no = 0.
  // ---------------------------------------------------------------------------
  scoring: {
    tq_eating: {
      not_eating: 1,
      eats_less:  0.5,
      normal:     0,
    },
    tq_urine_color: {
      bloody:     1,
      very_dark:  1,
      colourless: 0.5,
      normal:     0,
    },
    tq_walk_type: {
      circles:     1,
      stumbling:   1,
      not_walking: 1,
      straight:    0,
    },
    tq_stool: {
      bloody: 1,
      watery: 1,
      hard:   0,
      normal: 0,
    },
    tq_secretion_type: {
      blood:  1,
      pus:    1,
      froth:  0.5,
      mucus:  0.5,
    },
    tq_milk: {
      stopped:   1,
      different: 1,
      less:      0.5,
      normal:    0,
    },
    tq_eggs: {
      stopped: 1,
      less:    0.5,
      normal:  0,
    },
    // Reversed yes/no: reproductive failure scores 1 (animal did NOT reproduce)
    tq_reproduction: {
      yes: 0,
      no:  1,
    },
  },

};

# Enyana Health — CLAUDE.md

This file is the canonical reference for AI-assisted development on this repo.
Read it before making changes. Keep it updated when architecture or conventions change.

---

## Project Overview

**Enyana Health** is a USSD-based livestock health triage system for rural
smallholder farmers in Uganda. Farmers dial a short code (e.g. `*384#`) from
any feature phone — no smartphone or internet required — and navigate a menu to:

- Learn about common livestock diseases and symptoms
- Get feeding and nutrition advice
- Access breeding tips
- Connect with a vet via WhatsApp alert

The system is intentionally simple. USSD works on 2G networks, is carrier-billed
(free for the farmer), and reaches farmers who have never touched a smartphone.

---

## Two Pilots

### Pilot 1 — Nyakayojo (Active)

| Property   | Value                                       |
|------------|---------------------------------------------|
| Location   | Nyakayojo Sub-county, Mbarara District      |
| Languages  | English, Runyankole                         |
| Animals    | Cattle, Poultry, Pigs                       |
| Status     | Scaffold complete — content needs review    |
| Flow file  | `flows/nyakayojo.json`                      |

Runyankole translations are marked `[RUN]` and are placeholders pending review
by a native speaker before deployment.

### Pilot 2 — Gulu (Scaffold Only)

| Property   | Value                                       |
|------------|---------------------------------------------|
| Location   | Gulu District, Northern Uganda              |
| Languages  | English, Acholi (Leb Acoli)                |
| Animals    | Cattle, Poultry, Pigs (content TBD)        |
| Status     | Scaffold only — all content is placeholder  |
| Flow file  | `flows/gulu.json`                           |

Acholi translations are marked `[ACH]`. All English content is marked `[EN]` and
is placeholder. A local team needs to fill in context-appropriate advice for the
Gulu area (disease prevalence, local vet contacts, dietary norms).

---

## Tech Stack & Design Decisions

### Why plain JSON over Firestore for content?

Content (disease advice, feeding tips) changes rarely and needs offline review.
JSON files can be edited in a text editor, reviewed in a Git PR, and deployed
without a database migration. Firestore would add latency to every USSD request
and require credentials in the field.

**Migrate to Firestore** when content volume or multi-tenant needs grow.

### Why an explicit state machine over a counter or `*` parser?

Counter-based systems parse the full `*`-delimited `text` history on every
request. They break when:
- A session expires mid-flow and replays
- Navigation is non-linear (back button, future feature)
- A connectivity drop replays an old request

The explicit state machine stores the **current state name** (e.g.
`"selectAnimal"`) in the session. Each request only needs two things: the
current session state and the latest input (last `*` segment). State names
are readable strings — never counters or magic numbers.

### Why in-memory sessions?

Africa's Talking USSD sessions are short (< 5 minutes) and single-threaded
by phone number. A `Map` is fine for local testing and single-process servers.

**For production on Vercel** (multi-process/serverless), replace `services/session.js`
with a Redis-backed store so sessions survive across cold starts.

### No Africa's Talking SDK dependency

`simulator/index.html` provides a full browser-based USSD test environment. It
mimics AT's exact request format. When ready to go live, point the AT shortcode
webhook at the `/ussd` endpoint — no code changes needed.

---

## How the State Machine Works

Each state is a key in `flow.states` inside the pilot's JSON file:

```json
{
  "states": {
    "selectAnimal": {
      "isEnd": false,
      "prompt": {
        "english": "Which animal?\n\n1. Cattle\n2. Poultry\n3. Pigs",
        "runyankole": "[RUN] Orikwetaaga nte ehe?..."
      }
    },
    "cattle_disease": {
      "isEnd": true,
      "prompt": {
        "english": "Common cattle diseases: ...",
        "runyankole": "[RUN] Endwara z'ente..."
      }
    }
  }
}
```

The session object stored in memory looks like:

```json
{
  "state":       "selectAnimal",
  "language":    "english",
  "animal":      "cattle",
  "phoneNumber": "+256700000000",
  "inputs":      ["1", "1"]
}
```

On each USSD request (`handlers/ussd.js`):

1. If `text` is empty → new session, show `selectLanguage`
2. Look up session by `sessionId`
3. Read current state from `session.state`
4. Parse input = last `*` segment of `text` field
5. `switch (currentState)` → validate input → set `nextState`
6. Update `session.state = nextState`
7. Fetch prompt from flow JSON
8. Return `CON <prompt>` or `END <prompt>`

### State routing table

```
selectLanguage  →  selectAnimal   (sets session.language)
selectAnimal    →  selectTopic    (sets session.animal)
selectTopic     →  {animal}_disease | {animal}_nutrition | {animal}_breeding | connectVet
connectVet      →  vetConfirm     (fires WhatsApp alert, fire-and-forget)
vetConfirm      →  END
*_disease       →  END
*_nutrition     →  END
*_breeding      →  END
```

The `{animal}` in topic state names is resolved at runtime from `session.animal`.
The resulting names (`cattle_disease`, `poultry_nutrition`, etc.) are explicit
strings that must exist in the flow JSON — nothing is generated magically.

---

## Running Locally

```bash
# 1. Install dependencies
cd enyana-ussd-v2
npm install

# 2. Create your .env file
cp .env.example .env
# Leave Twilio vars blank for local dev — alerts are skipped gracefully

# 3. Start the server with auto-reload
npm run dev

# 4. Open the simulator
open http://localhost:3000
```

The server logs which pilot is active and how many states were loaded.  
To switch pilots, change `PILOT=gulu` in `.env` and restart.

---

## Testing with the Simulator

1. Open `http://localhost:3000` — the page auto-dials and shows the first screen
2. Type a menu number (e.g. `1`) in the **Press Key** field and click **SEND**
3. Continue navigating
4. Click **RESET** to start a fresh session

**Green screen** = CON (session continues, farmer can type another input)  
**Orange screen** = END (session closed, this is the final message)

The simulator accumulates input exactly as AT does:

| Turn | You type | `text` sent to server |
|------|----------|-----------------------|
| 1    | (auto)   | `""`                  |
| 2    | `1`      | `"1"`                 |
| 3    | `1`      | `"1*1"`               |
| 4    | `2`      | `"1*1*2"`             |

> **Note**: Because USSD uses `*` as a delimiter, free-text input at the
> `connectVet` step should not contain `*` characters — they would be
> interpreted as separators.

---

## Adding a New State to a Flow

**Step 1** — Add the state to the JSON (e.g. `flows/nyakayojo.json`):

```json
"cattle_deworming": {
  "isEnd": true,
  "prompt": {
    "english": "Cattle deworming:\n- Deworm every 3 months...",
    "runyankole": "[RUN] Okukura ente..."
  }
}
```

**Step 2** — Route to it in `handlers/ussd.js`.
For a new topic under selectTopic, add a branch:

```javascript
case 'selectTopic':
  // existing options...
  else if (input === '5') nextState = `${session.animal}_deworming`;
```

**Step 3** — Update the `selectTopic` prompt in the JSON to include the new option.

**Step 4** — Test with the simulator.

---

## Adding a New Language

**Step 1** — Add the language to `flow.metadata.languages`:

```json
"languages": ["english", "runyankole", "luganda"]
```

**Step 2** — Add the new key to every state's `prompt` object:

```json
"selectLanguage": {
  "prompt": {
    "english":    "Welcome...",
    "runyankole": "[RUN] ...",
    "luganda":    "[LUG] ..."
  }
}
```

**Step 3** — Update the `selectLanguage` prompt to list the new option:

```
1. English
2. Runyankole
3. Luganda
```

**Step 4** — Handle the new choice in `handlers/ussd.js`:

```javascript
case 'selectLanguage':
  // existing cases...
  else if (input === '3') {
    session.language = 'luganda';
    nextState = 'selectAnimal';
  }
```

---

## Adding a New Pilot

1. Create `flows/<pilot-name>.json` modelled on `nyakayojo.json`
2. Set `PILOT=<pilot-name>` in `.env`
3. Restart the server — the handler will load the new flow automatically

---

## Git Workflow

**Never push directly to `main`.** All work goes through feature branches.

```bash
# Start new work
git checkout main && git pull origin main
git checkout -b feature/my-feature

# Commit often
git add <specific files>
git commit -m "feat: add goat category to nyakayojo flow"

# Push and open a PR
git push origin feature/my-feature
```

Branch naming conventions:
- `feature/<description>` — new functionality
- `fix/<description>` — bug fixes
- `content/<description>` — flow JSON content changes only

---

## Environment Variables Reference

| Variable             | Required for  | Description                                                |
|----------------------|---------------|------------------------------------------------------------|
| `PORT`               | Local dev     | Port the Express server listens on (default: `3000`)       |
| `PILOT`              | Always        | Flow to load: `nyakayojo` or `gulu`                       |
| `TWILIO_ACCOUNT_SID` | Vet alerts    | Twilio account SID — see console.twilio.com               |
| `TWILIO_AUTH_TOKEN`  | Vet alerts    | Twilio auth token                                          |
| `WHATSAPP_FROM`      | Vet alerts    | Twilio WhatsApp sandbox sender: `whatsapp:+14155238886`    |
| `WHATSAPP_TO`        | Vet alerts    | Vet's WhatsApp number: `whatsapp:+256700000000`            |

Twilio variables are **optional for local testing** — if absent or set to
placeholder values, `services/notify.js` logs a warning and skips the alert
without crashing.

---

## Project File Map

```
enyana-ussd-v2/
├── index.js              Entry point — Express server + route registration
├── package.json          Dependencies and npm scripts
├── vercel.json           Serverless deployment config
├── .env.example          Environment variable template
├── .gitignore
├── CLAUDE.md             This file
├── README.md             Quick-start for new developers
│
├── flows/
│   ├── nyakayojo.json    Pilot 1 content (English + Runyankole)
│   └── gulu.json         Pilot 2 scaffold (English + Acholi, placeholder)
│
├── handlers/
│   └── ussd.js           State machine — core request handler
│
├── services/
│   ├── session.js        In-memory session store (Map + TTL)
│   └── notify.js         Twilio WhatsApp vet alert sender
│
└── simulator/
    └── index.html        Browser-based USSD test UI
```

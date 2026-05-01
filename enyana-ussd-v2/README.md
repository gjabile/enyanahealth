# Enyana Health USSD

USSD-based livestock health triage for rural Ugandan smallholder farmers.  
Farmers dial `*384#` on any feature phone — no smartphone or internet required.

## Quick Start

```bash
cd enyana-ussd-v2
npm install
cp .env.example .env
npm run dev
# Open http://localhost:3000
```

## Project Structure

| Path                   | Purpose                                        |
|------------------------|------------------------------------------------|
| `index.js`             | Express server — routes and startup            |
| `handlers/ussd.js`     | State machine — core USSD logic                |
| `flows/nyakayojo.json` | Pilot 1 content (English + Runyankole)         |
| `flows/gulu.json`      | Pilot 2 scaffold (English + Acholi, TBD)       |
| `services/session.js`  | In-memory session store with 5-min TTL         |
| `services/notify.js`   | Twilio WhatsApp vet alert sender               |
| `simulator/index.html` | Browser-based USSD test UI                     |

## Pilots

| Pilot      | Location | Languages          | Status            |
|------------|----------|--------------------|-------------------|
| Nyakayojo  | Mbarara  | English, Runyankole | Active scaffold  |
| Gulu       | Gulu     | English, Acholi    | Placeholder only  |

## Switching Pilots

Set `PILOT=gulu` (or `PILOT=nyakayojo`) in `.env` and restart the server.

## Enabling Vet Alerts

1. `npm install twilio`
2. Fill in the `TWILIO_*` and `WHATSAPP_*` variables in `.env`

Without Twilio configured, alerts are skipped gracefully — local testing is
unaffected.

## Architecture

See **[CLAUDE.md](./CLAUDE.md)** for:
- State machine design and routing table
- How to add new states, languages, or pilots
- Git workflow and environment variable reference

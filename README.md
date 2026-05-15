# Unified Inbox

A personal hub that pulls Slack, (later) Gmail, and (later) WhatsApp into one place,
with Claude-powered summaries.

**Stack**: FastAPI + SQLAlchemy (SQLite) backend, React (Vite + TypeScript) frontend,
WebSocket for live updates, Anthropic Claude for summaries.

Single-user — no auth/login system. One set of OAuth tokens lives in the DB.

## Layout

```
backend/   FastAPI app + Slack integration + Claude wrapper + background poller
frontend/  React app (Vite). Channel list, message view, "Summarize" button.
```

## Setup

### 1. Slack token

Easiest path: create a Slack app at https://api.slack.com/apps, install it to your
workspace, and copy the **Bot User OAuth Token** (`xoxb-...`) — or for full read
access to everything you can see, the **User OAuth Token** (`xoxp-...`).

Required scopes: `channels:history`, `channels:read`, `groups:history`,
`groups:read`, `im:history`, `im:read`, `users:read`.

For bot tokens, **invite the bot to channels you want to read** (`/invite @yourbot`).
User tokens see everything you see, no invites needed.

### 2. Backend

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
# edit .env: paste ANTHROPIC_API_KEY and SLACK_TOKEN
uvicorn app.main:app --reload
```

Backend runs on http://localhost:8000.

### 3. Frontend

```powershell
cd frontend
npm install
npm run dev
```

Frontend runs on http://localhost:5173 and proxies API + WebSocket calls to the backend.

## How it works

- On startup, the backend reads `SLACK_TOKEN`, calls `auth.test`, and seeds a
  `slack_accounts` row.
- A background task polls every `SLACK_POLL_INTERVAL_SECONDS` (default 30s):
  syncs the channel list, fetches new messages per channel since the last
  `ts`, and persists them.
- Each new message is broadcast via WebSocket to any connected frontend.
- The frontend subscribes to `/ws`, updates the active channel in real time,
  and shows unread badges for other channels.
- The "Summarize recent" button hits `POST /slack/channels/{id}/summary`,
  which feeds the last 50 messages to Claude and returns a short summary.

## Endpoints

- `GET /slack/channels` — list known channels
- `GET /slack/channels/{pk}/messages?limit=50` — recent messages
- `POST /slack/channels/{pk}/summary` — Claude summary of recent messages
- `POST /slack/sync` — force an immediate poll cycle
- `WS /ws` — live message stream (broadcasts `{type: "slack.message", ...}`)
- `GET /slack/auth/install` — start full OAuth flow (only if `SLACK_CLIENT_ID` is set)
- `GET /slack/auth/callback` — OAuth redirect target

## Roadmap

1. **Now**: Slack read + summaries.
2. **Next**: Gmail (similar shape — OAuth, polling, store, summarize).
3. **Then**: WhatsApp via WhatsApp Business Cloud API or `whatsapp-web.js` bridge.
4. **After**: Reminders (cron-like scheduler), LLM-curated reply drafts and
   automated sends, cross-channel digests.

## Switching to push instead of polling

The poller is in `backend/app/poller.py`. To swap to Slack's Events API:
add a `/slack/events` POST endpoint that calls the same persistence + broadcast
helpers, register it in your Slack app's Event Subscriptions (needs a public
URL — use ngrok in dev), and remove `run_poller()` from the `lifespan`.

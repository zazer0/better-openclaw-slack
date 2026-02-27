# Molty Slack Bot — Custom Integration

## Overview
A standalone Node.js service using Slack Bolt.js (Socket Mode) that bridges Slack threads to OpenClaw sessions via the gateway's `/v1/chat/completions` API.

## Architecture
```
Slack (Socket Mode) → Bolt.js service → OpenClaw Gateway /v1/chat/completions
```

## Requirements

### Thread-Based Session Isolation
1. **Top-level message in #oc-general** → Treat as the first user message in a NEW OpenClaw session. Bot replies in a thread under that message.
2. **Follow-up messages in that thread** (from any user) → Routed to the SAME OpenClaw session. Bot replies in the same thread.
3. **Session key mapping**: Derive a deterministic session key from `thread_ts` (which equals the top-level message's `ts` for the thread). Format: `slack:thread:{channel_id}:{thread_ts}`
4. **Context continuity**: The OpenClaw gateway handles session persistence — we just need to pass the same `x-openclaw-session-key` header for all messages in the same thread.

### Message Flow
- Top-level message arrives → `thread_ts` is undefined, so use `message.ts` as the thread identifier
- Thread reply arrives → `thread_ts` is set, use it as the thread identifier
- In both cases, derive the session key the same way and POST to OpenClaw

### Ack Reaction
- When a message arrives, immediately add 👀 reaction to it
- When the bot has finished replying, remove the 👀 reaction

### Channel Scope
- Only respond in channel `C0AGCR0USR0` (#oc-general)
- Ignore all other channels

### Bot Echo Prevention
- Ignore messages from the bot itself (check `message.bot_id` or `message.subtype === 'bot_message'`)

### OpenClaw Gateway Integration
- **Endpoint**: `http://127.0.0.1:18789/v1/chat/completions`
- **Auth**: `Authorization: Bearer open-DA-claws-FR`
- **Agent**: `x-openclaw-agent-id: main`
- **Session routing**: `x-openclaw-session-key: slack:thread:{channel}:{thread_ts}`
- **Request body**:
  ```json
  {
    "model": "openclaw",
    "messages": [{"role": "user", "content": "<message text>"}],
    "user": "slack:thread:{channel}:{thread_ts}"
  }
  ```
- **Response**: Extract `choices[0].message.content` for the reply text

### Slack Credentials
- **Bot Token**: `xoxb-REDACTED`
- **App Token**: `xapp-REDACTED`

These should be read from environment variables:
- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `OPENCLAW_GATEWAY_URL` (default: `http://127.0.0.1:18789`)
- `OPENCLAW_GATEWAY_TOKEN` (default: `open-DA-claws-FR`)
- `SLACK_CHANNEL_ID` (default: `C0AGCR0USR0`)

### Error Handling
- If the OpenClaw gateway returns an error, reply in the thread with a brief error message
- If the gateway is unreachable, reply with "⚠️ Gateway unavailable, try again later"
- Always remove the 👀 reaction even on error

## Tech Stack
- Node.js
- `@slack/bolt` (Socket Mode)
- `node-fetch` or built-in `fetch` for HTTP calls to OpenClaw
- No database needed — session keys are derived deterministically from thread_ts

## File Structure
```
molty-slack/
├── package.json
├── .env.example
├── src/
│   └── index.js
└── README.md
```

## Running
```bash
npm install
cp .env.example .env  # fill in tokens
node src/index.js
```

## Notes
- Keep it minimal. No unnecessary abstractions.
- The bot name in Slack is "Molty" (already configured in the Slack app).
- Slack's message text may contain user mentions like `<@U123>` — pass them through as-is to OpenClaw.
- Long responses: if the reply exceeds 4000 chars, split into multiple messages in the same thread.

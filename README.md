# better-openclaw-slack

OpenClaw plugin that bridges Slack threads to OpenClaw sessions via Socket Mode and the
`/v1/chat/completions` gateway endpoint.

## What it does

- For each incoming Slack message (thread-aware), derives the same session key format used by the
  original standalone bot: `slack:thread:{channel}:{thread_ts}`.
- Adds a `👀` reaction while the request is processing.
- Removes that reaction when the response is sent, even on errors.
- Skips bot messages and bot-originated content.
- Splits long gateway responses into multiple messages (default 4000 chars per Slack message).

## Environment

Set these variables in your OpenClaw extension environment:

- `SLACK_BOT_TOKEN` (required)
- `SLACK_APP_TOKEN` (required)
- `OPENCLAW_GATEWAY_URL` (optional, default `http://127.0.0.1:18789`)
- `OPENCLAW_GATEWAY_TOKEN` (optional)

## OpenClaw plugin config

Configure `plugins.entries.better-openclaw-slack.config`:

- `channelId` — Slack channel ID to process (`string`, optional)
- `gatewayUrl` — OpenClaw gateway URL (`string`, default `http://127.0.0.1:18789`)
- `agentId` — OpenClaw agent ID (`string`, default `main`)
- `maxMessageLength` — message split size (`number`, default `4000`)

## Installation

1. Install into your OpenClaw extensions folder.
2. Run `npm install` in the plugin directory.
3. Copy `.env.example` to `.env` and fill in required credentials.
4. Enable plugin `better-openclaw-slack` and set config as needed.

## Notes

- Keeps the same non-streaming `/v1/chat/completions` behavior as the standalone implementation.
- Requires Node.js 18+ (OpenClaw process provides runtime, plugin uses built-in `fetch`).

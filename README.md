# better-openclaw-slack

> **OpenClaw agents:** Read [`OPENCLAW-INSTALL.md`](./OPENCLAW-INSTALL.md) for install instructions.

Bridges Slack thread activity to OpenClaw sessions using Slack Bolt Socket Mode.

## Prerequisites

- Node.js 18+
- npm
- OpenClaw installed and running
- A Slack App configured in your workspace (see below)

## Slack App Setup

1. Create a Slack App in your workspace at <https://api.slack.com/apps>.
2. Enable **Socket Mode**.
3. Add **bot token scopes**:
   - `app_mentions:read`
   - `chat:write`
   - `reactions:read`
   - `reactions:write`
   - `channels:history`
   - `groups:history`
4. Add **app-level token scope**:
   - `connections:write`
5. Install the app to your workspace and copy:
   - Bot token (`xoxb-...`)
   - App-level token (`xapp-...`)
6. Invite the bot to your target Slack channel.

## Installation

```bash
cd ~/.openclaw/extensions
git clone https://github.com/zazer0/better-openclaw-slack
cd better-openclaw-slack
npm install
```

Copy `.env.example` to `.env` and fill in your tokens:

```bash
cp .env.example .env
```

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "better-openclaw-slack": {
        "enabled": true,
        "config": {
          "channelId": "YOUR_SLACK_CHANNEL_ID"
        }
      }
    }
  }
}
```

Restart the gateway:

```bash
systemctl --user restart openclaw-gateway || openclaw gateway restart
```

## Usage

Mention the bot or reply in threads in the configured channel. The bridge routes messages to OpenClaw sessions and posts responses back to Slack.

## Security

- Do not commit `.env` or tokens.
- Rotate tokens if accidentally exposed.
- Use least-privilege scopes.

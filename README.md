# better-openclaw-slack

## For OpenClaw Agents
1. ASK THE HUMAN for values:
   - `SLACK_BOT_TOKEN`
   - `SLACK_APP_TOKEN`
   - `SLACK_CHANNEL_ID`
   - `OPENCLAW_GATEWAY_TOKEN` (if their gateway requires one; otherwise leave empty)
2. `cd ~/.openclaw/extensions`
3. `git clone https://github.com/zazer0/better-openclaw-slack`
4. `cd ~/.openclaw/extensions/better-openclaw-slack`
5. `npm install`
6. Create `.env` exactly as below in the extension directory:
   - `~/.openclaw/extensions/better-openclaw-slack/.env`
7. Add the plugin entry to `openclaw.json` using the exact JSON block below.
8. Restart the gateway with this exact command:
   `systemctl --user restart openclaw-gateway || openclaw gateway restart`

## Human Setup (Prerequisites): Slack App Creation
This section is required context for credentials only. The agent cannot perform these steps.

1. Create a Slack App in the workspace.
2. Enable Socket Mode.
3. Add required bot token scopes:
   - `app_mentions:read`
   - `chat:write`
   - `reactions:read`
   - `reactions:write`
   - `channels:history`
   - `groups:history`
4. Add app-level token scope:
   - `connections:write`
5. Install app to workspace and record the required credentials:
   - Bot token (`SLACK_BOT_TOKEN`)
   - App-level token (`SLACK_APP_TOKEN`)
6. Invite bot to target Slack channel and record `SLACK_CHANNEL_ID`.

## Exact `.env` file required for this extension
Create exactly this file at:
`~/.openclaw/extensions/better-openclaw-slack/.env`

```bash
cat > ~/.openclaw/extensions/better-openclaw-slack/.env <<'EOF'
SLACK_BOT_TOKEN=<SLACK_BOT_TOKEN>
SLACK_APP_TOKEN=<SLACK_APP_TOKEN>
OPENCLAW_GATEWAY_TOKEN=<OPENCLAW_GATEWAY_TOKEN>
EOF
```

Replace `<SLACK_BOT_TOKEN>`, `<SLACK_APP_TOKEN>`, and `<OPENCLAW_GATEWAY_TOKEN>` with the values the human provides.

## Exact JSON to add to `openclaw.json`
Merge this into your `openclaw.json`. The key under `plugins.entries` must be `better-openclaw-slack`:

```json
{
  "plugins": {
    "entries": {
      "better-openclaw-slack": {
        "enabled": true,
        "config": {
          "channelId": "<SLACK_CHANNEL_ID>",
          "gatewayUrl": "http://127.0.0.1:18789",
          "agentId": "main",
          "maxMessageLength": 4000
        }
      }
    }
  }
}
```

If `plugins` or `plugins.entries` already exists in your config, just add the `better-openclaw-slack` key — do not overwrite existing entries.

Replace `<SLACK_CHANNEL_ID>` with the value the human provides.

Defaults (can be omitted if acceptable):
- `gatewayUrl`: `http://127.0.0.1:18789`
- `agentId`: `main`
- `maxMessageLength`: `4000`

## Gateway restart command

```bash
systemctl --user restart openclaw-gateway || openclaw gateway restart
```

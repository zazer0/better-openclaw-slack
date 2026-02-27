# OpenClaw Agent Install Instructions

## Steps
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

## Exact `.env` file
Create exactly this file at:
`~/.openclaw/extensions/better-openclaw-slack/.env`

```bash
cat > ~/.openclaw/extensions/better-openclaw-slack/.env <<'ENVEOF'
SLACK_BOT_TOKEN=<SLACK_BOT_TOKEN>
SLACK_APP_TOKEN=<SLACK_APP_TOKEN>
OPENCLAW_GATEWAY_TOKEN=<OPENCLAW_GATEWAY_TOKEN>
ENVEOF
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

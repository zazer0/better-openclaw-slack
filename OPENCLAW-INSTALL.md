# OpenClaw Agent Install Instructions

## ⚠️ Required Slack App Scopes

Before installing, the Slack App **must** have all of the following bot token scopes enabled. **Missing any of these will cause the plugin to fail.**

Go to your Slack App → **OAuth & Permissions** → **Bot Token Scopes** and verify each is present:

| Scope | Purpose |
|---|---|
| `app_mentions:read` | View messages that mention the bot |
| `channels:history` | View messages in public channels |
| `groups:history` | View messages in private channels |
| `chat:write` | Send messages |
| `reactions:read` | View reactions on messages |
| `reactions:write` | Add/remove reactions |

Also required under **App-Level Tokens** (for Socket Mode):

| Scope | Purpose |
|---|---|
| `connections:write` | Required for Socket Mode |

After adding or changing any scopes, **reinstall the app to your workspace** to apply them.


## ⚠️ Required Event Subscriptions

Go to [api.slack.com/apps](http://api.slack.com/apps) → your app → **Event Subscriptions**:

1. Turn **"Enable Events"** to **On**
2. Under **"Subscribe to bot events"**, add:
   - `message.channels` — messages in public channels
   - `message.groups` — messages in private channels (if needed)
   - `app_mention` — when someone @mentions the bot
3. **Save Changes**
4. Slack may ask you to **reinstall the app** — do it

Without these event subscriptions, the bot will not receive any messages from Slack.

---

## Steps
1. ASK THE HUMAN for values:
   - `SLACK_BOT_TOKEN`
   - `SLACK_APP_TOKEN`
   - `SLACK_CHANNEL_ID`
   - `OPENCLAW_GATEWAY_TOKEN` (if their gateway requires one; otherwise leave empty)
2. **VALIDATE SCOPES BEFORE PROCEEDING** (see section below). Do NOT continue with the install until all required scopes pass.
3. `cd ~/.openclaw/extensions`
4. `git clone https://github.com/zazer0/better-openclaw-slack`
5. `cd ~/.openclaw/extensions/better-openclaw-slack`
6. `npm install`
7. Inject environment variables into the gateway systemd service (see "Environment Variables" section below).
8. Enable the gateway chat completions endpoint (see "Enable Gateway Chat Completions Endpoint" section below).
9. Add the plugin entry to `openclaw.json` using the exact JSON block below.
10. Restart the gateway with this exact command:
   `systemctl --user restart openclaw-gateway || openclaw gateway restart`

## 🔍 Validate Scopes (MANDATORY — run before install)

After the human provides `SLACK_BOT_TOKEN`, you **must** validate that the token has all required scopes before touching any config or installing anything. This prevents a broken gateway config from a misconfigured Slack app.

Run this command (replacing `$SLACK_BOT_TOKEN` with the actual token):

```bash
curl -sI -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/auth.test | grep -i x-oauth-scopes
```

The `x-oauth-scopes` response header lists all scopes granted to the token as a comma-separated string.

**Check that ALL of these scopes are present in the header value:**
- `app_mentions:read`
- `channels:history`
- `groups:history`
- `chat:write`
- `reactions:read`
- `reactions:write`

**If any scope is missing:**
1. Tell the human exactly which scopes are missing.
2. Direct them to their Slack App settings → **OAuth & Permissions** → **Bot Token Scopes** to add them.
3. Remind them to **reinstall the app to their workspace** after adding scopes (scopes don't take effect until reinstalled).
4. After they confirm, re-run the validation. Do NOT proceed until all 6 scopes are confirmed present.

**If the `curl` call fails or returns no header:** the token is likely invalid. Ask the human to double-check the bot token value.

---

## Environment Variables

The plugin requires `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `OPENCLAW_GATEWAY_TOKEN` to be present as environment variables in the gateway process. **A `.env` file in the extension directory is not sufficient** — the variables must be injected into the systemd service.

Create a systemd drop-in:

```bash
mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d
cat > ~/.config/systemd/user/openclaw-gateway.service.d/slack-env.conf << 'ENVEOF'
[Service]
Environment=SLACK_BOT_TOKEN=<SLACK_BOT_TOKEN>
Environment=SLACK_APP_TOKEN=<SLACK_APP_TOKEN>
Environment=OPENCLAW_GATEWAY_TOKEN=<OPENCLAW_GATEWAY_TOKEN>
ENVEOF
systemctl --user daemon-reload
```

Replace `<SLACK_BOT_TOKEN>`, `<SLACK_APP_TOKEN>`, and `<OPENCLAW_GATEWAY_TOKEN>` with the values the human provides.

The `.env` file in the repo root is for reference only — it lists the required variable names but is not loaded by the running plugin.

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

## Enable Gateway Chat Completions Endpoint

The plugin communicates with the gateway via the OpenAI-compatible chat completions endpoint. This **must** be enabled.

Merge this into the `gateway` section of `openclaw.json`:

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  }
}
```

If `gateway` or `gateway.http` already exists in your config, just add the `endpoints` block — do not overwrite existing settings.

---

## Gateway restart command

```bash
systemctl --user restart openclaw-gateway || openclaw gateway restart
```

---

## Updating

If you already have the plugin installed and want to pull the latest version:

```bash
# 1. Pull latest from GitHub
cd ~/.openclaw/extensions/better-openclaw-slack && git pull origin main

# 2. Copy the runnable JS into place (required — OC loads index.js, not src/index.js)
cp src/index.js index.js

# 3. Restart the gateway
systemctl --user restart openclaw-gateway || openclaw gateway restart
```

**Why step 2?** The repo's canonical source is `index.ts` (TypeScript) with a CJS mirror at `src/index.js`. OC loads `index.js` from the top-level directory. There is no build step — deploying means copying `src/index.js` to `index.js`. If you skip this, the old version keeps running even after a pull.


### ⚠️ New instance? Disable the native Slack channel

If this is a fresh OpenClaw install, the OC setup wizard may have enabled the native `channels.slack` provider. **Running both the native Slack channel and this plugin simultaneously causes conflicts** — intermittent eye reactions, dropped messages, and unpredictable behavior.

Check your `openclaw.json` and ensure `channels.slack.enabled` is `false` (or the `slack` block is absent entirely):

```json
{
  "channels": {
    "slack": {
      "enabled": false
    }
  }
}
```

After making this change, restart the gateway. Confirm the logs show only:
```
[plugins] slack-bridge: running — listening in channel <your-channel-id>
```
and **no** `[slack] [default] starting provider` line.

# Findings: Config, openToolWatcher, readWithInactivityTimeout

## 1. Config values read from env vars

### src/index.js

All config is assembled into a single `config` object at module load time (lines 14–25).

| Env var | config field | Line | Notes |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | `config.slackBotToken` | 16 | Required; process exits if missing (line 8–12) |
| `SLACK_APP_TOKEN` | `config.slackAppToken` | 17 | Required; process exits if missing |
| `SLACK_CHANNEL_ID` | `config.slackChannelId` | 18 | Falls back to hardcoded `'C0AGCR0USR0'` |
| `OPENCLAW_GATEWAY_URL` | `config.openclawGatewayUrl` | 19 | Falls back to `'http://127.0.0.1:18789'` |
| `OPENCLAW_GATEWAY_TOKEN` | `config.openclawGatewayToken` | 20 | Falls back to `'open-DA-claws-FR'` |
| `UPDATE_INTERVAL_MS` | `config.updateIntervalMs` | 23 | `Number(...) || 1500` — falls back to 1500 |
| `INACTIVITY_TIMEOUT_MS` | `config.inactivityTimeoutMs` | 24 | `Number(...) || 60000` — falls back to 60000 |

Fields NOT from env vars (hardcoded):
- `config.openclawAgentId = 'main'` (line 21)
- `config.maxSlackMessageLength = 4000` (line 22)
- `config.port = Number(process.env.PORT) || 3000` (line 25, PORT env var used but not listed in config fields spec)

### index.ts

Config comes from the OC plugin `ctx.config` object (lines 534–540), parsed through individual `parse*` functions (lines 15–47). There is NO env var reading for config values — only `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `OPENCLAW_GATEWAY_TOKEN` are read from env vars (lines 524–526), and those are auth credentials, not config values.

| Parse function | ctx.config field | Fallback default |
|---|---|---|
| `parseChannelId` | `cfg.channelId` | `undefined` (all channels) |
| `parseGatewayUrl` | `cfg.gatewayUrl` | `'http://127.0.0.1:18789'` |
| `parseAgentId` | `cfg.agentId` | `'main'` |
| `parseMaxMessageLength` | `cfg.maxMessageLength` | `4000` |
| `parseUpdateIntervalMs` | `cfg.updateIntervalMs` | `1500` |
| `parseInactivityTimeoutMs` | `cfg.inactivityTimeoutMs` | `60000` |

**Key asymmetry**: `src/index.js` reads config from env vars with hardcoded fallbacks; `index.ts` reads from OC plugin config with hardcoded fallbacks. Neither file currently implements a two-source priority chain.

---

## 2. openToolWatcher()

### Signature (both files)

```
// index.ts (line 335–342)
async function openToolWatcher(options: {
  gatewayUrl: string;
  gatewayToken: string | undefined;
  runIdRef: RunIdRef;
  timerResetRef: TimerResetRef;
  onToolStart: (toolName: string) => void;
  logger: { warn?: ... };
}): Promise<{ close: () => void }>

// src/index.js (line 282)
async function openToolWatcher({ gatewayUrl, gatewayToken, runIdRef, timerResetRef, onToolStart, logger })
```

### Callbacks it accepts

- **`onToolStart(toolName: string)`** — called when a `tool` stream event with `phase === 'start'` arrives. This is a push callback; the caller provides it in the options object.
- No `onConnected` callback exists today.

### What it returns

Returns a `Promise<{ close: () => void }>`. The promise:
- **Resolves** when WS auth succeeds (after `connect.challenge` → `connect` req → `res` with `ok: true`). Resolves with `{ close: closeWs }`.
- **Rejects** if:
  - WS constructor throws
  - 8-second connect timeout fires
  - WS closes before auth completes
  - Auth response has `ok: false`

After resolution, the caller stores the handle and calls `.close()` in the `finally` block of the message handler.

### What it does NOT do

- No `onConnected` callback is called upon successful auth.
- The resolved `{ close }` handle has no way to notify the caller that auth succeeded beyond the promise resolving.
- The caller (message handler) uses `.then(watcher => { toolWatcher = watcher; })` — by the time `.then` runs, `queryOpenClaw` is already running, so there is currently no mechanism to change `inactivityTimeoutMs` based on WS auth success.

---

## 3. readWithInactivityTimeout()

### How it works

```
// src/index.js line 90; index.ts line 109
async function readWithInactivityTimeout(reader, timeoutMs, ac, provideReset?)
```

Inside the returned Promise:
1. `arm()` — starts a `setTimeout(timeoutMs)`. On fire: calls `ac.abort()` and rejects with `GATEWAY_TIMEOUT`.
2. `reset()` — clears and re-arms the timer. Exposed to callers via `provideReset`.
3. `provideReset?.(reset)` — if provided, immediately calls the callback with the reset function, letting callers store it.
4. `reader.read()` — races against the timer. On settlement, clears timer before resolve/reject.

### Where the timeout value comes from

- **index.ts**: `options.inactivityTimeoutMs` passed into `queryOpenClaw`, then forwarded directly to each `readWithInactivityTimeout` call inside the SSE reading loop (line 283–292). The value comes from `parseInactivityTimeoutMs(cfg.inactivityTimeoutMs)` resolved once at startup.
- **src/index.js**: `inactivityTimeoutMs` passed as a named param into `queryOpenClaw` (line 171), forwarded to each `readWithInactivityTimeout` call (line 232–239). The value comes from `config.inactivityTimeoutMs` set at module load.

### The limitation for Fix 1

`timeoutMs` is fixed at the time `readWithInactivityTimeout` is called — it's baked into the closure's `arm()` function. The `reset()` function re-arms with the **same** `timeoutMs` value. There is no way to change the timeout duration mid-stream via the existing `timerResetRef` mechanism. To implement a WS-connected bump, we need either:
- A mutable timeout ref passed alongside `timerResetRef`, or
- `readWithInactivityTimeout` to read `timeoutMs` from a ref on each `arm()` call rather than closing over a fixed value.

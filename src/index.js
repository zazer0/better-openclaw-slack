'use strict';

require('dotenv').config();
const { App, LogLevel } = require('@slack/bolt');
const WebSocket = require('ws');

const REQUIRED_ENV_VARS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'];
const missingVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingVars.length > 0) {
  console.error(`Missing required environment variable(s): ${missingVars.join(', ')}`);
  process.exit(1);
}

const MAX_MESSAGE_LENGTH = 3000;
const UPDATE_INTERVAL_MS = 1500;
const INACTIVITY_TIMEOUT_MS = 60000;

function normalizeNoReply(text) {
  if (text.trim().toUpperCase() === 'NO_REPLY') {
    return '🤫 [Model chose NO_REPLY]';
  }
  return text;
}

function buildConfig(api) {
  const channelId = api?.pluginConfig?.channelId?.trim();
  if (!channelId) {
    console.error('better-openclaw-slack: channelId is required in plugin config');
    return null;
  }
  return {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    slackChannelId: channelId,
    openclawGatewayUrl: process.env.OPENCLAW_GATEWAY_URL?.trim() || 'http://127.0.0.1:18789',
    openclawGatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || 'open-DA-claws-FR',
    openclawAgentId: api?.pluginConfig?.agentId?.trim() || 'main',
    maxSlackMessageLength: MAX_MESSAGE_LENGTH,
    updateIntervalMs: UPDATE_INTERVAL_MS,
    inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
    port: Number(process.env.PORT) || 3000,
  };
}

function resolveThreadTs(message) {
  return message.thread_ts || message.ts;
}

function buildSessionKey(channelId, threadTs) {
  return `slack:thread:${channelId}:${threadTs}`;
}

function splitMessage(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return [text || ''];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function parseGatewayError(status, payloadText) {
  try {
    const payload = JSON.parse(payloadText);
    if (typeof payload?.error?.message === 'string' && payload.error.message.trim()) {
      return `⚠️ Gateway error (${status}): ${payload.error.message.trim()}`;
    }
    if (typeof payload?.message === 'string' && payload.message.trim()) {
      return `⚠️ Gateway error (${status}): ${payload.message.trim()}`;
    }
  } catch (error) {
    // Ignore parsing failures and fallback to status-only message.
  }

  return `⚠️ Gateway error (${status})`;
}

function makeError(code, message, extra) {
  return Object.assign(new Error(message), { code, ...extra });
}

async function readWithInactivityTimeout(reader, timeoutMsRef, ac, provideReset) {
  return new Promise((resolve, reject) => {
    let timer;

    const arm = () => {
      timer = setTimeout(() => {
        ac.abort();
        reject(makeError('GATEWAY_TIMEOUT', '⚠️ Gateway timed out — try again'));
      }, timeoutMsRef.ms);
    };

    const reset = () => {
      clearTimeout(timer);
      arm();
    };

    if (provideReset) provideReset(reset);
    arm();

    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function throttledSlackUpdater({ client, channel, placeholderTs, updateIntervalMs, logger }) {
  let pendingText = '';
  let lastPosted = '';
  let contentReceived = false;
  let currentIntervalMs = updateIntervalMs;
  let intervalId;

  function scheduleInterval() {
    intervalId = setInterval(async () => {
      let current = pendingText;
      if (current === lastPosted) return;

      // Truncate to 3000 chars if needed, showing the LAST 3000 chars
      if (current.length > 3000) {
        current = '…' + current.slice(-3000);
      }

      try {
        await client.chat.update({
          channel,
          ts: placeholderTs,
          text: current
        });
        lastPosted = current;
      } catch (err) {
        if (err?.data?.error === 'ratelimited' || err?.code === 'slack_webapi_rate_limited_error') {
          logger.warn('chat.update rate limited, backing off');
          clearInterval(intervalId);
          currentIntervalMs = Math.min(currentIntervalMs * 2, 10000);
          scheduleInterval();
        } else if (err?.data?.error === 'msg_too_long') {
          // Silently skip this window
        } else {
          logger.warn('chat.update failed, skipping window', err?.message || String(err));
        }
      }
    }, currentIntervalMs);
  }

  scheduleInterval();

  return {
    onDelta(accumulated) {
      contentReceived = true;
      pendingText = accumulated;
    },
    setWorkingText(text) {
      if (!contentReceived) {
        pendingText = text;
      }
    },
    stop() {
      clearInterval(intervalId);
    }
  };
}

module.exports = {
  register(api) {
    api.registerService({
      name: 'better-openclaw-slack',
      start: async (ctx) => {
        const config = buildConfig(api);
        if (!config) {
          throw new Error('better-openclaw-slack: invalid config, cannot start');
        }

        const logger = ctx.logger || console;

        async function* queryOpenClaw({ sessionKey, userText, inactivityTimeoutMsRef, timerResetRef, runIdRef }) {
          const ac = new AbortController();
          const endpoint = `${config.openclawGatewayUrl.replace(/\/$/, '')}/v1/chat/completions`;
          const body = {
            model: 'openclaw',
            messages: [{ role: 'user', content: userText }],
            user: sessionKey,
            stream: true
          };

          let response;
          try {
            response = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.openclawGatewayToken}`,
                'x-openclaw-agent-id': config.openclawAgentId,
                'x-openclaw-session-key': sessionKey
              },
              body: JSON.stringify(body),
              signal: ac.signal
            });
          } catch (error) {
            throw makeError('GATEWAY_UNAVAILABLE', 'Gateway unavailable', { cause: error });
          }

          if (!response.ok) {
            const responseText = await response.text();
            throw makeError('GATEWAY_ERROR', parseGatewayError(response.status, responseText), {
              status: response.status
            });
          }

          const contentType = response.headers.get('content-type') ?? '';
          if (!contentType.startsWith('text/event-stream')) {
            try {
              const responseText = await response.text();
              const parsed = JSON.parse(responseText);
              const content = parsed?.choices?.[0]?.message?.content;
              if (typeof content === 'string' && (content.trim() || content.trim().toUpperCase() === 'NO_REPLY')) {
                logger.warn('better-openclaw-slack: gateway returned non-SSE response, falling back to non-streaming parse');
                yield normalizeNoReply(content);
                return;
              }
            } catch {
              // fall through to throw GATEWAY_STREAM_ERROR
            }
            throw makeError('GATEWAY_STREAM_ERROR', '⚠️ Gateway stream error');
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let hasContent = false;
          let lineBuffer = '';

          try {
            while (true) {
              const chunk = await readWithInactivityTimeout(
                reader,
                inactivityTimeoutMsRef,
                ac,
                timerResetRef
                  ? (reset) => { timerResetRef.reset = reset; }
                  : undefined
              );

              if (chunk.done) {
                if (hasContent) return;
                throw makeError('GATEWAY_EMPTY_STREAM', '⚠️ Gateway returned an empty reply');
              }

              lineBuffer += decoder.decode(chunk.value, { stream: true });
              const lines = lineBuffer.split('\n');
              lineBuffer = lines.pop();

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const dataStr = trimmed.slice('data:'.length).trim();
                if (dataStr === '[DONE]') return;
                try {
                  const parsed = JSON.parse(dataStr);

                  if (runIdRef && runIdRef.value === null && parsed.id) {
                    runIdRef.value = String(parsed.id);
                  }

                  const delta = parsed?.choices?.[0]?.delta?.content;
                  if (typeof delta === 'string' && delta.length > 0) {
                    hasContent = true;
                    yield delta;
                  }
                } catch {
                  // Skip malformed SSE data lines.
                }
              }
            }
          } finally {
            reader.releaseLock();
          }
        }

        async function openToolWatcher({ gatewayUrl, gatewayToken, runIdRef, timerResetRef, onConnected, onToolStart }) {
          const wsUrl = gatewayUrl
            .replace(/^https:\/\//i, 'wss://')
            .replace(/^http:\/\//i, 'ws://')
            .replace(/\/+$/, '');

          return new Promise((resolve, reject) => {
            let connected = false;
            let ws;

            try {
              ws = new WebSocket(wsUrl, { maxPayload: 25 * 1024 * 1024 });
            } catch (err) {
              reject(err);
              return;
            }

            const connectTimeout = setTimeout(() => {
              try { ws.terminate(); } catch {}
              reject(new Error('WS connect timeout'));
            }, 8000);

            const closeWs = () => {
              clearTimeout(connectTimeout);
              try { ws.close(); } catch {}
            };

            ws.on('error', (err) => {
              if (!connected) {
                clearTimeout(connectTimeout);
                reject(err);
              }
            });

            ws.on('close', () => {
              clearTimeout(connectTimeout);
              if (!connected) {
                reject(new Error('WS closed before auth'));
              }
            });

            ws.on('message', (data) => {
              let msg;
              try {
                const raw = typeof data === 'string' ? data : data.toString('utf8');
                msg = JSON.parse(raw);
              } catch {
                return;
              }

              if (!connected) {
                if (msg.type === 'event' && msg.event === 'connect.challenge') {
                  const connectParams = {
                    minProtocol: 3,
                    maxProtocol: 3,
                    client: {
                      id: 'gateway-client',
                      displayName: 'slack-bridge',
                      version: 'dev',
                      platform: process.platform,
                      mode: 'backend'
                    },
                    caps: ['tool-events'],
                    role: 'operator',
                    scopes: ['operator.admin']
                  };
                  if (gatewayToken) {
                    connectParams.auth = { token: gatewayToken };
                  }
                  try {
                    ws.send(JSON.stringify({ type: 'req', id: 'c1', method: 'connect', params: connectParams }));
                  } catch {}
                  return;
                }

                if (msg.type === 'res' && msg.id === 'c1') {
                  clearTimeout(connectTimeout);
                  if (msg.ok) {
                    connected = true;
                    if (onConnected) onConnected();
                    resolve({ close: closeWs });
                  } else {
                    reject(new Error(`WS auth failed: ${msg.error?.message ?? 'unknown'}`));
                    try { ws.close(); } catch {}
                  }
                  return;
                }
                return;
              }

              if (msg.type !== 'event' || msg.event !== 'agent') return;
              const payload = msg.payload;
              if (!payload || typeof payload !== 'object') return;
              if (payload.stream !== 'tool') return;
              if (runIdRef.value !== null && payload.runId !== runIdRef.value) return;

              if (timerResetRef.reset) timerResetRef.reset();

              const phase = payload.data?.phase;
              const toolName = payload.data?.name;
              if (phase === 'start' && typeof toolName === 'string' && toolName.trim()) {
                onToolStart(toolName.trim());
              }
            });
          });
        }

        async function safeAddEyesReaction(client, channel, timestamp) {
          try {
            await client.reactions.add({ channel, timestamp, name: 'eyes' });
          } catch (error) {
            const errorCode = error?.data?.error;
            if (errorCode !== 'already_reacted' && errorCode !== 'invalid_name') {
              throw error;
            }
          }
        }

        async function safeRemoveEyesReaction(client, channel, timestamp) {
          try {
            await client.reactions.remove({ channel, timestamp, name: 'eyes' });
          } catch (error) {
            const errorCode = error?.data?.error;
            if (errorCode !== 'no_reaction' && errorCode !== 'message_not_found') {
              logger.error('Failed to remove eyes reaction:', errorCode || error.message || error);
            }
          }
        }

        const app = new App({
          token: config.slackBotToken,
          appToken: config.slackAppToken,
          socketMode: true,
          logLevel: LogLevel.INFO
        });

        app.message(async ({ message, client }) => {
          if (!message || message.channel !== config.slackChannelId) {
            return;
          }

          if (message.bot_id || message.subtype === 'bot_message') {
            return;
          }

          if (typeof message.text !== 'string' || !message.text.trim()) {
            return;
          }

          const threadTs = resolveThreadTs(message);
          const sessionKey = buildSessionKey(message.channel, threadTs);

          try {
            await safeAddEyesReaction(client, message.channel, message.ts);
          } catch (error) {
            logger.error('Unable to add eyes reaction', error);
          }

          let placeholderTs;
          try {
            const placeholderResult = await client.chat.postMessage({
              channel: message.channel,
              thread_ts: threadTs,
              text: '_⏳ Working..._'
            });
            placeholderTs = placeholderResult.ts;
          } catch (placeholderError) {
            logger.error('Failed to post placeholder message', placeholderError);
            try {
              await client.chat.postMessage({
                channel: message.channel,
                thread_ts: threadTs,
                text: '⚠️ Failed to post message to Slack'
              });
            } catch {
              // ignore
            }
            await safeRemoveEyesReaction(client, message.channel, message.ts);
            return;
          }

          const timerResetRef = { reset: null };
          const runIdRef = { value: null };
          const timeoutMsRef = { ms: config.inactivityTimeoutMs };
          const toolNames = [];
          let toolWatcher = null;

          let accumulated = '';
          const updater = throttledSlackUpdater({
            client,
            channel: message.channel,
            placeholderTs,
            updateIntervalMs: config.updateIntervalMs,
            logger
          });

          openToolWatcher({
            gatewayUrl: config.openclawGatewayUrl,
            gatewayToken: config.openclawGatewayToken,
            runIdRef,
            timerResetRef,
            onConnected: () => {
              timeoutMsRef.ms = 600000;
            },
            onToolStart: (toolName) => {
              if (!toolNames.includes(toolName)) {
                toolNames.push(toolName);
              }
              updater.setWorkingText(`_🔧 Working... (${toolNames.join(', ')})_`);
            }
          })
            .then((watcher) => { toolWatcher = watcher; })
            .catch(() => { logger.warn('tool-watcher: WS unavailable, tool visibility disabled'); });

          try {
            for await (const delta of queryOpenClaw({
              sessionKey,
              userText: message.text,
              inactivityTimeoutMsRef: timeoutMsRef,
              timerResetRef,
              runIdRef
            })) {
              accumulated += delta;
              updater.onDelta(accumulated);
            }

            updater.stop();

            const finalText = normalizeNoReply(accumulated) || '⚠️ Gateway returned an empty reply';
            const chunks = splitMessage(finalText, config.maxSlackMessageLength);

            try {
              await client.chat.update({
                channel: message.channel,
                ts: placeholderTs,
                text: chunks[0]
              });
            } catch (err) {
              if (err?.data?.error === 'ratelimited' || err?.code === 'slack_webapi_rate_limited_error') {
                logger.warn('Final chat.update rate limited, retrying after 2s');
                await new Promise((resolve) => setTimeout(resolve, 2000));
                try {
                  await client.chat.update({
                    channel: message.channel,
                    ts: placeholderTs,
                    text: chunks[0]
                  });
                } catch {
                  await client.chat.postMessage({
                    channel: message.channel,
                    thread_ts: threadTs,
                    text: chunks[0]
                  });
                }
              } else {
                throw err;
              }
            }

            for (let i = 1; i < chunks.length; i++) {
              await client.chat.postMessage({
                channel: message.channel,
                thread_ts: threadTs,
                text: chunks[i]
              });
            }
          } catch (error) {
            updater.stop();
            logger.error('Message handling failed', error);

            const code = error?.code;
            let errorText;
            switch (code) {
              case 'GATEWAY_UNAVAILABLE':
                errorText = '⚠️ Gateway unavailable, try again later';
                break;
              case 'GATEWAY_ERROR':
                errorText = error?.message || '⚠️ Gateway error';
                break;
              case 'GATEWAY_STREAM_ERROR':
                errorText = accumulated
                  ? `${accumulated}\n\n⚠️ Stream interrupted`
                  : '⚠️ Gateway stream error';
                break;
              case 'GATEWAY_TIMEOUT':
                errorText = '⚠️ Gateway timed out — try again';
                break;
              case 'GATEWAY_EMPTY_STREAM':
                errorText = '⚠️ Gateway returned an empty reply';
                break;
              default:
                errorText = error?.message || '⚠️ Unexpected error';
            }

            try {
              const errorChunks = splitMessage(errorText, config.maxSlackMessageLength);
              await client.chat.update({
                channel: message.channel,
                ts: placeholderTs,
                text: errorChunks[0]
              });
              for (let i = 1; i < errorChunks.length; i++) {
                await client.chat.postMessage({
                  channel: message.channel,
                  thread_ts: threadTs,
                  text: errorChunks[i]
                });
              }
            } catch (postError) {
              logger.error('Failed to post error message to Slack', postError);
            }
          } finally {
            if (toolWatcher) toolWatcher.close();
            await safeRemoveEyesReaction(client, message.channel, message.ts);
          }
        });

        await app.start(config.port);
        logger.info('better-openclaw-slack: Slack bot started');
        logger.info(`better-openclaw-slack: Listening in channel: ${config.slackChannelId}`);
      },

      stop: async (ctx) => {
        const logger = ctx?.logger || console;
        logger.info('better-openclaw-slack: stopped');
      }
    });
  }
};

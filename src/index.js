'use strict';

require('dotenv').config();
const { App, LogLevel } = require('@slack/bolt');

const REQUIRED_ENV_VARS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'];
const missingVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingVars.length > 0) {
  console.error(`Missing required environment variable(s): ${missingVars.join(', ')}`);
  process.exit(1);
}

const config = {
  slackBotToken: process.env.SLACK_BOT_TOKEN,
  slackAppToken: process.env.SLACK_APP_TOKEN,
  slackChannelId: process.env.SLACK_CHANNEL_ID || 'C0AGCR0USR0',
  openclawGatewayUrl: process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789',
  openclawGatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || 'open-DA-claws-FR',
  openclawAgentId: 'main',
  maxSlackMessageLength: 4000,
  updateIntervalMs: Number(process.env.UPDATE_INTERVAL_MS) || 1500,
  inactivityTimeoutMs: Number(process.env.INACTIVITY_TIMEOUT_MS) || 30000,
  port: Number(process.env.PORT) || 3000
};

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
  logLevel: LogLevel.INFO
});

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

async function readWithInactivityTimeout(reader, timeoutMs, ac) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ac.abort();
      reject(makeError('GATEWAY_TIMEOUT', '⚠️ Gateway timed out — try again'));
    }, timeoutMs);

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
  let currentIntervalMs = updateIntervalMs;
  let intervalId;

  function scheduleInterval() {
    intervalId = setInterval(async () => {
      const current = pendingText;
      if (current === lastPosted) return;
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
        } else {
          logger.warn('chat.update failed, skipping window', err?.message || String(err));
        }
      }
    }, currentIntervalMs);
  }

  scheduleInterval();

  return {
    onDelta(accumulated) {
      pendingText = accumulated;
    },
    stop() {
      clearInterval(intervalId);
    }
  };
}

async function* queryOpenClaw({ sessionKey, userText, inactivityTimeoutMs }) {
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
    // Graceful fallback: gateway ignored stream: true, returned non-SSE response.
    try {
      const responseText = await response.text();
      const parsed = JSON.parse(responseText);
      const content = parsed?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) {
        console.warn(
          'better-openclaw-slack: gateway returned non-SSE response, falling back to non-streaming parse'
        );
        yield content;
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
      const chunk = await readWithInactivityTimeout(reader, inactivityTimeoutMs, ac);

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

async function safeAddEyesReaction(client, channel, timestamp) {
  try {
    await client.reactions.add({
      channel,
      timestamp,
      name: 'eyes'
    });
  } catch (error) {
    // Ignore known no-op reaction failures so message flow still proceeds.
    const errorCode = error?.data?.error;
    if (errorCode !== 'already_reacted' && errorCode !== 'invalid_name') {
      throw error;
    }
  }
}

async function safeRemoveEyesReaction(client, channel, timestamp, logger) {
  try {
    await client.reactions.remove({
      channel,
      timestamp,
      name: 'eyes'
    });
  } catch (error) {
    // Ignore cleanup errors; bot response should not fail because reaction removal failed.
    const errorCode = error?.data?.error;
    if (errorCode !== 'no_reaction' && errorCode !== 'message_not_found') {
      logger.error('Failed to remove eyes reaction:', errorCode || error.message || error);
    }
  }
}

app.message(async ({ message, client, logger }) => {
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

  // Post placeholder; if this fails, abort without starting gateway fetch.
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
    await safeRemoveEyesReaction(client, message.channel, message.ts, logger);
    return;
  }

  let accumulated = '';
  const updater = throttledSlackUpdater({
    client,
    channel: message.channel,
    placeholderTs,
    updateIntervalMs: config.updateIntervalMs,
    logger
  });

  try {
    for await (const delta of queryOpenClaw({
      sessionKey,
      userText: message.text,
      inactivityTimeoutMs: config.inactivityTimeoutMs
    })) {
      accumulated += delta;
      updater.onDelta(accumulated);
    }

    updater.stop();

    // Final update: replace placeholder with first chunk, post overflow as new messages.
    const finalText = accumulated || '⚠️ Gateway returned an empty reply';
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
    await safeRemoveEyesReaction(client, message.channel, message.ts, logger);
  }
});

(async () => {
  try {
    await app.start(config.port);
    console.log('Molty Slack bot is running');
    console.log(`Listening in channel: ${config.slackChannelId}`);
  } catch (error) {
    console.error('Failed to start app:', error);
    process.exit(1);
  }
})();

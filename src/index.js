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

async function queryOpenClaw({ sessionKey, userText }) {
  const endpoint = `${config.openclawGatewayUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const body = {
    model: 'openclaw',
    messages: [{ role: 'user', content: userText }],
    user: sessionKey
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
      body: JSON.stringify(body)
    });
  } catch (error) {
    const gatewayUnavailableError = new Error('Gateway unavailable');
    gatewayUnavailableError.code = 'GATEWAY_UNAVAILABLE';
    gatewayUnavailableError.cause = error;
    throw gatewayUnavailableError;
  }

  const responseText = await response.text();
  if (!response.ok) {
    const gatewayHttpError = new Error(parseGatewayError(response.status, responseText));
    gatewayHttpError.code = 'GATEWAY_ERROR';
    gatewayHttpError.status = response.status;
    throw gatewayHttpError;
  }

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    const invalidPayloadError = new Error('⚠️ Gateway returned an invalid response');
    invalidPayloadError.code = 'GATEWAY_ERROR';
    throw invalidPayloadError;
  }

  const reply = parsed?.choices?.[0]?.message?.content;
  if (typeof reply !== 'string' || !reply.trim()) {
    const emptyReplyError = new Error('⚠️ Gateway returned an empty reply');
    emptyReplyError.code = 'GATEWAY_ERROR';
    throw emptyReplyError;
  }

  return reply;
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

async function safeRemoveEyesReaction(client, channel, timestamp) {
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
      console.error('Failed to remove eyes reaction:', errorCode || error.message || error);
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

  try {
    const reply = await queryOpenClaw({
      sessionKey,
      userText: message.text
    });

    const chunks = splitMessage(reply, config.maxSlackMessageLength);
    for (const chunk of chunks) {
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: threadTs,
        text: chunk
      });
    }
  } catch (error) {
    logger.error('Message handling failed', error);

    const errorText = error?.code === 'GATEWAY_UNAVAILABLE'
      ? '⚠️ Gateway unavailable, try again later'
      : (error?.message || '⚠️ Unexpected error');

    try {
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: threadTs,
        text: errorText
      });
    } catch (postError) {
      logger.error('Failed to post error message to Slack', postError);
    }
  } finally {
    await safeRemoveEyesReaction(client, message.channel, message.ts);
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

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type PluginConfig = {
  channelId?: string;
  gatewayUrl?: string;
  agentId?: string;
  maxMessageLength?: number;
};

function parseChannelId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseGatewayUrl(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return "http://127.0.0.1:18789";
}

function parseAgentId(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return "main";
}

function parseMaxMessageLength(value: unknown): number {
  const candidate = Number(value);
  if (Number.isFinite(candidate) && candidate > 0) return candidate;
  return 4000;
}

function resolveThreadTs(message: { thread_ts?: string; ts: string }): string {
  return message.thread_ts || message.ts;
}

function buildSessionKey(channelId: string, threadTs: string): string {
  return `slack:thread:${channelId}:${threadTs}`;
}

function splitMessage(text: string, maxLength: number): string[] {
  if (!text || text.length <= maxLength) {
    return [text || ""];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
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

function parseGatewayError(status: number, payloadText: string): string {
  try {
    const payload = JSON.parse(payloadText);
    if (typeof payload?.error?.message === "string" && payload.error.message.trim()) {
      return `⚠️ Gateway error (${status}): ${payload.error.message.trim()}`;
    }
    if (typeof payload?.message === "string" && payload.message.trim()) {
      return `⚠️ Gateway error (${status}): ${payload.message.trim()}`;
    }
  } catch (error) {
    // Ignore parsing failures and fallback to status-only message.
  }

  return `⚠️ Gateway error (${status})`;
}

async function queryOpenClaw(options: {
  sessionKey: string;
  userText: string;
  gatewayUrl: string;
  gatewayToken: string | undefined;
  agentId: string;
}): Promise<string> {
  const endpoint = `${options.gatewayUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-openclaw-agent-id": options.agentId,
    "x-openclaw-session-key": options.sessionKey,
  };

  if (options.gatewayToken) {
    headers.Authorization = `Bearer ${options.gatewayToken}`;
  }

  const body = {
    model: "openclaw",
    messages: [{ role: "user", content: options.userText }],
    user: options.sessionKey,
    stream: false,
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    const gatewayUnavailableError = new Error("Gateway unavailable") as Error & {
      code: string;
      cause?: unknown;
    };
    gatewayUnavailableError.code = "GATEWAY_UNAVAILABLE";
    gatewayUnavailableError.cause = error;
    throw gatewayUnavailableError;
  }

  const responseText = await response.text();
  if (!response.ok) {
    const gatewayHttpError = new Error(
      parseGatewayError(response.status, responseText),
    ) as Error & { code: string; status?: number };
    gatewayHttpError.code = "GATEWAY_ERROR";
    gatewayHttpError.status = response.status;
    throw gatewayHttpError;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    const invalidPayloadError = new Error("⚠️ Gateway returned an invalid response");
    invalidPayloadError.code = "GATEWAY_ERROR" as const;
    throw invalidPayloadError;
  }

  const reply = parsed?.choices?.[0]?.message?.content;
  if (typeof reply !== "string" || !reply.trim()) {
    const emptyReplyError = new Error("⚠️ Gateway returned an empty reply");
    emptyReplyError.code = "GATEWAY_ERROR";
    throw emptyReplyError;
  }

  return reply;
}

async function safeAddEyesReaction(
  client: any,
  channel: string,
  timestamp: string,
): Promise<void> {
  try {
    await client.reactions.add({
      channel,
      timestamp,
      name: "eyes",
    });
  } catch (error) {
    // Ignore known no-op reaction failures so message flow still proceeds.
    const errorCode = (error as any)?.data?.error;
    if (errorCode !== "already_reacted" && errorCode !== "invalid_name") {
      throw error;
    }
  }
}

async function safeRemoveEyesReaction(
  client: any,
  channel: string,
  timestamp: string,
  logger: {
    error?: (message: string, ...args: unknown[]) => void;
  },
): Promise<void> {
  try {
    await client.reactions.remove({
      channel,
      timestamp,
      name: "eyes",
    });
  } catch (error) {
    // Ignore cleanup errors; bot response should not fail because reaction removal failed.
    const errorCode = (error as any)?.data?.error;
    if (errorCode !== "no_reaction" && errorCode !== "message_not_found") {
      logger.error?.(
        "Failed to remove eyes reaction:",
        errorCode || (error as Error)?.message || error,
      );
    }
  }
}

export default {
  id: "better-openclaw-slack",
  name: "Slack Bridge",
  register(api: OpenClawPluginApi) {
    let appInstance: any = null;

    api.registerService({
      id: "slack-bridge",
      start: async (ctx) => {
        const logger = ctx.logger;

        const botToken = process.env.SLACK_BOT_TOKEN?.trim();
        const appToken = process.env.SLACK_APP_TOKEN?.trim();
        const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
        if (!botToken || !appToken) {
          logger.error(
            "better-openclaw-slack: SLACK_BOT_TOKEN and SLACK_APP_TOKEN env vars required",
          );
          return;
        }

        const cfg = (ctx.config ?? {}) as PluginConfig;
        const channelId = parseChannelId(cfg.channelId);
        const gatewayUrl = parseGatewayUrl(cfg.gatewayUrl);
        const agentId = parseAgentId(cfg.agentId);
        const maxMessageLength = parseMaxMessageLength(cfg.maxMessageLength);

        let SlackApp;
        let LogLevel;
        try {
          ({ App: SlackApp, LogLevel } = await import("@slack/bolt"));
        } catch (error) {
          logger.error(
            `better-openclaw-slack: failed to load @slack/bolt (${String(error)})`,
          );
          return;
        }

        const app = new SlackApp({
          token: botToken,
          appToken,
          socketMode: true,
          logLevel: LogLevel?.INFO,
        });

        app.message(async ({ message, client }: { message: any; client: any }) => {
          if (!message) {
            return;
          }

          if (channelId && message.channel !== channelId) {
            return;
          }

          if (message.bot_id || message.subtype === "bot_message") {
            return;
          }

          if (typeof message.text !== "string" || !message.text.trim()) {
            return;
          }

          const threadTs = resolveThreadTs(message);
          const sessionKey = buildSessionKey(message.channel, threadTs);

          try {
            await safeAddEyesReaction(client, message.channel, message.ts);
          } catch (error) {
            logger.error("Unable to add eyes reaction", error as any);
          }

          try {
            const reply = await queryOpenClaw({
              sessionKey,
              userText: message.text,
              gatewayUrl,
              gatewayToken,
              agentId,
            });

            const chunks = splitMessage(reply, maxMessageLength);
            for (const chunk of chunks) {
              await client.chat.postMessage({
                channel: message.channel,
                thread_ts: threadTs,
                text: chunk,
              });
            }
          } catch (error) {
            logger.error("Message handling failed", error as any);

            const errorText =
              (error as any)?.code === "GATEWAY_UNAVAILABLE"
                ? "⚠️ Gateway unavailable, try again later"
                : (error as any)?.message || "⚠️ Unexpected error";

            try {
              await client.chat.postMessage({
                channel: message.channel,
                thread_ts: threadTs,
                text: errorText,
              });
            } catch (postError) {
              logger.error("Failed to post error message to Slack", postError as any);
            }
          } finally {
            await safeRemoveEyesReaction(client, message.channel, message.ts, logger);
          }
        });

        try {
          await app.client.auth.test();
        } catch (error) {
          logger.error(
            "better-openclaw-slack: Slack auth.test failed, service not started",
            error as any,
          );
          return;
        }

        try {
          await app.start();
        } catch (error) {
          logger.error(
            "better-openclaw-slack: failed to start Slack app",
            error as any,
          );
          return;
        }

        logger.info(
          channelId
            ? `slack-bridge: running — listening in channel ${channelId}`
            : "slack-bridge: running",
        );

        appInstance = app;
      },
      stop: async (ctx) => {
        if (!appInstance) {
          return;
        }

        try {
          await appInstance.stop();
          ctx.logger.info("better-openclaw-slack: stopped");
        } catch (error) {
          ctx.logger.error(
            `better-openclaw-slack: stop failed (${String(error)})`,
          );
        } finally {
          appInstance = null;
        }
      },
    });
  },
};


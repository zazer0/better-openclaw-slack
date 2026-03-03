import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type PluginConfig = {
  channelId?: string;
  gatewayUrl?: string;
  agentId?: string;
  maxMessageLength?: number;
  updateIntervalMs?: number;
  inactivityTimeoutMs?: number;
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

function parseUpdateIntervalMs(value: unknown): number {
  const candidate = Number(value);
  if (Number.isFinite(candidate) && candidate >= 500 && candidate <= 10000) return candidate;
  return 1500;
}

function parseInactivityTimeoutMs(value: unknown): number {
  const candidate = Number(value);
  if (Number.isFinite(candidate) && candidate >= 5000 && candidate <= 300000) return candidate;
  return 30000;
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

function makeError(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Error & { code: string } {
  return Object.assign(new Error(message), { code, ...extra });
}

async function readWithInactivityTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  timeoutMs: number,
  ac: AbortController,
): Promise<ReadableStreamReadResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ac.abort();
      reject(makeError("GATEWAY_TIMEOUT", "⚠️ Gateway timed out — try again"));
    }, timeoutMs);

    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function throttledSlackUpdater(options: {
  client: any;
  channel: string;
  placeholderTs: string;
  updateIntervalMs: number;
  logger: { warn?: (message: string, ...args: unknown[]) => void };
}): {
  onDelta: (accumulated: string) => void;
  stop: () => void;
} {
  let pendingText = "";
  let lastPosted = "";
  let currentIntervalMs = options.updateIntervalMs;
  let intervalId: ReturnType<typeof setInterval>;

  function scheduleInterval(): void {
    intervalId = setInterval(async () => {
      const current = pendingText;
      if (current === lastPosted) return;
      try {
        await options.client.chat.update({
          channel: options.channel,
          ts: options.placeholderTs,
          text: current,
        });
        lastPosted = current;
      } catch (err: any) {
        if (err?.data?.error === "ratelimited" || err?.code === "slack_webapi_rate_limited_error") {
          options.logger.warn?.("chat.update rate limited, backing off");
          clearInterval(intervalId);
          currentIntervalMs = Math.min(currentIntervalMs * 2, 10000);
          scheduleInterval();
        } else {
          options.logger.warn?.(
            "chat.update failed, skipping window",
            err?.message || String(err),
          );
        }
      }
    }, currentIntervalMs);
  }

  scheduleInterval();

  return {
    onDelta(accumulated: string): void {
      pendingText = accumulated;
    },
    stop(): void {
      clearInterval(intervalId);
    },
  };
}

async function* queryOpenClaw(options: {
  sessionKey: string;
  userText: string;
  gatewayUrl: string;
  gatewayToken: string | undefined;
  agentId: string;
  inactivityTimeoutMs: number;
}): AsyncGenerator<string, void, unknown> {
  const ac = new AbortController();
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
    stream: true,
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (error) {
    throw makeError("GATEWAY_UNAVAILABLE", "Gateway unavailable", { cause: error });
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw makeError("GATEWAY_ERROR", parseGatewayError(response.status, responseText), {
      status: response.status,
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/event-stream")) {
    // Graceful fallback: gateway ignored stream: true, returned non-SSE response.
    try {
      const responseText = await response.text();
      const parsed = JSON.parse(responseText);
      const content = parsed?.choices?.[0]?.message?.content;
      if (typeof content === "string" && content.trim()) {
        console.warn(
          "better-openclaw-slack: gateway returned non-SSE response, falling back to non-streaming parse",
        );
        yield content;
        return;
      }
    } catch {
      // fall through to throw GATEWAY_STREAM_ERROR
    }
    throw makeError("GATEWAY_STREAM_ERROR", "⚠️ Gateway stream error");
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let hasContent = false;
  let lineBuffer = "";

  try {
    while (true) {
      const chunk = await readWithInactivityTimeout(reader, options.inactivityTimeoutMs, ac);

      if (chunk.done) {
        if (hasContent) return;
        throw makeError("GATEWAY_EMPTY_STREAM", "⚠️ Gateway returned an empty reply");
      }

      lineBuffer += decoder.decode(chunk.value, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice("data:".length).trim();
        if (dataStr === "[DONE]") return;
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
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
        const updateIntervalMs = parseUpdateIntervalMs(cfg.updateIntervalMs);
        const inactivityTimeoutMs = parseInactivityTimeoutMs(cfg.inactivityTimeoutMs);

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

          // Post placeholder; if this fails, abort without starting gateway fetch.
          let placeholderTs: string;
          try {
            const placeholderResult = await client.chat.postMessage({
              channel: message.channel,
              thread_ts: threadTs,
              text: "_⏳ Working..._",
            });
            placeholderTs = placeholderResult.ts;
          } catch (placeholderError) {
            logger.error("Failed to post placeholder message", placeholderError as any);
            try {
              await client.chat.postMessage({
                channel: message.channel,
                thread_ts: threadTs,
                text: "⚠️ Failed to post message to Slack",
              });
            } catch {
              // ignore
            }
            await safeRemoveEyesReaction(client, message.channel, message.ts, logger);
            return;
          }

          let accumulated = "";
          const updater = throttledSlackUpdater({
            client,
            channel: message.channel,
            placeholderTs,
            updateIntervalMs,
            logger,
          });

          try {
            for await (const delta of queryOpenClaw({
              sessionKey,
              userText: message.text,
              gatewayUrl,
              gatewayToken,
              agentId,
              inactivityTimeoutMs,
            })) {
              accumulated += delta;
              updater.onDelta(accumulated);
            }

            updater.stop();

            // Final update: replace placeholder with first chunk, post overflow as new messages.
            const finalText = accumulated || "⚠️ Gateway returned an empty reply";
            const chunks = splitMessage(finalText, maxMessageLength);

            try {
              await client.chat.update({
                channel: message.channel,
                ts: placeholderTs,
                text: chunks[0],
              });
            } catch (err: any) {
              if (
                err?.data?.error === "ratelimited" ||
                err?.code === "slack_webapi_rate_limited_error"
              ) {
                logger.warn?.("Final chat.update rate limited, retrying after 2s");
                await new Promise<void>((resolve) => setTimeout(resolve, 2000));
                try {
                  await client.chat.update({
                    channel: message.channel,
                    ts: placeholderTs,
                    text: chunks[0],
                  });
                } catch {
                  await client.chat.postMessage({
                    channel: message.channel,
                    thread_ts: threadTs,
                    text: chunks[0],
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
                text: chunks[i],
              });
            }
          } catch (error) {
            updater.stop();
            logger.error("Message handling failed", error as any);

            const code = (error as any)?.code;
            let errorText: string;
            switch (code) {
              case "GATEWAY_UNAVAILABLE":
                errorText = "⚠️ Gateway unavailable, try again later";
                break;
              case "GATEWAY_ERROR":
                errorText = (error as any)?.message || "⚠️ Gateway error";
                break;
              case "GATEWAY_STREAM_ERROR":
                errorText = accumulated
                  ? `${accumulated}\n\n⚠️ Stream interrupted`
                  : "⚠️ Gateway stream error";
                break;
              case "GATEWAY_TIMEOUT":
                errorText = "⚠️ Gateway timed out — try again";
                break;
              case "GATEWAY_EMPTY_STREAM":
                errorText = "⚠️ Gateway returned an empty reply";
                break;
              default:
                errorText = (error as any)?.message || "⚠️ Unexpected error";
            }

            try {
              const errorChunks = splitMessage(errorText, maxMessageLength);
              await client.chat.update({
                channel: message.channel,
                ts: placeholderTs,
                text: errorChunks[0],
              });
              for (let i = 1; i < errorChunks.length; i++) {
                await client.chat.postMessage({
                  channel: message.channel,
                  thread_ts: threadTs,
                  text: errorChunks[i],
                });
              }
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

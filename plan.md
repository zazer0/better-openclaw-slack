# preservePlaceholder Content-Wipe Bug

## The Bug

When a mid-stream error occurs (GATEWAY_TIMEOUT or GATEWAY_STREAM_ERROR), the catch block at line 719-729 decides whether to preserve the placeholder or overwrite it:

```ts
const hasAccumulated = accumulated.length > 0;
const preservePlaceholder =
  hasAccumulated &&
  (code === "GATEWAY_TIMEOUT" || code === "GATEWAY_STREAM_ERROR");
```

The assumption is: "if we have accumulated content, the placeholder already shows it (via the throttled updater), so post the error as a follow-up instead of overwriting."

**This assumption is wrong.** The placeholder may still show `_Working..._` or `_Working... (tool_name)_` if the updater's interval timer hasn't fired yet, or if every `chat.update` attempt failed (rate-limited, etc). In that case, `preservePlaceholder` is `true`, the placeholder is left showing the working text permanently, and the accumulated content is silently lost.

## Root Cause: ThrottledSlackUpdater State

The updater (lines 115-183) tracks:

| Field | Purpose |
|---|---|
| `pendingText` | Next text to post on the next interval tick |
| `lastPosted` | Text from the last **successful** `chat.update` call |
| `contentReceived` | Set `true` by `onDelta()` — gates `setWorkingText()` |
| `currentIntervalMs` | Interval between ticks (doubles on rate-limit) |

Key observations:

1. **`onDelta(accumulated)`** (line 170): Sets `contentReceived = true` and `pendingText = accumulated`. Does NOT trigger an immediate Slack API call — it just queues the text for the next interval tick.

2. **`setWorkingText(text)`** (line 174): Only updates `pendingText` if `!contentReceived`. This correctly prevents tool-name updates from clobbering real content.

3. **Interval tick** (line 133): Compares `pendingText` vs `lastPosted`, calls `chat.update`, and sets `lastPosted = current` only on success.

4. **No exposure of whether any update succeeded.** The caller has no way to ask "has the placeholder been updated from its initial working text to actual content?"

### Race timeline that triggers the bug

```
T=0ms    placeholder posted: "_Working..._"
T=100ms  first SSE delta arrives → accumulated = "Hello", onDelta() called
         pendingText = "Hello", contentReceived = true
T=500ms  GATEWAY_TIMEOUT fires (or stream error)
         updater.stop() called — interval cleared
         catch block: accumulated.length > 0 → true
                      code === "GATEWAY_TIMEOUT" → true
                      preservePlaceholder → TRUE
         → posts "Gateway timed out" as follow-up
         → placeholder still shows "_Working..._" forever
         → "Hello" is lost
```

The interval (default 1500ms) hadn't fired yet at T=500ms, so `chat.update` was never called.

## The Fix

### 1. Expose `hasPosted()` on the updater

Add a method that returns whether any `chat.update` has actually succeeded with real content:

```ts
// Inside throttledSlackUpdater, add:
let updateSucceeded = false;

// In the interval tick, after successful chat.update:
lastPosted = current;
if (contentReceived) updateSucceeded = true;

// Expose:
return {
  onDelta(...) { ... },
  setWorkingText(...) { ... },
  stop() { ... },
  hasPosted(): boolean { return updateSucceeded; },
};
```

Using a dedicated `updateSucceeded` flag (rather than `lastPosted !== ""`) avoids ambiguity — `lastPosted` could theoretically match a working-text update, not real content.

### 2. Fix the catch block logic

Replace the current preservePlaceholder block (lines 715-744) with:

```ts
const hasAccumulated = accumulated.length > 0;
const isMidStreamError =
  code === "GATEWAY_TIMEOUT" || code === "GATEWAY_STREAM_ERROR";
const preservePlaceholder =
  hasAccumulated && isMidStreamError && updater.hasPosted();

if (preservePlaceholder) {
  // Placeholder already shows accumulated content — post error as follow-up
  await client.chat.postMessage({
    channel: message.channel,
    thread_ts: threadTs,
    text: errorText,
  });
} else if (hasAccumulated && isMidStreamError) {
  // Accumulated content exists but was never posted to Slack —
  // overwrite placeholder with accumulated + error suffix
  const combined = accumulated + "\n\n" + errorText;
  const combinedChunks = splitMessage(combined, maxMessageLength);
  await client.chat.update({
    channel: message.channel,
    ts: placeholderTs,
    text: combinedChunks[0],
  });
  for (let i = 1; i < combinedChunks.length; i++) {
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: threadTs,
      text: combinedChunks[i],
    });
  }
} else {
  // No accumulated content or non-mid-stream error — overwrite with error
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
}
```

### Why this is the minimal correct fix

- **One new boolean + one new method** — no structural changes to the updater.
- **Three-way branch** covers all cases:
  - Content posted to Slack + mid-stream error → preserve placeholder, follow-up error (existing working path)
  - Content accumulated but never posted + mid-stream error → write accumulated + error to placeholder (fixes the bug)
  - No content or pre-stream error → overwrite placeholder with error (existing working path)
- No changes to the happy path or to non-error flows.

### Alternative considered and rejected

**Forcing an immediate `chat.update` in `stop()`**: This would add latency to every request (even successful ones) and creates a second code path for the "final update" logic. The `hasPosted()` approach is simpler and only affects the error path.

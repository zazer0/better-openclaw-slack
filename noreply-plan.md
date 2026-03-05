# NO_REPLY Handling Investigation and Implementation Plan

## Findings

1. Gateway call location:
- `index.ts:181` builds the gateway endpoint as `.../v1/chat/completions`.
- `index.ts:201-206` performs the `fetch` POST.

2. Where `choices` content is processed:
- Non-SSE fallback parses full JSON at `index.ts:223-225` and reads `parsed?.choices?.[0]?.message?.content`.
- SSE streaming parses chunk deltas at `index.ts:278-282` and reads `parsed?.choices?.[0]?.delta?.content`, appending into `accumulated` at `index.ts:629`.

3. Current empty-reply behavior:
- Empty SSE stream throws `GATEWAY_EMPTY_STREAM` at `index.ts:258` with message `⚠️ Gateway returned an empty reply`.
- Final Slack message fallback also uses empty check at `index.ts:636`:
  - `const finalText = accumulated || "⚠️ Gateway returned an empty reply";`
- Error mapping for `GATEWAY_EMPTY_STREAM` is at `index.ts:698-700`.

4. Current NO_REPLY behavior:
- If model outputs `NO_REPLY`, it is treated as ordinary text and sent to Slack as-is (no indicator), because it is non-empty.

## Implementation Plan (index.ts)

### 1) Add explicit constants and a helper to normalize NO_REPLY

Add below existing constants (`index.ts:7-9`) and before `resolveThreadTs` (`index.ts:11`):

- `const EMPTY_REPLY_WARNING = "⚠️ Gateway returned an empty reply";`
- `const NO_REPLY_INDICATOR = "🤫 [Model chose NO_REPLY]";`
- Helper function:
  - Input: raw text string.
  - Logic: `trim()`, compare case-insensitively to `NO_REPLY`.
  - Return: `NO_REPLY_INDICATOR` when match, else `null`.

Suggested helper shape:
- `function mapNoReplyIndicator(text: string): string | null`
- `const normalized = text.trim();`
- `if (normalized.toLowerCase() === "no_reply") return NO_REPLY_INDICATOR;`
- `return null;`

### 2) Use the helper at final Slack text selection

Replace current final text assignment at `index.ts:636`.

Current:
- `const finalText = accumulated || "⚠️ Gateway returned an empty reply";`

Planned replacement:
- `const noReplyText = mapNoReplyIndicator(accumulated);`
- `const finalText = noReplyText ?? (accumulated || EMPTY_REPLY_WARNING);`

Why this placement:
- Covers both SSE and non-SSE paths because both end up in `accumulated`.
- Keeps existing empty/null behavior unchanged (`accumulated || EMPTY_REPLY_WARNING`).
- Only replaces exact semantic NO_REPLY values (case-insensitive, trimmed).

### 3) Replace duplicated empty-warning literals with the constant (safe consistency)

Update these lines to use `EMPTY_REPLY_WARNING`:
- `index.ts:258` (throw `GATEWAY_EMPTY_STREAM`)
- `index.ts:699` (`GATEWAY_EMPTY_STREAM` errorText)

This is optional for behavior, but recommended to prevent drift.

## Expected Behavior After Change

- Model returns `"NO_REPLY"`, `" no_reply "`, `"No_RePlY"`:
  - Slack final message becomes: `🤫 [Model chose NO_REPLY]`.
- Model returns empty/null/no stream content:
  - Existing warning remains: `⚠️ Gateway returned an empty reply`.
- Normal non-empty model content:
  - Unchanged behavior.

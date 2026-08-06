# Changelog

## 0.7.0 — 2026-08-08

- **Drop-in conversation mode.** `withMemory(openai, { memory })` now accepts a
  per-call `conversation: "id"` — the call site stays the provider SDK's, one
  field richer. Pass only the new messages; the stored conversation supplies
  the window, memory supplies the context, both turns are stored with the
  provider's usage, and compaction runs on cadence. Anthropic-shaped clients
  (`client.messages.create`) are wrapped too, with system content moved to the
  `system` field.
- **Server-side compaction.** `summarize: 'server'` hands summarization to
  GitLoom's own model — no model wired into the client. Local summarization
  (a function) remains the private-by-default choice.

## 0.6.1 — 2026-08-07

- A two-message history can still force-compact.

## 0.6.0 — 2026-08-07

- Multimodal content parts with transparent media upload; `edit` (fork) and
  `editInPlace` (redaction); titles; usage-driven and cadence compaction.

## 0.5.0 — 2026-08-06

- `recall()` passes the full evidence shape through: per-arm scores,
  provenance with history and diff, relations, vocabulary matches.

## 0.4.0

- Conversations: create/load/append/compact/rewind/branches/ingest; token
  estimation and context fitting.

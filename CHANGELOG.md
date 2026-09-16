# Changelog

## 0.9.1 — 2026-09-16

- **`withMemory` declares the surface it returns.** It attached `.gitloom` at
  runtime but typed its return as the client you passed in, so every
  documented `openai.gitloom.conversation(…)` / `openai.gitloom.memory.recall(…)`
  was a compile error. The return type is now `T & { gitloom: GitloomFeatures }`.
  Strictly wider — nothing that compiled before stops compiling.

## 0.9.0 — 2026-09-15

- **Recall returns memories, not fragments.** `recall()` now yields one entry per
  memory — `content` is the whole body, `sections` names the headings that
  matched — where it used to return one hit per matching section, each carrying
  its own copy of the same provenance and relations.
- **`score` is a calibrated relevance in `[0, 1]`**, comparable across queries,
  replacing a fused rank that only meant something within one response.
  `matched` says which arms produced a result, so a graph neighbour is
  distinguishable from evidence, and `via` names what pulled it in.
- **Filters on `recall()`**: `tiers`, `paths`, `tags`, `tagsAll`, `since`,
  `until`, `minScore`, `context`, `detail`. They apply inside every retrieval
  arm server-side, so confining a query to a directory is a real boundary.
- **`answer()`** — one text answer from the memory. A fast model summarizes the
  retrieval by default; `{ agentic: true }` lets a stronger model search with
  tools and return its trace. Both meter as chats rather than reads.
- **`vocab` and `skills`.** `memory.vocab.learn/list/lookup/forget` teaches a
  namespace the terms its memories are written in, so a query for one surface
  form finds another. `memory.skills.store/find/list` keeps procedural
  know-how and finds the one that fits a task.
- **`find_skill` tool** exported beside `recall_memory` and `save_memory`, in
  every tool format including MCP.

**Breaking.** The server field is `memories`, not `hits`; `RecalledMemory` gained
`path`/`content` in place of `id`/`text`, and `relations` is now `related`.
Requires the API deployed on or after 2026-09-15.

## 0.8.0 — 2026-08-08

- **Added features on the wrapped client.** `openai.gitloom.conversation(id)`
  exposes rewind/edit/redaction/titles/branches on the same managed
  conversation the completions flow through; `openai.gitloom.memory` for
  direct recall/remember/media.
- Documentation leads with the drop-in only; the manual append loop is gone.

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

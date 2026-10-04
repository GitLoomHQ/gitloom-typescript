# @gitloomhq/sdk

TypeScript SDK for [GitLoom](https://gitloom.cloud) — a **drop-in beside the
OpenAI and Anthropic SDKs**. Wrap the client you already use; your call sites
stay exactly as they are, one field richer, and the conversation manages
itself: rolling context window, memory retrieval, storage, compaction, titles.

```bash
npm install @gitloomhq/sdk
```

## Drop-in

```ts
import OpenAI from 'openai'
import { Gitloom, withMemory } from '@gitloomhq/sdk'

const memory = new Gitloom()                 // reads GITLOOM_API_KEY
const openai = withMemory(new OpenAI(), { memory })   // ← the only setup

const res = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'What camera do I own?' }],
  // @ts-expect-error -- GitLoom reads conversation and removes it before the request is sent
  conversation: 'chat-42',                   // ← the only change per call
})
```

`conversation` is not in OpenAI's parameter types yet, so TypeScript needs the
`@ts-expect-error` above it; at runtime GitLoom takes the field off the request
before OpenAI sees it.

That's the whole loop. Behind that one call: the stored conversation supplies
the earlier turns (you pass **only the new message** — never append anything),
memory is retrieved and injected as background, both turns are stored with the
response's **real token usage**, compaction runs on cadence (default every 5
exchanges) or window pressure — and every compaction feeds the summarized
turns to memory ingestion. Untitled conversations get a title automatically.

Anthropic clients (`client.messages.create`) wrap identically, with system
content moved to the `system` field. Calls without `conversation:` pass
through completely untouched.

```ts
const openai = withMemory(new OpenAI(), {
  memory,
  conversations: {
    summarize: 'server',        // GitLoom's model compacts…
    // summarize: myFunction,   // …or yours, locally
    compactEvery: 5,
    namespace: userId,
  },
})
```

## Added features, on the same client

```ts
const conv = await openai.gitloom.conversation('chat-42')

await conv.rewind(6)                                              // fork after seq 6
await conv.edit(4, { role: 'user', content: 'ask differently' })  // fork at same seq
await conv.editInPlace(4, { content: '[redacted]' })              // destroy the original (PII)
await conv.setTitle('Camera shopping')
await conv.branches()
```

These act on the **same managed conversation** the completions flow through.
Direct memory: `openai.gitloom.memory.recall(...)` / `.remember(...)` / `.write(...)` — every
result is one whole memory with a calibrated 0–1 score, which arms matched it,
its tags and dates, its edges, and its last commit.

## Recall, filtered and answered

```ts
// Ranked memories, no model call. Milliseconds.
const { memories } = await memory.recall('what camera do I own', {
  tiers: ['facts'],                 // facts | incidents | rules | skills
  paths: ['facts/gear'],            // any directories
  tags: ['camera'],
  since: '2026-01-01',
  minScore: 0.3,
  limit: 8,
})
for (const m of memories) console.log(m.score.toFixed(2), m.path, m.matched, m.content)

// One text answer from a fast model over that retrieval …
const { answer, memories: evidence } = await memory.answer('what camera do I own')
// … or let a stronger model search the memory itself with tools.
const agentic = await memory.answer('which of my trips had the longest flight', { agentic: true })
console.log(agentic.answer, agentic.trace)
```

`answer` is metered as a chat, not a read. `recall` with `mode: 'summary'` or
`mode: 'agentic'` is the same thing with the memories and timings alongside.

### The lane path

`rank` retrieves on the lane path: lexical, cue, body, graph and time lanes each
search on their own, over the curated memories and the conversation turns, and
the time lane reads dates in the question ("last month", "in May"). `fused`
orders what they find by lane score; `jev` has a ranking model order it, and
sets `rankFallback` when it answers in lane order instead.

```ts
const { memories } = await memory.recall('when did I stake the tomatoes', { rank: 'fused', maxChars: 8000 })
for (const m of memories) console.log(m.store, m.said, m.excerpted, m.content)

const { answer } = await memory.answer('what did I plant after the storm', { rank: 'jev', model: 'sonnet' })
```

Each memory then says which `store` it came from (`memory`, or a word-for-word
conversation `turn`) and the days it was `said`. `maxChars` caps the memory
content returned: a memory that does not fit is cut to its opening sentence and
the sentences matching the question, and marked `excerpted`. `model` picks the
model that reads the memories in `summary` or `agentic` mode.

## Tags and when it happened

```ts
// A conversation: every memory drawn from it carries the tags, and is dated
// by when the conversation happened rather than when you sent it.
await memory.remember(
  [{ role: 'user', content: 'We signed the lease on the Koramangala flat today.' }],
  { tags: ['home', 'lease'], occurredAt: '2026-03-01', timezone: 'Asia/Kolkata' },
)

// Memories you already formed, stored as given — no model decides what to keep.
await memory.write([
  { path: 'facts/home/lease.md', content: 'The Koramangala lease runs to 2027-02-28.',
    tags: ['home', 'lease'], occurredAt: new Date('2026-03-01T10:30:00+05:30'),
    cues: ['when does my lease end'] },
])
```

`occurredAt` takes a `Date` (sent as epoch seconds), epoch seconds, or a
string: RFC 3339 with an offset, a date (`YYYY-MM-DD`, that calendar day), or a
datetime without an offset, read in `timezone`. `date` still works and is
deprecated. Tags are trimmed and lowercased, and may hold letters, digits,
spaces and `- _ . : / # @` — up to 32 tags of 64 characters. A refusal throws a
`GitloomError` whose `code` is `invalid_tag`, `invalid_date` or
`invalid_timezone`, and whose message names the field, e.g. `memories[1].tags[0]`.

Recalled memories, and `get()`, carry `userTags` (yours alone; `tags` lists
yours first, then the inferred ones) and `createdAt`, `updatedAt`, `occurredAt` and `expiresAt` as
`Date`s. `occurredPrecision: 'day'` means only the date is known, held as noon
UTC on it, so show it as a date; `occurredSource` says how it is known. The
`created` and `updated` strings remain, deprecated.

## Listing by filter

```ts
// No question: every memory the filters match, newest first by timeField.
const { memories: lease } = await memory.recall({
  tags: ['lease'],
  timeField: 'occurred',            // occurred | created | updated (default)
  since: '2026-01-01',
  until: '2026-03-31',              // a date alone includes that whole day
  tz: 'Asia/Kolkata',               // reads dates and offset-less times
})

// The same filters narrow a question.
await memory.recall('where did we travel', {
  tags: ['trip'], timeField: 'occurred', since: new Date('2026-05-01'),
})
```

Without a query, at least one of `tags`, `tagsAll`, `since`, `until`, `tiers`
or `paths` is needed — the SDK refuses before sending a request otherwise —
every match scores 1, and `mode` must be `raw` with no `rank`.
`context({ tags: ['lease'] })` lists the same way.

## Reading by path

```ts
const file = await memory.get('facts/home/lease.md')      // or 'file.md#section'
const { topics } = await memory.topics({ like: 'home' })  // check before inventing a topic
const { tree } = await memory.tree({ path: 'facts', depth: 2 })
const { nodes, edges } = await memory.graph()
await memory.forget(['facts/home/old-lease.md'])          // asynchronous; git keeps history
```

## Vocabulary and skills

```ts
// Teach abbreviations and domain terms. A recall for "k8s" then also finds
// memories written "kubernetes", and the definition comes back as `defined`.
await memory.vocab.learn([
  { term: 'kubernetes', aliases: ['k8s', 'kube'], definition: 'Container orchestration.' },
])
await memory.vocab.lookup('k8s')          // → { term: 'kubernetes', aliases: [...] }
await memory.vocab.list({ like: 'kube' })
await memory.vocab.forget(['kubernetes'])

// Store how things are done; find the skill that fits a task.
await memory.skills.store([
  { name: 'Deploy to production', topic: 'ops', description: 'Ship a release.',
    content: '## Steps\n1. Tag the release.\n2. `make deploy ENV=prod`',
    triggers: ['how do I ship a release', 'deploy to prod'] },
])
const [skill] = await memory.skills.find('release the new build')
```

Skills are memories under the `skills/` tier, so `recall({ tiers: ['skills'] })`
reaches them too, and `find_skill` is exported beside `recall_memory` and
`save_memory` in every tool format.

In those tools, `recall_memory` takes `tags`, `since`, `until` and `time_field`
(default `occurred`), and lists by filter when the model leaves out `query`;
each memory it hands back starts with the day it happened, e.g.
`- [2023-05-29] …`. `save_memory` takes `tags` and `occurred_at`.
`runToolResult` returns `{ text, isError }` for hosts, like MCP, that mark a
failed tool call; `runTool` returns the text alone.

## Multimodal

```ts
// Upload the photo once and hand the model a short-lived URL to it, so the
// stored turn holds a reference rather than the bytes.
const { id } = await memory.media.upload({ contentType: 'image/png', base64: b64 })
const { url } = await memory.media.get(id)

await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: [
    { type: 'text', text: "what's in this photo?" },
    { type: 'image_url', image_url: { url } },
  ] }],
  // @ts-expect-error -- GitLoom reads conversation and removes it before the request is sent
  conversation: 'chat-42',
})
```

Content parts go to the model exactly as you write them, so they take the
provider's own shape. `textPart`, `imagePart` and `imageData` build GitLoom's
parts for `conv.append()` on a conversation you drive yourself, where
`imageData`'s bytes are uploaded on append and stored by reference.

## Errors

Every failure is a `GitloomError` with a stable `code`, the HTTP `status` (0
when no response came back), and a readable `message`. No error, and nothing
logged from the client, ever carries the API key.

```ts
import { GitloomError } from '@gitloomhq/sdk'

try {
  await memory.recall('what camera do I own')
} catch (e) {
  if (!(e instanceof GitloomError)) throw e
  if (e.code === 'unauthorized') { /* wrong or revoked key */ }
  else if (e.isRateLimited) { /* too many requests; e.retryAfter is the seconds to wait, when known */ }
  else if (e.isQuotaExceeded) { /* the plan's monthly allowance is used */ }
  else if (e.isBalanceExhausted) { /* the prepaid wallet is empty */ }
  else if (e.code === 'timeout' || e.code === 'network_error') { /* no answer came back */ }
  else console.error(e.code, e.status, e.message)
}
```

`new Gitloom()` itself throws `missing_api_key` when no key is given or
`GITLOOM_API_KEY` is unset or blank, and `invalid_api_key` when the key holds
whitespace or control characters; surrounding whitespace is trimmed first.
Neither waits for a request. The API's own codes come through unchanged
(`invalid_tag`, `namespace_not_found`, `forbidden_namespace`, …); a key the
gateway refuses is `unauthorized`; anything else is `http_<status>` with
whatever the response said. 5xx responses, timeouts and network errors are
retried on reads; a 4xx, a 429 included, never is.

## Docs

https://docs.gitloom.cloud/documentation/typescript

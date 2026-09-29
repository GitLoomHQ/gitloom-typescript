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
  conversation: 'chat-42',                   // ← the only change per call
})
```

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
Direct memory: `openai.gitloom.memory.recall(...)` / `.remember(...)` — every
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

## Multimodal

```ts
import { textPart, imageData } from '@gitloomhq/sdk'

await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: [
    textPart("what's in this photo?"),
    imageData(b64, 'image/png'),   // uploaded transparently; stored by reference
  ] }],
  conversation: 'chat-42',
})
```

## Docs

https://docs.gitloom.cloud/documentation/typescript

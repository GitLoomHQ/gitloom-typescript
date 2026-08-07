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
hit carries per-arm scores, git history with the last diff, and relation
snippets.

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

# @gitloomhq/sdk

Memory for LLM agents. Drop it in beside the OpenAI or Anthropic SDK you already
use.

No dependencies, `fetch` only — runs on Node 18+, Bun, Deno, Cloudflare Workers
and Vercel edge functions.

```bash
npm install @gitloomhq/sdk
```

## One line

```ts
import OpenAI from 'openai'
import { Gitloom, withMemory } from '@gitloomhq/sdk'

const memory = new Gitloom()                       // reads GITLOOM_API_KEY
const openai = withMemory(new OpenAI(), { memory }) // ← the only change
```

Every completion now retrieves what is known about the user and saves the
exchange afterwards. The rest of your code is untouched:

```ts
const res = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'what should I cook tonight?' }],
})
```

Serving many users? Give each their own namespace:

```ts
const openai = withMemory(new OpenAI(), {
  memory,
  namespace: () => currentUserId,   // resolved per request
})
```

Skip memory for one call:

```ts
await openai.chat.completions.create({ model, messages, memory: false })
```

## Or call it directly

If you would rather see exactly what goes into the prompt:

```ts
const memory = new Gitloom({ namespace: userId })

const context = await memory.context('what should I cook tonight?')
const res = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [...(context ? [context] : []), { role: 'user', content: question }],
})

await memory.remember([
  { role: 'user', content: question },
  { role: 'assistant', content: answer },
])
```

`context()` returns `null` when nothing relevant is stored, so spreading it adds
nothing rather than an empty system message.

## Or let the agent decide

```ts
import { openaiTools, runTool, isMemoryTool } from '@gitloomhq/sdk'

const res = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages,
  tools: openaiTools,
})

for (const call of res.choices[0].message.tool_calls ?? []) {
  if (!isMemoryTool(call.function.name)) continue
  const result = await runTool(memory, {
    name: call.function.name,
    arguments: JSON.parse(call.function.arguments),
  })
  messages.push({ role: 'tool', tool_call_id: call.id, content: result })
}
```

`anthropicTools` is the same set in Anthropic's `input_schema` shape.

## Conversations that cannot overflow

Store the chat, and the SDK keeps what you send the model inside that model's
context window — summarizing what falls out, and turning those turns into
memory rather than discarding them.

```ts
const conv = await memory.conversations.create('chat-123', {
  model: 'gpt-5',
  summarize: async (evicted) => summarize(openai, evicted),
})

await conv.append({ role: 'user', content: input })

const reply = await openai.chat.completions.create({
  model: 'gpt-5',
  messages: conv.forModel(),   // provably fits, or throws
})

await conv.append(reply.choices[0].message)
```

No overflow check, no manual trimming, no decision about when to summarize.
`forModel()` never returns something the provider will reject.

Compaction happens **before** the append that would overflow, so the turn you
just handed in is never the one summarized away. The summary is produced
locally by your own model — GitLoom never sees the conversation in order to
compact it — while the evicted turns go to your memory, so the detail the
summary flattened stays recallable.

### Rewind

Every message is kept, including ones a compaction has already summarized.
Rewinding forks a branch; nothing is destroyed.

```ts
await conv.rewind(seq)          // fork here, originals intact
await conv.load({ full: true }) // every message, ignoring compactions
await conv.branches()
```

Reaching turns an earlier compaction covered is an ordinary read, not a
recovery.

## Just the context window

The window logic is usable on its own, against history you manage yourself:

```ts
import { fit, assertFits } from '@gitloomhq/sdk'

const { messages, evicted } = fit(history, {
  model: 'gpt-5',
  reserveForReply: 4000,
})

assertFits(history, { model: 'gpt-5' })  // throws before the provider 400s
```

System messages are always kept. Everything else evicts oldest-first, and a
tool call is never separated from its result — a result whose call was dropped
refers to something absent, which providers reject.

Token counts are estimated, biased to overcount, with a 10% margin under the
model's real limit: compacting slightly early is cheap, and a rejected request
is not. Pass `countTokens` to use an exact tokenizer instead.

## Namespaces

Or per call, when the user is only known once the request arrives:

```ts
await openai.chat.completions.create({
  model: 'gpt-5',
  messages,
  namespace: req.userId,   // wins over the wrapper's setting; never reaches OpenAI
})
```

A namespace is one isolated memory — its own history, its own index. The usual
pattern is one per end user.

They are created explicitly, so a typo in a user id is an error rather than a
new empty memory that silently swallows writes:

```ts
await memory.createNamespace(userId)   // idempotent; call it on every startup
```

## Writes are asynchronous

`remember()` returns once the write is **accepted**, not once it is stored.
Extraction runs a language model over the transcript and takes a few seconds.

That is usually what you want — the user is not waiting on it. When a test or a
script needs the memory to exist before reading:

```ts
await memory.remember(messages)
await memory.waitUntilStored('the thing you expect to find')
```

## Errors

Every failure is a `GitloomError` carrying the API's code:

```ts
import { GitloomError } from '@gitloomhq/sdk'

try {
  await memory.recall('anything')
} catch (e) {
  if (e instanceof GitloomError) {
    if (e.isNamespaceNotFound) await memory.createNamespace()
    else if (e.isQuotaExceeded) // back off
    else if (e.retryable) // already retried twice; the service is struggling
  }
}
```

`4xx` responses are not retried — they will not fix themselves and retrying only
delays the message. `429` and `5xx` are retried twice with jittered backoff.

Memory failures inside `withMemory` never fail your completion; they are passed
to `onError` and the call proceeds without memory.

## Configuration

| option | default |
|---|---|
| `apiKey` | `process.env.GITLOOM_API_KEY` |
| `baseUrl` | `process.env.GITLOOM_BASE_URL`, then the hosted API |
| `namespace` | `default` |
| `timeoutMs` | `30000` |
| `maxRetries` | `2` |
| `fetch` | the global `fetch` |

## What it costs you in latency

Retrieval is a single round trip; the service answers in about 145 ms at p99,
most of which is computing the query embedding. `withMemory` adds one retrieval
before the model call. The save afterwards is not awaited.

/**
 * The one-line integration: wrap an existing OpenAI or Anthropic client and it
 * gains memory.
 *
 * A Proxy rather than a subclass or a re-export, because both SDKs are large,
 * change often, and are not designed to be extended. Intercepting one method
 * and forwarding everything else means this keeps working when they add
 * something new, and it does not pin a peer-dependency version.
 */

import type { Gitloom } from './client'
import type { Conversation, ConversationOptions } from './conversation'
import type { ChatMessage } from './tokens'
import type { Memory } from './types'

export interface WrapOptions {
  /** Memory to read and write. */
  memory: Gitloom
  /**
   * Which namespace to use. A function is the useful form: a server handles
   * many users, and the namespace is whichever one this request belongs to.
   */
  namespace?: string | (() => string | undefined) | undefined
  /**
   * Save the exchange after the model answers. Default true.
   *
   * Off by default would make the wrapper a retrieval helper with a misleading
   * name; on by default means an integration that only reads has to say so.
   */
  save?: boolean | undefined
  /**
   * How many turns must pass before the conversation is saved again. Default 6.
   *
   * Saving on every completion means a forty-turn conversation buys forty
   * extractions of largely the same content — each one a language-model pass
   * over the transcript, and each one a unit of the caller's write quota.
   * Batching costs a little recency and saves most of the bill. Set to 1 to
   * restore per-turn saving.
   */
  saveEveryTurns?: number | undefined
  /** Inject remembered context before the model answers. Default true. */
  inject?: boolean | undefined
  /**
   * How much retrieved memory to inject. Default 8. Kept small deliberately:
   * the point is the handful of facts that bear on this turn, and a large block
   * of background measurably degrades the answer.
   */
  limit?: number | undefined
  /** Called when a memory operation fails. Default: warn and continue. */
  onError?: ((error: unknown) => void) | undefined
  /**
   * Defaults for conversations opened through the per-call `conversation`
   * field — summarize, compactEvery, namespace and so on. The model always
   * comes from the call itself.
   */
  conversations?: Omit<ConversationOptions, 'model'> | undefined
}

type ChatCreate = (body: Record<string, unknown>, ...rest: unknown[]) => Promise<unknown>

/** Turns since the last save, per namespace. */
const sinceSave = new Map<string, number>()

/**
 * Conversations opened by the wrapper, one per id. A promise so two racing
 * first calls create once; a failed create is evicted so the next call
 * retries rather than remembering the failure forever.
 */
const conversations = new Map<string, Promise<Conversation>>()

async function conversationFor(
  options: WrapOptions,
  id: string,
  model: string,
): Promise<Conversation> {
  let p = conversations.get(id)
  if (!p) {
    p = options.memory.conversations
      .create(id, { ...(options.conversations ?? {}), model })
      .then((c) => c.load())
    conversations.set(id, p)
    p.catch(() => conversations.delete(id))
  }
  return p
}

/**
 * Adds memory to an OpenAI-shaped client (`client.chat.completions.create`).
 *
 * ```ts
 * const openai = withMemory(new OpenAI(), { memory, namespace: () => userId })
 * ```
 *
 * Memory failures never fail the call. An agent that stops answering because
 * its memory is briefly unreachable is worse than one that answers without it.
 */
export function withMemory<T extends object>(client: T, options: WrapOptions): T {
  const onError =
    options.onError ??
    ((e: unknown) => console.warn('[gitloom] memory unavailable, continuing without it:', e))

  return new Proxy(client, {
    get(target, prop, receiver) {
      // GitLoom's added features, on the wrapped client itself. The provider
      // surface stays untouched beside it.
      if (prop === 'gitloom') return featuresFor(options)
      const value = Reflect.get(target, prop, receiver)
      // Anthropic clients: client.messages.create.
      if (prop === 'messages' && hasCreate(value)) {
        return new Proxy(value as object, {
          get(mTarget, mProp, mReceiver) {
            const mValue = Reflect.get(mTarget, mProp, mReceiver)
            if (mProp !== 'create') return bind(mValue, mTarget)
            return wrapCreate(mValue as ChatCreate, mTarget, options, onError, 'anthropic')
          },
        })
      }
      if (prop !== 'chat') return bind(value, target)

      // client.chat.completions.create — wrap only that leaf.
      return new Proxy(value as object, {
        get(chatTarget, chatProp, chatReceiver) {
          const chatValue = Reflect.get(chatTarget, chatProp, chatReceiver)
          if (chatProp !== 'completions') return bind(chatValue, chatTarget)

          return new Proxy(chatValue as object, {
            get(compTarget, compProp, compReceiver) {
              const compValue = Reflect.get(compTarget, compProp, compReceiver)
              if (compProp !== 'create') return bind(compValue, compTarget)
              return wrapCreate(compValue as ChatCreate, compTarget, options, onError, 'openai')
            },
          })
        },
      })
    },
  }) as T
}

function bind(value: unknown, thisArg: unknown): unknown {
  return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(thisArg) : value
}

function wrapCreate(
  create: ChatCreate,
  thisArg: unknown,
  options: WrapOptions,
  onError: (e: unknown) => void,
  flavor: 'openai' | 'anthropic' = 'openai',
): ChatCreate {
  return async function (body: Record<string, unknown>, ...rest: unknown[]) {
    const memoryOpt = (body as { memory?: boolean }).memory
    // Per-call opt-out. Deleted from the body because the upstream SDK would
    // reject an unknown field.
    delete (body as { memory?: boolean }).memory
    const enabled = memoryOpt !== false

    // Conversation mode: the drop-in. The developer passes only the NEW
    // messages plus a conversation id; the stored conversation supplies the
    // window, memory supplies the context, and both turns are stored with the
    // provider's own usage afterwards — the call site looks exactly like the
    // provider SDK's, one field richer.
    const convId = (body as { conversation?: unknown }).conversation
    delete (body as { conversation?: unknown }).conversation
    if (typeof convId === 'string' && convId !== '' && enabled) {
      return conversationCall(create, thisArg, options, onError, flavor, convId, body, rest)
    }

    // A per-call namespace, for the common case: one server, many users, and
    // the namespace known only when the request arrives. It wins over the
    // wrapper's own setting, and is removed for the same reason `memory` is.
    const perCall = (body as { namespace?: unknown }).namespace
    delete (body as { namespace?: unknown }).namespace

    const namespace =
      typeof perCall === 'string' && perCall !== ''
        ? perCall
        : typeof options.namespace === 'function'
          ? options.namespace()
          : options.namespace
    const messages = Array.isArray(body.messages) ? (body.messages as Memory[]) : []
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')

    let outgoing = messages
    if (enabled && options.inject !== false && lastUser?.content) {
      try {
        const ctx = await options.memory.context(String(lastUser.content), {
          namespace,
          limit: options.limit ?? 8,
        })
        if (ctx) {
          // After any leading system messages, so the developer's instructions
          // still frame the conversation and this reads as background.
          const head = messages.filter((m) => m.role === 'system')
          const tail = messages.filter((m) => m.role !== 'system')
          outgoing = [...head, ctx as Memory, ...tail]
        }
      } catch (e) {
        onError(e)
      }
    }

    const response = await create.call(thisArg, { ...body, messages: outgoing }, ...rest)

    if (enabled && options.save !== false && lastUser?.content) {
      const every = Math.max(1, options.saveEveryTurns ?? 6)
      const key = namespace ?? '\u0000default'
      const turnsSoFar = (sinceSave.get(key) ?? 0) + 1
      if (turnsSoFar >= every) {
        sinceSave.set(key, 0)
        const reply = assistantText(response)
        // The whole exchange, not just this turn: extraction reads a
        // conversation, and a lone reply with no question rarely yields a fact
        // worth keeping.
        const turns: Memory[] = messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: String(m.content) }))
        if (reply) turns.push({ role: 'assistant', content: reply })
        // Not awaited: the caller wants their completion, and the write is
        // asynchronous server-side anyway. Rejections are swallowed here rather
        // than surfacing as an unhandled rejection that could crash a worker.
        void options.memory.remember(turns, { namespace }).catch(onError)
      } else {
        sinceSave.set(key, turnsSoFar)
      }
    }

    return response
  }
}

/**
 * The added surface on a wrapped client: `openai.gitloom.conversation(id)` is
 * the SAME managed conversation the completions flow through — a rewind there
 * is what the next create({ conversation: id }) continues from — plus direct
 * memory and media.
 */
export interface GitloomFeatures {
  /** The managed conversation behind a `conversation:` id. */
  conversation(id: string, model?: string): Promise<Conversation>
  /** The underlying client, for recall/remember/media and everything else. */
  memory: Gitloom
}

function featuresFor(options: WrapOptions): GitloomFeatures {
  return {
    memory: options.memory,
    conversation: (id: string, model = '') => conversationFor(options, id, model),
  }
}

async function conversationCall(
  create: ChatCreate,
  thisArg: unknown,
  options: WrapOptions,
  onError: (e: unknown) => void,
  flavor: 'openai' | 'anthropic',
  convId: string,
  body: Record<string, unknown>,
  rest: unknown[],
): Promise<unknown> {
  const model = String(body.model ?? '')
  const conv = await conversationFor(options, convId, model)
  const fresh = (Array.isArray(body.messages) ? body.messages : []) as ChatMessage[]
  const lastUser = [...fresh].reverse().find((m) => m.role === 'user')

  let contextMsg: ChatMessage | null = null
  if (options.inject !== false && lastUser) {
    try {
      contextMsg = await conv.withContext(textOf(lastUser))
    } catch (e) {
      onError(e)
    }
  }

  const window = conv.forModel()
  let outgoing: Record<string, unknown>
  if (flavor === 'anthropic') {
    // Anthropic takes the system prompt as a top-level field; the compaction
    // summary and the memory context are system content, so they move there,
    // joined after whatever the caller already set.
    const systems: string[] = []
    if (typeof body.system === 'string' && body.system) systems.push(body.system)
    const chat = [...window, ...fresh].filter((m) => {
      if (m.role !== 'system') return true
      if (typeof m.content === 'string') systems.push(m.content)
      return false
    })
    if (contextMsg && typeof contextMsg.content === 'string') systems.push(contextMsg.content)
    outgoing = {
      ...body,
      ...(systems.length ? { system: systems.join('\n\n') } : {}),
      messages: chat,
    }
  } else {
    const merged = [...window, ...fresh]
    const head = merged.filter((m) => m.role === 'system')
    const tail = merged.filter((m) => m.role !== 'system')
    outgoing = { ...body, messages: [...head, ...(contextMsg ? [contextMsg] : []), ...tail] }
  }

  const response = await create.call(thisArg, outgoing, ...rest)

  const reply = assistantText(response)
  const turns: ChatMessage[] = [...fresh]
  if (reply) turns.push({ role: 'assistant', content: reply })
  try {
    // Awaited: appends assign sequence numbers, and letting a second call
    // race the first would interleave them.
    await conv.append(turns, { usage: (response as { usage?: unknown }).usage as never })
  } catch (e) {
    onError(e)
  }
  return response
}

function textOf(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n')
  }
  return ''
}

function hasCreate(v: unknown): boolean {
  return !!v && typeof (v as { create?: unknown }).create === 'function'
}

/** Pulls the assistant's text out of a completion, tolerating both SDK shapes. */
function assistantText(response: unknown): string {
  const r = response as {
    choices?: Array<{ message?: { content?: unknown } }>
    content?: Array<{ type?: string; text?: string }>
  }
  const openai = r?.choices?.[0]?.message?.content
  if (typeof openai === 'string') return openai
  if (Array.isArray(r?.content)) {
    return r.content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  }
  return ''
}

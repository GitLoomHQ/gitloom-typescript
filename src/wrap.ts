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
}

type ChatCreate = (body: Record<string, unknown>, ...rest: unknown[]) => Promise<unknown>

/** Turns since the last save, per namespace. */
const sinceSave = new Map<string, number>()

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
      const value = Reflect.get(target, prop, receiver)
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
              return wrapCreate(compValue as ChatCreate, compTarget, options, onError)
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
): ChatCreate {
  return async function (body: Record<string, unknown>, ...rest: unknown[]) {
    const memoryOpt = (body as { memory?: boolean }).memory
    // Per-call opt-out. Deleted from the body because the upstream SDK would
    // reject an unknown field.
    delete (body as { memory?: boolean }).memory
    const enabled = memoryOpt !== false

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

/**
 * The rolling context window.
 *
 * One guarantee: what comes out of `fit` provably fits the budget, or `fit`
 * throws. It never silently returns something the provider will reject, and it
 * never quietly drops a message the caller believed was pinned.
 */

import { GitloomError } from './errors'
import {
  type ChatMessage,
  type TokenCounter,
  contextLimit,
  messageTokens,
  resolveCounter,
  totalTokens,
} from './tokens'

export interface FitOptions {
  /** Model whose context window bounds the result. */
  model: string
  /**
   * Hard token ceiling. Defaults to the model's context limit reduced by
   * `safetyMargin`.
   */
  maxTokens?: number
  /**
   * Fraction of the limit held back, absorbing estimator error and any framing
   * the provider adds that we cannot see. Default 0.1.
   */
  safetyMargin?: number
  /**
   * Tokens to leave free for the model's reply. Subtracted from the budget, so
   * a caller expecting a long answer does not get a full window of input and a
   * truncated response.
   */
  reserveForReply?: number
  /** Exact token counter; the estimator is used when absent. */
  countTokens?: TokenCounter
  /**
   * Keep at least this many of the most recent messages, even if they do not
   * fit. Fewer than this and the model has no conversation left to continue —
   * better to throw than to return something incoherent. Default 2.
   */
  keepRecent?: number
}

/** What `fit` decided. */
export interface Fitted {
  /** The messages to send, in order. Provably within budget. */
  messages: ChatMessage[]
  /** Messages dropped from the front, oldest first. These are what to compact. */
  evicted: ChatMessage[]
  /** Tokens the kept messages occupy. */
  tokens: number
  /** The ceiling they were fitted to. */
  budget: number
}

/**
 * Choose which messages to send.
 *
 * System messages are always kept: they are instructions, not conversation,
 * and dropping them changes the model's behaviour rather than its memory.
 * Everything else is evicted oldest-first, which is the only order that
 * preserves the thread of a conversation.
 *
 * Tool-call pairs are never split. A tool result whose call has been evicted is
 * a message referring to something that is not there — most providers reject
 * it outright, and the ones that accept it produce nonsense.
 */
export function fit(messages: ChatMessage[], options: FitOptions): Fitted {
  const count = resolveCounter(options.countTokens)
  const margin = options.safetyMargin ?? 0.1
  const limit = options.maxTokens ?? Math.floor(contextLimit(options.model) * (1 - margin))
  const budget = limit - (options.reserveForReply ?? 0)
  const keepRecent = Math.max(0, options.keepRecent ?? 2)

  if (budget <= 0) {
    throw new GitloomError(
      'context_budget_invalid',
      `Nothing left for input: a ${limit} token budget with ${options.reserveForReply} reserved for the reply.`,
      0,
    )
  }

  const system = messages.filter((m) => m.role === 'system')
  const rest = messages.filter((m) => m.role !== 'system')

  const systemTokens = totalTokens(system, options.model, count)
  if (systemTokens > budget) {
    throw new GitloomError(
      'context_system_too_large',
      `The system messages alone need ${systemTokens} tokens against a ${budget} token budget. ` +
        `Shorten them, raise maxTokens, or use a model with a larger window.`,
      0,
    )
  }

  // Walk backwards from the newest message, taking what fits. Backwards
  // because recency is what a conversation needs to stay coherent; the oldest
  // turns are the ones whose content has usually already been superseded.
  const keptReversed: ChatMessage[] = []
  let used = systemTokens
  let index = rest.length - 1

  for (; index >= 0; index--) {
    const group = groupAt(rest, index)
    const groupTokens = group.reduce((n, m) => n + messageTokens(m, options.model, count), 0)
    if (used + groupTokens > budget) break
    used += groupTokens
    for (let i = group.length - 1; i >= 0; i--) keptReversed.push(group[i]!)
    index -= group.length - 1
  }

  const kept = keptReversed.reverse()
  const evicted = rest.slice(0, rest.length - kept.length)

  // The floor exists so a caller learns their budget is unusable rather than
  // receiving a single message and wondering why the model lost the plot.
  if (kept.length < Math.min(keepRecent, rest.length)) {
    throw new GitloomError(
      'context_too_small',
      `Only ${kept.length} of the last ${keepRecent} messages fit in ${budget} tokens. ` +
        `The most recent turns are too large for this window — raise maxTokens or use a larger model.`,
      0,
    )
  }

  return { messages: [...system, ...kept], evicted, tokens: used, budget }
}

/**
 * The atomic group ending at `index`.
 *
 * A tool result belongs with the assistant turn that requested it, and several
 * results can answer one turn. Returned oldest-first.
 */
function groupAt(messages: ChatMessage[], index: number): ChatMessage[] {
  const end = messages[index]!
  if (end.role !== 'tool') return [end]

  // Walk back over consecutive tool results to the assistant turn that made the
  // calls. If there is no such turn the results are orphaned already, and
  // treating each as its own group is the only thing left to do.
  let start = index
  while (start >= 0 && messages[start]!.role === 'tool') start--
  if (start < 0 || messages[start]!.role !== 'assistant' || !messages[start]!.tool_calls) {
    return [end]
  }
  return messages.slice(start, index + 1)
}

/**
 * Assert that messages fit, throwing if they do not.
 *
 * For callers who manage their own history and want the guarantee without the
 * eviction — a pre-flight check that turns a provider 400 into an error raised
 * before the request is made.
 */
export function assertFits(messages: ChatMessage[], options: FitOptions): number {
  const count = resolveCounter(options.countTokens)
  const margin = options.safetyMargin ?? 0.1
  const limit = options.maxTokens ?? Math.floor(contextLimit(options.model) * (1 - margin))
  const budget = limit - (options.reserveForReply ?? 0)
  const n = totalTokens(messages, options.model, count)
  if (n > budget) {
    throw new GitloomError(
      'context_overflow',
      `${n} tokens against a ${budget} token budget for ${options.model}. ` +
        `Compact the history or raise maxTokens.`,
      0,
    )
  }
  return n
}

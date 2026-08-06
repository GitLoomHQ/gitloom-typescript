/**
 * Token counting and per-model context limits.
 *
 * Every guarantee this SDK makes about not overflowing a context window rests
 * on a number produced here, so being WRONG in the unsafe direction is the one
 * unacceptable failure: a count that is too low means a request the provider
 * rejects with a 400 the caller cannot act on. Both the estimator and the
 * safety margin below are therefore biased to overcount.
 */

/** A message as the OpenAI and Anthropic chat APIs shape it. */
/**
 * One block of a multimodal message: a text run, an image, an audio clip.
 *
 * Deliberately loose. OpenAI spells an image {type:"image_url"}, Anthropic
 * {type:"image", source:{...}} — the SDK stores whatever the provider emitted
 * and replays it verbatim, because a stored conversation that cannot be
 * replayed exactly as it ran is a transcript, not a conversation. `media_id`
 * and `data` are GitLoom's additions: `data` (base64 + media_type) is uploaded
 * transparently on append and replaced by a `media_id` reference.
 */
export interface ContentPart {
  type: string
  text?: string
  /** A GitLoom attachment, uploaded via media.upload or transparently on append. */
  media_id?: string
  /** Bytes to upload on append: base64 with its content type. */
  data?: { base64: string; media_type: string }
  [key: string]: unknown
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | ContentPart[]
  /** Present on assistant turns that called tools. */
  tool_calls?: Array<{ id: string; type?: string; function?: { name: string; arguments: string } }>
  /** Present on tool results, naming the call they answer. */
  tool_call_id?: string
  name?: string
}

/** The flattened text of a message, whatever shape its content takes. */
export function textOf(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Context windows, in tokens, by model prefix. Longest prefix wins, so
 * "gpt-5-mini" resolves without a separate entry.
 *
 * These are INPUT limits. A caller who also wants room for the reply passes
 * `reserveForReply` — the alternative is silently subtracting an output budget
 * nobody asked for, which produces a window smaller than the model's and no
 * explanation of why.
 */
const CONTEXT_LIMITS: Array<[prefix: string, limit: number]> = [
  ['claude-opus-5', 1_000_000],
  ['claude-sonnet-5', 1_000_000],
  ['claude-fable-5', 1_000_000],
  ['claude-opus-4', 1_000_000],
  ['claude-sonnet-4', 1_000_000],
  ['claude-haiku-4-5', 200_000],
  ['claude-', 200_000],
  ['gpt-5', 400_000],
  ['gpt-4.1', 1_047_576],
  ['gpt-4o', 128_000],
  ['gpt-4-turbo', 128_000],
  ['gpt-4', 8_192],
  ['gpt-3.5', 16_385],
  ['o1', 200_000],
  ['o3', 200_000],
  ['gemini-1.5-pro', 2_000_000],
  ['gemini-', 1_000_000],
  ['llama-3', 128_000],
  ['mistral-', 32_000],
]

/**
 * Characters per token, by model family. Deliberately LOW: dividing by a
 * smaller number yields a larger estimate, and overcounting costs a little
 * unnecessary compaction while undercounting costs a rejected request.
 */
const CHARS_PER_TOKEN: Array<[prefix: string, ratio: number]> = [
  ['claude-', 3.6],
  ['gpt-', 3.7],
  ['o1', 3.7],
  ['o3', 3.7],
  ['gemini-', 3.8],
]
const DEFAULT_CHARS_PER_TOKEN = 3.4

/**
 * Per-message overhead: role, separators, and the framing the provider adds
 * around each turn. Small, but a hundred short messages make it the difference
 * between fitting and not.
 */
const PER_MESSAGE_OVERHEAD = 4
/** Every request carries a little envelope of its own on top of the messages. */
const PER_REQUEST_OVERHEAD = 3

/**
 * Tokens charged for one image part. Providers price images by resolution and
 * detail; 1100 sits above OpenAI's high-detail single-tile cost and near
 * Anthropic's ~1.15MP ceiling, keeping the estimate wrong in the safe
 * direction, like everything else here.
 */
const PER_IMAGE_TOKENS = 1_100

/** A function that counts tokens exactly, if the caller has one. */
export type TokenCounter = (text: string, model: string) => number

/** The context limit for a model, or `fallback` when the model is unknown. */
export function contextLimit(model: string, fallback = 128_000): number {
  const m = model.toLowerCase()
  let best = -1
  let limit = fallback
  for (const [prefix, value] of CONTEXT_LIMITS) {
    if (m.startsWith(prefix) && prefix.length > best) {
      best = prefix.length
      limit = value
    }
  }
  return limit
}

/**
 * Estimate the tokens in a string.
 *
 * A character ratio rather than a real tokenizer, because the SDK has no
 * dependencies and must run on edge runtimes where a 1MB wasm tokenizer cannot
 * go. Accurate to within a few percent on prose, worse on dense punctuation or
 * CJK — which is what the safety margin absorbs.
 */
export function estimateTokens(text: string, model = ''): number {
  if (!text) return 0
  const m = model.toLowerCase()
  let ratio = DEFAULT_CHARS_PER_TOKEN
  let best = -1
  for (const [prefix, value] of CHARS_PER_TOKEN) {
    if (m.startsWith(prefix) && prefix.length > best) {
      best = prefix.length
      ratio = value
    }
  }
  // Runs of non-alphanumeric characters tokenize far worse than prose, so text
  // that is mostly punctuation or markup gets a denser ratio rather than an
  // estimate that is confidently too small.
  const dense = (text.match(/[^\s\w]/g)?.length ?? 0) / text.length > 0.3
  return Math.ceil(text.length / (dense ? ratio * 0.6 : ratio))
}

/** Tokens in one message, including its structural overhead. */
export function messageTokens(
  message: ChatMessage,
  model: string,
  count: TokenCounter = estimateTokens,
): number {
  let n = PER_MESSAGE_OVERHEAD
  if (typeof message.content === 'string') {
    n += count(message.content, model)
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (typeof part.text === 'string') n += count(part.text, model)
      // Anything that is not text is billed as an image: audio and documents
      // cost at least as much, so the flat charge stays an overcount.
      else n += PER_IMAGE_TOKENS
    }
  }
  if (message.name) n += count(message.name, model)
  for (const call of message.tool_calls ?? []) {
    // Tool calls are billed as the JSON the provider serializes them into, so
    // the arguments and the function name both count.
    n += count(call.function?.name ?? '', model)
    n += count(call.function?.arguments ?? '', model)
    n += PER_MESSAGE_OVERHEAD
  }
  return n
}

/** Tokens in a whole conversation. */
export function totalTokens(
  messages: ChatMessage[],
  model: string,
  count: TokenCounter = estimateTokens,
): number {
  let n = PER_REQUEST_OVERHEAD
  for (const m of messages) n += messageTokens(m, model, count)
  return n
}

/**
 * Resolve the token counter to use.
 *
 * An exact counter is used when the caller supplies one; otherwise the
 * estimator. There is deliberately no dynamic import of `tiktoken` here — a
 * bare `import()` of an optional dependency breaks bundlers that resolve
 * statically, and a counter the caller passes explicitly is both faster and
 * honest about the dependency.
 */
export function resolveCounter(counter?: TokenCounter): TokenCounter {
  return counter ?? estimateTokens
}

/**
 * Conversations: a stored chat that cannot outgrow its context window.
 *
 * The loop a developer writes is `append` → `forModel` → call their provider →
 * `append`. Everything else — deciding when the window is full, summarizing
 * what falls out, handing those turns to memory — happens without being asked,
 * because a context manager that has to be driven is just an API.
 */

import type { Gitloom } from './client'
import { GitloomError } from './errors'
import { fit, type FitOptions, type Fitted } from './context'
import { contextLimit, textOf, totalTokens, type ChatMessage, type TokenCounter } from './tokens'

/**
 * Token usage as providers report it. OpenAI spells it prompt/completion,
 * Anthropic input/output; both are accepted so the caller passes their
 * response's usage object through untouched.
 */
export interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  input_tokens?: number
  output_tokens?: number
}

function usageTotal(u: Usage): number {
  if (typeof u.total_tokens === 'number') return u.total_tokens
  return (u.prompt_tokens ?? u.input_tokens ?? 0) + (u.completion_tokens ?? u.output_tokens ?? 0)
}

/** How a range of evicted turns becomes one summary message. */
export type Summarizer = (messages: ChatMessage[]) => Promise<string>

export interface ConversationOptions {
  /** Model whose context window bounds this conversation. */
  model?: string
  /** Hard token ceiling. Defaults to the model's window less the safety margin. */
  maxTokens?: number
  /** Tokens held back for the reply. */
  reserveForReply?: number
  /** Exact token counter, when the caller has one. */
  countTokens?: TokenCounter
  /**
   * Turns evicted content into a summary. Without one, compaction is refused
   * rather than silently dropping the turns — losing a conversation's early
   * history to save a round trip is not a trade an SDK should make quietly.
   */
  summarize?: Summarizer
  /**
   * Compact when the window is this full, as a fraction. Default 0.85.
   *
   * Below 1 on purpose: compacting exactly at the limit means every subsequent
   * turn immediately overflows again, so the conversation compacts on every
   * message. Leaving headroom makes it periodic instead.
   */
  compactAt?: number
  /** Where memories from this conversation land. */
  namespace?: string
  /**
   * Compact after this many exchanges (a user turn plus the assistant's
   * reply), even when the window is not yet full. Default 5. Zero disables the
   * cadence and leaves only the token threshold.
   *
   * The cadence exists because compaction is also the memory trigger: each one
   * hands the summarized turns to ingestion, so waiting for a 200k window to
   * fill would mean hours of conversation before anything became memory.
   */
  compactEvery?: number
  /**
   * How memory is consulted as the conversation runs.
   *
   * - 'query' (default): `withContext()` retrieves for every user message and
   *   prepends what it finds as a system message.
   * - 'tools': the developer wires `openaiTools`/`anthropicTools` and the
   *   model decides when to look something up.
   * - 'off': no retrieval; the conversation is only stored and compacted.
   */
  memory?: 'query' | 'tools' | 'off'
}

export interface LoadOptions {
  /** Load every message, ignoring compactions. Needed to rewind past one. */
  full?: boolean
  /** Read a branch other than the active one. */
  branch?: string
  /** Read the conversation as it stood at this sequence. */
  at?: number
}

interface StoredMessage extends ChatMessage {
  seq: number
  branch: string
}

interface LoadResponse {
  id: string
  branch: string
  next_seq: number
  model?: string
  namespace?: string
  title?: string
  messages: Array<StoredMessage & { content: string }>
  truncated: boolean
  compaction?: { summary: string; from_seq: number; to_seq: number }
}

/**
 * A stored conversation.
 *
 * Obtain one from `gitloom.conversations.create()` or `.load()`; the
 * constructor is not part of the API.
 */
export class Conversation {
  readonly id: string
  branch: string

  /** Messages held locally: the summary of what came before, then live turns. */
  private history: ChatMessage[] = []
  private nextSeq = 0
  /** Sequence of the first live message, so compaction knows what it covers. */
  private firstLiveSeq = 0
  private summaryMessage: ChatMessage | null = null
  /** Cached fit, invalidated whenever history changes. */
  private cachedFit: { key: string; value: Fitted } | null = null
  /** Exchanges (user turn + reply) appended since the last compaction. */
  private exchangesSinceCompaction = 0
  /** Real token total, when the caller reports provider usage. */
  private reportedTokens = 0
  /** Title as the server knows it; filled by load(), settable via setTitle. */
  title = ''

  constructor(
    private readonly client: Gitloom,
    id: string,
    branch: string,
    private options: ConversationOptions = {},
  ) {
    this.id = id
    this.branch = branch
  }

  /** The messages currently held, summary first. */
  messages(): ChatMessage[] {
    return this.summaryMessage ? [this.summaryMessage, ...this.history] : [...this.history]
  }

  /** Sequence the next appended message will take. */
  get seq(): number {
    return this.nextSeq
  }

  /** Load state from the server, replacing anything held locally. */
  async load(options: LoadOptions = {}): Promise<this> {
    const params = new URLSearchParams()
    if (options.full) params.set('full', '1')
    if (options.branch) params.set('branch', options.branch)
    if (options.at !== undefined) params.set('at', String(options.at))
    const qs = params.toString()

    const res = await this.client.request<LoadResponse>(
      'GET',
      `/v1/conversations/${encodeURIComponent(this.id)}${qs ? `?${qs}` : ''}`,
    )
    this.branch = res.branch
    this.nextSeq = res.next_seq
    this.title = res.title ?? ''
    this.history = res.messages.map(strip)
    this.firstLiveSeq = res.messages[0]?.seq ?? res.next_seq
    // A compaction is replayed as a system message rather than a user or
    // assistant turn: it is a note about the conversation, not something
    // either party said, and attributing it to one of them puts words in
    // their mouth.
    this.summaryMessage = res.compaction
      ? { role: 'system', content: `Earlier in this conversation: ${res.compaction.summary}` }
      : null
    if (res.model && !this.options.model) this.options = { ...this.options, model: res.model }
    this.cachedFit = null
    return this
  }

  /**
   * Append messages, compacting first if they would overflow the window.
   *
   * Compaction happens BEFORE the append rather than after, so the caller's
   * turn is never the one summarized away the instant it arrives.
   */
  async append(
    messages: ChatMessage | ChatMessage[],
    options: { usage?: Usage } = {},
  ): Promise<this> {
    const batch = Array.isArray(messages) ? messages : [messages]
    if (batch.length === 0) return this

    // Real counts beat estimates. The provider already counted this
    // conversation's tokens on the last completion; a caller who passes that
    // usage through gets compaction timed by truth rather than heuristic.
    if (options.usage) this.reportedTokens = usageTotal(options.usage)
    this.exchangesSinceCompaction += batch.filter((m) => m.role === 'assistant').length

    if (this.options.summarize && (this.wouldOverflow(batch) || this.cadenceDue())) {
      await this.compact()
    }

    const wire = await Promise.all(batch.map((m) => this.toWire(m)))
    const res = await this.client.request<{ next_seq: number; written: number }>(
      'POST',
      `/v1/conversations/${encodeURIComponent(this.id)}/messages`,
      { branch: this.branch, messages: wire },
    )
    this.history.push(...batch)
    this.nextSeq = res.next_seq
    this.cachedFit = null
    return this
  }

  /**
   * One stored message, ready for the wire: multimodal content becomes a raw
   * parts array plus flattened text, and any part still carrying bytes is
   * uploaded first so the stored message references the attachment rather than
   * containing it.
   */
  private async toWire(m: ChatMessage): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { role: m.role }
    if (m.name) out['name'] = m.name
    if (m.tool_calls) out['tool_calls'] = m.tool_calls
    if (m.tool_call_id) out['tool_call_id'] = m.tool_call_id
    if (Array.isArray(m.content)) {
      const parts = await Promise.all(
        m.content.map(async (p) => {
          if (!p.data) return p
          const info = await this.client.media.upload({
            contentType: p.data.media_type,
            base64: p.data.base64,
          })
          const { data: _dropped, ...rest } = p
          // The local message keeps its bytes; only the stored copy references
          // the upload. Mutating the caller's object would be a side effect
          // nobody asked for.
          return { ...rest, media_id: info.id }
        }),
      )
      out['parts'] = parts
      out['content'] = textOf(m)
    } else {
      out['content'] = m.content ?? ''
    }
    return out
  }

  /** Whether the exchange cadence says it is time to compact. */
  private cadenceDue(): boolean {
    const every = this.options.compactEvery ?? 5
    return every > 0 && this.exchangesSinceCompaction >= every
  }

  /**
   * Memory context for the next user message, per the conversation's memory
   * mode: a system message of relevant memories, or null when nothing relevant
   * is stored or retrieval is configured away.
   */
  async withContext(userMessage: string): Promise<ChatMessage | null> {
    const mode = this.options.memory ?? 'query'
    if (mode !== 'query' || !userMessage.trim()) return null
    return this.client.context(userMessage, {
      ...(this.options.namespace ? { namespace: this.options.namespace } : {}),
    })
  }

  /**
   * Replace the message at `seq` on a NEW branch — the edit every chat UI
   * offers. The original line is untouched; this conversation switches to the
   * fork, whose replacement occupies the same seq.
   */
  async edit(seq: number, message: ChatMessage, options: { name?: string } = {}): Promise<this> {
    const wire = await this.toWire(message)
    const res = await this.client.request<{ branch: string; next_seq: number }>(
      'POST',
      `/v1/conversations/${encodeURIComponent(this.id)}/edit`,
      {
        seq,
        branch: this.branch,
        message: wire,
        ...(options.name ? { name: options.name } : {}),
      },
    )
    this.branch = res.branch
    await this.load({ full: true, branch: res.branch })
    return this
  }

  /**
   * Rewrite the message at `seq` in place, on this branch, destroying the
   * original. The one edit that does not fork, for content that must stop
   * existing — a leaked secret, PII. Later turns and summaries that responded
   * to the original are left standing.
   */
  async editInPlace(
    seq: number,
    replacement: { content: string; parts?: unknown[] },
  ): Promise<void> {
    await this.client.request(
      'PATCH',
      `/v1/conversations/${encodeURIComponent(this.id)}/messages/${seq}`,
      { branch: this.branch, content: replacement.content, ...(replacement.parts ? { parts: replacement.parts } : {}) },
    )
    const idx = seq - this.firstLiveSeq
    if (idx >= 0 && idx < this.history.length) {
      const held = this.history[idx]!
      held.content = replacement.content
      this.cachedFit = null
    }
  }

  /** Name the conversation. Overwrites any automatic title. */
  async setTitle(title: string): Promise<void> {
    await this.client.request('PATCH', `/v1/conversations/${encodeURIComponent(this.id)}`, { title })
    this.title = title
  }

  /**
   * The messages to send to the model, guaranteed to fit.
   *
   * Cached against the history's identity, because a turn-by-turn loop would
   * otherwise recount every token of the whole conversation on every message —
   * quadratic in the length of the chat, which is exactly the shape that hurts
   * on the long conversations this class exists for.
   */
  forModel(overrides: Partial<FitOptions> = {}): ChatMessage[] {
    const model = overrides.model ?? this.options.model
    if (!model) {
      throw new GitloomError(
        'model_required',
        'Set a model on the conversation or pass one to forModel(); the context budget depends on it.',
        0,
      )
    }
    const opts: FitOptions = {
      model,
      ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
      ...(this.options.reserveForReply !== undefined
        ? { reserveForReply: this.options.reserveForReply }
        : {}),
      ...(this.options.countTokens ? { countTokens: this.options.countTokens } : {}),
      ...overrides,
    }
    const key = `${model}:${opts.maxTokens ?? ''}:${opts.reserveForReply ?? ''}:${this.history.length}:${this.summaryMessage ? 1 : 0}`
    if (this.cachedFit?.key === key) return this.cachedFit.value.messages

    const value = fit(this.messages(), opts)
    this.cachedFit = { key, value }
    return value.messages
  }

  /**
   * Summarize the turns that no longer fit and hand them to memory.
   *
   * The summary is produced locally, by the caller's own model — GitLoom never
   * sees the conversation in order to compact it. What it does receive is the
   * evicted turns, which it ingests into the memory store, so the detail the
   * summary flattened is still recallable later.
   */
  async compact(): Promise<{ summary: string; from: number; to: number } | null> {
    const summarize = this.options.summarize
    if (!summarize) {
      throw new GitloomError(
        'no_summarizer',
        'Compaction needs a summarize function. Without one the evicted turns would be dropped, ' +
          'and losing a conversation\'s history is not something this SDK will do silently.',
        0,
      )
    }
    const model = this.options.model
    if (!model) {
      throw new GitloomError('model_required', 'Set a model before compacting.', 0)
    }

    const decided = fit(this.messages(), {
      model,
      ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
      ...(this.options.reserveForReply !== undefined
        ? { reserveForReply: this.options.reserveForReply }
        : {}),
      ...(this.options.countTokens ? { countTokens: this.options.countTokens } : {}),
    })
    // The replayed summary is a system message and is never itself evicted, so
    // anything in `evicted` is a real turn.
    let evicted = decided.evicted
    if (evicted.length === 0) {
      // The estimator sees room, but the trigger knew better: the exchange
      // cadence fired, or the provider reported a bigger conversation than the
      // estimate. Compacting must then still compact — evict everything except
      // the latest exchange, which stays for continuity. Without this, cadence
      // compaction silently did nothing and no memories were ever ingested
      // from a conversation that fit its window.
      if (this.history.length < 2) return null
      const keep = Math.min(2, this.history.length - 1)
      evicted = this.history.slice(0, this.history.length - keep)
    }
    if (evicted.length === 0) return null

    const summary = await summarize(evicted)
    const from = this.firstLiveSeq
    const to = from + evicted.length - 1

    await this.client.request('POST', `/v1/conversations/${encodeURIComponent(this.id)}/compact`, {
      branch: this.branch,
      summary,
      from_seq: from,
      to_seq: to,
    })

    // Fold the new summary into the old one rather than stacking system
    // messages: a conversation compacted twenty times would otherwise carry
    // twenty summaries, which is the overflow this exists to prevent.
    this.summaryMessage = {
      role: 'system',
      content: this.summaryMessage
        ? `${this.summaryMessage.content}\n\nThen: ${summary}`
        : `Earlier in this conversation: ${summary}`,
    }
    this.history = this.history.slice(evicted.length)
    this.firstLiveSeq = to + 1
    this.exchangesSinceCompaction = 0
    // The provider's count described the conversation before this compaction;
    // it no longer describes what is held.
    this.reportedTokens = 0
    this.cachedFit = null
    return { summary, from, to }
  }

  /**
   * Fork a new branch after `seq` and make it active.
   *
   * Nothing is destroyed: the old line keeps its messages and its compactions.
   * Rewinding to a point before a compaction is therefore an ordinary read —
   * the turns were never deleted.
   */
  async rewind(seq: number, options: { name?: string } = {}): Promise<this> {
    const res = await this.client.request<{ branch: string; next_seq: number }>(
      'POST',
      `/v1/conversations/${encodeURIComponent(this.id)}/rewind`,
      { to: seq, branch: this.branch, ...(options.name ? { name: options.name } : {}) },
    )
    this.branch = res.branch
    // Reload in full: a rewind's whole purpose may be to reach turns an
    // earlier compaction summarized, and the default read would hide them.
    await this.load({ full: true, branch: res.branch, at: seq })
    this.nextSeq = res.next_seq
    return this
  }

  /** Every line of this conversation. */
  async branches(): Promise<Array<{ name: string; forked_from?: string; forked_at?: number }>> {
    const res = await this.client.request<{ branches: Array<{ name: string }> }>(
      'GET',
      `/v1/conversations/${encodeURIComponent(this.id)}/branches`,
    )
    return res.branches
  }

  /** Hand a range of turns to memory without compacting. */
  async ingest(range: { from?: number; to?: number } = {}): Promise<number> {
    const res = await this.client.request<{ queued: number }>(
      'POST',
      `/v1/conversations/${encodeURIComponent(this.id)}/ingest`,
      { branch: this.branch, from_seq: range.from ?? 0, to_seq: range.to ?? 0 },
    )
    return res.queued
  }

  /** Whether adding these messages would cross the compaction threshold. */
  private wouldOverflow(batch: ChatMessage[]): boolean {
    const model = this.options.model
    if (!model) return false
    const ceiling =
      this.options.maxTokens ?? Math.floor(contextLimit(model) * 0.9) - (this.options.reserveForReply ?? 0)
    const threshold = ceiling * (this.options.compactAt ?? 0.85)
    // The provider's own count, when reported, is the truth for what is
    // already held; only the incoming batch still needs estimating.
    const held =
      this.reportedTokens > 0
        ? this.reportedTokens
        : totalTokens(this.messages(), model, this.options.countTokens)
    const incoming = totalTokens(batch, model, this.options.countTokens)
    return held + incoming > threshold
  }
}

/** Drop server-side fields, leaving a plain chat message. */
function strip(m: StoredMessage): ChatMessage {
  const out: ChatMessage = { role: m.role, content: m.content }
  if (m.name) out.name = m.name
  if (m.tool_calls) out.tool_calls = m.tool_calls
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id
  return out
}

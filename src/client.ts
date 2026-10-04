/**
 * The GitLoom client.
 *
 * Built on `fetch` and nothing else: no Node built-ins, no dependencies. That
 * is what lets the same package run in Node, Bun, Deno, an edge function and a
 * browser, which matters because agents get deployed in all of them.
 */

import { GitloomError, errorFromResponse } from './errors'
import { Conversation, type ConversationOptions } from './conversation'
import { Media } from './media'
import { Skills, Vocab } from './memory'
import type {
  AnswerOptions,
  AnswerResult,
  ContextOptions,
  CreateKeyResult,
  ForgetOptions,
  GraphOptions,
  GraphResult,
  KeyInfo,
  Memory,
  NewMemory,
  OccurredPrecision,
  OccurredSource,
  RecallFilters,
  RecallOptions,
  RecallResult,
  RecalledMemory,
  RememberOptions,
  RememberResult,
  StoredMemory,
  TimeInput,
  TopicsOptions,
  TopicsResult,
  TreeOptions,
  TreeResult,
  WriteOptions,
} from './types'

export interface GitloomOptions {
  /** An API key: `gl_live_…` or `gl_test_…`. Defaults to `process.env.GITLOOM_API_KEY`. */
  apiKey?: string
  /** API base URL. Defaults to `process.env.GITLOOM_BASE_URL`, then the hosted API. */
  baseUrl?: string
  /**
   * Namespace every call uses unless one is passed explicitly. The recommended
   * pattern is one namespace per end user; leaving it unset uses `default`,
   * which is right for a single-user integration.
   */
  namespace?: string
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number
  /** Retries for transient failures. Default 2. */
  maxRetries?: number
  /** Swap in a custom fetch (a proxy, a test double, an instrumented client). */
  fetch?: typeof fetch
}

const DEFAULT_BASE_URL = 'https://api.gitloom.cloud'

export class Gitloom {
  readonly baseUrl: string
  readonly namespace: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly fetchImpl: typeof fetch

  constructor(options: GitloomOptions = {}) {
    const env = readEnv()
    const apiKey = options.apiKey ?? env.GITLOOM_API_KEY
    if (!apiKey) {
      throw new GitloomError(
        'missing_api_key',
        'No API key. Pass { apiKey } or set GITLOOM_API_KEY.',
        0,
      )
    }
    this.apiKey = apiKey
    this.baseUrl = (options.baseUrl ?? env.GITLOOM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.namespace = options.namespace ?? 'default'
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxRetries = options.maxRetries ?? 2
    this.fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof this.fetchImpl !== 'function') {
      throw new GitloomError(
        'no_fetch',
        'No global fetch. Use Node 18+, or pass { fetch }.',
        0,
      )
    }
  }

  /** A client bound to one namespace. Cheap — it shares this one's config. */
  for(namespace: string): Gitloom {
    return new Gitloom({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      namespace,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      fetch: this.fetchImpl,
    })
  }

  /** The account and how this request authenticated. */
  async whoami(): Promise<{ account: string; auth: string; env: string }> {
    return this.request('GET', '/v1/whoami')
  }

  // --- namespaces ---

  /**
   * Creates a namespace. Safe to call on every startup: creating one that
   * already exists succeeds rather than throwing, so callers do not have to
   * branch on it.
   */
  async createNamespace(namespace?: string): Promise<{ namespace: string; created: boolean }> {
    return this.request('POST', '/v1/namespaces', { namespace: namespace ?? this.namespace })
  }

  async listNamespaces(): Promise<string[]> {
    const res = await this.request<{ namespaces: string[] }>('GET', '/v1/namespaces')
    return res.namespaces ?? []
  }

  // --- memories ---

  /**
   * Remembers a conversation.
   *
   * Returns once the write is ACCEPTED, not once it is stored: extraction runs
   * a language model over the transcript and takes seconds. Await
   * `waitUntilStored` if the next read must see it.
   */
  async remember(messages: Memory[], options: RememberOptions = {}): Promise<RememberResult> {
    const namespace = options.namespace ?? this.namespace
    const res = await this.request<{ id: string; namespace: string; status: string }>(
      'POST',
      '/v1/memories',
      {
        namespace,
        session_id: options.sessionId,
        date: options.date,
        occurred_at: timeArg(options.occurredAt),
        timezone: options.timezone,
        tags: options.tags,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      },
      { signal: options.signal, retry: options.retryOnServerError },
    )
    return { id: res.id, namespace: res.namespace, status: 'accepted' }
  }

  /**
   * Stores already-formed memories, as given, with no model deciding what to
   * keep. Asynchronous like `remember`: they appear in retrieval within seconds.
   *
   * Send them in batches: one call is one commit round, so a thousand memories
   * sent one at a time costs a thousand times what a few batches do.
   */
  async write(memories: NewMemory[], options: WriteOptions = {}): Promise<void> {
    if (memories.length === 0) return
    memories.forEach((m, i) => {
      if (!m.path.endsWith('.md')) {
        throw new GitloomError('invalid_path', `memory ${i}: path "${m.path}" must end in .md`, 0)
      }
    })
    await this.request(
      'POST',
      '/v1/memories',
      {
        namespace: options.namespace ?? this.namespace,
        timezone: options.timezone,
        memories: memories.map((m) => ({
          path: m.path,
          content: m.content,
          tags: m.tags,
          occurred_at: timeArg(m.occurredAt),
          date: m.date,
          confidence: m.confidence,
          ttl: m.ttl,
          supersedes: m.supersedes,
          cues: m.cues,
          related: m.related,
        })),
      },
      { signal: options.signal, retry: options.retryOnServerError },
    )
  }

  /** Reads one memory by path — a file, or `file.md#section`. What follows a recall hit. */
  async get(
    path: string,
    options: { namespace?: string | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<StoredMemory> {
    const params = new URLSearchParams({ path, namespace: options.namespace ?? this.namespace })
    return this.request('GET', `/v1/memories?${params.toString()}`, undefined, {
      signal: options.signal,
    })
  }

  /**
   * Deletes memories by path. Asynchronous. It unpublishes them from
   * retrieval; earlier revisions remain in the repository's history.
   */
  async forget(paths: string[], options: ForgetOptions = {}): Promise<void> {
    if (paths.length === 0) return
    const params = new URLSearchParams({
      path: paths.join(','),
      namespace: options.namespace ?? this.namespace,
    })
    await this.request('DELETE', `/v1/memories?${params.toString()}`, undefined, {
      signal: options.signal,
      retry: options.retryOnServerError,
    })
  }

  /** The table of contents: tier → topic → file → sections, with a summary at each level. */
  async tree(options: TreeOptions = {}): Promise<TreeResult> {
    const params = new URLSearchParams({ namespace: options.namespace ?? this.namespace })
    if (options.path) params.set('path', options.path)
    if (options.depth) params.set('depth', String(options.depth))
    return this.request('GET', `/v1/tree?${params.toString()}`, undefined, {
      signal: options.signal,
    })
  }

  /**
   * The topics (directories) with how many memories each holds. Check before
   * filing under a new topic, so `facts/database` does not appear beside
   * `facts/databases`.
   */
  async topics(options: TopicsOptions = {}): Promise<TopicsResult> {
    const params = new URLSearchParams({ namespace: options.namespace ?? this.namespace })
    if (options.tier) params.set('tier', options.tier)
    if (options.prefix) params.set('prefix', options.prefix)
    if (options.like) params.set('like', options.like)
    if (options.maxDepth) params.set('max_depth', String(options.maxDepth))
    if (options.minFiles) params.set('min_files', String(options.minFiles))
    if (options.limit) params.set('limit', String(options.limit))
    const res = await this.request<Partial<TopicsResult>>(
      'GET',
      `/v1/topics?${params.toString()}`,
      undefined,
      { signal: options.signal },
    )
    return {
      namespace: res.namespace ?? options.namespace ?? this.namespace,
      topics: res.topics ?? [],
      millis: res.millis ?? 0,
    }
  }

  /** The relationship graph between memories. `truncated` means it was larger than one response. */
  async graph(options: GraphOptions = {}): Promise<GraphResult> {
    const params = new URLSearchParams({ namespace: options.namespace ?? this.namespace })
    if (options.limit) params.set('limit', String(options.limit))
    const res = await this.request<Partial<GraphResult>>(
      'GET',
      `/v1/graph?${params.toString()}`,
      undefined,
      { signal: options.signal },
    )
    return {
      namespace: res.namespace ?? options.namespace ?? this.namespace,
      nodes: res.nodes ?? [],
      edges: res.edges ?? [],
      truncated: res.truncated ?? false,
      millis: res.millis ?? 0,
    }
  }

  /**
   * Polls until a query returns at least one memory, or the deadline passes.
   *
   * Deliberately not a "job status" call: the useful question is not whether
   * extraction finished but whether the memory can be found, and those differ —
   * a session may yield nothing worth remembering.
   */
  async waitUntilStored(
    query: string,
    options: {
      namespace?: string | undefined
      timeoutMs?: number | undefined
      intervalMs?: number | undefined
    } = {},
  ): Promise<boolean> {
    // Each poll is a query embedding and a metered read, so this backs off
    // rather than hammering at a fixed interval — extraction takes seconds, and
    // thirty polls to discover that is thirty charges.
    const deadline = Date.now() + (options.timeoutMs ?? 60_000)
    let interval = options.intervalMs ?? 2_000
    while (Date.now() < deadline) {
      const res = await this.recall(query, { namespace: options.namespace, limit: 1 })
      if (res.memories.length > 0) return true
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())))
      interval = Math.min(interval * 1.6, 10_000)
    }
    return false
  }

  /**
   * Retrieves the memories bearing on a question.
   *
   * Every entry is one whole memory, scored on a calibrated 0–1 scale. Filters
   * narrow every retrieval arm, so a memory outside them cannot surface even
   * as a graph neighbour. `mode: 'summary'` adds a text answer from a fast
   * model; `mode: 'agentic'` lets a stronger model search for itself.
   *
   * Without a query, the filters (`tags`, `tagsAll`, `since`, `until`, `tiers`
   * or `paths`) list every memory they match, newest first by `timeField`,
   * each scored 1. That needs `mode: 'raw'` and no `rank`.
   */
  recall(options: RecallOptions): Promise<RecallResult>
  recall(query: string | undefined, options?: RecallOptions): Promise<RecallResult>
  async recall(
    queryOrOptions?: string | RecallOptions,
    maybeOptions?: RecallOptions,
  ): Promise<RecallResult> {
    const [query, options] = recallArgs(queryOrOptions, maybeOptions)
    if (!query && !filtered(options)) {
      throw new GitloomError(
        'missing_query',
        'recall needs a query, or a filter (tags, tagsAll, since, until, tiers or paths) to list by',
        0,
      )
    }
    const params = new URLSearchParams(query ? { q: query } : {})
    params.set('namespace', options.namespace ?? this.namespace)
    if (options.limit) params.set('limit', String(options.limit))
    if (options.mode && options.mode !== 'raw') params.set('mode', options.mode)
    if (options.tiers?.length) params.set('tiers', options.tiers.join(','))
    if (options.paths?.length) params.set('paths', options.paths.join(','))
    if (options.tags?.length) params.set('tags', options.tags.join(','))
    if (options.tagsAll?.length) params.set('tags_all', options.tagsAll.join(','))
    if (options.since) params.set('since', String(timeArg(options.since)))
    if (options.until) params.set('until', String(timeArg(options.until)))
    if (options.timeField) params.set('time_field', options.timeField)
    if (options.tz) params.set('tz', options.tz)
    if (options.minScore !== undefined) params.set('min_score', String(options.minScore))
    if (options.context === false) params.set('context', '0')
    if (options.detail === 'full') params.set('detail', 'full')
    if (options.includeExpired) params.set('include_expired', '1')
    if (options.rank) params.set('rank', options.rank)
    if (options.maxChars) params.set('max_chars', String(options.maxChars))
    if (options.model) params.set('model', options.model)
    const res = await this.request<
      Omit<Partial<RecallResult>, 'memories'> & {
        memories?: WireMemory[] | null
        rank_fallback?: boolean
      }
    >(
      'GET',
      `/v1/retrieve?${params.toString()}`,
      undefined,
      { signal: options.signal },
    )
    return {
      namespace: res.namespace ?? options.namespace ?? this.namespace,
      query: res.query ?? query,
      mode: res.mode ?? options.mode ?? 'raw',
      memories: (res.memories ?? []).map(fromWire),
      ...(res.defined ? { defined: res.defined } : {}),
      ...(res.answer ? { answer: res.answer } : {}),
      ...(res.model ? { model: res.model } : {}),
      ...(res.trace ? { trace: res.trace } : {}),
      ...(res.truncated ? { truncated: res.truncated } : {}),
      ...(res.rank ? { rank: res.rank } : {}),
      ...(res.rank_fallback ? { rankFallback: true } : {}),
      candidates: res.candidates ?? res.memories?.length ?? 0,
      filteredOut: res.filteredOut ?? (res as { filtered_out?: number }).filtered_out ?? 0,
      millis: res.millis ?? 0,
      timings: res.timings ?? { lexical_ms: 0, vector_ms: 0, graph_ms: 0 },
    }
  }

  /**
   * One text answer to a question, from the memory.
   *
   * By default a fast model summarizes one retrieval; with `agentic: true` a
   * stronger model searches the memory itself with tools. Both are metered as
   * a chat, not a read. The memories the answer rests on come back alongside.
   */
  async answer(query: string, options: AnswerOptions = {}): Promise<AnswerResult> {
    const { agentic, ...rest } = options
    const res = await this.recall(query, { ...rest, mode: agentic ? 'agentic' : 'summary' })
    if (!res.answer) {
      throw new GitloomError('no_answer', 'The model did not produce an answer', 0)
    }
    return {
      answer: res.answer,
      model: res.model,
      memories: res.memories,
      trace: res.trace,
      truncated: res.truncated,
      millis: res.millis,
    }
  }

  /**
   * Retrieved memories rendered as a system message, ready to prepend.
   *
   * The single most common thing a caller wants, and the reason it exists as
   * one call: composing it by hand means every integration invents its own
   * wording for how the model should treat remembered context.
   */
  context(options: ContextOptions): Promise<{ role: 'system'; content: string } | null>
  context(
    query: string | undefined,
    options?: ContextOptions,
  ): Promise<{ role: 'system'; content: string } | null>
  async context(
    queryOrOptions?: string | ContextOptions,
    maybeOptions?: ContextOptions,
  ): Promise<{ role: 'system'; content: string } | null> {
    const [query, options] = recallArgs(queryOrOptions, maybeOptions)
    const { memories } = await this.recall(query, options)
    if (memories.length === 0) return null
    const header =
      options.header ??
      'What you already know about this user, from earlier conversations. Treat it as background, not as something they just said:'
    return {
      role: 'system',
      content: `${header}\n${memories.map((m) => `- ${m.content}`).join('\n')}`,
    }
  }

  /** The namespace's custom vocabulary: learn, list, look up and forget terms. */
  get vocab(): Vocab {
    return new Vocab(this)
  }

  /** Procedural know-how: store skills and find the ones that bear on a task. */
  get skills(): Skills {
    return new Skills(this)
  }

  // --- keys (dashboard sessions only) ---

  /**
   * Stored conversations.
   *
   * A conversation holds every message it has ever carried, and the SDK keeps
   * what it hands the model inside that model's context window — summarizing
   * what falls out, and letting GitLoom turn those turns into memory.
   */
  get conversations(): Conversations {
    return new Conversations(this)
  }

  /** Conversation attachments: upload bytes once, reference them by id. */
  get media(): Media {
    return new Media(this)
  }

  async createKey(name: string, env: 'live' | 'test' = 'live'): Promise<CreateKeyResult> {
    return this.request('POST', '/v1/keys', { name, env })
  }

  async listKeys(): Promise<KeyInfo[]> {
    const res = await this.request<{ keys: KeyInfo[] }>('GET', '/v1/keys')
    return res.keys ?? []
  }

  async revokeKey(id: string): Promise<void> {
    await this.request('DELETE', `/v1/keys/${encodeURIComponent(id)}`)
  }

  // --- transport ---

  /**
   * Issue a request against the API.
   *
   * @internal — public at runtime so Conversation can reach it, but not part
   * of the supported surface. Its shape may change without a major version.
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { signal?: AbortSignal | undefined; retry?: boolean | undefined } = {},
  ): Promise<T> {
    // A write is not retried by default. A 5xx can mean the server accepted it
    // and then failed to answer; repeating that stores the memory twice and
    // spends the quota twice, and on a metered API that is a second charge for
    // one call. Reads repeat harmlessly.
    const mayRetry = opts.retry ?? method === 'GET'
    const attempts = mayRetry ? this.maxRetries : 0

    let lastError: unknown
    for (let attempt = 0; attempt <= attempts; attempt++) {
      if (opts.signal?.aborted) throw abortedError()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      // AbortSignal.any is Node 20+; the manual wiring keeps Node 18 working,
      // which the package claims to support.
      const onAbort = () => controller.abort()
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        })
        if (res.ok) {
          const text = await res.text()
          if (!text) return {} as T
          try {
            return JSON.parse(text) as T
          } catch {
            // A proxy or a captive portal can answer 200 with HTML. Leaking a
            // SyntaxError makes that look like a bug in the caller's code.
            throw new GitloomError(
              'invalid_response',
              `Expected JSON from ${path} but got ${text.slice(0, 80)}`,
              res.status,
            )
          }
        }
        const err = await errorFromResponse(res)
        // A 4xx is the caller's to fix; retrying only delays the message. 429
        // and 5xx are the server's, and may succeed on their own.
        if (!err.retryable || attempt === attempts) throw err
        lastError = err
      } catch (e) {
        if (e instanceof GitloomError) {
          if (!e.retryable || attempt === attempts) throw e
          lastError = e
        } else if ((e as { name?: string })?.name === 'AbortError') {
          // Distinguish the two aborts: the caller gave up, or we did. Retrying
          // after the caller gave up would ignore them.
          if (opts.signal?.aborted) throw abortedError()
          if (attempt === attempts) {
            throw new GitloomError('timeout', `Request timed out after ${this.timeoutMs}ms`, 0)
          }
          lastError = e
        } else {
          if (attempt === attempts) {
            throw new GitloomError('network_error', String((e as Error)?.message ?? e), 0, {
              cause: e,
            })
          }
          lastError = e
        }
      } finally {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
      }
      // Exponential backoff with jitter: synchronized retries from many agents
      // are what turn a brief wobble into an outage.
      await sleep(Math.min(2 ** attempt * 250, 4_000) * (0.5 + Math.random() / 2))
    }
    throw lastError instanceof Error ? lastError : new GitloomError('unknown', String(lastError), 0)
  }
}

type WireMemory = Omit<
  RecalledMemory,
  | 'userTags'
  | 'createdAt'
  | 'updatedAt'
  | 'occurredAt'
  | 'occurredSource'
  | 'occurredPrecision'
  | 'expiresAt'
> & {
  user_tags?: string[]
  created_at?: number
  updated_at?: number
  occurred_at?: number
  occurred_source?: OccurredSource
  occurred_precision?: OccurredPrecision
  expires_at?: number
}

function fromWire(w: WireMemory): RecalledMemory {
  const {
    user_tags,
    created_at,
    updated_at,
    occurred_at,
    occurred_source,
    occurred_precision,
    expires_at,
    ...m
  } = w
  const out: RecalledMemory = m
  if (user_tags) out.userTags = user_tags
  if (created_at) out.createdAt = new Date(created_at * 1000)
  if (updated_at) out.updatedAt = new Date(updated_at * 1000)
  if (occurred_at) out.occurredAt = new Date(occurred_at * 1000)
  if (occurred_source) out.occurredSource = occurred_source
  if (occurred_precision) out.occurredPrecision = occurred_precision
  if (expires_at) out.expiresAt = new Date(expires_at * 1000)
  return out
}

function recallArgs<O extends RecallOptions>(a: string | O | undefined, b: O | undefined): [string, O] {
  if (typeof a === 'object') return ['', a]
  return [a?.trim() ?? '', b ?? ({} as O)]
}

/** Whether the options name something to list without a question, as the API counts it. */
function filtered(o: RecallFilters): boolean {
  return Boolean(
    o.tags?.length ||
      o.tagsAll?.length ||
      o.tiers?.length ||
      o.paths?.length ||
      o.since ||
      o.until,
  )
}

/**
 * A time as the API reads it. Epoch seconds outside 9–11 digits are not read
 * as epochs, so a Date that far out goes as RFC 3339 instead.
 */
function timeArg(t: TimeInput | undefined): number | string | undefined {
  if (t === undefined || typeof t === 'string') return t
  if (typeof t === 'number') return Math.floor(t)
  const ms = t.getTime()
  if (Number.isNaN(ms)) throw new GitloomError('invalid_date', 'Invalid Date', 0)
  const s = Math.floor(ms / 1000)
  return s >= 1e8 && s < 1e11 ? s : t.toISOString()
}

function abortedError(): GitloomError {
  return new GitloomError('aborted', 'Request aborted by the caller', 0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Reads env without assuming `process` exists — this runs on edge runtimes too. */
function readEnv(): Record<string, string | undefined> {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return p?.env ?? {}
}

/** Create and load conversations. Reached through `gitloom.conversations`. */
export class Conversations {
  constructor(private readonly client: Gitloom) {}

  /**
   * Create a conversation. The id is yours to choose, so a conversation can be
   * found again from your own records without storing ours alongside them.
   */
  async create(
    id: string,
    options: ConversationOptions & { title?: string } = {},
  ): Promise<Conversation> {
    const res = await this.client.request<{ branch: string }>('POST', '/v1/conversations', {
      id,
      namespace: options.namespace,
      title: options.title,
      model: options.model,
    })
    return new Conversation(this.client, id, res.branch, options)
  }

  /** Load an existing conversation, resuming from its last compaction. */
  async load(
    id: string,
    options: ConversationOptions & { full?: boolean; branch?: string } = {},
  ): Promise<Conversation> {
    const conv = new Conversation(this.client, id, options.branch ?? 'main', options)
    await conv.load({
      ...(options.full !== undefined ? { full: options.full } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
    })
    return conv
  }

  /**
   * List conversations, most recent first.
   *
   * A namespace scopes them to one memory. The usual shape is a namespace per
   * end user, so "every conversation on the account" is rarely the question —
   * "this user's conversations" is, and without a scope a caller would have to
   * fetch everyone's and filter client-side.
   */
  async list(
    options: { namespace?: string } = {},
  ): Promise<
    Array<{ id: string; title?: string; branch: string; namespace?: string; updated_at: string }>
  > {
    const qs = options.namespace
      ? `?namespace=${encodeURIComponent(options.namespace)}`
      : ''
    const res = await this.client.request<{
      conversations: Array<{
        id: string
        title?: string
        branch: string
        namespace?: string
        updated_at: string
      }>
    }>('GET', `/v1/conversations${qs}`)
    return res.conversations ?? []
  }
}

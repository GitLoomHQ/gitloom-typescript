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
import type {
  CreateKeyResult,
  HitScores,
  KeyInfo,
  Memory,
  Provenance,
  RecallOptions,
  RecallResult,
  Relation,
  RememberOptions,
  RememberResult,
  VocabHit,
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
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      },
      { signal: options.signal, retry: options.retryOnServerError },
    )
    return { id: res.id, namespace: res.namespace, status: 'accepted' }
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

  /** Retrieves the memories bearing on a question. */
  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
    const params = new URLSearchParams({ q: query })
    params.set('namespace', options.namespace ?? this.namespace)
    if (options.limit) params.set('limit', String(options.limit))
    const res = await this.request<{
      namespace: string
      hits: Array<{
        path: string
        score: number
        snippet: string
        scores?: HitScores
        provenance?: Provenance
        relations?: Relation[]
      }> | null
      defined?: VocabHit[]
      millis: number
    }>('GET', `/v1/retrieve?${params.toString()}`, undefined, { signal: options.signal })
    return {
      namespace: res.namespace,
      // The full server shape passes through. The SDK used to keep only
      // path/snippet/score — the same silent gutting the playground had — so
      // "results are uniform everywhere" stopped at the SDK boundary.
      memories: (res.hits ?? []).map((h) => ({
        id: h.path,
        text: h.snippet,
        score: h.score,
        scores: h.scores,
        provenance: h.provenance,
        relations: h.relations,
      })),
      ...(res.defined ? { defined: res.defined } : {}),
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
  async context(
    query: string,
    options: RecallOptions & { header?: string | undefined } = {},
  ): Promise<{ role: 'system'; content: string } | null> {
    const { memories } = await this.recall(query, options)
    if (memories.length === 0) return null
    const header =
      options.header ??
      'What you already know about this user, from earlier conversations. Treat it as background, not as something they just said:'
    return {
      role: 'system',
      content: `${header}\n${memories.map((m) => `- ${m.text}`).join('\n')}`,
    }
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

  /** List this account's conversations, most recent first. */
  async list(): Promise<Array<{ id: string; title?: string; branch: string; updated_at: string }>> {
    const res = await this.client.request<{
      conversations: Array<{ id: string; title?: string; branch: string; updated_at: string }>
    }>('GET', '/v1/conversations')
    return res.conversations ?? []
  }
}

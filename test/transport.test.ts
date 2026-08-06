/**
 * Transport tests: the failures that happen to an SDK in production rather
 * than in a demo — malformed responses, timeouts, retry storms, and the
 * question of whether a retry can charge a customer twice.
 */

import { describe, expect, it, vi } from 'vitest'
import { Gitloom, GitloomError } from '../src'

const KEY = 'gl_test_abc_secret'

/** A fetch double that returns queued responses and records every call. */
function fetchStub(...responses: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses[Math.min(i++, responses.length - 1)]
    return typeof next === 'function' ? next() : next
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function client(fetchImpl: typeof fetch, opts: Record<string, unknown> = {}) {
  return new Gitloom({ apiKey: KEY, fetch: fetchImpl, maxRetries: 0, ...opts })
}

describe('malformed responses', () => {
  it('reports a non-JSON success as a GitloomError, not a raw SyntaxError', async () => {
    // A proxy or a CDN error page can return 200 with HTML. Leaking a
    // SyntaxError makes that look like a bug in the caller's own code.
    const { impl } = fetchStub(new Response('<html>proxy</html>', { status: 200 }))
    const g = client(impl)
    await expect(g.recall('x')).rejects.toBeInstanceOf(GitloomError)
  })

  it('treats an empty success body as an empty result', async () => {
    const { impl } = fetchStub(new Response('', { status: 200 }))
    const g = client(impl)
    await expect(g.recall('x')).resolves.toMatchObject({ memories: [] })
  })

  it('falls back to the status when an error body will not parse', async () => {
    const { impl } = fetchStub(new Response('gateway exploded', { status: 502 }))
    const g = client(impl)
    await expect(g.recall('x')).rejects.toMatchObject({ status: 502 })
  })
})

describe('retries', () => {
  it('makes exactly maxRetries + 1 attempts and no more', async () => {
    const { impl, calls } = fetchStub(() => json({ error: { code: 'internal' } }, 500))
    const g = client(impl, { maxRetries: 2 })
    await expect(g.recall('x')).rejects.toBeInstanceOf(GitloomError)
    expect(calls.length).toBe(3)
  })

  it('does not sleep after the final attempt', async () => {
    const { impl } = fetchStub(() => json({}, 500))
    const g = client(impl, { maxRetries: 1 })
    const started = Date.now()
    await expect(g.recall('x')).rejects.toBeInstanceOf(GitloomError)
    // One backoff (~125-250ms) between two attempts, not two.
    expect(Date.now() - started).toBeLessThan(900)
  })

  it('stops as soon as a retry succeeds', async () => {
    const { impl, calls } = fetchStub(json({}, 503), json({ results: [] }))
    const g = client(impl, { maxRetries: 3 })
    await expect(g.recall('x')).resolves.toMatchObject({ memories: [] })
    expect(calls.length).toBe(2)
  })

  it.each([[400], [401], [403], [404], [422], [429]])(
    'does not retry %i',
    async (status) => {
      const { impl, calls } = fetchStub(() => json({ error: { code: 'x' } }, status))
      const g = client(impl, { maxRetries: 3 })
      await expect(g.recall('x')).rejects.toBeInstanceOf(GitloomError)
      expect(calls.length).toBe(1)
    },
  )

  it.each([[500], [502], [503], [504]])('retries %i', async (status) => {
    const { impl, calls } = fetchStub(() => json({}, status))
    const g = client(impl, { maxRetries: 1 })
    await expect(g.recall('x')).rejects.toBeInstanceOf(GitloomError)
    expect(calls.length).toBe(2)
  })

  it('surfaces a network failure as a GitloomError carrying the cause', async () => {
    const boom = new TypeError('fetch failed')
    const { impl } = fetchStub(() => Promise.reject(boom))
    const g = client(impl)
    const err = await g.recall('x').catch((e) => e)
    expect(err).toBeInstanceOf(GitloomError)
    expect(err.code).toBe('network_error')
    expect(err.cause).toBe(boom)
  })

  it('does not retry a write, so one save cannot become three', async () => {
    // Retrying a POST that the server may already have accepted is how a
    // metered API charges twice for one call. A read is safe to repeat; a
    // write is not, unless the caller opts in.
    const { impl, calls } = fetchStub(() => json({ error: { code: 'internal' } }, 500))
    const g = client(impl, { maxRetries: 3 })
    await expect(
      g.remember([{ role: 'user', content: 'a fact' }]),
    ).rejects.toBeInstanceOf(GitloomError)
    expect(calls.length).toBe(1)
  })
})

describe('timeouts and cancellation', () => {
  it('times out rather than hanging forever', async () => {
    const { impl } = fetchStub(
      (): Promise<Response> =>
        new Promise((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 5),
        ),
    )
    const g = client(impl, { timeoutMs: 1 })
    const err = await g.recall('x').catch((e) => e)
    expect(err).toBeInstanceOf(GitloomError)
    expect(err.code).toBe('timeout')
  })

  it('honours a caller-supplied AbortSignal', async () => {
    // An agent that abandons a turn must be able to abandon the request with
    // it, or the process holds a socket open for the full timeout.
    const controller = new AbortController()
    const { impl } = fetchStub(
      (): Promise<Response> =>
        new Promise((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 5),
        ),
    )
    const g = client(impl, { maxRetries: 2 })
    const p = g.recall('x', { signal: controller.signal })
    controller.abort()
    const err = await p.catch((e) => e)
    expect(err).toBeInstanceOf(GitloomError)
    expect(err.code).toBe('aborted')
  })
})

describe('request shape', () => {
  it('encodes a namespace that would otherwise alter the URL', async () => {
    const { impl, calls } = fetchStub(json({ results: [] }))
    const g = client(impl, { namespace: 'a/../b?x=1&y=2' })
    await g.recall('hello')
    const url = new URL(calls[0]!.url)
    // The namespace must arrive as one parameter value, not as extra path or
    // extra parameters.
    expect(url.searchParams.get('namespace')).toBe('a/../b?x=1&y=2')
    expect(url.pathname).toBe('/v1/retrieve')
  })

  it('encodes a query containing a delimiter', async () => {
    const { impl, calls } = fetchStub(json({ results: [] }))
    const g = client(impl)
    await g.recall('what about a&b=c#d?')
    expect(new URL(calls[0]!.url).searchParams.get('q')).toBe('what about a&b=c#d?')
  })

  it('tolerates a base URL with trailing slashes', async () => {
    const { impl, calls } = fetchStub(json({ results: [] }))
    const g = client(impl, { baseUrl: 'https://example.test///' })
    await g.recall('x')
    expect(calls[0]!.url.startsWith('https://example.test/v1/retrieve')).toBe(true)
  })

  it('carries the key on every attempt, not just the first', async () => {
    const { impl, calls } = fetchStub(json({}, 500), json({ results: [] }))
    const g = client(impl, { maxRetries: 1 })
    await g.recall('x')
    for (const c of calls) {
      expect((c.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
    }
  })

  it('sends no content-type on a request with no body', async () => {
    const { impl, calls } = fetchStub(json({ results: [] }))
    await client(impl).recall('x')
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBeUndefined()
  })
})

describe('for()', () => {
  it('inherits transport configuration rather than resetting it', async () => {
    // A derived client that silently drops maxRetries or the custom fetch
    // behaves differently from its parent for no visible reason.
    const { impl, calls } = fetchStub(() => json({}, 500))
    const parent = new Gitloom({ apiKey: KEY, fetch: impl, maxRetries: 1, timeoutMs: 1234 })
    const child = parent.for('other')
    await expect(child.recall('x')).rejects.toBeInstanceOf(GitloomError)
    expect(calls.length).toBe(2)
    expect(child.namespace).toBe('other')
    expect(child.baseUrl).toBe(parent.baseUrl)
  })
})

// The SDK must pass the server's rich hit shape through untouched. It used to
// keep only path/snippet/score — the same silent gutting the playground had —
// so "results are uniform everywhere" quietly stopped at the SDK boundary.
it('recall passes scores, provenance and relations through', async () => {
  const rich = {
    namespace: 'ns',
    hits: [
      {
        path: 'facts/a.md',
        score: 0.5,
        snippet: 'A.',
        scores: { bm25: 1.2, cue: 0.4, arms: ['lexical', 'cue'] },
        provenance: {
          commit: 'abc123',
          when: '2026-08-06T00:00:00Z',
          revisions: 2,
          history: [{ commit: 'abc123', when: '2026-08-06T00:00:00Z' }],
          diff: 'diff --git a/facts/a.md b/facts/a.md',
        },
        relations: [{ label: 'same-trip', path: 'facts/b.md', snippet: 'B.' }],
      },
    ],
    defined: [{ path: 'vocab/term.md', term: 'RRF' }],
    millis: 7,
  }
  const { impl } = fetchStub(json(rich))
  const res = await client(impl).recall('anything')
  const m = res.memories[0]!
  expect(m.scores?.arms).toEqual(['lexical', 'cue'])
  expect(m.provenance?.commit).toBe('abc123')
  expect(m.provenance?.diff).toContain('diff --git')
  expect(m.relations?.[0]?.snippet).toBe('B.')
  expect(res.defined?.[0]?.term).toBe('RRF')
})

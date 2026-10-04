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

  it('surfaces a network failure as a GitloomError carrying a copy of the cause', async () => {
    const boom = new TypeError('fetch failed')
    const { impl } = fetchStub(() => Promise.reject(boom))
    const g = client(impl)
    const err = await g.recall('x').catch((e) => e)
    expect(err).toBeInstanceOf(GitloomError)
    expect(err.code).toBe('network_error')
    expect(err.cause).toMatchObject({ name: 'TypeError', message: 'fetch failed' })
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

// The SDK must pass the server's rich memory shape through untouched, so
// "results are uniform everywhere" does not stop at the SDK boundary.
it('recall passes scores, provenance and relations through', async () => {
  const rich = {
    namespace: 'ns',
    memories: [
      {
        path: 'facts/a.md',
        tier: 'facts',
        content: 'A.',
        score: 0.5,
        matched: ['lexical', 'cue'],
        scores: { bm25: 1.2, cue: 0.4 },
        provenance: {
          commit: 'abc123',
          when: '2026-08-06T00:00:00Z',
          revisions: 2,
          history: [{ commit: 'abc123', when: '2026-08-06T00:00:00Z' }],
          diff: 'diff --git a/facts/a.md b/facts/a.md',
        },
        related: [{ label: 'same-trip', path: 'facts/b.md', snippet: 'B.' }],
      },
    ],
    defined: [{ path: 'vocab/term.md', term: 'RRF' }],
    millis: 7,
  }
  const { impl } = fetchStub(json(rich))
  const res = await client(impl).recall('anything')
  const m = res.memories[0]!
  expect(m.matched).toEqual(['lexical', 'cue'])
  expect(m.provenance?.commit).toBe('abc123')
  expect(m.provenance?.diff).toContain('diff --git')
  expect(m.related?.[0]?.snippet).toBe('B.')
  expect(res.defined?.[0]?.term).toBe('RRF')
})

describe('error contract', () => {
  const fail = async (res: Response) => {
    const { impl, calls } = fetchStub(res)
    const err = await client(impl).recall('x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitloomError)
    return { err: err as GitloomError, calls }
  }

  it('keeps an enveloped code and message as they are', async () => {
    const { err } = await fail(json({ error: { code: 'forbidden_namespace', message: 'this key is scoped to another namespace' } }, 403))
    expect([err.code, err.message, err.status]).toEqual(['forbidden_namespace', 'this key is scoped to another namespace', 403])
  })

  // The API Gateway answers a missing or bad key itself, without the envelope.
  it('names a gateway 403 as an unaccepted key', async () => {
    const { err, calls } = await fail(json({ message: 'Forbidden' }, 403))
    expect(err.code).toBe('unauthorized')
    expect(err.message).toBe(
      'The API key was not accepted (403 Forbidden) — check the API key (GITLOOM_API_KEY, or the key passed to the client), or whether it has been revoked.',
    )
    expect(calls).toHaveLength(1)
  })

  it('names a gateway 401 as a missing key', async () => {
    const { err } = await fail(json({ message: 'Unauthorized' }, 401))
    expect(err.code).toBe('unauthorized')
    expect(err.message).toBe(
      'No API key was accepted (401 Unauthorized) — check the API key (GITLOOM_API_KEY, or the key passed to the client).',
    )
  })

  it('keeps a plain-text body as the message', async () => {
    const { err } = await fail(new Response('  upstream connect error  ', { status: 500 }))
    expect([err.code, err.message]).toEqual(['http_500', 'upstream connect error'])
  })

  it('uses a bare JSON message when there is one', async () => {
    const { err } = await fail(json({ message: 'Endpoint request timed out' }, 504))
    expect([err.code, err.message]).toEqual(['http_504', 'Endpoint request timed out'])
  })

  it('reads JSON that is not an object as text, and never crashes on it', async () => {
    expect((await fail(new Response('[1,2]', { status: 500 }))).err).toMatchObject({ code: 'http_500', message: '[1,2]' })
    expect((await fail(new Response('"oops"', { status: 500 }))).err).toMatchObject({ code: 'http_500', message: '"oops"' })
    expect((await fail(new Response('42', { status: 500 }))).err).toMatchObject({ code: 'http_500', message: '42' })
  })

  it('falls back to the status text for an empty, blank or null body, and caps a long one', async () => {
    expect((await fail(new Response('', { status: 502, statusText: 'Bad Gateway' }))).err.message).toBe('Bad Gateway')
    expect((await fail(new Response('  \n ', { status: 502, statusText: 'Bad Gateway' }))).err.message).toBe('Bad Gateway')
    expect((await fail(new Response('null', { status: 500, statusText: 'Internal Server Error' }))).err)
      .toMatchObject({ code: 'http_500', message: 'Internal Server Error' })
    expect((await fail(new Response('', { status: 502 }))).err.message).toBe('Request failed with 502')
    const long = (await fail(new Response('x'.repeat(1000), { status: 500 }))).err.message
    expect(long).toBe(`${'x'.repeat(300)}…`)
  })

  // A per-minute rate limit clears in seconds; the monthly quota does not.
  it('tells the quota, the rate limit and an empty wallet apart', async () => {
    const quota = (await fail(json({ error: { code: 'quota_exceeded', message: 'monthly reads used' } }, 429))).err
    const rate = (await fail(json({ error: { code: 'rate_limited', message: 'slow down' } }, 429))).err
    const wallet = (await fail(json({ error: { code: 'balance_exhausted', message: 'recharge' } }, 402))).err
    expect([quota.isQuotaExceeded, quota.isRateLimited, quota.isBalanceExhausted]).toEqual([true, false, false])
    expect([rate.isQuotaExceeded, rate.isRateLimited, rate.isBalanceExhausted]).toEqual([false, true, false])
    expect([wallet.isQuotaExceeded, wallet.isRateLimited, wallet.isBalanceExhausted]).toEqual([false, false, true])
    expect((await fail(new Response('', { status: 429 }))).err.isQuotaExceeded).toBe(false)
  })
})

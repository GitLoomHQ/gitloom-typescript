/**
 * The error contract every GitLoom SDK implements, against a real socket where
 * it matters: what a key can leak through is the transport, not a stub.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Gitloom, GitloomError, runTool } from '../src'

const PROBE = 'gl_test_LEAKPROBE_9x7q'

// No @types/node here: the SDK itself must not depend on Node, so the tests
// reach the built-ins untyped.
let http: any
let inspect: (v: unknown, o?: object) => string
beforeAll(async () => {
  http = await import('node:http' as string)
  inspect = (await import('node:util' as string)).inspect
})

const servers: any[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.()
    await new Promise((r) => s.close(r))
  }
})

function serve(handler: (req: any, res: any) => void): Promise<string> {
  const server = http.createServer(handler)
  servers.push(server)
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)))
}

async function refusedUrl(): Promise<string> {
  const url = await serve(() => {})
  const s = servers.pop()
  await new Promise((r) => s.close(r))
  return url
}

function everyForm(err: unknown): string[] {
  const out: string[] = []
  let e: unknown = err
  for (let i = 0; e !== undefined && e !== null && i < 8; i++) {
    out.push(String(e), String((e as Error).message), String((e as Error).stack), inspect(e, { depth: null, showHidden: true }))
    e = (e as Error).cause
  }
  return out
}

async function failure(baseUrl: string, opts: object = {}, apiKey = PROBE): Promise<GitloomError> {
  const err = await (async () => new Gitloom({ apiKey, baseUrl, maxRetries: 0, ...opts }).recall('x'))().catch(
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(GitloomError)
  return err as GitloomError
}

function stub(res: () => Response) {
  const calls: string[] = []
  const impl = (async (url: unknown) => {
    calls.push(String(url))
    return res()
  }) as unknown as typeof fetch
  return { gl: new Gitloom({ apiKey: 'gl_test_a_b', baseUrl: 'https://api.test', fetch: impl, maxRetries: 2 }), calls }
}

describe('the key never leaks', () => {
  const scenarios: Array<[string, () => Promise<[string, object]>, string]> = [
    ['a gateway 403', async () => [await serve((_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end('{"message":"Forbidden"}')
    }), {}], 'unauthorized'],
    ['a refused connection', async () => [await refusedUrl(), {}], 'network_error'],
    ['a timeout', async () => [await serve(() => {}), { timeoutMs: 50 }], 'timeout'],
  ]
  // The key as given, the secret part that must not appear, and the code the call ends in.
  const keys: Array<[string, string, string | null]> = [
    [PROBE, PROBE, null],
    ['glk_SECRET\n', 'glk_SECRET', null],
    ['glk_SEC\r\nRET', 'SEC', 'invalid_api_key'],
  ]
  for (const [name, setup, code] of scenarios) {
    for (const [key, secret, refused] of keys) {
      it(`from ${name}, with the key ${JSON.stringify(key)}`, async () => {
        const [url, opts] = await setup()
        const err = await failure(url, opts, key)
        expect(err.code).toBe(refused ?? code)
        if (refused) expect(err.status).toBe(0)
        for (const s of everyForm(err)) expect(s).not.toContain(secret)
      })
    }
  }

  it('from a proxy that echoes the request back', async () => {
    const url = await serve((req, res) => {
      res.writeHead(502)
      res.end(`upstream refused: authorization=${req.headers.authorization}`)
    })
    const err = await failure(url)
    expect(err.message).toBe('upstream refused: authorization=Bearer [redacted]')
    for (const s of everyForm(err)) expect(s).not.toContain(PROBE)
  })

  it('from a transport error that stored the request', async () => {
    const leaky = (async (_url: unknown, init: RequestInit) => {
      const e = new TypeError('fetch failed') as TypeError & { request?: unknown }
      e.request = { headers: init.headers }
      e.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', config: init })
      throw e
    }) as unknown as typeof fetch
    const err = await failure('https://api.test', { fetch: leaky })
    expect(err.code).toBe('network_error')
    expect(err.cause).toMatchObject({ name: 'TypeError', message: 'fetch failed', cause: { code: 'ECONNREFUSED' } })
    for (const s of everyForm(err)) expect(s).not.toContain(PROBE)
  })
})

describe('the key as given', () => {
  it('is trimmed, and the trimmed key is what is sent', async () => {
    const seen: unknown[] = []
    const impl = (async (_url: unknown, init: RequestInit) => {
      seen.push(init.headers)
      return new Response('{"account":"a","auth":"api_key","env":"test"}')
    }) as unknown as typeof fetch
    await expect(new Gitloom({ apiKey: 'glk_SECRET\n', baseUrl: 'https://api.test', fetch: impl }).whoami())
      .resolves.toMatchObject({ account: 'a' })
    expect(seen[0]).toMatchObject({ authorization: 'Bearer glk_SECRET' })
  })

  it('is refused with a control character inside, before any request and without the key', () => {
    let called = false
    const impl = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as typeof fetch
    for (const apiKey of ['glk_SEC\r\nRET', 'glk_SEC RET', 'glk_SEC\u00e9RET', 'glk_SEC\u0000RET']) {
      let err: unknown
      try {
        new Gitloom({ apiKey, fetch: impl })
      } catch (e) {
        err = e
      }
      expect(err).toMatchObject({
        code: 'invalid_api_key',
        status: 0,
        message: 'The API key contains whitespace or control characters — check GITLOOM_API_KEY, or the key passed to the client.',
      })
      for (const s of everyForm(err)) expect(s).not.toContain('SEC')
    }
    expect(called).toBe(false)
  })

  // A real private field: logging or serialising a client cannot show the key.
  it('cannot be read off the client', () => {
    const gl = new Gitloom({ apiKey: PROBE, fetch: (async () => new Response('{}')) as unknown as typeof fetch })
    const bound = gl.for('u1')
    for (const c of [gl, bound]) {
      expect(inspect(c, { depth: null, showHidden: true })).not.toContain(PROBE)
      expect(JSON.stringify(c)).not.toContain(PROBE)
      expect(String(c)).not.toContain(PROBE)
      expect(Object.values(c).join(' ')).not.toContain(PROBE)
    }
  })
})

describe('missing keys', () => {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env
  const saved = env.GITLOOM_API_KEY
  afterEach(() => {
    if (saved === undefined) delete env.GITLOOM_API_KEY
    else env.GITLOOM_API_KEY = saved
  })

  it('treats an empty or whitespace key as missing, before any request', () => {
    delete env.GITLOOM_API_KEY
    let called = false
    const impl = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as typeof fetch
    for (const apiKey of ['', '   ', '\n\t']) {
      expect(() => new Gitloom({ apiKey, fetch: impl })).toThrow(expect.objectContaining({ code: 'missing_api_key', status: 0 }))
    }
    env.GITLOOM_API_KEY = '  '
    expect(() => new Gitloom({ fetch: impl })).toThrow(expect.objectContaining({ code: 'missing_api_key' }))
    expect(called).toBe(false)
  })

  it('falls back to the environment past a blank key, trimmed', async () => {
    env.GITLOOM_API_KEY = ' gl_test_env_key\n'
    const seen: unknown[] = []
    const impl = (async (_url: unknown, init: RequestInit) => {
      seen.push(init.headers)
      return new Response('{"account":"a","auth":"api_key","env":"test"}')
    }) as unknown as typeof fetch
    await new Gitloom({ apiKey: ' ', baseUrl: 'https://api.test', fetch: impl }).whoami()
    expect(seen[0]).toMatchObject({ authorization: 'Bearer gl_test_env_key' })
  })
})

describe('legacy and odd bodies', () => {
  it('reads a flat {"error": "…"} as the message', async () => {
    const { gl } = stub(() => new Response('{"error":"q is required"}', { status: 400 }))
    await expect(gl.recall('x')).rejects.toMatchObject({ code: 'http_400', message: 'q is required' })
  })
})

describe('Retry-After', () => {
  it('is exposed on a 429, and nothing retries', async () => {
    const { gl, calls } = stub(
      () => new Response('{"error":{"code":"rate_limited","message":"slow down"}}', { status: 429, headers: { 'retry-after': '30' } }),
    )
    const err = (await gl.recall('x').catch((e: unknown) => e)) as GitloomError
    expect([err.isRateLimited, err.retryAfter, err.retryable]).toEqual([true, 30, false])
    expect(calls).toHaveLength(1)
    expect(await runTool(gl, { name: 'recall_memory', arguments: { query: 'x' } })).toBe(
      'The memory service failed (rate_limited): slow down (retry after 30s)',
    )
  })

  it('is absent without the header, or when it is not whole seconds', async () => {
    for (const headers of [{}, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }, { 'retry-after': '1.5' }]) {
      const { gl } = stub(
        () => new Response('{"error":{"code":"rate_limited","message":"slow down"}}', { status: 429, headers }),
      )
      const err = (await gl.recall('x').catch((e: unknown) => e)) as GitloomError
      expect(err.retryAfter).toBeUndefined()
      expect(err).not.toHaveProperty('retryAfter')
      expect(await runTool(gl, { name: 'recall_memory', arguments: { query: 'x' } })).toBe(
        'The memory service failed (rate_limited): slow down',
      )
    }
  })
})

describe('times as RFC 3339 strings', () => {
  // The SDK never asks for time_format, but a proxy or a future default could
  // answer with strings; they must read into the same Dates, not crash.
  it('reads ISO times on recall and get into the same Dates', async () => {
    const memory = {
      path: 'facts/a.md', tier: 'facts', content: 'A.', score: 1, matched: ['cue'],
      created_at: '2026-10-04T13:33:23Z', updated_at: '2026-10-04T13:33:23Z',
      occurred_at: '2026-03-05T12:00:00Z', occurred_precision: 'day', expires_at: 'not a time',
      tags: null, user_tags: null,
    }
    const responses = [{ namespace: 'x', memories: [memory], millis: 1 }, { namespace: 'x', ...memory }]
    const urls: string[] = []
    let i = 0
    const impl = (async (url: unknown) => {
      urls.push(String(url))
      return new Response(JSON.stringify(responses[i++]))
    }) as unknown as typeof fetch
    const gl = new Gitloom({ apiKey: 'gl_test_a_b', baseUrl: 'https://api.test', fetch: impl })
    const [recalled] = (await gl.recall('x')).memories
    const stored = await gl.get('facts/a.md')
    for (const m of [recalled!, stored]) {
      expect(m.createdAt?.toISOString()).toBe('2026-10-04T13:33:23.000Z')
      expect(m.occurredAt?.toISOString()).toBe('2026-03-05T12:00:00.000Z')
      expect(m.expiresAt).toBeUndefined()
      expect([m.tags, m.userTags]).toEqual([[], []])
    }
    for (const u of urls) expect(u).not.toContain('time_format')
  })
})

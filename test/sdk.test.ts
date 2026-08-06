import { describe, expect, it, vi } from 'vitest'
import { Gitloom, GitloomError, withMemory, openaiTools, anthropicTools, runTool } from '../src'

/** A fetch double that records calls and replays queued responses. */
function stubFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  const impl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit })
    const r = responses[Math.min(i++, responses.length - 1)] ?? { status: 200, body: {} }
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

function client(responses: Array<{ status?: number; body?: unknown }>, opts = {}) {
  const { impl, calls } = stubFetch(responses)
  return {
    gl: new Gitloom({ apiKey: 'gl_test_abc_def', baseUrl: 'https://api.test', fetch: impl, ...opts }),
    calls,
  }
}

describe('client', () => {
  it('refuses to construct without a key rather than failing at the first call', () => {
    expect(() => new Gitloom({ fetch: stubFetch([]).impl })).toThrow(GitloomError)
  })

  it('sends the key as a bearer token', async () => {
    const { gl, calls } = client([{ body: { account: 'acme', auth: 'api_key', env: 'test' } }])
    await gl.whoami()
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer gl_test_abc_def' })
  })

  it('scopes calls to the bound namespace', async () => {
    const { gl, calls } = client([{ body: { namespace: 'u1', hits: [], millis: 1 } }])
    await gl.for('u1').recall('anything')
    expect(calls[0]!.url).toContain('namespace=u1')
  })

  it('surfaces the API error code, not just a status', async () => {
    const { gl } = client([
      { status: 404, body: { error: { code: 'namespace_not_found', message: 'create it first' } } },
    ])
    await expect(gl.recall('x')).rejects.toMatchObject({
      code: 'namespace_not_found',
      isNamespaceNotFound: true,
    })
  })

  // A 4xx will not fix itself; retrying only delays the message the caller needs.
  it('does not retry a client error', async () => {
    const { gl, calls } = client([{ status: 400, body: { error: { code: 'invalid_body' } } }])
    await expect(gl.recall('x')).rejects.toThrow(GitloomError)
    expect(calls).toHaveLength(1)
  })

  it('retries a server error and succeeds', async () => {
    const { gl, calls } = client([
      { status: 503, body: {} },
      { body: { namespace: 'default', hits: [{ path: 'a.md', score: 1, snippet: 'hello' }], millis: 5 } },
    ])
    const res = await gl.recall('x')
    expect(calls.length).toBeGreaterThan(1)
    expect(res.memories[0]!.text).toBe('hello')
  })

  // A monthly quota refusal will not clear in a few hundred milliseconds, so
  // retrying turns one refusal into three requests — and three charges.
  it('does not retry a quota refusal', async () => {
    const { gl, calls } = client([
      { status: 429, body: { error: { code: 'quota_exceeded', message: 'limit' } } },
    ])
    await expect(gl.recall('x')).rejects.toMatchObject({ isQuotaExceeded: true, retryable: false })
    expect(calls).toHaveLength(1)
  })

  it('returns null context rather than an empty system message', async () => {
    const { gl } = client([{ body: { namespace: 'default', hits: [], millis: 1 } }])
    expect(await gl.context('anything')).toBeNull()
  })

  it('renders context as a system message', async () => {
    const { gl } = client([
      { body: { namespace: 'default', hits: [{ path: 'a.md', score: 1, snippet: 'Likes tea' }], millis: 1 } },
    ])
    const ctx = await gl.context('drinks')
    expect(ctx?.role).toBe('system')
    expect(ctx?.content).toContain('Likes tea')
  })
})

describe('tools', () => {
  it('exposes both provider formats from one schema', () => {
    expect(openaiTools[0]!.function.name).toBe('recall_memory')
    expect(anthropicTools[0]!.name).toBe('recall_memory')
    expect(anthropicTools[0]!.input_schema).toEqual(openaiTools[0]!.function.parameters)
  })

  // A thrown error ends the agent's turn; returned text is something the model
  // can reason about and recover from.
  it('returns tool failures as text instead of throwing', async () => {
    const { gl } = client([{ status: 500, body: {} }])
    const out = await runTool(gl, { name: 'recall_memory', arguments: { query: 'x' } })
    expect(out).toContain('failed')
  })

  it('reports an empty memory plainly', async () => {
    const { gl } = client([{ body: { namespace: 'default', hits: [], millis: 1 } }])
    const out = await runTool(gl, { name: 'recall_memory', arguments: { query: 'x' } })
    expect(out).toContain('Nothing relevant')
  })
})

describe('withMemory', () => {
  function fakeOpenAI(create: ReturnType<typeof vi.fn>) {
    return { chat: { completions: { create } }, models: { list: () => 'untouched' } }
  }

  it('injects context after system messages and saves the exchange', async () => {
    const { gl } = client([
      { body: { namespace: 'default', hits: [{ path: 'a.md', score: 1, snippet: 'Allergic to nuts' }], millis: 2 } },
      { body: { id: 'm1', namespace: 'default', status: 'accepted' } },
    ])
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'Noted.' } }] })
    const wrapped = withMemory(fakeOpenAI(create), { memory: gl })

    await wrapped.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'what can I eat' },
      ],
    })

    const sent = create.mock.calls[0]![0].messages
    expect(sent[0].role).toBe('system')
    expect(sent[0].content).toBe('You are helpful.')
    expect(sent[1].content).toContain('Allergic to nuts')
    expect(sent[2].role).toBe('user')
  })

  // The wrapper must forward everything it does not handle, or wrapping the
  // client breaks unrelated parts of the SDK.
  it('passes through untouched properties', () => {
    const create = vi.fn()
    const { gl } = client([])
    const wrapped = withMemory(fakeOpenAI(create), { memory: gl })
    expect(wrapped.models.list()).toBe('untouched')
  })

  // An agent that stops answering because memory is briefly unreachable is
  // worse than one that answers without it.
  it('still answers when memory is down', async () => {
    const failing = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const gl = new Gitloom({ apiKey: 'gl_test_a_b', baseUrl: 'https://api.test', fetch: failing, maxRetries: 0 })
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    const onError = vi.fn()
    const wrapped = withMemory(fakeOpenAI(create), { memory: gl, onError })

    const res = await wrapped.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect((res as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe('ok')
    expect(onError).toHaveBeenCalled()
  })

  it('honours a per-call opt-out and does not leak the flag upstream', async () => {
    const { gl, calls } = client([])
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    const wrapped = withMemory(fakeOpenAI(create), { memory: gl })

    await wrapped.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      memory: false,
    } as never)

    expect(calls).toHaveLength(0)
    expect(create.mock.calls[0]![0]).not.toHaveProperty('memory')
  })

  // Saving on every completion means an N-turn conversation buys N extractions
  // of largely the same content, each one a model pass and a write unit.
  it('batches saves instead of writing on every turn', async () => {
    const { gl, calls } = client([{ body: { namespace: 'batch', hits: [], millis: 1 } }])
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    const wrapped = withMemory(fakeOpenAI(create), {
      memory: gl, namespace: 'batch', inject: false, saveEveryTurns: 3,
    })

    for (let i = 0; i < 2; i++) {
      await wrapped.chat.completions.create({ model: 'x', messages: [{ role: 'user', content: `turn ${i}` }] })
    }
    expect(calls.filter((c) => c.url.includes('/v1/memories'))).toHaveLength(0)

    await wrapped.chat.completions.create({ model: 'x', messages: [{ role: 'user', content: 'turn 3' }] })
    expect(calls.filter((c) => c.url.includes('/v1/memories'))).toHaveLength(1)
  })

  it('resolves the namespace per call so one server can serve many users', async () => {
    const { gl, calls } = client([
      { body: { namespace: 'u2', hits: [], millis: 1 } },
      { body: { id: 'm', namespace: 'u2', status: 'accepted' } },
    ])
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    let current = 'u2'
    const wrapped = withMemory(fakeOpenAI(create), { memory: gl, namespace: () => current })

    await wrapped.chat.completions.create({ model: 'x', messages: [{ role: 'user', content: 'hi' }] })
    expect(calls[0]!.url).toContain('namespace=u2')
  })
})

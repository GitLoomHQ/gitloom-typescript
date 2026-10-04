import { describe, expect, it, vi } from 'vitest'
import { Gitloom, GitloomError, withMemory, openaiTools, anthropicTools, mcpTools, runTool, isMemoryTool } from '../src'

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
    const { gl, calls } = client([{ body: { namespace: 'u1', memories: [], millis: 1 } }])
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
      { body: { namespace: 'default', memories: [{ path: 'a.md', score: 1, content: 'hello' }], millis: 5 } },
    ])
    const res = await gl.recall('x')
    expect(calls.length).toBeGreaterThan(1)
    expect(res.memories[0]!.content).toBe('hello')
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
    const { gl } = client([{ body: { namespace: 'default', memories: [], millis: 1 } }])
    expect(await gl.context('anything')).toBeNull()
  })

  it('renders context as a system message', async () => {
    const { gl } = client([
      { body: { namespace: 'default', memories: [{ path: 'a.md', score: 1, content: 'Likes tea' }], millis: 1 } },
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
    const { gl } = client([{ body: { namespace: 'default', memories: [], millis: 1 } }])
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
      { body: { namespace: 'default', memories: [{ path: 'a.md', score: 1, content: 'Allergic to nuts' }], millis: 2 } },
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
    const { gl, calls } = client([{ body: { namespace: 'batch', memories: [], millis: 1 } }])
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
      { body: { namespace: 'u2', memories: [], millis: 1 } },
      { body: { id: 'm', namespace: 'u2', status: 'accepted' } },
    ])
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    let current = 'u2'
    const wrapped = withMemory(fakeOpenAI(create), { memory: gl, namespace: () => current })

    await wrapped.chat.completions.create({ model: 'x', messages: [{ role: 'user', content: 'hi' }] })
    expect(calls[0]!.url).toContain('namespace=u2')
  })
})

describe('recall options', () => {
  it('sends every filter and the mode on the query string', async () => {
    const { gl, calls } = client([{ body: { namespace: 'default', memories: [], millis: 1 } }])
    await gl.recall('runs', {
      mode: 'summary',
      tiers: ['facts', 'skills'],
      paths: ['facts/events', 'incidents'],
      tags: ['sport'],
      tagsAll: ['a', 'b'],
      since: new Date('2026-01-01T00:00:00Z'),
      until: '2026-06-30',
      minScore: 0.4,
      context: false,
      detail: 'full',
      limit: 5,
    })
    const url = new URL(calls[0]!.url)
    const got: Record<string, string> = {}
    url.searchParams.forEach((v, k) => {
      got[k] = v
    })
    expect(got).toMatchObject({
      q: 'runs',
      mode: 'summary',
      tiers: 'facts,skills',
      paths: 'facts/events,incidents',
      tags: 'sport',
      tags_all: 'a,b',
      since: '1767225600',
      until: '2026-06-30',
      min_score: '0.4',
      context: '0',
      detail: 'full',
      limit: '5',
    })
  })

  it('leaves the defaults off the wire', async () => {
    const { gl, calls } = client([{ body: { namespace: 'default', memories: [], millis: 1 } }])
    await gl.recall('x')
    const url = new URL(calls[0]!.url)
    const keys: string[] = []
    url.searchParams.forEach((_, k) => {
      keys.push(k)
    })
    expect(keys.sort()).toEqual(['namespace', 'q'])
  })

  it('passes the full memory shape through and normalises the envelope', async () => {
    const { gl } = client([
      {
        body: {
          namespace: 'default', query: 'x', mode: 'raw',
          memories: [{
            path: 'facts/a.md', tier: 'facts', topic: 'facts', content: 'A.', score: 0.9,
            matched: ['lexical', 'cue'], sections: ['setup'], scores: { bm25: 1.2, coverage: 1 },
            related: [{ label: 'same-trip', path: 'facts/b.md' }],
            provenance: { commit: 'abc', when: '2026-08-06T00:00:00Z', revisions: 2 },
          }],
          candidates: 3, filtered_out: 2, millis: 7,
          timings: { lexical_ms: 1, vector_ms: 5, graph_ms: 1 },
        },
      },
    ])
    const res = await gl.recall('x')
    const m = res.memories[0]!
    expect(m.matched).toEqual(['lexical', 'cue'])
    expect(m.scores?.coverage).toBe(1)
    expect(m.related?.[0]?.path).toBe('facts/b.md')
    expect(m.provenance?.revisions).toBe(2)
    expect(res.filteredOut).toBe(2)
    expect(res.candidates).toBe(3)
    expect(res.timings.vector_ms).toBe(5)
  })
})

function query(url: URL): Record<string, string> {
  const out: Record<string, string> = {}
  url.searchParams.forEach((v, k) => {
    out[k] = v
  })
  return out
}

describe('tags and times on recall', () => {
  const empty = { body: { namespace: 'default', memories: [], millis: 1 } }

  it('sends the time range, its field and zone, and converts each time form', async () => {
    const { gl, calls } = client([empty])
    await gl.recall('trips', {
      since: new Date('2026-05-01T00:00:00Z'),
      until: 1780271999.9,
      timeField: 'occurred',
      tz: 'Asia/Kolkata',
    })
    const url = new URL(calls[0]!.url)
    expect(query(url)).toMatchObject({
      since: '1777593600',
      until: '1780271999',
      time_field: 'occurred',
      tz: 'Asia/Kolkata',
    })
  })

  it('sends a string time as is, and a Date the API cannot read as an epoch as RFC 3339', async () => {
    const { gl, calls } = client([empty])
    await gl.recall('x', { since: new Date('1969-07-20T20:17:00Z'), until: '2026-05-31' })
    const url = new URL(calls[0]!.url)
    expect(url.searchParams.get('since')).toBe('1969-07-20T20:17:00.000Z')
    expect(url.searchParams.get('until')).toBe('2026-05-31')
  })

  // A raw # ends the query string, so the server would see an empty filter.
  it('URL-encodes tags, # included', async () => {
    const { gl, calls } = client([empty])
    await gl.recall('x', { tags: ['#launch', 'q3 plans'], tagsAll: ['client:acme'] })
    expect(calls[0]!.url).toContain('tags=%23launch%2Cq3+plans')
    expect(calls[0]!.url).not.toContain('#')
    const url = new URL(calls[0]!.url)
    expect(url.searchParams.get('tags')).toBe('#launch,q3 plans')
    expect(url.searchParams.get('tags_all')).toBe('client:acme')
  })

  it('lists by filter without a query', async () => {
    const { gl, calls } = client([empty, empty, empty])
    await gl.recall({ tags: ['lease'], timeField: 'occurred', since: '2026-03-01' })
    await gl.recall(undefined, { paths: ['facts/home'] })
    await gl.recall('', { tiers: ['incidents'] })
    for (const c of calls) {
      const url = new URL(c.url)
      expect(url.searchParams.has('q')).toBe(false)
      expect(url.searchParams.has('mode')).toBe(false)
    }
    expect(new URL(calls[0]!.url).searchParams.get('tags')).toBe('lease')
    expect(new URL(calls[1]!.url).searchParams.get('paths')).toBe('facts/home')
  })

  it('renders a filter-only context', async () => {
    const { gl, calls } = client([
      { body: { namespace: 'default', memories: [{ path: 'facts/a.md', score: 1, content: 'Lease ends in May.' }], millis: 1 } },
    ])
    const ctx = await gl.context({ tags: ['lease'] })
    expect(ctx?.content).toContain('Lease ends in May.')
    expect(new URL(calls[0]!.url).searchParams.has('q')).toBe(false)
  })

  it('refuses a recall with neither a query nor a filter before calling the server', async () => {
    const { gl, calls } = client([empty])
    await expect(gl.recall({})).rejects.toMatchObject({ code: 'missing_query', status: 0 })
    await expect(gl.recall('  ')).rejects.toMatchObject({ code: 'missing_query' })
    // A zone or a time field says how to read a range, not what to list.
    await expect(gl.recall({ timeField: 'created', tz: 'UTC', tags: [] })).rejects.toMatchObject({ code: 'missing_query' })
    await expect(gl.context({})).rejects.toMatchObject({ code: 'missing_query' })
    expect(calls).toHaveLength(0)
  })

  it('reads times as Dates and keeps the deprecated strings', async () => {
    const { gl } = client([
      {
        body: {
          namespace: 'default',
          memories: [
            {
              path: 'facts/gear/a7iii.md', tier: 'facts', content: 'Bought a Sony A7III.', score: 0.93, matched: ['cue'],
              tags: ['gear', 'camera'], user_tags: ['gear'],
              created_at: 1785492131, updated_at: 1785492200, occurred_at: 1785499200, expires_at: 1788091200,
              occurred_source: 'user', occurred_precision: 'day',
              created: '2026-07-31T10:02:11Z', updated: '2026-07-31T10:03:20Z',
            },
            { path: 'facts/b.md', tier: 'facts', content: 'B.', score: 0.5, matched: ['graph'] },
          ],
          millis: 1,
        },
      },
    ])
    const [m, bare] = (await gl.recall('camera')).memories
    expect(m!.userTags).toEqual(['gear'])
    expect(m!.tags).toEqual(['gear', 'camera'])
    expect(m!.createdAt).toEqual(new Date(1785492131 * 1000))
    expect(m!.updatedAt).toEqual(new Date(1785492200 * 1000))
    expect(m!.occurredAt?.toISOString()).toBe('2026-07-31T12:00:00.000Z')
    expect(m!.expiresAt).toBeInstanceOf(Date)
    expect([m!.occurredSource, m!.occurredPrecision]).toEqual(['user', 'day'])
    expect([m!.created, m!.updated]).toEqual(['2026-07-31T10:02:11Z', '2026-07-31T10:03:20Z'])
    expect(m).not.toHaveProperty('created_at')
    expect(m).not.toHaveProperty('user_tags')
    for (const k of ['userTags', 'createdAt', 'updatedAt', 'occurredAt', 'expiresAt', 'occurredSource', 'occurredPrecision']) {
      expect(bare![k as keyof typeof bare]).toBeUndefined()
    }
  })

  it('carries the new filters through answer', async () => {
    const { gl, calls } = client([{ body: { namespace: 'default', memories: [], answer: 'Goa.', millis: 1 } }])
    await gl.answer('where did we travel', { tags: ['trip'], timeField: 'occurred', since: '2026-05-01', tz: 'Asia/Kolkata' })
    const url = new URL(calls[0]!.url)
    expect(query(url)).toMatchObject({
      q: 'where did we travel', mode: 'summary', tags: 'trip', time_field: 'occurred', since: '2026-05-01', tz: 'Asia/Kolkata',
    })
  })
})

describe('lane path', () => {
  it('sends rank, max_chars and model, and reads what the lane path adds', async () => {
    const { gl, calls } = client([
      {
        body: {
          namespace: 'default', query: 'x', mode: 'summary', rank: 'jev', rank_fallback: true,
          memories: [{
            path: 'turns/conv-1/main/000001-user-aa.md', tier: 'facts', content: 'user: I staked the tomatoes …',
            score: 0.8, matched: ['lexical', 'time'], store: 'turn', said: ['2026-05-21'], excerpted: true,
          }],
          candidates: 9, filtered_out: 0, millis: 40,
          timings: { lexical_ms: 0, vector_ms: 0, graph_ms: 0, embed_ms: 20, lanes_ms: 8, rank_ms: 300,
            lane: [{ lane: 'time', store: 'turn', ms: 2, n: 1 }] },
        },
      },
    ])
    const res = await gl.recall('x', { mode: 'summary', rank: 'jev', maxChars: 12000, model: 'sonnet' })
    const url = new URL(calls[0]!.url)
    expect([url.searchParams.get('rank'), url.searchParams.get('max_chars'), url.searchParams.get('model')])
      .toEqual(['jev', '12000', 'sonnet'])
    expect(res.rank).toBe('jev')
    expect(res.rankFallback).toBe(true)
    const m = res.memories[0]!
    expect([m.store, m.said, m.excerpted]).toEqual(['turn', ['2026-05-21'], true])
    expect(res.timings.lane?.[0]?.lane).toBe('time')
  })

  it('leaves the envelope as it was without rank', async () => {
    const { gl } = client([{ body: { namespace: 'default', memories: [], millis: 1 } }])
    const res = await gl.recall('x')
    expect('rank' in res).toBe(false)
    expect('rankFallback' in res).toBe(false)
  })

  it('passes rank through answer', async () => {
    const { gl, calls } = client([{ body: { namespace: 'default', memories: [], answer: 'A.', millis: 1 } }])
    await gl.answer('x', { rank: 'fused', model: 'haiku' })
    const url = new URL(calls[0]!.url)
    expect([url.searchParams.get('mode'), url.searchParams.get('rank'), url.searchParams.get('model')])
      .toEqual(['summary', 'fused', 'haiku'])
  })

  it('lets a host recall on the lane path and shows when each memory was said', async () => {
    const { gl, calls } = client([
      { body: { namespace: 'default', memories: [{ path: 'facts/a.md', tier: 'facts', content: 'A.', score: 1, matched: ['time'], said: ['2026-05-20', '2026-05-25'] }], millis: 1 } },
      { body: { namespace: 'default', memories: [{ path: 'facts/a.md', tier: 'facts', content: 'A.', score: 1, matched: ['lexical'] }], millis: 1 } },
    ])
    const out = await runTool(gl, { name: 'recall_memory', arguments: { query: 'x' } }, { rank: 'fused', maxChars: 8000 })
    const url = new URL(calls[0]!.url)
    expect([url.searchParams.get('rank'), url.searchParams.get('max_chars')]).toEqual(['fused', '8000'])
    expect(out).toBe('- (said 2026-05-20, 2026-05-25) A.')
    expect(await runTool(gl, { name: 'recall_memory', arguments: { query: 'x' } })).toBe('- A.')
    expect(new URL(calls[1]!.url).searchParams.has('rank')).toBe(false)
  })
})

describe('answer', () => {
  it('asks for a summary and returns the text with its evidence', async () => {
    const { gl, calls } = client([
      {
        body: {
          namespace: 'default', mode: 'summary', answer: 'A Sony A7III [1].', model: 'haiku',
          memories: [{ path: 'facts/a.md', content: 'Bought a Sony A7III.', score: 0.9, matched: ['cue'] }],
          millis: 900, timings: { lexical_ms: 1, vector_ms: 90, graph_ms: 1, model_ms: 800 },
        },
      },
    ])
    const res = await gl.answer('what camera do I own')
    expect(new URL(calls[0]!.url).searchParams.get('mode')).toBe('summary')
    expect(res.answer).toBe('A Sony A7III [1].')
    expect(res.model).toBe('haiku')
    expect(res.memories[0]!.content).toContain('Sony')
  })

  it('switches to agentic mode on request', async () => {
    const { gl, calls } = client([
      { body: { namespace: 'default', mode: 'agentic', answer: 'ok', memories: [], trace: [{ type: 'text', text: 'ok' }], millis: 1 } },
    ])
    const res = await gl.answer('q', { agentic: true })
    expect(new URL(calls[0]!.url).searchParams.get('mode')).toBe('agentic')
    expect(res.trace?.[0]?.type).toBe('text')
  })

  it('refuses to return an empty answer silently', async () => {
    const { gl } = client([{ body: { namespace: 'default', mode: 'summary', memories: [], millis: 1 } }])
    await expect(gl.answer('q')).rejects.toMatchObject({ code: 'no_answer' })
  })
})

describe('vocab', () => {
  it('learns, lists, looks up and forgets terms', async () => {
    const { gl, calls } = client([
      { status: 202, body: { id: 'j1', namespace: 'default', status: 'accepted' } },
      { body: { namespace: 'default', terms: [{ term: 'kubernetes', aliases: ['k8s'] }] } },
      { body: { namespace: 'default', word: 'k8s', found: true, term: { term: 'kubernetes', aliases: ['k8s'] } } },
      { body: { namespace: 'default', word: 'zzz', found: false } },
      { status: 202, body: { id: 'j2', namespace: 'default', status: 'accepted' } },
    ])
    const learned = await gl.vocab.learn([{ term: 'kubernetes', aliases: ['k8s'], definition: 'Orchestration.' }])
    expect(learned.status).toBe('accepted')
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ terms: [{ term: 'kubernetes', aliases: ['k8s'] }] })

    const terms = await gl.vocab.list({ like: 'kube' })
    expect(terms[0]!.term).toBe('kubernetes')
    expect(calls[1]!.url).toContain('like=kube')

    expect((await gl.vocab.lookup('k8s'))?.term).toBe('kubernetes')
    expect(await gl.vocab.lookup('zzz')).toBeNull()

    await gl.vocab.forget(['kubernetes'])
    expect(calls[4]!.init.method).toBe('DELETE')
    expect(calls[4]!.url).toContain('term=kubernetes')
  })
})

describe('skills', () => {
  it('stores skills and finds them by task', async () => {
    const { gl, calls } = client([
      { status: 202, body: { id: 'j1', namespace: 'default', status: 'accepted', paths: ['skills/ops/deploy.md'] } },
      { body: { namespace: 'default', skills: [{ path: 'skills/ops/deploy.md', name: 'Deploy', content: 'Run make deploy.', score: 0.8 }] } },
      { body: { namespace: 'default', skills: [] } },
    ])
    const stored = await gl.skills.store([{ name: 'Deploy', topic: 'ops', content: 'Run make deploy.' }])
    expect(stored.paths).toEqual(['skills/ops/deploy.md'])
    expect(calls[0]!.url).toContain('/v1/skills')

    const found = await gl.skills.find('ship a release', { paths: ['ops'], limit: 3 })
    expect(found[0]!.name).toBe('Deploy')
    const url = new URL(calls[1]!.url)
    expect(url.searchParams.get('q')).toBe('ship a release')
    expect(url.searchParams.get('paths')).toBe('ops')
    expect(url.searchParams.get('limit')).toBe('3')

    await gl.skills.list()
    expect(new URL(calls[2]!.url).searchParams.has('q')).toBe(false)
  })

  it('exposes find_skill as a tool the model can call', async () => {
    const { gl } = client([
      { body: { namespace: 'default', skills: [{ path: 'skills/deploy.md', name: 'Deploy', description: 'Ship it.', content: '1. Tag.' }] } },
    ])
    expect(isMemoryTool('find_skill')).toBe(true)
    expect(mcpTools.map((t) => t.name)).toEqual(['recall_memory', 'save_memory', 'find_skill'])
    const out = await runTool(gl, { name: 'find_skill', arguments: { task: 'deploy' } })
    expect(out).toContain('## Deploy')
    expect(out).toContain('1. Tag.')
  })

  it('forwards recall tool filters', async () => {
    const { gl, calls } = client([{ body: { namespace: 'default', memories: [], millis: 1 } }])
    await runTool(gl, { name: 'recall_memory', arguments: { query: 'x', tiers: ['skills'], paths: ['facts/events'] } })
    const url = new URL(calls[0]!.url)
    expect(url.searchParams.get('tiers')).toBe('skills')
    expect(url.searchParams.get('paths')).toBe('facts/events')
  })
})

describe('mcp tool annotations', () => {
  // OpenAI's plugin review requires readOnlyHint, openWorldHint and
  // destructiveHint on every tool, so a missing one fails a submission rather
  // than anything a test would otherwise notice.
  it('declares every hint a plugin submission requires', () => {
    for (const tool of mcpTools) {
      const a = tool.annotations as Record<string, boolean>
      for (const hint of ['readOnlyHint', 'openWorldHint', 'destructiveHint']) {
        expect(typeof a[hint], `${tool.name} is missing ${hint}`).toBe('boolean')
      }
      expect(a.openWorldHint, `${tool.name} reaches a hosted namespace`).toBe(true)
      expect(a.destructiveHint, `${tool.name} never destroys history`).toBe(false)
    }
    expect(mcpTools.find((t) => t.name === 'save_memory')!.annotations.readOnlyHint).toBe(false)
  })
})

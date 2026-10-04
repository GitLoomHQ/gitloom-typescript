import { describe, expect, it } from 'vitest'
import { Gitloom } from '../src'

function client(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: URL; method: string; body: Record<string, unknown> | undefined }> = []
  let i = 0
  const impl = (async (url: unknown, init: RequestInit) => {
    calls.push({
      url: new URL(String(url)),
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const r = responses[Math.min(i++, responses.length - 1)] ?? {}
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 })
  }) as unknown as typeof fetch
  return {
    gl: new Gitloom({ apiKey: 'gl_test_abc_def', baseUrl: 'https://api.test', namespace: 'ns', fetch: impl }),
    calls,
  }
}

function query(url: URL): Record<string, string> {
  const out: Record<string, string> = {}
  url.searchParams.forEach((v, k) => {
    out[k] = v
  })
  return out
}

const accepted = { status: 202, body: { id: 'j1', namespace: 'ns', status: 'accepted' } }

describe('write', () => {
  it('sends memories, not messages, with tags and times in the API form', async () => {
    const { gl, calls } = client([accepted])
    await gl.write(
      [
        {
          path: 'facts/people/maya.md', content: 'Maya rides a bicycle.', tags: ['people', '#family'],
          occurredAt: new Date('2026-07-19T08:30:00Z'), confidence: 0.8,
          cues: ['how does Maya get around'], related: ['spouse: facts/people/arun.md'],
        },
        { path: 'incidents/outage.md', content: 'DB down.', occurredAt: 1784449800.75, ttl: '30d', supersedes: 'incidents/old.md' },
        { path: 'facts/home/lease.md', content: 'Lease signed.', occurredAt: '2026-03-01' },
        { path: 'facts/legacy.md', content: 'Old.', date: '2025-01-02' },
      ],
      { timezone: 'Asia/Kolkata' },
    )
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url.pathname).toBe('/v1/memories')
    const body = calls[0]!.body!
    expect(body).not.toHaveProperty('messages')
    expect(body.namespace).toBe('ns')
    expect(body.timezone).toBe('Asia/Kolkata')
    const [maya, outage, lease, legacy] = body.memories as Array<Record<string, unknown>>
    expect(maya).toEqual({
      path: 'facts/people/maya.md', content: 'Maya rides a bicycle.', tags: ['people', '#family'],
      occurred_at: 1784449800, confidence: 0.8,
      cues: ['how does Maya get around'], related: ['spouse: facts/people/arun.md'],
    })
    expect(outage).toMatchObject({ occurred_at: 1784449800, ttl: '30d', supersedes: 'incidents/old.md' })
    expect(lease!.occurred_at).toBe('2026-03-01')
    expect(legacy).toEqual({ path: 'facts/legacy.md', content: 'Old.', date: '2025-01-02' })
  })

  // One bad path fails the whole batch, and the server's refusal costs a round trip.
  it('refuses a path that is not markdown before sending', async () => {
    const { gl, calls } = client([accepted])
    await expect(
      gl.write([{ path: 'facts/ok.md', content: 'x' }, { path: 'facts/not-markdown', content: 'y' }]),
    ).rejects.toMatchObject({ code: 'invalid_path' })
    expect(calls).toHaveLength(0)
  })

  it('refuses an invalid Date before sending', async () => {
    const { gl, calls } = client([accepted])
    await expect(
      gl.write([{ path: 'facts/a.md', content: 'x', occurredAt: new Date('not a date') }]),
    ).rejects.toMatchObject({ code: 'invalid_date' })
    expect(calls).toHaveLength(0)
  })

  it('writes nothing without calling the API', async () => {
    const { gl, calls } = client([accepted])
    await gl.write([])
    await gl.forget([])
    expect(calls).toHaveLength(0)
  })

  it('surfaces a tag the server refuses', async () => {
    const { gl } = client([
      { status: 400, body: { error: { code: 'invalid_tag', message: 'memories[0].tags[0] "a!" has a character outside letters, digits, spaces and - _ . : / # @' } } },
    ])
    await expect(gl.write([{ path: 'facts/a.md', content: 'x', tags: ['a!'] }])).rejects.toMatchObject({
      code: 'invalid_tag',
      status: 400,
      message: expect.stringContaining('memories[0].tags[0]'),
    })
  })
})

describe('remember', () => {
  it('sends tags, occurred_at and timezone for the conversation', async () => {
    const { gl, calls } = client([accepted])
    await gl.remember([{ role: 'user', content: 'We moved to Pune.' }], {
      tags: ['move'], occurredAt: new Date('2026-04-12T00:00:00Z'), timezone: 'Asia/Kolkata', sessionId: 's1',
    })
    expect(calls[0]!.body).toEqual({
      namespace: 'ns', session_id: 's1', tags: ['move'], occurred_at: 1775952000, timezone: 'Asia/Kolkata',
      messages: [{ role: 'user', content: 'We moved to Pune.' }],
    })
  })

  it('still sends the deprecated date', async () => {
    const { gl, calls } = client([accepted])
    await gl.remember([{ role: 'user', content: 'x' }], { date: '2025-12-01' })
    expect(calls[0]!.body).toMatchObject({ date: '2025-12-01' })
    expect(calls[0]!.body).not.toHaveProperty('occurred_at')
  })
})

describe('get and forget', () => {
  it('reads one memory by path, a section included', async () => {
    const { gl, calls } = client([
      { body: { namespace: 'ns', path: 'facts/people/maya.md#bike', content: 'Maya rides a bicycle.', tags: ['people'], confidence: 0.8 } },
    ])
    const m = await gl.get('facts/people/maya.md#bike')
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url.pathname).toBe('/v1/memories')
    expect(calls[0]!.url.search).toContain('path=facts%2Fpeople%2Fmaya.md%23bike')
    expect(calls[0]!.url.searchParams.get('namespace')).toBe('ns')
    expect([m.content, m.confidence]).toEqual(['Maya rides a bicycle.', 0.8])
  })

  // Several HTTP clients decline to send a body on DELETE.
  it('forgets by path in the query string, not a body', async () => {
    const { gl, calls } = client([{ status: 202, body: { status: 'accepted' } }])
    await gl.forget(['facts/a.md', 'facts/b.md'], { namespace: 'other' })
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.body).toBeUndefined()
    expect(calls[0]!.url.searchParams.get('path')).toBe('facts/a.md,facts/b.md')
    expect(calls[0]!.url.searchParams.get('namespace')).toBe('other')
  })
})

describe('tree, topics and graph', () => {
  it('sends the tree root and depth', async () => {
    const { gl, calls } = client([
      { body: { namespace: 'ns', depth: 3, tree: { path: 'facts', children: [{ path: 'facts/people', kind: 'dir' }] }, millis: 4 } },
    ])
    const res = await gl.tree({ path: 'facts', depth: 3 })
    expect(calls[0]!.url.pathname).toBe('/v1/tree')
    expect(query(calls[0]!.url)).toEqual({ namespace: 'ns', path: 'facts', depth: '3' })
    expect(res.tree.children?.[0]?.path).toBe('facts/people')
  })

  it('sends only the topic filters that are set', async () => {
    const { gl, calls } = client([
      { body: { namespace: 'ns', topics: [{ path: 'facts/databases', name: 'databases', tier: 'facts', parent: 'facts', depth: 2, memories: 7 }], millis: 2 } },
      { body: { namespace: 'ns', topics: null, millis: 1 } },
    ])
    const res = await gl.topics({ tier: 'facts', like: 'databas', minFiles: 2, maxDepth: 3, prefix: 'facts', limit: 50 })
    expect(calls[0]!.url.pathname).toBe('/v1/topics')
    expect(query(calls[0]!.url)).toEqual({
      namespace: 'ns', tier: 'facts', prefix: 'facts', like: 'databas', max_depth: '3', min_files: '2', limit: '50',
    })
    expect(res.topics[0]!.memories).toBe(7)
    expect((await gl.topics()).topics).toEqual([])
    expect(query(calls[1]!.url)).toEqual({ namespace: 'ns' })
  })

  it('reads the graph', async () => {
    const { gl, calls } = client([
      {
        body: {
          namespace: 'ns', truncated: true, millis: 9,
          nodes: [{ path: 'facts/a.md', tier: 'facts', kind: 'file' }],
          edges: [{ src: 'facts/a.md', dst: 'facts/b.md', label: 'spouse' }],
        },
      },
      { body: {} },
    ])
    const g = await gl.graph({ limit: 100 })
    expect(calls[0]!.url.pathname).toBe('/v1/graph')
    expect(calls[0]!.url.searchParams.get('limit')).toBe('100')
    expect([g.nodes.length, g.edges[0]!.label, g.truncated]).toEqual([1, 'spouse', true])
    expect(await gl.graph()).toEqual({ namespace: 'ns', nodes: [], edges: [], truncated: false, millis: 0 })
  })
})

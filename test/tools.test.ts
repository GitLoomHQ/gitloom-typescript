import { describe, expect, it } from 'vitest'
import { Gitloom, anthropicTools, mcpTools, openaiTools, runTool, runToolResult } from '../src'

function client(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: URL; body: Record<string, unknown> | undefined }> = []
  let i = 0
  const impl = (async (url: unknown, init: RequestInit) => {
    calls.push({
      url: new URL(String(url)),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const r = responses[Math.min(i++, responses.length - 1)] ?? {}
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 })
  }) as unknown as typeof fetch
  return {
    gl: new Gitloom({ apiKey: 'gl_test_abc_def', baseUrl: 'https://api.test', fetch: impl, maxRetries: 0 }),
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

const empty = { body: { namespace: 'default', memories: [], millis: 1 } }

function schemas(name: string) {
  return [
    mcpTools.find((t) => t.name === name)!.inputSchema,
    openaiTools.find((t) => t.function.name === name)!.function.parameters,
    anthropicTools.find((t) => t.name === name)!.input_schema,
  ] as Array<{ properties: Record<string, { type: string; enum?: readonly string[] }>; required?: readonly string[]; additionalProperties: boolean }>
}

describe('tool schemas', () => {
  it('lets recall_memory filter by tags and time without a query, in every host shape', () => {
    for (const s of schemas('recall_memory')) {
      // Draft-04 validators refuse an empty required list, so it is left out.
      expect(s).not.toHaveProperty('required')
      expect(s.additionalProperties).toBe(false)
      expect(s.properties.tags!.type).toBe('array')
      expect(s.properties.since!.type).toBe('string')
      expect(s.properties.until!.type).toBe('string')
      expect(s.properties.time_field!.enum).toEqual(['occurred', 'created', 'updated'])
      expect(Object.keys(s.properties)).toEqual(['query', 'tags', 'since', 'until', 'time_field', 'tiers', 'paths'])
    }
  })

  it('lets save_memory carry tags and when it happened, in every host shape', () => {
    for (const s of schemas('save_memory')) {
      expect(s.required).toEqual(['fact'])
      expect(s.additionalProperties).toBe(false)
      expect(s.properties.tags!.type).toBe('array')
      expect(s.properties.occurred_at!.type).toBe('string')
    }
  })
})

describe('runTool recall_memory', () => {
  it('sends the filters with a query, time_field defaulting to occurred under a range', async () => {
    const { gl, calls } = client([empty])
    await runTool(
      gl,
      { name: 'recall_memory', arguments: { query: 'where did we travel', tags: ['trip'], since: '2026-05-01', until: '2026-05-31' } },
      { rank: 'fused', maxChars: 8000 },
    )
    expect(query(calls[0]!.url)).toEqual({
      q: 'where did we travel', namespace: 'default', tags: 'trip', since: '2026-05-01', until: '2026-05-31',
      time_field: 'occurred', rank: 'fused', max_chars: '8000',
    })
  })

  it('keeps the time_field the model chose, and sends none without a range', async () => {
    const { gl, calls } = client([empty, empty])
    await runTool(gl, { name: 'recall_memory', arguments: { query: 'x', since: '2026-01-01', time_field: 'created' } })
    await runTool(gl, { name: 'recall_memory', arguments: { query: 'x', tags: ['a'] } })
    expect(calls[0]!.url.searchParams.get('time_field')).toBe('created')
    expect(calls[1]!.url.searchParams.has('time_field')).toBe(false)
  })

  // The server refuses rank without a question, and a list has no reader.
  it('lists by filter with no query, rank, max_chars or mode, whatever the host set', async () => {
    const { gl, calls } = client([
      { body: { namespace: 'default', memories: [{ path: 'facts/a.md', score: 1, content: 'Lease ends in May.', occurred_at: 1772366400, occurred_precision: 'day' }], millis: 1 } },
    ])
    const out = await runTool(
      gl,
      { name: 'recall_memory', arguments: { tags: ['lease'], since: '2026-01-01' } },
      { rank: 'jev', maxChars: 8000 },
    )
    expect(query(calls[0]!.url)).toEqual({ namespace: 'default', tags: 'lease', since: '2026-01-01', time_field: 'occurred' })
    expect(out).toBe('- [2026-03-01] Lease ends in May.')
  })

  it('refuses a call with neither a query nor a filter without calling the server', async () => {
    const { gl, calls } = client([empty])
    expect(await runTool(gl, { name: 'recall_memory', arguments: {} })).toBe('No query or filter was provided.')
    expect(await runTool(gl, { name: 'recall_memory', arguments: { query: ' ', time_field: 'occurred', tags: [] } }))
      .toBe('No query or filter was provided.')
    expect(calls).toHaveLength(0)
  })

  it('dates each memory by the UTC day it happened, never by when it was written', async () => {
    const { gl } = client([
      {
        body: {
          namespace: 'default',
          millis: 1,
          memories: [
            { path: 'facts/a.md', score: 1, content: 'Moved to Pune.', occurred_at: 1685361600, occurred_precision: 'day', created_at: 1785492131 },
            { path: 'facts/b.md', score: 0.9, content: 'Flight landed.', occurred_at: 1685399400, occurred_precision: 'instant', said: ['2023-05-30'] },
            { path: 'facts/c.md', score: 0.8, content: 'Likes tea.', created_at: 1785492131, updated_at: 1785492200 },
          ],
        },
      },
    ])
    const out = await runTool(gl, { name: 'recall_memory', arguments: { query: 'x' } })
    expect(out).toBe(
      '- [2023-05-29] Moved to Pune.\n' +
        '- [2023-05-29] (said 2023-05-30) Flight landed.\n' +
        '- Likes tea.',
    )
  })
})

describe('runTool save_memory', () => {
  it('passes tags and occurred_at to remember', async () => {
    const { gl, calls } = client([{ status: 202, body: { id: 'j', namespace: 'default', status: 'accepted' } }])
    const out = await runTool(gl, {
      name: 'save_memory',
      arguments: { fact: 'The user moved to Pune on 2023-05-29.', tags: ['move', 'home'], occurred_at: '2023-05-29' },
    })
    expect(out).toContain('Saved')
    expect(calls[0]!.body).toMatchObject({ tags: ['move', 'home'], occurred_at: '2023-05-29' })
  })

  it('leaves both out when the model does', async () => {
    const { gl, calls } = client([{ status: 202, body: { id: 'j', namespace: 'default', status: 'accepted' } }])
    await runTool(gl, { name: 'save_memory', arguments: { fact: 'Likes tea.' } })
    expect(calls[0]!.body).not.toHaveProperty('tags')
    expect(calls[0]!.body).not.toHaveProperty('occurred_at')
  })

  it('hands back a refused tag or date as text naming the problem', async () => {
    const { gl } = client([
      { status: 400, body: { error: { code: 'invalid_tag', message: 'tags[0] "a!" has a character outside letters, digits, spaces and - _ . : / # @' } } },
      { status: 400, body: { error: { code: 'invalid_date', message: 'occurred_at: not a time' } } },
    ])
    expect(await runTool(gl, { name: 'save_memory', arguments: { fact: 'x', tags: ['a!'] } })).toBe(
      'The memory service refused this (invalid_tag): tags[0] "a!" has a character outside letters, digits, spaces and - _ . : / # @',
    )
    expect(await runTool(gl, { name: 'save_memory', arguments: { fact: 'x', occurred_at: 'last spring' } })).toBe(
      'The memory service refused this (invalid_date): occurred_at: not a time',
    )
  })
})

describe('runToolResult', () => {
  it('marks every failure, including missing input, as an error', async () => {
    const { gl } = client([{ status: 400, body: { error: { code: 'invalid_tag', message: 'tags[0] "a!" is not a tag' } } }])
    for (const call of [
      { name: 'recall_memory', arguments: {} },
      { name: 'save_memory', arguments: {} },
      { name: 'find_skill', arguments: {} },
      { name: 'no_such_tool', arguments: {} },
    ]) {
      expect((await runToolResult(gl, call)).isError, call.name).toBe(true)
    }
    expect(await runToolResult(gl, { name: 'save_memory', arguments: { fact: 'x', tags: ['a!'] } })).toEqual({
      text: 'The memory service refused this (invalid_tag): tags[0] "a!" is not a tag',
      isError: true,
    })
  })

  it('names the code of any other failure', async () => {
    const { gl } = client([
      { status: 429, body: { error: { code: 'rate_limited', message: 'slow down' } } },
      { status: 403, body: { message: 'Forbidden' } },
    ])
    expect(await runToolResult(gl, { name: 'recall_memory', arguments: { query: 'x' } })).toEqual({
      text: 'The memory service failed (rate_limited): slow down',
      isError: true,
    })
    expect(await runTool(gl, { name: 'recall_memory', arguments: { query: 'x' } })).toBe(
      'The memory service failed (unauthorized): The API key was not accepted (403 Forbidden) — check the API key (GITLOOM_API_KEY, or the key passed to the client), or whether it has been revoked.',
    )
  })

  it('is not an error when the call worked, even when nothing matched', async () => {
    const { gl } = client([empty, { status: 202, body: { id: 'j', namespace: 'default', status: 'accepted' } }])
    expect(await runToolResult(gl, { name: 'recall_memory', arguments: { query: 'x' } })).toEqual({
      text: 'Nothing relevant is stored about this user yet.',
      isError: false,
    })
    expect((await runToolResult(gl, { name: 'save_memory', arguments: { fact: 'Likes tea.' } })).isError).toBe(false)
  })
})

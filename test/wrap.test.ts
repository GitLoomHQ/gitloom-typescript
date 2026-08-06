/**
 * withMemory tests.
 *
 * The wrapper sits between an app and its model provider, so its failures are
 * the expensive kind: a leaked flag reaching OpenAI, memory from one user
 * appearing in another's conversation, or an outage in GitLoom taking the
 * caller's product down with it.
 */

import { describe, expect, it, vi } from 'vitest'
import { Gitloom, withMemory } from '../src'

const KEY = 'gl_test_abc_secret'

function memoryStub(hits: Array<{ path: string; snippet: string; score: number }> = []) {
  const saved: unknown[] = []
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/v1/memories')) {
      saved.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ id: 's1', namespace: 'default', status: 'queued' }))
    }
    return new Response(JSON.stringify({ namespace: 'default', hits, millis: 1 }))
  })
  const memory = new Gitloom({ apiKey: KEY, fetch: impl as unknown as typeof fetch, maxRetries: 0 })
  return { memory, saved, impl }
}

/** A stand-in for an OpenAI client, recording what it was actually asked. */
function fakeOpenAI() {
  const seen: any[] = []
  return {
    seen,
    chat: {
      completions: {
        create: vi.fn(async (params: any) => {
          seen.push(structuredClone(params))
          return { choices: [{ message: { role: 'assistant', content: 'ok' } }] }
        }),
      },
    },
    models: { list: vi.fn(async () => ['gpt-5']) },
    apiKey: 'sk-test',
  }
}

describe('withMemory', () => {
  it('never leaks its own options to the provider', async () => {
    const { memory } = memoryStub([{ path: 'a', snippet: 'lives in Lisbon', score: 1 }])
    const openai = fakeOpenAI()
    const wrapped = withMemory(openai as any, { memory })

    await wrapped.chat.completions.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'where do I live?' }],
      memory: false,
      namespace: 'u1-memory',
      user: 'u1',
    } as any)

    const sent = openai.seen[0]
    // A provider that receives an unknown field can reject the whole request.
    expect(sent).not.toHaveProperty('memory')
    expect(sent).not.toHaveProperty('namespace')
    expect(sent.user).toBe('u1')
  })

  it('keeps one user\'s memories out of another\'s conversation', async () => {
    const { memory, impl } = memoryStub([{ path: 'a', snippet: 'secret', score: 1 }])
    const openai = fakeOpenAI()
    const wrapped = withMemory(openai as any, { memory })

    await wrapped.chat.completions.create({
      model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], namespace: 'alice',
    } as any)
    await wrapped.chat.completions.create({
      model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], namespace: 'bob',
    } as any)

    const namespaces = impl.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/v1/retrieve'))
      .map((u) => new URL(u).searchParams.get('namespace'))
    expect(namespaces).toEqual(['alice', 'bob'])
  })

  it('does not mutate the caller\'s messages array', async () => {
    const { memory } = memoryStub([{ path: 'a', snippet: 'lives in Lisbon', score: 1 }])
    const openai = fakeOpenAI()
    const wrapped = withMemory(openai as any, { memory })

    const messages = [{ role: 'user' as const, content: 'where do I live?' }]
    const before = structuredClone(messages)
    await wrapped.chat.completions.create({ model: 'gpt-5', messages } as any)
    // A caller who reuses their array for a second provider would otherwise
    // find someone else's system message in it.
    expect(messages).toEqual(before)
  })

  it('answers normally when memory is unreachable', async () => {
    const failing = new Gitloom({
      apiKey: KEY,
      maxRetries: 0,
      fetch: (async () => {
        throw new TypeError('network down')
      }) as unknown as typeof fetch,
    })
    const openai = fakeOpenAI()
    const wrapped = withMemory(openai as any, { memory: failing })

    const res = await wrapped.chat.completions.create({
      model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }],
    } as any)
    expect(res.choices[0].message.content).toBe('ok')
    expect(openai.seen).toHaveLength(1)
  })

  it('leaves an unrelated method exactly as it was', async () => {
    const { memory } = memoryStub()
    const openai = fakeOpenAI()
    const wrapped = withMemory(openai as any, { memory })
    await expect(wrapped.models.list()).resolves.toEqual(['gpt-5'])
    expect(wrapped.apiKey).toBe('sk-test')
  })

  it('survives a provider that throws, without swallowing the error', async () => {
    const { memory } = memoryStub()
    const openai = fakeOpenAI()
    const boom = new Error('rate limited by openai')
    openai.chat.completions.create = vi.fn(async () => {
      throw boom
    }) as any
    const wrapped = withMemory(openai as any, { memory })
    await expect(
      wrapped.chat.completions.create({ model: 'gpt-5', messages: [] } as any),
    ).rejects.toBe(boom)
  })

  it('still saves the user\'s own statement when the model returns nothing', async () => {
    // A reply is not what makes a turn worth remembering — what the user said
    // about themselves is. Dropping the exchange because the provider returned
    // an empty choice would lose the fact.
    const { memory, saved } = memoryStub()
    const openai = fakeOpenAI()
    openai.chat.completions.create = vi.fn(async () => ({ choices: [] })) as any
    const wrapped = withMemory(openai as any, { memory, saveEveryTurns: 1 })
    await wrapped.chat.completions.create({
      model: 'gpt-5', messages: [{ role: 'user', content: 'I moved to Lisbon' }],
    } as any)
    expect(saved).toHaveLength(1)
    expect(JSON.stringify(saved[0])).toContain('Lisbon')
  })

  it('handles concurrent calls without crossing them', async () => {
    const { memory, impl } = memoryStub()
    const openai = fakeOpenAI()
    const wrapped = withMemory(openai as any, { memory })

    await Promise.all(
      ['alice', 'bob', 'carol'].map((ns) =>
        wrapped.chat.completions.create({
          model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], namespace: ns,
        } as any),
      ),
    )
    const namespaces = impl.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/v1/retrieve'))
      .map((u) => new URL(u).searchParams.get('namespace'))
      .sort()
    expect(namespaces).toEqual(['alice', 'bob', 'carol'])
  })
})

describe('drop-in conversation mode', () => {
  function convServer() {
    const stored: Array<{ role: string; content: string; seq: number }> = []
    let nextSeq = 0
    const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url))
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 })
      if (u.pathname === '/v1/conversations' && init?.method === 'POST')
        return json({ id: body.id, branch: 'main', next_seq: nextSeq })
      if (u.pathname.endsWith('/messages')) {
        for (const m of body.messages) stored.push({ ...m, seq: nextSeq++ })
        return json({ next_seq: nextSeq, written: body.messages.length })
      }
      if (u.pathname === '/v1/retrieve')
        return json({ namespace: 'ns', hits: [{ path: 'a.md', score: 1, snippet: 'likes Go' }], millis: 1 })
      // load
      return json({ id: body.id, branch: 'main', next_seq: nextSeq, messages: stored })
    })
    return { impl: impl as unknown as typeof fetch, stored }
  }

  it('the call site is the provider SDK, one field richer', async () => {
    const api = convServer()
    const memory = new Gitloom({ apiKey: 'gl_test_x', fetch: api.impl, maxRetries: 0 })
    const seen: Array<Record<string, unknown>> = []
    const fakeOpenAI = {
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            seen.push(body)
            return {
              choices: [{ message: { content: `reply ${seen.length}` } }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }
          },
        },
      },
    }
    const openai = withMemory(fakeOpenAI as never, { memory })

    // First exchange: dev passes ONLY the new message.
    await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'I like Go' }],
      conversation: 'conv-1',
    } as never)

    // Both turns stored without the dev appending anything.
    expect(api.stored.map((m) => m.role)).toEqual(['user', 'assistant'])

    // Second exchange: the wrapper supplies the earlier turns itself.
    await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'what do I like?' }],
      conversation: 'conv-1',
    } as never)

    const secondCall = seen[1]!
    const roles = (secondCall.messages as Array<{ role: string; content: string }>).map(
      (m) => `${m.role}:${m.content}`,
    )
    expect(roles).toContain('user:I like Go')
    expect(roles).toContain('assistant:reply 1')
    expect(roles.at(-1)).toBe('user:what do I like?')
    // The conversation field never reaches the provider.
    expect('conversation' in secondCall).toBe(false)
    // Memory context was injected as background.
    expect(roles.some((r) => r.includes('likes Go'))).toBe(true)
  })

  it('anthropic-shaped clients move system content to the system field', async () => {
    const api = convServer()
    const memory = new Gitloom({ apiKey: 'gl_test_x', fetch: api.impl, maxRetries: 0 })
    const seen: Array<Record<string, unknown>> = []
    const fakeAnthropic = {
      messages: {
        create: async (body: Record<string, unknown>) => {
          seen.push(body)
          return {
            content: [{ type: 'text', text: 'claude reply' }],
            usage: { input_tokens: 8, output_tokens: 4 },
          }
        },
      },
    }
    const anthropic = withMemory(fakeAnthropic as never, { memory })
    await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: 'hello' }],
      conversation: 'conv-2',
    } as never)

    const call = seen[0]!
    expect('conversation' in call).toBe(false)
    // Memory context landed in the system field, not the message array.
    expect(String(call.system ?? '')).toContain('likes Go')
    const roles = (call.messages as Array<{ role: string }>).map((m) => m.role)
    expect(roles.every((r) => r !== 'system')).toBe(true)
    expect(api.stored.map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})

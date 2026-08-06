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

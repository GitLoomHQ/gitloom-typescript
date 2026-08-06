import { describe, expect, it, vi } from 'vitest'
import { Gitloom } from '../src/client'
import { GitloomError } from '../src/errors'
import type { ChatMessage } from '../src/tokens'

const KEY = 'gl_test_abc_secret'
const long = (n: number) => 'word '.repeat(n)

/**
 * A fake API that keeps the server's invariants: sequences advance, messages
 * are never deleted, and a compaction is recorded rather than applied. A fake
 * that let a compaction destroy turns would make the rewind test pass for the
 * wrong reason.
 */
function fakeApi() {
  const messages: Array<ChatMessage & { seq: number; branch: string; parts?: unknown[] }> = []
  const uploads: Array<{ content_type: string; data: string }> = []
  let title = ''
  const compactions: Array<{ branch: string; summary: string; from_seq: number; to_seq: number }> = []
  const branches: Array<{ name: string; forked_from?: string; forked_at?: number }> = [{ name: 'main' }]
  let nextSeq = 0
  let active = 'main'
  const calls: string[] = []

  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const path = u.pathname
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push(`${init?.method ?? 'GET'} ${path}`)

    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 })

    if (path === '/v1/conversations' && init?.method === 'POST') {
      return json({ id: body.id, branch: 'main', next_seq: 0 })
    }
    if (path.endsWith('/messages')) {
      for (const m of body.messages) {
        messages.push({ ...m, seq: nextSeq++, branch: body.branch })
      }
      return json({ branch: body.branch, written: body.messages.length, next_seq: nextSeq })
    }
    if (path.endsWith('/compact')) {
      compactions.push({ branch: body.branch, summary: body.summary, from_seq: body.from_seq, to_seq: body.to_seq })
      return json({ branch: body.branch, compacted: true, queued: body.to_seq - body.from_seq + 1 })
    }
    if (path.endsWith('/rewind')) {
      const name = body.name ?? `main-${body.to}`
      branches.push({ name, forked_from: body.branch, forked_at: body.to })
      active = name
      return json({ branch: name, forked_from: body.branch, next_seq: body.to + 1 })
    }
    if (path.endsWith('/branches')) return json({ branches })
    if (path.endsWith('/ingest')) return json({ queued: 3 })
    if (path === '/v1/media' && init?.method === 'POST') {
      uploads.push(body)
      return json({ id: `med-${uploads.length}`, content_type: body.content_type, bytes: 42 })
    }
    if (path.endsWith('/edit') && init?.method === 'POST') {
      const name = body.name ?? `main-${body.seq}`
      branches.push({ name, forked_from: body.branch, forked_at: body.seq - 1 })
      active = name
      messages.push({ ...body.message, seq: body.seq, branch: name })
      nextSeq = Math.max(nextSeq, body.seq + 1)
      return json({ branch: name, forked_from: body.branch, forked_at: body.seq, next_seq: body.seq + 1 })
    }
    if (/\/messages\/\d+$/.test(path) && init?.method === 'PATCH') {
      const seq = Number(path.split('/').at(-1))
      const m = messages.find((x) => x.seq === seq && x.branch === (body.branch ?? active))
      if (m) m.content = body.content
      return json({ branch: body.branch, seq, updated: true })
    }
    if (/\/v1\/conversations\/[^/]+$/.test(path) && init?.method === 'PATCH') {
      title = body.title
      return json({ id: 'c1', title })
    }

    // load
    const full = u.searchParams.get('full') === '1'
    const branch = u.searchParams.get('branch') ?? active
    const at = u.searchParams.get('at')
    const last = full ? undefined : compactions.filter((c) => c.branch === branch).at(-1)
    let visible = messages.filter((m) => m.branch === branch || (branch !== 'main' && m.branch === 'main'))
    if (last) visible = visible.filter((m) => m.seq > last.to_seq)
    if (at !== null) visible = visible.filter((m) => m.seq <= Number(at))
    return json({
      id: 'c1',
      branch,
      title,
      next_seq: nextSeq,
      messages: visible,
      truncated: !!last,
      ...(last ? { compaction: last } : {}),
    })
  })

  return { impl: impl as unknown as typeof fetch, messages, compactions, calls, uploads, titleOf: () => title }
}

const client = (impl: typeof fetch) => new Gitloom({ apiKey: KEY, fetch: impl, maxRetries: 0 })

describe('conversation', () => {
  it('appends and hands the model something that fits', async () => {
    const api = fakeApi()
    const conv = await client(api.impl).conversations.create('c1', { model: 'gpt-4', maxTokens: 2000 })

    await conv.append({ role: 'user', content: 'hello' })
    await conv.append({ role: 'assistant', content: 'hi' })

    const out = conv.forModel()
    expect(out.map((m) => m.content)).toEqual(['hello', 'hi'])
  })

  it('refuses to guess a model rather than picking one', async () => {
    const api = fakeApi()
    const conv = await client(api.impl).conversations.create('c1')
    await conv.append({ role: 'user', content: 'hi' })
    expect(() => conv.forModel()).toThrow(GitloomError)
  })

  it('compacts before appending, so the new turn is never what gets summarized', async () => {
    const api = fakeApi()
    const summarize = vi.fn(async (msgs: ChatMessage[]) => `summary of ${msgs.length} turns`)
    const conv = await client(api.impl).conversations.create('c1', {
      model: 'gpt-4',
      maxTokens: 900,
      summarize,
    })

    // Sized to actually cross the compaction threshold — an earlier version
    // asserted on a compaction that never fired because the turns were tiny.
    for (let i = 0; i < 12; i++) {
      await conv.append({ role: 'user', content: `${i}: ${long(60)}` })
    }

    expect(summarize).toHaveBeenCalled()
    expect(api.compactions.length).toBeGreaterThan(0)

    // The most recent turn is still present in full — it was appended after
    // the compaction, not folded into it.
    const held = conv.messages()
    expect(held.at(-1)!.content).toContain('11:')
    // And a summary is carried at the front.
    expect(held[0]!.role).toBe('system')
    expect(held[0]!.content).toContain('summary of')
  })

  it('never lets the window overflow across a long conversation', async () => {
    const api = fakeApi()
    const conv = await client(api.impl).conversations.create('c1', {
      model: 'gpt-4',
      maxTokens: 1200,
      summarize: async (m) => `covered ${m.length}`,
    })
    for (let i = 0; i < 40; i++) {
      await conv.append({ role: 'user', content: `${i}: ${long(20)}` })
      // The guarantee, checked on every single turn rather than at the end.
      expect(() => conv.forModel()).not.toThrow()
    }
  })

  it('folds successive summaries together instead of stacking them', async () => {
    const api = fakeApi()
    const conv = await client(api.impl).conversations.create('c1', {
      model: 'gpt-4',
      maxTokens: 800,
      summarize: async () => 'S',
    })
    for (let i = 0; i < 30; i++) {
      await conv.append({ role: 'user', content: `${i}: ${long(20)}` })
    }
    // Twenty compactions must not mean twenty system messages — that is the
    // overflow this class exists to prevent.
    const systems = conv.messages().filter((m) => m.role === 'system')
    expect(systems.length).toBeLessThanOrEqual(1)
  })

  it('refuses to compact without a summarizer rather than dropping turns', async () => {
    const api = fakeApi()
    const conv = await client(api.impl).conversations.create('c1', { model: 'gpt-4', maxTokens: 500 })
    await conv.append({ role: 'user', content: long(200) })
    await expect(conv.compact()).rejects.toThrow(GitloomError)
  })

  it('rewinds past a compaction and still sees the original turns', async () => {
    const api = fakeApi()
    const conv = await client(api.impl).conversations.create('c1', {
      model: 'gpt-4',
      maxTokens: 900,
      summarize: async () => 'earlier stuff',
    })
    for (let i = 0; i < 15; i++) {
      await conv.append({ role: 'user', content: `${i}: ${long(60)}` })
    }
    expect(api.compactions.length).toBeGreaterThan(0)

    // Rewind to a point the compaction already covered.
    const covered = api.compactions[0]!.to_seq
    await conv.rewind(Math.max(0, covered - 1))

    // The turns the compaction summarized are readable again — nothing was
    // ever deleted, so this is an ordinary read rather than a recovery.
    const contents = conv.messages().map((m) => m.content ?? '')
    expect(contents.some((c) => c.startsWith('0:'))).toBe(true)
    expect(conv.branch).not.toBe('main')
  })

  it('keeps the original branch intact after a rewind', async () => {
    const api = fakeApi()
    const conv = await client(api.impl).conversations.create('c1', { model: 'gpt-4' })
    for (let i = 0; i < 5; i++) await conv.append({ role: 'user', content: `m${i}` })

    const before = api.messages.length
    await conv.rewind(2)
    expect(api.messages.length).toBe(before)
    expect(api.messages.filter((m) => m.branch === 'main')).toHaveLength(5)

    const branches = await conv.branches()
    expect(branches.length).toBe(2)
  })

  it('caches the fit so a turn-by-turn loop is not quadratic', async () => {
    const api = fakeApi()
    const counted = vi.fn((text: string) => Math.ceil(text.length / 4))
    const conv = await client(api.impl).conversations.create('c1', {
      model: 'gpt-4',
      maxTokens: 100000,
      countTokens: counted,
    })
    await conv.append({ role: 'user', content: 'hello' })

    conv.forModel()
    const afterFirst = counted.mock.calls.length
    conv.forModel()
    conv.forModel()
    // Repeated calls with unchanged history must not recount anything.
    expect(counted.mock.calls.length).toBe(afterFirst)

    // A new message invalidates it.
    await conv.append({ role: 'user', content: 'again' })
    conv.forModel()
    expect(counted.mock.calls.length).toBeGreaterThan(afterFirst)
  })

  it('resumes from the last compaction by default', async () => {
    const api = fakeApi()
    const gl = client(api.impl)
    const conv = await gl.conversations.create('c1', {
      model: 'gpt-4',
      maxTokens: 900,
      summarize: async () => 'the beginning',
    })
    for (let i = 0; i < 14; i++) {
      await conv.append({ role: 'user', content: `${i}: ${long(60)}` })
    }

    const reopened = await gl.conversations.load('c1', { model: 'gpt-4' })
    const held = reopened.messages()
    // The summary is replayed, and the turns it covers are not re-sent.
    expect(held[0]!.role).toBe('system')
    expect(held.length).toBeLessThan(14)
  })
})

describe('multimodal messages', () => {
  it('uploads data parts transparently and stores a reference', async () => {
    const api = fakeApi()
    const conv = await client(api.impl).conversations.create('c1', { model: 'gpt-4o' })

    await conv.append({
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', data: { base64: 'aGVsbG8=', media_type: 'image/png' } },
      ],
    })

    expect(api.uploads).toHaveLength(1)
    expect(api.uploads[0]?.content_type).toBe('image/png')
    const stored = api.messages[0] as { parts?: Array<Record<string, unknown>>; content?: unknown }
    // The stored part references the upload; the bytes never land in the row.
    expect(stored.parts?.[1]?.['media_id']).toBe('med-1')
    expect(stored.parts?.[1]?.['data']).toBeUndefined()
    // Flattened text travels alongside so ingestion needs no parser.
    expect(stored.content).toBe('look at this')
  })

  it('keeps the local copy bytes intact for the current model call', async () => {
    const api = fakeApi()
    const conv = await client(api.impl).conversations.create('c1', { model: 'gpt-4o' })
    const msg: ChatMessage = {
      role: 'user',
      content: [{ type: 'image', data: { base64: 'aGVsbG8=', media_type: 'image/png' } }],
    }
    await conv.append(msg)
    const held = conv.messages().at(-1)!
    expect(Array.isArray(held.content) && held.content[0]?.data?.base64).toBe('aGVsbG8=')
  })
})

describe('usage-driven compaction', () => {
  it('compacts on the exchange cadence even when tokens are plentiful', async () => {
    const api = fakeApi()
    const conv = await client(api.impl).conversations.create('c1', {
      model: 'claude-sonnet-5', // a million-token window: tokens never trigger
      compactEvery: 2,
      summarize: async () => 'earlier chat, summarized',
    })
    for (let i = 0; i < 3; i++) {
      await conv.append([
        { role: 'user', content: `question ${i}` },
        { role: 'assistant', content: `answer ${i}` },
      ])
    }
    expect(api.compactions.length).toBeGreaterThanOrEqual(1)
  })

  it('uses reported provider usage instead of estimating', async () => {
    const api = fakeApi()
    const conv = await client(api.impl).conversations.create('c1', {
      model: 'gpt-4o',
      maxTokens: 10_000,
      compactAt: 0.5,
      compactEvery: 0, // cadence off: only tokens can trigger
      summarize: async () => 'summary',
    })
    await conv.append([
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'also short' },
    ])
    expect(api.compactions).toHaveLength(0)

    // The provider reports the conversation is far bigger than it looks —
    // tool outputs, images — and the SDK believes the provider.
    await conv.append(
      [{ role: 'user', content: 'tiny' }],
      { usage: { prompt_tokens: 9_000, completion_tokens: 500 } },
    )
    await conv.append([{ role: 'assistant', content: 'reply' }])
    expect(api.compactions.length).toBeGreaterThanOrEqual(1)
  })
})

describe('edits', () => {
  it('edit forks a branch with the replacement at the same seq', async () => {
    const api = fakeApi()
    const conv = await client(api.impl).conversations.create('c1', { model: 'gpt-4o' })
    await conv.append([
      { role: 'user', content: 'original' },
      { role: 'assistant', content: 'reply to original' },
    ])
    await conv.edit(0, { role: 'user', content: 'edited' })

    expect(conv.branch).not.toBe('main')
    const original = api.messages.find((m) => m.branch === 'main' && m.seq === 0)
    expect(original?.content).toBe('original')
    const replacement = api.messages.find((m) => m.branch === conv.branch && m.seq === 0)
    expect(replacement?.content).toBe('edited')
  })

  it('editInPlace rewrites without forking', async () => {
    const api = fakeApi()
    const conv = await client(api.impl).conversations.create('c1', { model: 'gpt-4o' })
    await conv.append([{ role: 'user', content: 'my key is sk-123' }])
    await conv.editInPlace(0, { content: 'my key is [redacted]' })

    expect(conv.branch).toBe('main')
    expect(api.messages[0]?.content).toBe('my key is [redacted]')
    expect(conv.messages()[0]?.content).toBe('my key is [redacted]')
  })
})

describe('titles', () => {
  it('setTitle stores and load reads it back', async () => {
    const api = fakeApi()
    const conv = await client(api.impl).conversations.create('c1', { model: 'gpt-4o' })
    await conv.setTitle('Camera shopping')
    expect(api.titleOf()).toBe('Camera shopping')
    const again = await client(api.impl).conversations.load('c1')
    expect(again.title).toBe('Camera shopping')
  })
})

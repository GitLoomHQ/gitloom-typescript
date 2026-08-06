import { describe, expect, it } from 'vitest'
import { GitloomError } from '../src/errors'
import { assertFits, fit } from '../src/context'
import { contextLimit, estimateTokens, totalTokens, type ChatMessage } from '../src/tokens'

const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content })
const long = (n: number) => 'word '.repeat(n)

describe('token estimation', () => {
  it('never undercounts prose, which is the only unsafe direction', () => {
    // A real tokenizer puts English prose near 4 chars/token. The estimator
    // must land at or above that count, never below.
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(50)
    const naive = Math.ceil(text.length / 4)
    expect(estimateTokens(text, 'gpt-5')).toBeGreaterThanOrEqual(naive)
  })

  it('counts dense punctuation more heavily than prose', () => {
    const prose = 'a'.repeat(400)
    const dense = '{"a":1},'.repeat(50)
    expect(estimateTokens(dense, 'gpt-5') / dense.length).toBeGreaterThan(
      estimateTokens(prose, 'gpt-5') / prose.length,
    )
  })

  it('resolves model limits by longest prefix', () => {
    expect(contextLimit('gpt-4o-mini')).toBe(128_000)
    expect(contextLimit('claude-haiku-4-5-20251001')).toBe(200_000)
    expect(contextLimit('claude-opus-5')).toBe(1_000_000)
    expect(contextLimit('something-unheard-of', 4096)).toBe(4096)
  })
})

describe('fit', () => {
  it('keeps the newest messages and evicts the oldest', () => {
    const messages = Array.from({ length: 40 }, (_, i) => msg('user', `${i}: ${long(40)}`))
    const out = fit(messages, { model: 'gpt-4', maxTokens: 800 })

    expect(out.messages.length).toBeGreaterThan(0)
    expect(out.evicted.length).toBeGreaterThan(0)
    expect(out.messages.length + out.evicted.length).toBe(messages.length)
    // The last message must always survive: it is what the model is answering.
    expect(out.messages.at(-1)).toBe(messages.at(-1))
    // Eviction is oldest-first and contiguous.
    expect(out.evicted[0]).toBe(messages[0])
  })

  it('never exceeds the budget it reports', () => {
    for (const budget of [500, 1200, 5000]) {
      const messages = Array.from({ length: 60 }, (_, i) => msg('user', `${i}: ${long(30)}`))
      const out = fit(messages, { model: 'gpt-4', maxTokens: budget })
      expect(out.tokens).toBeLessThanOrEqual(out.budget)
      expect(totalTokens(out.messages, 'gpt-4')).toBeLessThanOrEqual(out.budget)
    }
  })

  it('always keeps system messages, wherever they sit', () => {
    const messages: ChatMessage[] = [
      msg('system', 'You are terse.'),
      ...Array.from({ length: 30 }, (_, i) => msg('user', `${i}: ${long(40)}`)),
    ]
    const out = fit(messages, { model: 'gpt-4', maxTokens: 700 })
    expect(out.messages[0]!.role).toBe('system')
    expect(out.evicted.some((m) => m.role === 'system')).toBe(false)
  })

  it('never splits a tool call from its result', () => {
    // A tool result whose call was evicted refers to something absent, which
    // providers reject outright.
    const messages: ChatMessage[] = [
      ...Array.from({ length: 20 }, (_, i) => msg('user', `${i}: ${long(30)}`)),
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', function: { name: 'search', arguments: '{"q":"x"}' } }],
      },
      { role: 'tool', content: 'result', tool_call_id: 'call_1' },
      msg('assistant', 'Done.'),
    ]
    for (const budget of [300, 500, 900, 1500]) {
      let out
      try {
        out = fit(messages, { model: 'gpt-4', maxTokens: budget })
      } catch (e) {
        expect(e).toBeInstanceOf(GitloomError)
        continue
      }
      const kept = out.messages
      for (const m of kept) {
        if (m.role !== 'tool') continue
        const call = kept.find((k) => k.tool_calls?.some((c) => c.id === m.tool_call_id))
        expect(call, `orphaned tool result at budget ${budget}`).toBeDefined()
      }
    }
  })

  it('throws rather than returning an incoherent stub', () => {
    const messages = [msg('user', long(5000))]
    expect(() => fit(messages, { model: 'gpt-4', maxTokens: 100 })).toThrow(GitloomError)
  })

  it('says so when the system prompt alone will not fit', () => {
    const messages = [msg('system', long(5000)), msg('user', 'hi')]
    try {
      fit(messages, { model: 'gpt-4', maxTokens: 200 })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitloomError).code).toBe('context_system_too_large')
    }
  })

  it('subtracts the reply reservation from the input budget', () => {
    // Sized so the reservation actually forces eviction — otherwise the test
    // passes on messages that fit either way and proves nothing.
    const messages = Array.from({ length: 30 }, (_, i) => msg('user', `${i}: ${long(20)}`))
    const plain = fit(messages, { model: 'gpt-4', maxTokens: 1400 })
    const reserved = fit(messages, { model: 'gpt-4', maxTokens: 1400, reserveForReply: 900 })
    expect(reserved.budget).toBe(plain.budget - 900)
    expect(reserved.messages.length).toBeLessThan(plain.messages.length)
    expect(reserved.evicted.length).toBeGreaterThan(0)
  })

  it('applies a safety margin below the model limit by default', () => {
    const out = fit([msg('user', 'hi')], { model: 'gpt-4' })
    expect(out.budget).toBeLessThan(contextLimit('gpt-4'))
  })
})

describe('assertFits', () => {
  it('turns a provider 400 into an error raised before the request', () => {
    const messages = Array.from({ length: 200 }, (_, i) => msg('user', `${i}: ${long(50)}`))
    expect(() => assertFits(messages, { model: 'gpt-4' })).toThrow(GitloomError)
  })

  it('returns the count when the history fits', () => {
    expect(assertFits([msg('user', 'hello')], { model: 'gpt-5' })).toBeGreaterThan(0)
  })
})

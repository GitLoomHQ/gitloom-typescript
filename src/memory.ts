/**
 * Vocabulary and skills: the two kinds of knowledge a namespace holds beside
 * its memories. Reached through `gitloom.vocab` and `gitloom.skills`.
 */

import type { Gitloom } from './client'
import type { Skill, SkillInput, SkillQueryOptions, VocabTerm } from './types'

export interface VocabOptions {
  namespace?: string | undefined
  signal?: AbortSignal | undefined
}

/** A namespace's custom vocabulary: the terms and abbreviations it has learned. */
export class Vocab {
  constructor(private readonly client: Gitloom) {}

  /**
   * Teach terms. Once learned, a recall for any surface form of a term also
   * matches memories written with another (`k8s` finds `kubernetes`), and the
   * definition comes back as `defined` on every recall that mentions it.
   *
   * Asynchronous like every write: the terms are queued and land in seconds.
   */
  async learn(
    terms: VocabTerm[],
    options: VocabOptions = {},
  ): Promise<{ id: string; namespace: string; status: 'accepted' }> {
    return this.client.request(
      'POST',
      '/v1/vocab',
      {
        namespace: options.namespace ?? this.client.namespace,
        terms: terms.map((t) => ({ term: t.term, aliases: t.aliases ?? [], definition: t.definition })),
      },
      { signal: options.signal },
    )
  }

  /** Every learned term, alphabetically, optionally filtered by a substring. */
  async list(options: VocabOptions & { like?: string; limit?: number } = {}): Promise<VocabTerm[]> {
    const params = new URLSearchParams({ namespace: options.namespace ?? this.client.namespace })
    if (options.like) params.set('like', options.like)
    if (options.limit) params.set('limit', String(options.limit))
    const res = await this.client.request<{ terms?: VocabTerm[] }>(
      'GET',
      `/v1/vocab?${params.toString()}`,
      undefined,
      { signal: options.signal },
    )
    return res.terms ?? []
  }

  /** Resolve any surface form to its term, or null when the word is unknown. */
  async lookup(word: string, options: VocabOptions = {}): Promise<VocabTerm | null> {
    const params = new URLSearchParams({ namespace: options.namespace ?? this.client.namespace, word })
    const res = await this.client.request<{ found: boolean; term?: VocabTerm }>(
      'GET',
      `/v1/vocab?${params.toString()}`,
      undefined,
      { signal: options.signal },
    )
    return res.found && res.term ? res.term : null
  }

  /** Forget terms by their canonical form. Asynchronous. */
  async forget(
    terms: string[],
    options: VocabOptions = {},
  ): Promise<{ id: string; namespace: string; status: 'accepted' }> {
    const params = new URLSearchParams({
      namespace: options.namespace ?? this.client.namespace,
      term: terms.join(','),
    })
    return this.client.request('DELETE', `/v1/vocab?${params.toString()}`, undefined, {
      signal: options.signal,
    })
  }
}

/** Procedural know-how: how to do things, stored under the skills tier. */
export class Skills {
  constructor(private readonly client: Gitloom) {}

  /**
   * Store skills. Each becomes a memory at `skills/<topic>/<slug>.md`, found
   * later by `find` from its triggers, name and description. Asynchronous.
   */
  async store(
    skills: SkillInput[],
    options: VocabOptions = {},
  ): Promise<{ id: string; namespace: string; status: 'accepted'; paths: string[] }> {
    return this.client.request(
      'POST',
      '/v1/skills',
      { namespace: options.namespace ?? this.client.namespace, skills },
      { signal: options.signal },
    )
  }

  /** The skills that bear on a task, best first. */
  async find(task: string, options: SkillQueryOptions = {}): Promise<Skill[]> {
    return this.query(task, options)
  }

  /** Every skill, most recently updated first. */
  async list(options: SkillQueryOptions = {}): Promise<Skill[]> {
    return this.query('', options)
  }

  private async query(q: string, options: SkillQueryOptions): Promise<Skill[]> {
    const params = new URLSearchParams({ namespace: options.namespace ?? this.client.namespace })
    if (q) params.set('q', q)
    if (options.limit) params.set('limit', String(options.limit))
    if (options.paths?.length) params.set('paths', options.paths.join(','))
    if (options.tags?.length) params.set('tags', options.tags.join(','))
    const res = await this.client.request<{ skills?: Skill[] }>(
      'GET',
      `/v1/skills?${params.toString()}`,
      undefined,
      { signal: options.signal },
    )
    return res.skills ?? []
  }
}

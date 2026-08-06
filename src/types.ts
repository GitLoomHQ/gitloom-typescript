export interface Memory {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface RememberOptions {
  namespace?: string | undefined
  /** Abandon the request. An agent that drops a turn should drop its calls too. */
  signal?: AbortSignal | undefined
  /**
   * Retry this write if the server fails.
   *
   * Off by default. A 5xx can mean the server accepted the write and then
   * failed to say so, and repeating it would store the memory twice and spend
   * the quota twice. Turn it on only where a duplicate is cheaper than a loss.
   */
  retryOnServerError?: boolean | undefined
  /** Your id for the conversation. Useful for tracing a write back to its source. */
  sessionId?: string | undefined
  /**
   * The date the conversation HAPPENED (YYYY-MM-DD), which is what the memories
   * are dated by. Leave unset for now; set it when backfilling, or last year's
   * transcripts all claim to have happened today.
   */
  date?: string | undefined
}

export interface RememberResult {
  id: string
  namespace: string
  /** Accepted, not stored. Extraction runs a model and takes seconds. */
  status: 'accepted'
}

export interface RecallOptions {
  namespace?: string | undefined
  limit?: number | undefined
  /** Abandon the request. An agent that drops a turn should drop its calls too. */
  signal?: AbortSignal | undefined
}

/** Why a hit surfaced: the fused rank broken into its retrieval arms. */
export interface HitScores {
  bm25?: number
  cue?: number
  body?: number
  graph_hops?: number
  arms?: string[]
}

export interface Revision {
  commit: string
  author?: string
  when: string
  message?: string
}

/** The memory's git history: who wrote it, when, and what the last change replaced. */
export interface Provenance {
  commit: string
  author?: string
  when: string
  message?: string
  revisions?: number
  history?: Revision[]
  /** The last change as a unified diff — which lines arrived, which they displaced. */
  diff?: string
}

/** One outgoing edge, with enough of the neighbour to decide whether to follow it. */
export interface Relation {
  label?: string
  path: string
  snippet?: string
  valid_from?: number
  valid_to?: number
}

/** A custom-vocabulary term the query matched. */
export interface VocabHit {
  path: string
  term: string
  definition?: string
  matched?: string[]
}

export interface RecalledMemory {
  id: string
  text: string
  /** Relative rank within this result set. Not comparable across queries. */
  score: number
  /** Per-arm scores, provenance and relations arrive whenever the server has
   * them. Optional because a hit is still an answer without its citations. */
  scores?: HitScores | undefined
  provenance?: Provenance | undefined
  relations?: Relation[] | undefined
}

export interface RecallResult {
  namespace: string
  memories: RecalledMemory[]
  /** Query terms that matched the namespace's custom vocabulary. */
  defined?: VocabHit[] | undefined
  millis: number
}

export interface KeyInfo {
  id: string
  env: string
  name: string
  revoked: boolean
  created_at: string
}

export interface CreateKeyResult {
  id: string
  env: string
  name: string
  /** The only time the secret exists outside your process. Store it now. */
  key: string
}

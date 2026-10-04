export interface Memory {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/**
 * A time as the API reads it. A `Date` is sent as epoch seconds, a number is
 * epoch seconds, and a string is sent as is: RFC 3339 with an offset, a date
 * (`YYYY-MM-DD`, that calendar day), or a datetime without an offset, read in
 * the request's timezone.
 */
export type TimeInput = Date | number | string

export interface WriteOptions {
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
  /** IANA zone, e.g. `Asia/Kolkata`, that a datetime without an offset is read in. */
  timezone?: string | undefined
}

export type ForgetOptions = Omit<WriteOptions, 'timezone'>

export interface RememberOptions extends WriteOptions {
  /** Your id for the conversation. Useful for tracing a write back to its source. */
  sessionId?: string | undefined
  /** Tags every memory drawn from the conversation carries. */
  tags?: string[] | undefined
  /**
   * When the conversation HAPPENED, which is what its memories are dated by.
   * Leave unset for now; set it when backfilling, or last year's transcripts
   * all claim to have happened today.
   */
  occurredAt?: TimeInput | undefined
  /** @deprecated Use `occurredAt`. */
  date?: string | undefined
}

/** One already-formed memory to store: the input to `write`, as `RecalledMemory` is the output of `recall`. */
export interface NewMemory {
  /**
   * Repo-relative, ending in `.md`, under facts/, incidents/, rules/ or
   * skills/. The directory is the topic: `facts/people/maya.md`.
   */
  path: string
  /** Markdown. Its `##` headers become separately addressable sections. */
  content: string
  tags?: string[] | undefined
  /** When what the memory is ABOUT happened, not when it was written. */
  occurredAt?: TimeInput | undefined
  /** @deprecated Use `occurredAt`. */
  date?: string | undefined
  /** In [0, 1]. Breaks ties between memories that contradict each other. */
  confidence?: number | undefined
  /** Expires an incident, e.g. `30d`. Only meaningful under incidents/. */
  ttl?: string | undefined
  /** A memory this one replaces, so the update wins over what it contradicts. */
  supersedes?: string | undefined
  /** 2–5 short phrasings of how someone would later ASK for this. */
  cues?: string[] | undefined
  /** Paths of related memories, optionally labelled: `spouse: facts/people/maya.md`. */
  related?: string[] | undefined
}

/** One memory read back by path. */
export interface StoredMemory {
  namespace: string
  path: string
  title?: string
  tier?: string
  kind?: string
  content: string
  tags?: string[]
  confidence?: number
  cues?: string[]
  related?: string[]
  created?: string
  updated?: string
}

/** One level of the hierarchical table of contents. */
export interface TreeNode {
  path: string
  title?: string
  kind?: string
  tier?: string
  summary?: string
  children?: TreeNode[]
}

export interface TreeOptions {
  namespace?: string | undefined
  /** Roots the tree; unset is the whole memory. */
  path?: string | undefined
  /** How far down to descend. Default 2, maximum 8. */
  depth?: number | undefined
  signal?: AbortSignal | undefined
}

export interface TreeResult {
  namespace: string
  depth: number
  tree: TreeNode
  millis: number
}

/** One directory in the memory, with how many memories it holds. */
export interface Topic {
  path: string
  name: string
  tier: string
  parent: string
  depth: number
  memories: number
}

export interface TopicsOptions {
  namespace?: string | undefined
  tier?: Tier | undefined
  /** Only topics under this path. */
  prefix?: string | undefined
  /** Case-insensitive substring on the leaf name. */
  like?: string | undefined
  maxDepth?: number | undefined
  minFiles?: number | undefined
  limit?: number | undefined
  signal?: AbortSignal | undefined
}

export interface TopicsResult {
  namespace: string
  topics: Topic[]
  millis: number
}

/** One memory in the relationship graph. */
export interface GraphNode {
  path: string
  tier: string
  kind: string
  title?: string
}

/** One declared relationship between two memories. */
export interface GraphEdge {
  src: string
  dst: string
  label?: string
  origin?: string
}

export interface GraphOptions {
  namespace?: string | undefined
  limit?: number | undefined
  signal?: AbortSignal | undefined
}

export interface GraphResult {
  namespace: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** The graph was larger than one response, so the picture is partial. */
  truncated: boolean
  millis: number
}

export interface RememberResult {
  id: string
  namespace: string
  /** Accepted, not stored. Extraction runs a model and takes seconds. */
  status: 'accepted'
}

/** The four top-level directories a memory can live under. */
export type Tier = 'facts' | 'incidents' | 'rules' | 'skills'

/**
 * How a recall answers.
 *
 * - `raw`: ranked memories, no model call. Milliseconds.
 * - `summary`: the same memories, plus one text answer written by a fast model.
 * - `agentic`: a stronger model searches the memory itself with tools and
 *   answers when it has enough. Seconds, and metered as a chat.
 */
export type RecallMode = 'raw' | 'summary' | 'agentic'

export interface RecallFilters {
  /** Only these tiers. */
  tiers?: Tier[] | undefined
  /** Only memories under these directories, e.g. `['facts/events', 'incidents']`. */
  paths?: string[] | undefined
  /** Only memories carrying any of these tags. */
  tags?: string[] | undefined
  /** Only memories carrying every one of these tags. */
  tagsAll?: string[] | undefined
  /** Only memories whose `timeField` is at or after this. */
  since?: TimeInput | undefined
  /** Only memories whose `timeField` is at or before this. A date alone includes that whole day. */
  until?: TimeInput | undefined
  /** Which time `since` and `until` bound. Default `updated`. */
  timeField?: TimeField | undefined
  /** IANA zone a date or datetime without an offset is read in. Default UTC. */
  tz?: string | undefined
  /** Include TTL-expired incidents. Default false. */
  includeExpired?: boolean | undefined
}

/** When its subject happened, when it was written, or when it last changed. */
export type TimeField = 'occurred' | 'created' | 'updated'

/** How a memory's `occurredAt` is known: you said, the memory names the day, its conversation's date, or when it was written. */
export type OccurredSource = 'user' | 'extracted' | 'said' | 'written'

/** `day` when only the date is known, held as noon UTC on that date; otherwise `instant`. */
export type OccurredPrecision = 'day' | 'instant'

/** How the lane path orders what it finds: by lane score, or with a ranking model. */
export type RecallRank = 'fused' | 'jev'

/** A model that can read the memories in `summary` or `agentic` mode. */
export type ReaderModel = 'haiku' | 'sonnet'

export interface RecallOptions extends RecallFilters {
  namespace?: string | undefined
  limit?: number | undefined
  mode?: RecallMode | undefined
  /** Drop memories scoring below this, in [0, 1]. */
  minScore?: number | undefined
  /**
   * Whether graph neighbours ride along as context, ranked under the memories
   * that matched. Default true.
   */
  context?: boolean | undefined
  /** `full` adds each memory's recent history, last diff, relation snippets and cues. */
  detail?: 'compact' | 'full' | undefined
  /**
   * Retrieve on the lane path, which also reaches conversation turns and the
   * dates in a question, ordering what it finds by lane score (`fused`) or with
   * a ranking model (`jev`). Not with `mode: 'agentic'`.
   */
  rank?: RecallRank | undefined
  /** The most characters of memory content to return; memories that do not fit come back `excerpted`. */
  maxChars?: number | undefined
  /** The model that reads the memories in `summary` or `agentic` mode. */
  model?: ReaderModel | undefined
  /** Abandon the request. An agent that drops a turn should drop its calls too. */
  signal?: AbortSignal | undefined
}

/** Why a memory surfaced: its raw per-arm scores. */
export interface HitScores {
  bm25?: number
  cue?: number
  body?: number
  graph_hops?: number
  /** Fraction of the query's content terms present in the memory. */
  coverage?: number
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

/** One recalled memory: the whole memory, with everything needed to cite it. */
export interface RecalledMemory {
  path: string
  tier: string
  topic?: string
  title?: string
  /** The whole memory body. */
  content: string
  /** A query-focused excerpt, when the lexical arm matched. */
  snippet?: string
  /**
   * Calibrated relevance in [0, 1], comparable across queries. A memory that
   * matches the question outright scores near 1; a graph neighbour a fraction
   * of what pulled it in.
   */
  score: number
  /** Which arms produced it: lexical, cue, body, graph; on the lane path, also time. */
  matched: string[]
  /** `content` was cut to fit `maxChars`. */
  excerpted?: boolean
  /** Lane path: a curated `memory`, or a conversation `turn` kept word for word. */
  store?: 'memory' | 'turn'
  /** Lane path: the days it was stated, oldest first. */
  said?: string[]
  /** Section slugs that matched, when the match was narrower than the file. */
  sections?: string[]
  /** For a graph neighbour, the memories it was reached from. */
  via?: string[]
  /** Your tags first, then the ones GitLoom inferred. */
  tags?: string[]
  /** Your tags alone. */
  userTags?: string[]
  createdAt?: Date
  updatedAt?: Date
  /** When the memory's subject happened. */
  occurredAt?: Date
  occurredSource?: OccurredSource
  /** At `day`, `occurredAt` is noon UTC on the date: show it as a date. */
  occurredPrecision?: OccurredPrecision
  /** When a memory with a TTL expires. */
  expiresAt?: Date
  /** @deprecated Use `createdAt`. */
  created?: string
  /** @deprecated Use `updatedAt`. */
  updated?: string
  confidence?: number
  cues?: string[]
  scores?: HitScores | undefined
  related?: Relation[] | undefined
  provenance?: Provenance | undefined
}

/** One step of an agentic recall's trace. */
export interface TraceEvent {
  type: 'tool_use' | 'tool_result' | 'text'
  tool?: string
  id?: string
  input?: unknown
  result?: unknown
  text?: string
  millis?: number
}

export interface RecallTimings {
  lexical_ms: number
  vector_ms: number
  graph_ms: number
  model_ms?: number
  /** Lane path: the query embedding, every lane, the ranking call, and each lane on each store. */
  embed_ms?: number
  lanes_ms?: number
  rank_ms?: number
  lane?: LaneTiming[]
}

export interface LaneTiming {
  lane: string
  store: 'memory' | 'turn'
  ms: number
  n: number
  err?: string
}

export interface RecallResult {
  namespace: string
  /** Empty when the filters listed memories without a question. */
  query: string
  mode: RecallMode
  /** Ranked memories, best first. Empty rather than absent when nothing matched. */
  memories: RecalledMemory[]
  /** Query terms that matched the namespace's custom vocabulary. */
  defined?: VocabHit[] | undefined
  /** The model's text, in `summary` and `agentic` modes. */
  answer?: string | undefined
  model?: string | undefined
  trace?: TraceEvent[] | undefined
  /** The agent ran out of budget before choosing to stop. */
  truncated?: boolean | undefined
  /** The lane ranking asked for. */
  rank?: RecallRank | undefined
  /** `rank: 'jev'` could not rank, so the memories are in lane order. */
  rankFallback?: boolean | undefined
  /** Distinct memories any arm produced before the relevance floor. */
  candidates: number
  /** Candidates the relevance floor dropped. Many with no memories means an unanswerable question. */
  filteredOut: number
  millis: number
  timings: RecallTimings
}

export interface ContextOptions extends RecallOptions {
  /** The line above the memories. Defaults to framing them as background. */
  header?: string | undefined
}

export interface AnswerOptions extends Omit<RecallOptions, 'mode'> {
  /** Let a tool-using model search the memory itself instead of summarizing one retrieval. */
  agentic?: boolean | undefined
}

export interface AnswerResult {
  answer: string
  model?: string | undefined
  memories: RecalledMemory[]
  trace?: TraceEvent[] | undefined
  truncated?: boolean | undefined
  millis: number
}

/** A learned term: its canonical form, the surface forms that mean the same, and what it means. */
export interface VocabTerm {
  term: string
  aliases?: string[] | undefined
  definition?: string | undefined
  path?: string | undefined
}

/** A skill as you store it. */
export interface SkillInput {
  name: string
  description?: string | undefined
  /** The procedure itself, as markdown. `##` headings become sections. */
  content?: string | undefined
  /** Files the skill under `skills/<topic>/`. */
  topic?: string | undefined
  /** Overrides the location entirely; must stay under `skills/`. */
  path?: string | undefined
  tags?: string[] | undefined
  /** How someone would ask for this skill. Defaults to the name and description. */
  triggers?: string[] | undefined
  confidence?: number | undefined
  date?: string | undefined
}

/** A skill as it comes back. */
export interface Skill {
  path: string
  topic?: string
  name: string
  description?: string
  content: string
  tags?: string[]
  triggers?: string[]
  score?: number
  matched?: string[]
  created?: string
  updated?: string
}

export interface SkillQueryOptions {
  namespace?: string | undefined
  limit?: number | undefined
  /** Only skills under these topics, e.g. `['ops']`. */
  paths?: string[] | undefined
  tags?: string[] | undefined
  signal?: AbortSignal | undefined
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

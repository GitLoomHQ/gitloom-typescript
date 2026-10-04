/**
 * Tool definitions, so an agent can decide for itself when to remember and when
 * to recall.
 *
 * OpenAI and Anthropic describe tools differently — OpenAI nests the schema
 * under `function`, Anthropic puts it in `input_schema` — so both shapes are
 * exported rather than one plus a note in the docs telling you to reshape it.
 */

import type { Gitloom } from './client'
import { GitloomError } from './errors'
import type { RecallRank, RecalledMemory, Tier, TimeField } from './types'

const RECALL_DESCRIPTION =
  'Search what you already know about this user from earlier conversations. ' +
  'Call this before answering anything that depends on their history, preferences, ' +
  'possessions, plans or past decisions — not just when they explicitly ask you to remember.'

const REMEMBER_DESCRIPTION =
  'Save something worth knowing about this user for later conversations. ' +
  'Call this when they state a durable fact about themselves: a preference, a decision, ' +
  'a possession, a plan, a relationship. Do not save small talk or anything you inferred.'

const FIND_SKILL_DESCRIPTION =
  'Look up how to do something the user has taught you before: a procedure, a checklist, ' +
  'a way of working. Call this before carrying out a multi-step task, so you follow their ' +
  'way of doing it rather than inventing one.'

const recallParameters = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'What you want to know, phrased as a question in the user\'s own terms. Leave it out only ' +
        'when tags, since, until, tiers or paths are given, to list everything they match, newest first.',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional: only memories carrying any of these tags.',
    },
    since: {
      type: 'string',
      description: 'Optional: only memories from this time on. A date YYYY-MM-DD or an RFC 3339 time.',
    },
    until: {
      type: 'string',
      description:
        'Optional: only memories up to this time. A date YYYY-MM-DD, which includes that whole day, ' +
        'or an RFC 3339 time.',
    },
    time_field: {
      type: 'string',
      enum: ['occurred', 'created', 'updated'],
      description:
        'Optional: which time since and until bound. occurred (the default) is when the thing ' +
        'happened; created and updated are when the memory was written or last changed.',
    },
    tiers: {
      type: 'array',
      items: { type: 'string', enum: ['facts', 'incidents', 'rules', 'skills'] },
      description:
        'Optional: only these kinds of memory. facts are stable knowledge, incidents dated events, ' +
        'rules standing instructions, skills procedures.',
    },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional: only memories under these directories, e.g. "facts/events".',
    },
  },
  additionalProperties: false,
} as const

const findSkillParameters = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description: 'The task you are about to do, in a few words.',
    },
  },
  required: ['task'],
  additionalProperties: false,
} as const

const rememberParameters = {
  type: 'object',
  properties: {
    fact: {
      type: 'string',
      description:
        'The thing to remember, as one self-contained sentence including any specifics ' +
        '(names, numbers, dates). It will be read months later with no surrounding conversation.',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional: short labels to file it under, such as a project or a person. Lowercased; ' +
        'letters, digits, spaces and - _ . : / # @ only.',
    },
    occurred_at: {
      type: 'string',
      description:
        'When what this fact describes happened, if the user said: a date YYYY-MM-DD or an ' +
        'RFC 3339 time. Leave it out for timeless facts.',
    },
  },
  required: ['fact'],
  additionalProperties: false,
} as const

/**
 * Tool definitions in MCP's format.
 *
 * A fourth shape rather than a fourth copy: the descriptions and schemas above
 * are the single source, and every host — OpenAI, Anthropic, MCP — gets the
 * same wording. A tool described one way to Claude Code and another way through
 * the SDK would behave differently for no reason anyone could see.
 */
// openWorldHint is true on all three: every one reaches a hosted namespace
// rather than anything in the caller's environment. destructiveHint is false on
// save_memory even though ingestion reconciles a memory that restates an
// existing one — the rewrite is a commit, so the previous version stays
// readable in the memory's history.
export const mcpTools = [
  {
    name: 'recall_memory',
    description: RECALL_DESCRIPTION,
    inputSchema: recallParameters,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'save_memory',
    description: REMEMBER_DESCRIPTION,
    inputSchema: rememberParameters,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'find_skill',
    description: FIND_SKILL_DESCRIPTION,
    inputSchema: findSkillParameters,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
] as const

/** Tool definitions in OpenAI's function-calling format. */
export const openaiTools = [
  {
    type: 'function' as const,
    function: {
      name: 'recall_memory',
      description: RECALL_DESCRIPTION,
      parameters: recallParameters,
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'save_memory',
      description: REMEMBER_DESCRIPTION,
      parameters: rememberParameters,
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_skill',
      description: FIND_SKILL_DESCRIPTION,
      parameters: findSkillParameters,
    },
  },
]

/** The same tools in Anthropic's format. */
export const anthropicTools = [
  { name: 'recall_memory', description: RECALL_DESCRIPTION, input_schema: recallParameters },
  { name: 'save_memory', description: REMEMBER_DESCRIPTION, input_schema: rememberParameters },
  { name: 'find_skill', description: FIND_SKILL_DESCRIPTION, input_schema: findSkillParameters },
]

export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

/**
 * Runs a tool call the model made and returns the string to hand back.
 *
 * Errors are returned as text rather than thrown: a failed tool call is
 * information the model can act on ("I could not reach your memory"), whereas an
 * exception ends the agent's turn and loses the conversation.
 */
export async function runTool(
  client: Gitloom,
  call: ToolCall,
  options: {
    namespace?: string | undefined
    /** Recall on the lane path, ordered this way. Off by default. */
    rank?: RecallRank | undefined
    /** The most characters of memory content a recall hands back. */
    maxChars?: number | undefined
  } = {},
): Promise<string> {
  try {
    switch (call.name) {
      case 'recall_memory': {
        const query = stringArg(call.arguments.query)
        const filters = {
          namespace: options.namespace,
          tiers: stringList(call.arguments.tiers) as Tier[] | undefined,
          paths: stringList(call.arguments.paths),
          tags: stringList(call.arguments.tags),
          since: stringArg(call.arguments.since),
          until: stringArg(call.arguments.until),
          timeField: timeFieldArg(call.arguments.time_field),
        }
        if (filters.since || filters.until) filters.timeField ??= 'occurred'
        const listing =
          filters.tiers || filters.paths || filters.tags || filters.since || filters.until
        if (!query && !listing) return 'No query or filter was provided.'
        // A list without a question has nothing to rank, so the host's rank stays off it.
        const { memories } = query
          ? await client.recall(query, { ...filters, rank: options.rank, maxChars: options.maxChars })
          : await client.recall(filters)
        if (memories.length === 0) {
          return query ? 'Nothing relevant is stored about this user yet.' : 'No memory matches these filters.'
        }
        return memories.map(memoryLine).join('\n')
      }
      case 'find_skill': {
        const task = String(call.arguments.task ?? '')
        if (!task) return 'No task was provided.'
        const skills = await client.skills.find(task, { namespace: options.namespace, limit: 3 })
        if (skills.length === 0) return 'No stored skill applies to this task.'
        return skills
          .map((s) => `## ${s.name}\n${s.description ? s.description + '\n' : ''}${s.content}`)
          .join('\n\n')
      }
      case 'save_memory': {
        const fact = String(call.arguments.fact ?? '')
        if (!fact) return 'No fact was provided.'
        await client.remember([{ role: 'user', content: fact }], {
          namespace: options.namespace,
          tags: stringList(call.arguments.tags),
          occurredAt: stringArg(call.arguments.occurred_at),
        })
        return 'Saved. It will be searchable shortly.'
      }
      default:
        return `Unknown tool: ${call.name}`
    }
  } catch (e) {
    if (e instanceof GitloomError && e.status === 400) {
      return `The memory service refused this (${e.code}): ${e.message}`
    }
    return `The memory service failed: ${(e as Error).message}`
  }
}

/** The day it happened, then the days it was said, then the memory. Ingestion times stay out. */
function memoryLine(m: RecalledMemory): string {
  const day = m.occurredAt ? `[${m.occurredAt.toISOString().slice(0, 10)}] ` : ''
  const said = m.said?.length ? `(said ${m.said.join(', ')}) ` : ''
  return `- ${day}${said}${m.content}`
}

function stringArg(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function timeFieldArg(v: unknown): TimeField | undefined {
  return v === 'occurred' || v === 'created' || v === 'updated' ? v : undefined
}

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string' && x !== '')
  return out.length ? out : undefined
}

/** True when a tool call belongs to this SDK, so a dispatcher can route it. */
export function isMemoryTool(name: string): boolean {
  return name === 'recall_memory' || name === 'save_memory' || name === 'find_skill'
}

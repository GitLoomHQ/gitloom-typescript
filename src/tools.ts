/**
 * Tool definitions, so an agent can decide for itself when to remember and when
 * to recall.
 *
 * OpenAI and Anthropic describe tools differently — OpenAI nests the schema
 * under `function`, Anthropic puts it in `input_schema` — so both shapes are
 * exported rather than one plus a note in the docs telling you to reshape it.
 */

import type { Gitloom } from './client'

const RECALL_DESCRIPTION =
  'Search what you already know about this user from earlier conversations. ' +
  'Call this before answering anything that depends on their history, preferences, ' +
  'possessions, plans or past decisions — not just when they explicitly ask you to remember.'

const REMEMBER_DESCRIPTION =
  'Save something worth knowing about this user for later conversations. ' +
  'Call this when they state a durable fact about themselves: a preference, a decision, ' +
  'a possession, a plan, a relationship. Do not save small talk or anything you inferred.'

const recallParameters = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'What you want to know, phrased as a question in the user\'s own terms.',
    },
  },
  required: ['query'],
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
export const mcpTools = [
  {
    name: 'recall_memory',
    description: RECALL_DESCRIPTION,
    inputSchema: recallParameters,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'save_memory',
    description: REMEMBER_DESCRIPTION,
    inputSchema: rememberParameters,
    annotations: { readOnlyHint: false, idempotentHint: false },
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
]

/** The same tools in Anthropic's format. */
export const anthropicTools = [
  { name: 'recall_memory', description: RECALL_DESCRIPTION, input_schema: recallParameters },
  { name: 'save_memory', description: REMEMBER_DESCRIPTION, input_schema: rememberParameters },
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
  options: { namespace?: string | undefined } = {},
): Promise<string> {
  try {
    switch (call.name) {
      case 'recall_memory': {
        const query = String(call.arguments.query ?? '')
        if (!query) return 'No query was provided.'
        const { memories } = await client.recall(query, { namespace: options.namespace })
        if (memories.length === 0) return 'Nothing relevant is stored about this user yet.'
        return memories.map((m) => `- ${m.text}`).join('\n')
      }
      case 'save_memory': {
        const fact = String(call.arguments.fact ?? '')
        if (!fact) return 'No fact was provided.'
        await client.remember([{ role: 'user', content: fact }], {
          namespace: options.namespace,
        })
        return 'Saved. It will be searchable shortly.'
      }
      default:
        return `Unknown tool: ${call.name}`
    }
  } catch (e) {
    return `The memory service failed: ${(e as Error).message}`
  }
}

/** True when a tool call belongs to this SDK, so a dispatcher can route it. */
export function isMemoryTool(name: string): boolean {
  return name === 'recall_memory' || name === 'save_memory'
}

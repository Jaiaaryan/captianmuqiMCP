/**
 * The MCP surface of response processor chains: how an agent edits what a tool
 * returns.
 *
 * Code mode (the sandbox) lets an agent write a script that calls several tools
 * and returns the small answer. These four tools are the other half of the same
 * idea, one level down: when a tool's answer is simply the wrong *shape* — a
 * price in the wrong currency, a net amount where the user wants gross, a
 * description full of newlines, a numeric status code — the fix belongs on the
 * tool, once, not in every script and every prompt that reads it. So the agent
 * can look at the processors it has, try a chain against a real recorded
 * response, and store it on the tool. The next call, for every client, returns
 * the edited response.
 *
 * What keeps this safe:
 *   - The tools are only registered for a caller who may already change the
 *     connector through the dashboard (its owner, or an admin of the
 *     organization). Nobody else is offered them, so no call has to be refused.
 *   - A chain can only be put on a tool this session can see: the server's own
 *     connectors, after the caller's role has filtered the tool list.
 *   - A chain is data, checked against the registry before it is stored. A
 *     processor is a pure function with no capabilities, so a chain cannot read
 *     anything, call anything or reach anywhere.
 *   - `response_chain_preview` changes nothing, which is where an agent is
 *     meant to iterate.
 */
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  PROCESSOR_CHAIN_LIMITS,
  hasProcessorChain,
  readProcessorChain,
  runProcessorChain,
  validateProcessorChain,
  type ProcessorChain,
} from '../connectors/processor-chain.util';
import { describeProcessors } from '../connectors/processor-registry';

const logger = new Logger('ProcessorTools');

export const PROCESSOR_CHAIN_TOOL_NAMES = [
  'response_chain_processors',
  'response_chain_get',
  'response_chain_preview',
  'response_chain_set',
] as const;

/** The operator's off-switch for the agent-facing half of the feature. */
export function areProcessorChainToolsEnabled(): boolean {
  return process.env.PROCESSOR_CHAIN_MCP_TOOLS !== 'false';
}

/** Which tools of which connectors this MCP session may touch. */
export interface ProcessorToolScope {
  /** Absent for a pure API-key session, which can then edit nothing. */
  userId?: string;
  /** Organization that owns the MCP server. */
  organizationId: string;
  /** The server's connectors. */
  connectorIds: string[];
  /** Tool names the caller can see here, after the role filter. */
  visibleToolNames: ReadonlySet<string>;
}

export interface ProcessorChainTarget {
  toolId: string;
  toolName: string;
  connectorId: string;
  connectorName: string;
  responseMapping: Record<string, unknown> | null;
  /** True when this caller may change the connector's configuration. */
  editable: boolean;
}

/**
 * Everything these tools need from the database, as an interface so they test
 * with a fake and carry no Nest dependency of their own.
 */
export interface ProcessorChainStore {
  /** The named tool on one of the scope's connectors, or why it cannot be used. */
  findTool(
    toolName: string,
    scope: ProcessorToolScope,
  ): Promise<ProcessorChainTarget | { ambiguous: string[] } | null>;
  /** The most recent real response recorded for a tool, for the preview. */
  lastSample(toolId: string): Promise<{ output: unknown; capturedAt: Date } | null>;
  /** Store (or, with null, remove) the chain, and reload the connector's tools. */
  saveChain(
    target: ProcessorChainTarget,
    chain: Record<string, unknown> | null,
  ): Promise<void>;
}

/** A planned registration, the shape the endpoint controller appends. */
export interface ProcessorToolEntry {
  name: string;
  sig: string;
  register: (mcpServer: McpServer) => { remove: () => void };
}

const textResult = (text: string, isError = false) => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError: true } : {}),
});

const jsonResult = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true } : {}),
});

const CHAIN_SHAPE =
  'A chain is `{ steps: [...] }`. A step is ' +
  '`{ id, processor, each, reads, writes, mode, params }`: `id` names the step ' +
  '(it appears in every error), `processor` is a registry entry such as ' +
  '`number_scale@1`, `each` is the collection to run over (`$.items[*]`; omit ' +
  'it to run once on the whole response), `reads` is the field the processor ' +
  'reads from each element, `writes` the field its result goes to, and `mode` ' +
  'is `add` (the field must be new), `replace` (it must exist) or `upsert` ' +
  '(either, the default). Steps run in order, so a later step can read what an ' +
  'earlier one wrote.';

const step = z.object({
  id: z
    .string()
    .describe('Name of the step, letters, digits, "-" and "_" (e.g. "convert_to_eur").'),
  processor: z
    .string()
    .describe('A registry entry, ideally version-pinned: "number_scale@1".'),
  each: z
    .string()
    .optional()
    .describe('The collection to run over, as a path: "$.items[*]". Omit to run once on the response.'),
  reads: z.string().describe('Field the processor reads from each element: "price_usd".'),
  writes: z.string().describe('Field the result is written to: "price_eur".'),
  mode: z
    .enum(['add', 'replace', 'upsert'])
    .optional()
    .describe('add = the field must be new, replace = it must exist, upsert = either (default).'),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("The processor's parameters, as its contract declares them."),
  onMissing: z
    .enum(['fail', 'skip'])
    .optional()
    .describe('When `reads` is absent on an element: fail the call (default) or leave it alone.'),
});

/**
 * Build the four tools for one authenticated MCP session. The caller decides
 * whether to offer them at all (see `editable` on the scope's connectors) —
 * these are only built for a caller who may change the configuration.
 */
export function buildProcessorToolEntries(
  store: ProcessorChainStore,
  scope: ProcessorToolScope,
): ProcessorToolEntry[] {
  /** Resolve a tool name to something the caller is allowed to act on. */
  const resolve = async (
    toolName: string,
  ): Promise<{ ok: true; target: ProcessorChainTarget } | { ok: false; message: string }> => {
    const name = (toolName ?? '').trim();
    if (!name) return { ok: false, message: 'Provide the name of a tool on this MCP server.' };
    if (!scope.visibleToolNames.has(name)) {
      return {
        ok: false,
        message:
          `Tool '${name}' is not one of the tools on this MCP server. Call tools/list ` +
          'to see the names you can edit.',
      };
    }
    const found = await store.findTool(name, scope);
    if (!found) return { ok: false, message: `Tool '${name}' not found on this MCP server.` };
    if ('ambiguous' in found) {
      return {
        ok: false,
        message:
          `Several connectors on this server have a tool called '${name}' ` +
          `(${found.ambiguous.join(', ')}). Edit it in the dashboard, where the ` +
          'connector is unambiguous.',
      };
    }
    return { ok: true, target: found };
  };

  const chainOf = (target: ProcessorChainTarget) =>
    (target.responseMapping?.processors as Record<string, unknown> | undefined) ?? null;

  const processors = async () =>
    jsonResult({
      processors: describeProcessors(),
      chain: CHAIN_SHAPE,
      writeModes: ['add', 'replace', 'upsert'],
      // The same keys `GET /api/processors` returns, so an agent and the
      // dashboard do not read two names for one cap.
      limits: {
        maxSteps: PROCESSOR_CHAIN_LIMITS.maxSteps,
        maxTargets: PROCESSOR_CHAIN_LIMITS.maxTargets,
      },
      example: {
        steps: [
          {
            id: 'convert_to_eur',
            processor: 'number_scale@1',
            each: '$.items[*]',
            reads: 'price_usd',
            writes: 'price_eur',
            mode: 'add',
            params: { factor: 0.92, round: 2 },
          },
          {
            id: 'clean_description',
            processor: 'text_clean@1',
            each: '$.items[*]',
            reads: 'description',
            writes: 'description',
            mode: 'replace',
          },
        ],
      },
    });

  const get = async (input: { toolName: string }) => {
    const resolved = await resolve(input.toolName);
    if (!resolved.ok) return textResult(resolved.message, true);
    const { target } = resolved;
    const sample = await store.lastSample(target.toolId);
    return jsonResult({
      tool: target.toolName,
      connector: target.connectorName,
      processors: chainOf(target),
      active: hasProcessorChain(target.responseMapping),
      editable: target.editable,
      sampleAvailable: sample !== null,
      ...(sample ? { sampleCapturedAt: sample.capturedAt } : {}),
    });
  };

  const preview = async (input: {
    toolName: string;
    steps?: unknown[] | null;
    onError?: 'fail' | 'passthrough';
    sample?: unknown;
  }) => {
    const resolved = await resolve(input.toolName);
    if (!resolved.ok) return textResult(resolved.message, true);
    const { target } = resolved;

    const proposed =
      input.steps === undefined
        ? chainOf(target)
        : input.steps === null
          ? null
          : { version: 1, steps: input.steps, ...(input.onError ? { onError: input.onError } : {}) };

    const invalid = validateProcessorChain(proposed);
    if (invalid) return jsonResult({ ok: false, error: invalid }, true);

    let sample = input.sample;
    let sampleSource = 'argument';
    if (sample === undefined) {
      const last = await store.lastSample(target.toolId);
      if (!last) {
        return textResult(
          `No recorded response for '${target.toolName}' to preview against. Call the tool ` +
            'once, or pass a `sample` of what it returns.',
          true,
        );
      }
      sample = last.output;
      sampleSource = 'last-call';
    }

    const chain = readProcessorChain(proposed ? { processors: proposed } : null);
    if (!chain) {
      return jsonResult({ ok: true, chainActive: false, sampleSource, result: sample });
    }

    const run = runProcessorChain(sample, chain, { trace: true });
    return jsonResult(
      {
        ok: run.ok,
        chainActive: true,
        sampleSource,
        steps: run.steps,
        result: run.value,
        ...(run.ok
          ? {}
          : {
              error: run.error,
              failedStep: run.failedStep,
              failedPath: run.failedPath,
              hint:
                'The step refused that value. Fix the step, or set `onMissing: "skip"` ' +
                'on it when the field is genuinely optional.',
            }),
      },
      !run.ok,
    );
  };

  const set = async (input: {
    toolName: string;
    steps?: unknown[] | null;
    enabled?: boolean;
    onError?: 'fail' | 'passthrough';
  }) => {
    const resolved = await resolve(input.toolName);
    if (!resolved.ok) return textResult(resolved.message, true);
    const { target } = resolved;
    if (!target.editable) {
      return textResult(
        `You may not change the configuration of connector '${target.connectorName}'. ` +
          "Its owner or an admin of the workspace can, in the dashboard's tool editor.",
        true,
      );
    }
    if (input.steps === undefined) {
      return textResult(
        'Provide `steps` (the chain) or `steps: null` to remove the chain from the tool.',
        true,
      );
    }

    const chain: Record<string, unknown> | null =
      input.steps === null
        ? null
        : {
            version: 1,
            steps: input.steps,
            ...(input.enabled === false ? { enabled: false } : {}),
            ...(input.onError ? { onError: input.onError } : {}),
          };

    const invalid = validateProcessorChain(chain);
    if (invalid) return jsonResult({ ok: false, error: invalid }, true);

    try {
      await store.saveChain(target, chain);
    } catch (err) {
      logger.warn(
        `Could not store the processor chain of ${target.toolName}: ${(err as Error)?.message ?? err}`,
      );
      return textResult('Could not store the chain. Try again.', true);
    }

    const stored = chain ? ({ processors: chain } as Record<string, unknown>) : null;
    return jsonResult({
      ok: true,
      tool: target.toolName,
      connector: target.connectorName,
      processors: chain,
      active: hasProcessorChain(stored),
      note: chain
        ? 'Every client of this tool now receives the edited response. Call the tool to see it.'
        : 'The tool returns its unedited response again.',
    });
  };

  const sig = (description: string) =>
    `processors:v1:${createHash('sha1').update(description).digest('hex').slice(0, 16)}`;

  const entry = (
    name: string,
    build: (mcpServer: McpServer) => unknown,
    description: string,
  ): ProcessorToolEntry => ({
    name,
    sig: sig(description),
    register: (mcpServer) => build(mcpServer) as { remove: () => void },
  });

  const processorsDescription =
    'List the response processors available for editing a tool\'s response, with what each ' +
    'one reads, writes and takes as parameters. Read this before writing a chain with ' +
    'response_chain_set. ' +
    CHAIN_SHAPE;

  const getDescription =
    "Show the response processor chain currently stored on a tool of this MCP server — what " +
    'is being done to that tool\'s response before you see it, and whether you may change it.';

  const previewDescription =
    'Try a processor chain on a tool without storing it: returns the response after every ' +
    'step, the size after each, and, if a step refuses a value, which step and which JSON ' +
    'path. Uses the most recent real response of the tool unless you pass a `sample`. Use ' +
    'this to get a chain right before response_chain_set stores it. Nothing is changed.';

  const setDescription =
    "Store a response processor chain on a tool of this MCP server: from the next call, that " +
    'tool\'s response is edited before anyone sees it — for every client, not just this ' +
    'session. Use it when a tool keeps returning values in the wrong shape (a price in the ' +
    'wrong currency, a net amount where gross is wanted, a description full of newlines, a ' +
    'numeric status code) and the fix belongs on the tool rather than in every prompt. ' +
    'Preview it with response_chain_preview first. Send `steps: null` to remove the chain. ' +
    'A step that refuses a value fails the tool call, naming the step and the path, so a ' +
    'half-edited response never reaches a model. ' +
    CHAIN_SHAPE;

  return [
    entry(
      'response_chain_processors',
      (mcpServer) =>
        mcpServer.registerTool(
          'response_chain_processors',
          {
            description: processorsDescription,
            inputSchema: {},
            annotations: {
              title: 'List response processors',
              readOnlyHint: true,
              openWorldHint: false,
            },
          },
          processors,
        ),
      processorsDescription,
    ),
    entry(
      'response_chain_get',
      (mcpServer) =>
        mcpServer.registerTool(
          'response_chain_get',
          {
            description: getDescription,
            inputSchema: {
              toolName: z.string().describe('A tool of this MCP server, as tools/list names it.'),
            },
            annotations: {
              title: 'Get a response chain',
              readOnlyHint: true,
              openWorldHint: false,
            },
          },
          get,
        ),
      getDescription,
    ),
    entry(
      'response_chain_preview',
      (mcpServer) =>
        mcpServer.registerTool(
          'response_chain_preview',
          {
            description: previewDescription,
            inputSchema: {
              toolName: z.string().describe('A tool of this MCP server.'),
              steps: z
                .array(step)
                .max(PROCESSOR_CHAIN_LIMITS.maxSteps)
                .nullable()
                .optional()
                .describe('The chain to try. Omit to preview the one already stored.'),
              onError: z.enum(['fail', 'passthrough']).optional(),
              sample: z
                .unknown()
                .optional()
                .describe(
                  "A response to run the chain against. Omit to use the tool's most recent real response.",
                ),
            },
            annotations: {
              title: 'Preview a response chain',
              readOnlyHint: true,
              openWorldHint: false,
            },
          },
          preview,
        ),
      previewDescription,
    ),
    entry(
      'response_chain_set',
      (mcpServer) =>
        mcpServer.registerTool(
          'response_chain_set',
          {
            description: setDescription,
            inputSchema: {
              toolName: z.string().describe('A tool of this MCP server.'),
              steps: z
                .array(step)
                .max(PROCESSOR_CHAIN_LIMITS.maxSteps)
                .nullable()
                .optional()
                .describe('The steps, in order. `null` removes the chain from the tool.'),
              enabled: z
                .boolean()
                .optional()
                .describe('false keeps the chain on the tool without running it.'),
              onError: z
                .enum(['fail', 'passthrough'])
                .optional()
                .describe(
                  'fail (default): a refused value fails the call. passthrough: return the ' +
                    'unedited response and log the reason.',
                ),
            },
            annotations: {
              title: 'Set a response chain',
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          set,
        ),
      setDescription,
    ),
  ];
}

/** The chain an agent just wrote, as the runner will read it. */
export function toChainConfig(steps: unknown[]): ProcessorChain {
  return { version: 1, steps } as unknown as ProcessorChain;
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { readChain, runChain, validateChain, type ResponseProcessingChain } from './chain';

export interface DryRunOutcome {
  ok: boolean;
  result?: unknown;
  steps: ReturnType<typeof runChain>['steps'];
  error?: string;
  failedStep?: string;
  failedPath?: string;
}

/** Limits for the sample the editor's path picker shows. */
export const SAMPLE_LIMITS = { maxBytes: 64 * 1024, maxDepth: 8, maxItems: 3 } as const;

/**
 * Successively tighter cuts; the first one that fits `maxBytes` wins. Every
 * level keeps arrays to `items` elements and depth to `depth`; deeper objects
 * and arrays become `{}` / `[]` so their type is still visible.
 */
const SAMPLE_PASSES = [
  { items: SAMPLE_LIMITS.maxItems, depth: SAMPLE_LIMITS.maxDepth, keys: Infinity, chars: 1024 },
  { items: 1, depth: SAMPLE_LIMITS.maxDepth, keys: 200, chars: 256 },
  { items: 1, depth: 6, keys: 100, chars: 64 },
  { items: 1, depth: 4, keys: 50, chars: 32 },
  { items: 1, depth: 2, keys: 20, chars: 16 },
];

type Pass = (typeof SAMPLE_PASSES)[number];

function cut(value: unknown, pass: Pass, depth: number, flag: { cut: boolean }): unknown {
  if (typeof value === 'string') {
    if (value.length <= pass.chars) return value;
    flag.cut = true;
    return value.slice(0, pass.chars);
  }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'number' || typeof value === 'boolean' ? value : null;
  }
  if (Array.isArray(value)) {
    if (depth >= pass.depth) {
      if (value.length) flag.cut = true;
      return [];
    }
    if (value.length > pass.items) flag.cut = true;
    return value.slice(0, pass.items).map((v) => cut(v, pass, depth + 1, flag));
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (depth >= pass.depth) {
    if (entries.length) flag.cut = true;
    return {};
  }
  if (entries.length > pass.keys) flag.cut = true;
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries.slice(0, pass.keys)) out[k] = cut(v, pass, depth + 1, flag);
  return out;
}

/**
 * A recorded response cut down for the editor: arrays to their first 3
 * elements, depth ≤ 8, JSON ≤ 64 KB (tighter passes until it fits; nothing
 * when even the tightest does not). `truncated` says whether anything was cut.
 */
export function truncateSample(value: unknown): { sample: unknown; truncated: boolean } {
  for (const pass of SAMPLE_PASSES) {
    const flag = { cut: false };
    const sample = cut(value, pass, 0, flag);
    const json = JSON.stringify(sample);
    if (json !== undefined && Buffer.byteLength(json, 'utf8') <= SAMPLE_LIMITS.maxBytes) {
      return { sample, truncated: flag.cut };
    }
  }
  return { sample: null, truncated: true };
}

@Injectable()
export class ResponseProcessingService {
  constructor(private readonly prisma: PrismaService) {}

  /** `{ valid: true }`, or the first problem found. */
  validate(chain: unknown): { valid: true } | { valid: false; problem: string } {
    const problem = validateChain(chain);
    return problem ? { valid: false, problem } : { valid: true };
  }

  /** Run a chain over a sample, always with a trace. Never throws. */
  dryRun(chain: unknown, sample: unknown): DryRunOutcome {
    const problem = validateChain(chain);
    if (problem) return { ok: false, error: problem, steps: [] };
    const result = runChain(sample, chain as ResponseProcessingChain, { trace: true });
    if (result.ok) return { ok: true, result: result.value, steps: result.steps };
    return {
      ok: false,
      error: result.error,
      failedStep: result.failedStep,
      failedPath: result.failedPath,
      steps: result.steps,
    };
  }

  /**
   * The tool, provided it belongs to a connector of the caller's organization.
   * A tool of another organization is indistinguishable from a missing one.
   */
  async getToolForOrganization(toolId: string, organizationId: string) {
    const tool = await this.prisma.mcpTool.findFirst({
      where: { id: toolId, connector: { organizationId } },
      select: { id: true, responseMapping: true },
    });
    if (!tool) throw new NotFoundException('Tool not found');
    return tool;
  }

  /** The chain stored on a tool, or null. */
  storedChain(tool: { responseMapping: unknown }): ResponseProcessingChain | null {
    return readChain(tool.responseMapping);
  }

  /**
   * Most recent successful response recorded for the tool: the same source the
   * response-mapping preview uses (ToolInvocation.output holds the upstream
   * response before any mapping). A small scan rather than a JSON-null filter
   * in SQL: `output` is only null for older rows.
   */
  async findLatestSample(
    toolId: string,
  ): Promise<{ output: unknown; createdAt: Date } | null> {
    const recent = await this.prisma.toolInvocation.findMany({
      where: { toolId, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { output: true, createdAt: true },
    });
    const hit = recent.find((r) => r.output !== null && r.output !== undefined);
    return hit ? { output: hit.output, createdAt: hit.createdAt } : null;
  }
}

/**
 * The database side of the agent-facing processor chain tools: which tools of
 * this MCP server the caller may edit, what is stored on one, and storing a
 * chain on it.
 *
 * It lives in the MCP module (where the tools are registered) rather than in
 * the connectors module, which already imports this one; the chain's own logic
 * is in `connectors/processor-chain.util`, imported as a file, so there is no
 * module cycle.
 *
 * The permission rule is deliberately the same one the dashboard enforces for
 * the tool editor — the connector's owner, or an admin of the organization that
 * owns it. An agent therefore gets exactly the reach the person it is acting
 * for already has, and no API-key-only session (which has no user) can change a
 * tool's configuration at all.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { McpServerService } from './mcp-server.service';
import type {
  ProcessorChainStore,
  ProcessorChainTarget,
  ProcessorToolScope,
} from './processor-tools';

/** Just the identity and reach of one MCP session. */
type EditScope = Pick<ProcessorToolScope, 'userId' | 'organizationId' | 'connectorIds'>;

@Injectable()
export class ProcessorChainService implements ProcessorChainStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mcpServer: McpServerService,
  ) {}

  /**
   * The server's connectors whose configuration this caller may change: the
   * ones they own, or all of them for an admin of the owning organization.
   * Empty for a session with no user (an API key), which is what keeps the
   * editing tools off that surface entirely.
   */
  async editableConnectorIds(scope: EditScope): Promise<string[]> {
    if (!scope.userId || scope.connectorIds.length === 0) return [];

    const [user, connectors] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: scope.userId },
        select: { role: true, organizationId: true },
      }),
      this.prisma.connector.findMany({
        where: { id: { in: scope.connectorIds }, organizationId: scope.organizationId },
        select: { id: true, userId: true },
      }),
    ]);

    // A multi-org member acting on another workspace's server edits nothing
    // there, exactly as the REST endpoint refuses it.
    if (!user || user.organizationId !== scope.organizationId) return [];
    const isAdmin = user.role === 'ADMIN';
    return connectors.filter((c) => isAdmin || c.userId === scope.userId).map((c) => c.id);
  }

  /** Whether to offer the editing tools on this session at all. */
  async canEdit(scope: EditScope): Promise<boolean> {
    return (await this.editableConnectorIds(scope)).length > 0;
  }

  async findTool(
    toolName: string,
    scope: ProcessorToolScope,
  ): Promise<ProcessorChainTarget | { ambiguous: string[] } | null> {
    if (scope.connectorIds.length === 0) return null;

    const rows = await this.prisma.mcpTool.findMany({
      where: {
        name: toolName,
        connectorId: { in: scope.connectorIds },
        connector: { organizationId: scope.organizationId },
      },
      select: {
        id: true,
        name: true,
        connectorId: true,
        responseMapping: true,
        connector: { select: { name: true } },
      },
    });
    if (rows.length === 0) return null;
    // Only the first connector of a duplicated name is callable here (see the
    // duplicate handling in the endpoint controller), so editing by name alone
    // would be a guess. Say so instead.
    if (rows.length > 1) return { ambiguous: rows.map((r) => r.connector.name) };

    const row = rows[0];
    const editable = await this.editableConnectorIds(scope);
    return {
      toolId: row.id,
      toolName: row.name,
      connectorId: row.connectorId,
      connectorName: row.connector.name,
      responseMapping: (row.responseMapping as Record<string, unknown> | null) ?? null,
      editable: editable.includes(row.connectorId),
    };
  }

  /**
   * The most recent real response recorded for a tool, so a chain can be tried
   * against production-shaped data. Scans the last few successful invocations
   * rather than filtering on JSON null in SQL: `output` is only null on older
   * rows, and a small scan keeps the query portable (same approach as the REST
   * preview endpoint).
   */
  async lastSample(toolId: string): Promise<{ output: unknown; capturedAt: Date } | null> {
    const recent = await this.prisma.toolInvocation.findMany({
      where: { toolId, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { output: true, createdAt: true },
    });
    const hit = recent.find((r) => r.output !== null && r.output !== undefined);
    return hit ? { output: hit.output, capturedAt: hit.createdAt } : null;
  }

  async saveChain(
    target: ProcessorChainTarget,
    chain: Record<string, unknown> | null,
  ): Promise<void> {
    const next: Record<string, unknown> = { ...(target.responseMapping ?? {}) };
    if (chain === null) {
      delete next.processors;
    } else {
      next.processors = chain;
    }

    await this.prisma.mcpTool.updateMany({
      where: { id: target.toolId, connectorId: target.connectorId },
      data: {
        responseMapping: (Object.keys(next).length > 0 ? next : null) as any,
        // A chain adds and changes fields, so the advertised outputSchema
        // described the previous shape. It is re-inferred from the next real
        // response.
        outputSchema: null as any,
      },
    });

    // Without this the running registry would keep serving the old mapping
    // until something else reloaded the connector.
    await this.mcpServer.reloadConnectorTools(target.connectorId);
  }
}

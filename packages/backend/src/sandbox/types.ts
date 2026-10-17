import type { McpServer } from '@modelcontextprotocol/server';
import type { RegisteredTool } from '../mcp-server/tool-registry';
import type { SandboxLimits } from './limits';

/**
 * A planned MCP tool registration. Structurally the same as the endpoint
 * controller's (private) ToolEntry, so the controller can append these directly.
 */
export interface SandboxMcpToolEntry {
  name: string;
  /** Changes whenever the tool's description or schema changes (session reconciliation). */
  sig: string;
  register: (mcpServer: McpServer) => { remove: () => void };
}

/**
 * Caller identity and scope, fixed by the authenticated MCP session. Same shape
 * as the MCP endpoint controller's InvocationContext; duplicated here so the
 * sandbox has no import path back into the MCP module.
 */
export interface SandboxInvocationContext {
  userId?: string;
  userEmail?: string;
  organizationId?: string;
  authMethod: string;
  apiKeyName?: string;
  mcpServerId: string;
  mcpServerName: string;
  connectorIds: string[];
  intent?: string;
}

/** The slice of a RegisteredTool the sandbox needs. */
export type SandboxTool = Pick<
  RegisteredTool,
  'name' | 'connectorId' | 'description' | 'parameters' | 'outputSchema'
>;

/** Result shape of DynamicMcpTools.executeTool. */
export interface SandboxToolResult {
  content: ReadonlyArray<{ type: string; text?: string }>;
  isError?: boolean;
  structured?: unknown;
}

/**
 * How the sandbox reaches connector tools. The service receives this as a
 * callback (bound to DynamicMcpTools.executeTool by the caller) so it carries no
 * Nest dependency on the MCP module and unit-tests with a fake.
 */
export type SandboxExecuteTool = (
  name: string,
  args: Record<string, unknown>,
  context: SandboxInvocationContext,
) => Promise<SandboxToolResult>;

export interface SandboxRunRequest {
  code: string;
  args?: Record<string, unknown>;
  /** Already role-filtered by planToolSet: the only tools the script can call. */
  allowedTools: SandboxTool[];
  invocationContext: SandboxInvocationContext;
  executeTool: SandboxExecuteTool;
  limits?: Partial<SandboxLimits>;
}

export type SandboxErrorCode =
  | 'TIMEOUT'
  | 'MEMORY_LIMIT'
  | 'OUTPUT_TOO_LARGE'
  | 'TOOL_NOT_ALLOWED'
  | 'TOOL_ERROR'
  | 'CONNECTOR_CALL_LIMIT'
  | 'CONNECTOR_BYTES_LIMIT'
  | 'SYNTAX_ERROR'
  | 'RUNTIME_ERROR'
  | 'CODE_TOO_LARGE'
  | 'BUSY';

export interface SandboxError {
  code: SandboxErrorCode;
  message: string;
  hint?: string;
  stack?: string;
  line?: number;
  column?: number;
}

export interface SandboxRunMeta {
  ms: number;
  connectorCalls: number;
  /** Bytes pulled from connectors into the sandbox: what stayed server-side. */
  bytesFromConnectors: number;
  /** Bytes of the result that went back to the model. */
  bytesReturned: number;
  /** console.log output, capped. */
  logs: string[];
  toolsCalled: string[];
}

export interface SandboxRunResult {
  ok: boolean;
  /** JSON-serialisable, at most maxOutputBytes. */
  result?: unknown;
  error?: SandboxError;
  meta: SandboxRunMeta;
}

export type SandboxSyntaxCheck =
  | { ok: true }
  | { ok: false; line: number; column: number; message: string };

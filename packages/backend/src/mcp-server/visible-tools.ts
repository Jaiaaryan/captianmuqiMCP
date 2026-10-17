import type { SandboxTool } from '../sandbox/types';
import { isListable, type RegisteredTool } from './tool-registry';
import { stripEnvVarParams } from './tool-schema.util';

/**
 * The tools of one MCP server that a caller may use, in registration order:
 * the connector is set up, the caller's role allows the tool, and the first tool
 * of each name wins (the SDK throws on a second registration of a name).
 *
 * `allowedToolIds === null` means unrestricted. `onDuplicate` is told about each
 * skipped copy so the caller can log it.
 *
 * Every surface that offers tools to a caller selects them here, so a sandbox
 * script can never reach a tool that the caller's own tool list hides.
 */
export function visibleServerTools(
  serverTools: readonly RegisteredTool[],
  allowedToolIds: readonly string[] | null,
  onDuplicate?: (tool: RegisteredTool) => void,
): RegisteredTool[] {
  const allowed = allowedToolIds === null ? null : new Set(allowedToolIds);
  const names = new Set<string>();
  const visible: RegisteredTool[] = [];
  for (const tool of serverTools) {
    // A connector that is not set up yet would only produce errors.
    if (!isListable(tool)) continue;
    if (allowed !== null && !allowed.has(tool.id)) continue;
    if (names.has(tool.name)) {
      onDuplicate?.(tool);
      continue;
    }
    names.add(tool.name);
    visible.push(tool);
  }
  return visible;
}

/** What a sandbox script is told about each tool it may call. */
export function toSandboxTools(tools: readonly RegisteredTool[]): SandboxTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    connectorId: tool.connectorId,
    description: tool.description,
    // Environment-variable parameters are filled by the gateway, not the caller.
    parameters: stripEnvVarParams(tool.parameters, tool.connectorConfig.envVars),
    outputSchema: tool.outputSchema,
  }));
}

/**
 * The connectors and tools a saved script declares it uses, and the two rules
 * built on that declaration:
 *
 *  - Exposure: an MCP server offers a script to an agent if and only if the server
 *    has every connector the script uses (`missingConnectors` is empty).
 *  - Enforcement: when a saved script runs, it can call only the tools it declared
 *    (`declaredOnly`), so the declaration cannot understate what the script does.
 */

/** One tool of one connector, as stored. */
export interface DeclaredUse {
  connectorId: string;
  connectorName: string;
  toolName: string;
}

/** A connector and the tools of it a script uses, as shown to people and agents. */
export interface ScriptUse {
  connectorId: string;
  /** The connector's current name, or the name it had when the script was saved. */
  connectorName: string;
  /** False when the connector has been deleted: the script still needs it. */
  connectorExists: boolean;
  tools: string[];
}

const byText = (a: string, b: string) => a.localeCompare(b);

/** Rows grouped by connector, connectors and tools sorted by name. */
export function groupUses(
  rows: DeclaredUse[],
  current: Map<string, string> = new Map(),
): ScriptUse[] {
  const byConnector = new Map<string, ScriptUse>();
  for (const row of rows) {
    let use = byConnector.get(row.connectorId);
    if (!use) {
      use = {
        connectorId: row.connectorId,
        connectorName: current.get(row.connectorId) ?? row.connectorName,
        connectorExists: current.has(row.connectorId),
        tools: [],
      };
      byConnector.set(row.connectorId, use);
    }
    if (!use.tools.includes(row.toolName)) use.tools.push(row.toolName);
  }
  const uses = [...byConnector.values()];
  for (const use of uses) use.tools.sort(byText);
  return uses.sort((a, b) => byText(a.connectorName, b.connectorName));
}

/**
 * The connectors the script uses that the server does not have. The script is
 * offered on the server only when this is empty. A script that uses no connector
 * is offered everywhere, and one that uses a deleted connector nowhere.
 */
export function missingConnectors(
  uses: { connectorId: string; connectorName: string }[],
  serverConnectorIds: Iterable<string>,
): { id: string; name: string }[] {
  const has = new Set(serverConnectorIds);
  return uses
    .filter((u) => !has.has(u.connectorId))
    .map((u) => ({ id: u.connectorId, name: u.connectorName }));
}

const keyOf = (connectorId: string, toolName: string) => `${connectorId}\u0000${toolName}`;

/**
 * The tools a saved script may call: of those the caller can call, only the ones
 * it declared, matched by connector as well as by name so a same-named tool of
 * another connector is not let in.
 */
export function declaredOnly<T extends { connectorId: string; name: string }>(
  tools: T[],
  uses: { connectorId: string; tools: string[] }[],
): T[] {
  const declared = new Set(uses.flatMap((u) => u.tools.map((t) => keyOf(u.connectorId, t))));
  return tools.filter((t) => declared.has(keyOf(t.connectorId, t.name)));
}

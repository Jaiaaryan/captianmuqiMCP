// Shared contract for the Build flow view: what `GET /api/flow` returns and
// what the canvas, nodes and edges render. Keep this file free of React.

export type FlowNodeKind =
  | 'agent'
  | 'server'
  | 'connector'
  | 'tool'
  | 'processing'
  | 'mapping'
  | 'script';

export type FlowEdgeKind =
  | 'mcp' // agent → server
  | 'tool' // server → tool (the tool is offered on the server)
  | 'http' // tool → connector (the request leaves the workspace)
  | 'processing' // tool → processing (raw response enters the chain)
  | 'mapping' // processing|tool → mapping
  | 'script-use' // script → tool (declared dependency, SandboxScriptTool)
  | 'script-call'; // script → tool (observed calls in the window)

export interface FlowStats {
  calls: number;
  errors: number;
  /** Bytes that entered this hop in the window (sum). */
  bytesIn?: number;
  /** Bytes that left this hop in the window (sum). */
  bytesOut?: number;
  /** Average duration of one call in ms. */
  avgMs?: number;
  /** ISO time of the most recent call. */
  lastAt?: string;
}

export interface FlowNode {
  /** `agent` | `server:<id>` | `connector:<id>` | `tool:<id>` | `processing:<toolId>` | `mapping:<toolId>` | `script:<id>` */
  id: string;
  kind: FlowNodeKind;
  label: string;
  ref?: {
    serverId?: string;
    connectorId?: string;
    toolId?: string;
    scriptId?: string;
  };
  stats?: FlowStats;
  /** Kind-specific facts the node may show: readOnly, authType, steps, mode, version, enabled … */
  meta?: Record<string, string | number | boolean | null>;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  kind: FlowEdgeKind;
  stats?: FlowStats;
}

export interface FlowGraph {
  /** The server drawn, or null for every server of the organization. */
  serverId: string | null;
  /** Start of the stats window (ISO). */
  since: string;
  generatedAt: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export type FlowWindow = '1h' | '24h' | '7d';

/** One call of the window, as `GET /api/flow/events` returns it (oldest first). */
export interface FlowEvent {
  ts: string;
  kind: 'tool' | 'script' | 'processing';
  serverId: string;
  connectorId?: string;
  toolId?: string;
  scriptId?: string;
  status: 'ok' | 'error' | 'refused';
  durationMs: number | null;
  /** Identical failures stored once, when more than one. */
  count?: number;
  /** Script runs: the tool names the run called. */
  tools?: string[];
}

export interface FlowEvents {
  from: string;
  until: string;
  truncated: boolean;
  events: FlowEvent[];
}

/** Calls and errors of a node or an edge as of a replay position. */
export type ReplayCounts = Map<string, { calls: number; errors: number }>;


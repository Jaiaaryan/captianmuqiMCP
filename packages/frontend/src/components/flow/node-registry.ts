import type { EdgeTypes, NodeTypes } from '@xyflow/react';
import { AgentNode } from './nodes/agent-node';
import { ConnectorNode } from './nodes/connector-node';
import { MappingNode } from './nodes/mapping-node';
import { ProcessingNode } from './nodes/processing-node';
import { ScriptNode } from './nodes/script-node';
import { ServerNode } from './nodes/server-node';
import { ToolNode } from './nodes/tool-node';
import { FlowEdgeComponent } from './edges/flow-edge';
import type { FlowEdgeKind, FlowNodeKind } from './types';

export { NODE_SIZE } from './nodes/base-node';

// Defined at module scope so React Flow sees stable references.
export const nodeTypes: NodeTypes = {
  agent: AgentNode,
  server: ServerNode,
  connector: ConnectorNode,
  tool: ToolNode,
  processing: ProcessingNode,
  mapping: MappingNode,
  script: ScriptNode,
} satisfies Record<FlowNodeKind, unknown>;

export const edgeTypes: EdgeTypes = {
  mcp: FlowEdgeComponent,
  tool: FlowEdgeComponent,
  http: FlowEdgeComponent,
  processing: FlowEdgeComponent,
  mapping: FlowEdgeComponent,
  'script-use': FlowEdgeComponent,
  'script-call': FlowEdgeComponent,
} satisfies Record<FlowEdgeKind, unknown>;

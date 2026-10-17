'use client';

import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Bot } from 'lucide-react';
import type { FlowNode } from '../types';
import { BaseNode, callsChip, compact } from './base-node';

function Agent({ data, selected }: NodeProps) {
  const node = data as unknown as FlowNode;
  return (
    <BaseNode
      node={node}
      icon={Bot}
      selected={selected}
      stats={compact([callsChip(node.stats?.calls)])}
    />
  );
}

export const AgentNode = memo(Agent);

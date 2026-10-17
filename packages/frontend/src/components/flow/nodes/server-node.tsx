'use client';

import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Server } from 'lucide-react';
import type { FlowNode } from '../types';
import { BaseNode, callsChip, compact } from './base-node';
import { formatCount } from '../flow-format';

function ServerNodeBase({ data, selected }: NodeProps) {
  const node = data as unknown as FlowNode;
  const connectors = node.meta?.connectors;
  return (
    <BaseNode
      node={node}
      icon={Server}
      selected={selected}
      stats={compact([
        typeof connectors === 'number'
          ? { text: `${formatCount(connectors)} connectors`, tone: 'default' }
          : null,
        callsChip(node.stats?.calls),
      ])}
    />
  );
}

export const ServerNode = memo(ServerNodeBase);

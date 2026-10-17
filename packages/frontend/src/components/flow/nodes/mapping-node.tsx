'use client';

import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Shuffle } from 'lucide-react';
import type { FlowNode } from '../types';
import { BaseNode, bytesChip, compact, type NodeChip } from './base-node';

function MappingNodeBase({ data, selected }: NodeProps) {
  const node = data as unknown as FlowNode;
  const mode = node.meta?.mode;
  const codes: NodeChip[] =
    typeof mode === 'string' && mode
      ? [{ text: mode, tone: mode === 'off' ? 'muted' : 'default' }]
      : [];
  return (
    <BaseNode
      node={node}
      icon={Shuffle}
      selected={selected}
      codes={codes}
      stats={compact([bytesChip(node.stats?.bytesIn, node.stats?.bytesOut)])}
    />
  );
}

export const MappingNode = memo(MappingNodeBase);

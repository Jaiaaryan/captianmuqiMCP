'use client';

import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Wrench } from 'lucide-react';
import type { FlowNode } from '../types';
import { BaseNode, callsChip, compact, errorsChip } from './base-node';

function ToolNodeBase({ data, selected }: NodeProps) {
  const node = data as unknown as FlowNode;
  const readOnly = node.meta?.readOnly;
  return (
    <BaseNode
      node={node}
      icon={Wrench}
      selected={selected}
      codes={
        typeof readOnly === 'boolean'
          ? [{ text: readOnly ? 'ro' : 'rw', tone: readOnly ? 'muted' : 'default' }]
          : []
      }
      stats={compact([callsChip(node.stats?.calls), errorsChip(node.stats?.errors)])}
    />
  );
}

export const ToolNode = memo(ToolNodeBase);

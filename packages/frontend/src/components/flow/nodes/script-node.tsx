'use client';

import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { FileCode2 } from 'lucide-react';
import type { FlowNode } from '../types';
import { BaseNode, callsChip, compact, errorsChip, type NodeChip } from './base-node';
import { formatCount } from '../flow-format';

function ScriptNodeBase({ data, selected }: NodeProps) {
  const node = data as unknown as FlowNode;
  const { version, tools } = node.meta ?? {};
  const codes: NodeChip[] =
    version != null && version !== '' ? [{ text: `v${version}`, tone: 'muted' }] : [];
  return (
    <BaseNode
      node={node}
      icon={FileCode2}
      selected={selected}
      codes={codes}
      stats={compact([
        typeof tools === 'number' ? { text: `${formatCount(tools)} tools`, tone: 'default' } : null,
        callsChip(node.stats?.calls),
        errorsChip(node.stats?.errors),
      ])}
    />
  );
}

export const ScriptNode = memo(ScriptNodeBase);

'use client';

import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Check, Workflow, X } from 'lucide-react';
import type { FlowNode } from '../types';
import { BaseNode, bytesChip, compact, type NodeChip } from './base-node';
import { formatCount } from '../flow-format';

function ProcessingNodeBase({ data, selected }: NodeProps) {
  const node = data as unknown as FlowNode;
  const { steps, enabled, valid } = node.meta ?? {};
  const codes: NodeChip[] = [];
  if (enabled === false) codes.push({ text: 'off', tone: 'muted' });
  else if (valid === false) codes.push({ text: '', icon: X, tone: 'danger' });
  else if (valid === true) codes.push({ text: '', icon: Check, tone: 'ok' });
  return (
    <BaseNode
      node={node}
      icon={Workflow}
      selected={selected}
      codes={codes}
      stats={compact([
        typeof steps === 'number' ? { text: `${formatCount(steps)} steps`, tone: 'default' } : null,
        bytesChip(node.stats?.bytesIn, node.stats?.bytesOut),
      ])}
    />
  );
}

export const ProcessingNode = memo(ProcessingNodeBase);

'use client';

import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Plug } from 'lucide-react';
import type { FlowNode } from '../types';
import { BaseNode, callsChip, compact, type NodeChip } from './base-node';

/** API_KEY / BEARER_TOKEN / OAUTH2 / NONE -> key | bearer | oauth | none. */
export function authCode(authType: unknown): string {
  const raw = typeof authType === 'string' ? authType.trim().toLowerCase() : '';
  if (!raw || raw === 'none') return 'none';
  if (raw.includes('oauth')) return 'oauth';
  if (raw.includes('bearer')) return 'bearer';
  if (raw.includes('key')) return 'key';
  return raw.replace(/[^a-z0-9]+/g, '').slice(0, 8);
}

function ConnectorNodeBase({ data, selected }: NodeProps) {
  const node = data as unknown as FlowNode;
  const codes: NodeChip[] = [{ text: authCode(node.meta?.authType), tone: 'muted' }];
  return (
    <BaseNode
      node={node}
      icon={Plug}
      selected={selected}
      codes={codes}
      stats={compact([callsChip(node.stats?.calls)])}
    />
  );
}

export const ConnectorNode = memo(ConnectorNodeBase);

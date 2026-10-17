'use client';

import { ChevronDown, Clock, Maximize2, Server } from 'lucide-react';
import { AppSelect } from '@/components/ui/select';
import { StatusChip } from '@/components/tool-editor/status-chip';
import { Kbd } from '@/components/tool-editor/kbd';
import { Icon } from '@/components/tool-editor/icon';
import type { FlowWindow } from './types';

const WINDOWS: FlowWindow[] = ['1h', '24h', '7d'];

const TRIGGER =
  'inline-flex h-8 items-center gap-1.5 border-0 bg-transparent px-2 text-[12.5px] text-[var(--text)] outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] data-[state=open]:bg-[var(--surface-2)] disabled:text-[var(--text-3)] focus-visible:outline-none!';
const CONTENT =
  'z-50 min-w-[var(--radix-select-trigger-width)] max-h-72 overflow-auto bg-[var(--surface)] py-1 shadow-[var(--shadow)] focus-visible:outline-none! [&_*:focus-visible]:outline-none!';
const ITEM =
  'flex cursor-pointer select-none items-center px-2.5 py-1.5 text-[12.5px] text-[var(--text)] outline-none data-[highlighted]:bg-[var(--surface-2)] data-[state=checked]:font-medium';
const CHEVRON = <Icon as={ChevronDown} className="text-[var(--text-3)]" />;

interface Props {
  servers: { id: string; name: string }[];
  serverId: string;
  onServerChange: (id: string) => void;
  window: FlowWindow;
  onWindowChange: (w: FlowWindow) => void;
  onFit: () => void;
  /** Counts of the loaded graph, or null while unavailable. */
  counts: { nodes: number; edges: number } | null;
}

export function FlowToolbar({ servers, serverId, onServerChange, window: win, onWindowChange, onFit, counts }: Props) {
  return (
    <>
      <div data-testid="flow-server">
        <AppSelect
          aria-label="Server"
          value={serverId}
          onValueChange={onServerChange}
          disabled={servers.length === 0}
          className={`${TRIGGER} min-w-[140px] max-w-[240px] justify-between`}
          chevron={CHEVRON}
          contentClassName={CONTENT}
          itemClassName={ITEM}
          options={servers.map((s) => ({ value: s.id, label: s.name, icon: <Icon as={Server} /> }))}
        />
      </div>
      <AppSelect
        aria-label="Window"
        testId="flow-window"
        value={win}
        onValueChange={(v) => onWindowChange(v as FlowWindow)}
        className={TRIGGER}
        chevron={CHEVRON}
        contentClassName={CONTENT}
        itemClassName={ITEM}
        options={WINDOWS.map((w) => ({ value: w, label: w, icon: <Icon as={Clock} />, testId: `flow-window-${w}` }))}
      />
      <button
        type="button"
        data-testid="flow-fit"
        onClick={onFit}
        className="inline-flex h-8 items-center gap-1.5 px-2 text-[12.5px] text-[var(--text)] outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none!"
      >
        <Icon as={Maximize2} />
        Fit
        <Kbd>f</Kbd>
      </button>
      <StatusChip tone="neutral" testId="flow-status">
        {counts ? `${counts.nodes} nodes · ${counts.edges} edges · ${win}` : '—'}
      </StatusChip>
    </>
  );
}

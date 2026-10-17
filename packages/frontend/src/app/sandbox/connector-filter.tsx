'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ConnectorOption {
  id: string;
  name: string;
  /** How many saved scripts use the connector. */
  count: number;
  /** False once the connector has been deleted. */
  exists: boolean;
}

function FilterIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" />
    </svg>
  );
}

/**
 * "Filter" button and its pop-up: tick connectors, press Apply, and the list shows only
 * the scripts that use at least one of them. Nothing changes until Apply.
 */
export function ConnectorFilter({
  options,
  applied,
  onApply,
}: {
  options: ConnectorOption[];
  applied: string[];
  onApply: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setDraft((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // Start from what is applied now, so Cancel really discards the changes.
        if (next) setDraft(new Set(applied));
        setOpen(next);
      }}
    >
      <Dialog.Trigger asChild>
        <Button size="sm" variant="secondary" disabled={options.length === 0} data-testid="filter-button">
          <span className="inline-flex items-center gap-1.5">
            <FilterIcon />
            Filter
            {applied.length > 0 && (
              <Badge tone="brand" data-testid="filter-count">
                {applied.length}
              </Badge>
            )}
          </span>
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          data-testid="filter-dialog"
          className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]"
        >
          <Dialog.Title className="text-lg font-semibold text-[var(--text)]">Filter scripts</Dialog.Title>
          <Dialog.Description className="mb-4 mt-1 text-sm text-[var(--text-3)]">
            Show only the scripts that use at least one of the connectors you tick.
          </Dialog.Description>

          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Connector</span>
            <button
              type="button"
              className="text-[12px] text-[var(--text-2)] underline hover:text-[var(--text)] disabled:no-underline disabled:opacity-50"
              onClick={() => setDraft(new Set())}
              disabled={draft.size === 0}
            >
              Clear selection
            </button>
          </div>
          <ul className="max-h-[50dvh] overflow-y-auto rounded-[9px] border border-[var(--border)]">
            {options.map((o) => (
              <li key={o.id} className="border-b border-[var(--border)] last:border-b-0">
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-[var(--surface-2)]">
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--brand)]"
                    checked={draft.has(o.id)}
                    onChange={() => toggle(o.id)}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text)]">{o.name}</span>
                  {!o.exists && <Badge tone="danger">removed</Badge>}
                  <span className="shrink-0 text-[12px] text-[var(--text-3)]">
                    {o.count} script{o.count === 1 ? '' : 's'}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close className={cn(buttonVariants({ variant: 'secondary', size: 'md' }))}>Cancel</Dialog.Close>
            <Button
              onClick={() => {
                onApply([...draft]);
                setOpen(false);
              }}
            >
              Apply
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

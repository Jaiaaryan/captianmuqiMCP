import type { ReactNode } from 'react';

/** A keyboard key, as in a shortcut hint. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] border border-[var(--border)] bg-[var(--surface-2)] px-1 font-mono text-[10.5px] leading-none text-[var(--text-3)]">
      {children}
    </kbd>
  );
}

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type StatusTone = 'neutral' | 'ok' | 'warn' | 'danger';

const TONES: Record<StatusTone, string> = {
  neutral: 'bg-[var(--surface-2)] text-[var(--text-2)]',
  ok: 'bg-[var(--t-success-bg)] text-[var(--t-success-fg)]',
  warn: 'bg-[var(--t-warn-bg)] text-[var(--t-warn-fg)]',
  danger: 'bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]',
};

/** A small read-only label for a state or a count. */
export function StatusChip({
  tone = 'neutral',
  testId,
  children,
}: {
  tone?: StatusTone;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <span
      data-testid={testId}
      className={cn('inline-flex h-6 items-center rounded-full px-2.5 text-[11.5px] font-medium', TONES[tone])}
    >
      {children}
    </span>
  );
}

import { Check, TriangleAlert, X } from 'lucide-react';
import { Icon } from './icon';

export type ChipTone = 'ok' | 'error' | 'warn' | 'neutral';

interface Props {
  tone: ChipTone;
  children: React.ReactNode;
  /** Error sentence from the server; surfaced on hover and to assistive tech. */
  detail?: string;
  testId?: string;
}

/** Icon + text, no fill: valid in success, invalid in danger, a warning in warn, nothing known in text-3. */
export function StatusChip({ tone, children, detail, testId }: Props) {
  return (
    <span
      role="status"
      data-testid={testId}
      data-tone={tone}
      title={detail}
      className={`inline-flex max-w-[280px] items-center gap-1.5 whitespace-nowrap font-mono text-[12px] ${
        tone === 'error'
          ? 'font-medium text-[var(--t-danger-fg)]'
          : tone === 'warn'
            ? 'text-[var(--t-warn-fg)]'
            : tone === 'ok'
              ? 'text-[var(--t-success-fg)]'
              : 'text-[var(--text-3)]'
      }`}
    >
      {tone === 'ok' && <Icon as={Check} />}
      {tone === 'error' && <Icon as={X} />}
      {tone === 'warn' && <Icon as={TriangleAlert} />}
      <span className="truncate">{children}</span>
    </span>
  );
}

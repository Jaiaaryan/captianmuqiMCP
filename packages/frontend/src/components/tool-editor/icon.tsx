import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The one icon box: 14px, one stroke, currentColor. Sits in `items-center gap-1.5` rows. */
export function Icon({ as: As, className }: { as: LucideIcon; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center align-middle',
        className,
      )}
    >
      <As size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden />
    </span>
  );
}

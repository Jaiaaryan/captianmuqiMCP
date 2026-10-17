import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A lucide glyph at the size and weight the dashboard's compact controls use. */
export function Icon({
  as: Glyph,
  className,
  size = 14,
}: {
  as: LucideIcon;
  className?: string;
  size?: number;
}) {
  return <Glyph size={size} strokeWidth={1.75} aria-hidden="true" className={cn('shrink-0', className)} />;
}

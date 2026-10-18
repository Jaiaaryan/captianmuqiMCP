import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Optical correction. Lucide draws on a 24-unit grid with ~2 units of air on
 * every side, so a 16px glyph reads smaller than the text beside it and its
 * visual centre sits slightly above the x-height centre. Scaling the glyph
 * (not the box) and nudging it down half a pixel keeps the layout box at
 * 16px while lining the ink up with the text. 18px boxes (the `⋯` trigger)
 * need a little less scale.
 */
const CORRECTION: Record<16 | 18, string> = {
  16: 'scale(1.125) translateY(0.5px)',
  18: 'scale(1.1) translateY(0.5px)',
};

/**
 * The one icon box: 16px (or 18px), one stroke, currentColor. Put it in a flex
 * row with `items-center` and `leading-none` next to its text.
 */
export function Icon({
  as: As,
  className,
  size = 16,
}: {
  as: LucideIcon;
  className?: string;
  size?: 16 | 18;
}) {
  return (
    <span
      aria-hidden
      data-icon
      className={cn('inline-flex shrink-0 items-center justify-center align-middle leading-none', className)}
      style={{ width: size, height: size }}
    >
      <As
        size={size}
        strokeWidth={1.75}
        aria-hidden
        style={{ display: 'block', overflow: 'visible', transform: CORRECTION[size] }}
      />
    </span>
  );
}

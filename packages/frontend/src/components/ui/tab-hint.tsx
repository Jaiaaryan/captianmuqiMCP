import { cn } from '@/lib/utils';

/**
 * The `Tab` key glyph at the right end of a field whose placeholder Tab accepts.
 * Render it inside the field's `relative` wrapper; `show` = `useTabPlaceholder().hint`
 * (empty and focused). `className` adjusts the position (e.g. `top-2` for a textarea).
 */
export function TabHint({ show, className }: { show: boolean; className?: string }) {
  if (!show) return null;
  return (
    <kbd
      data-testid="tab-hint"
      className={cn(
        'pointer-events-none absolute right-3 top-1/2 inline-flex -translate-y-1/2 items-center font-mono text-[14px] leading-none text-[var(--text-3)]',
        className,
      )}
    >
      Tab
    </kbd>
  );
}

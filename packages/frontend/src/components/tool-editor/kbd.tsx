import { cn } from '@/lib/utils';

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn('inline-flex items-center font-mono text-[11px] leading-none text-[var(--text-3)]', className)}>
      {children}
    </kbd>
  );
}

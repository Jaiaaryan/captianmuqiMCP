export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center font-mono text-[11px] leading-none text-[var(--text-3)]">
      {children}
    </kbd>
  );
}

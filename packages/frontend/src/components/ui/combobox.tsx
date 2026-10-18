'use client';

import { useId, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Icon } from '@/components/tool-editor/icon';
import { cn } from '@/lib/utils';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Second text on the row, right-aligned (a tool name, a count). */
  meta?: string;
}

/**
 * A type-to-filter select: the trigger is a text input, the list opens below it
 * and keeps the options whose label (or meta) contains the typed text. ↑/↓ move,
 * Enter picks, Esc closes and restores. No portal: the list is positioned inside
 * the field's own box, so it works in any scroll container that does not clip.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  mono,
  className,
  testId,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  disabled?: boolean;
  /** Values in mono (tool and script names). */
  mono?: boolean;
  className?: string;
  testId?: string;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const selected = options.find((o) => o.value === value);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q) || (o.meta ?? '').toLowerCase().includes(q));
  }, [options, query]);
  const activeIndex = Math.min(active, Math.max(shown.length - 1, 0));

  const openList = () => {
    if (disabled) return;
    setQuery('');
    const i = options.findIndex((o) => o.value === value);
    setActive(i < 0 ? 0 : i);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const pick = (opt: ComboboxOption | undefined) => {
    if (!opt) return;
    close();
    if (opt.value !== value) onChange(opt.value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (!open) return openList();
        if (!shown.length) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((activeIndex + step + shown.length) % shown.length);
        return;
      }
      case 'Enter':
        if (!open) return;
        e.preventDefault();
        pick(shown[activeIndex]);
        return;
      case 'Escape':
        if (!open) return;
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case 'Tab':
        if (open) close();
        return;
    }
  };

  const optionId = (i: number) => `${listId}-o${i}`;

  return (
    <div className={cn('relative', className)} data-testid={testId}>
      <input
        id={id}
        role="combobox"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown.length ? optionId(activeIndex) : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={open ? query : (selected?.label ?? '')}
        placeholder={open ? (selected?.label ?? placeholder) : placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          if (!open) setOpen(true);
        }}
        onFocus={openList}
        onClick={() => !open && openList()}
        onBlur={close}
        onKeyDown={onKeyDown}
        className={cn(
          'h-9 w-full rounded-md bg-[var(--surface-2)] pl-3 pr-9 text-[14px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50',
          mono && 'font-mono',
        )}
      />
      <span className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center leading-none text-[var(--text-3)]">
        <Icon as={ChevronDown} />
      </span>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 max-h-72 overflow-auto rounded-md bg-[var(--surface)] p-1 shadow-[var(--shadow)]"
        >
          {shown.length ? (
            shown.map((o, i) => (
              <li
                key={o.value}
                id={optionId(i)}
                role="option"
                aria-selected={o.value === value}
                // Keep focus in the input so blur does not close the list before the pick.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-[14px] leading-tight text-[var(--text)]',
                  i === activeIndex && 'bg-[var(--surface-3)]',
                  o.value === value && 'font-semibold',
                  mono && 'font-mono',
                )}
              >
                <span className="truncate">{o.label}</span>
                {o.meta && <span className="shrink-0 font-mono text-[14px] text-[var(--text-3)]">{o.meta}</span>}
              </li>
            ))
          ) : (
            <li role="option" aria-selected={false} aria-disabled className="px-2.5 py-1.5 text-[14px] text-[var(--text-3)]">
              —
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

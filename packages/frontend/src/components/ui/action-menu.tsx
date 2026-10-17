'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export interface ActionMenuItem {
  label: string;
  /** Leading icon. Same family and stroke as the toolbar buttons. */
  icon?: React.ReactNode;
  onSelect?: () => void;
  /** Renders the item as a link instead of a button. */
  href?: string;
  disabled?: boolean;
  /** Tints the item with the danger colour; keep it for real destruction. */
  destructive?: boolean;
  testId?: string;
  /** Marks the current choice of a set (trailing check). */
  checked?: boolean;
  /** Flat menus: a state colour for the icon and label (`fail` danger, `skip` warn). */
  tone?: 'danger' | 'warn' | 'success';
}

export interface ActionMenuGroup {
  label?: string;
  items: ActionMenuItem[];
}

/**
 * Square, grayscale look for dense editors (no radius, no border, no tint).
 * Colour only for state: `destructive` and `tone` items, and the check of the
 * current choice.
 */
const FLAT = {
  trigger:
    'inline-flex items-center gap-1.5 rounded-none px-1 py-0.5 text-[12.5px] text-[var(--text)] outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] data-[state=open]:bg-[var(--surface-2)] disabled:pointer-events-none disabled:text-[var(--text-3)] focus-visible:outline-none!',
  content:
    'z-50 min-w-[180px] overflow-hidden rounded-none bg-[var(--surface)] py-1 shadow-[var(--shadow)] focus-visible:outline-none! [&_*:focus-visible]:outline-none!',
  item: 'flex cursor-pointer select-none items-center gap-1.5 rounded-none px-2.5 py-1.5 text-[12.5px] text-[var(--text)] outline-none hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] data-[disabled]:pointer-events-none data-[disabled]:text-[var(--text-3)]',
  label: 'px-2.5 pb-0.5 pt-1.5 text-[11px] uppercase tracking-[0.04em] text-[var(--text-3)]',
  tone: {
    danger: 'text-[var(--t-danger-fg)]',
    warn: 'text-[var(--t-warn-fg)]',
    success: 'text-[var(--t-success-fg)]',
  },
};

/**
 * Overflow menu for a page toolbar.
 *
 * A phone gives a toolbar about one row. Pages that carry five actions —
 * Connectors has Health Check, Export, Import, Adapters and Add Connector —
 * either wrap to three header rows or hide their labels behind icons, and an
 * icon has no tooltip on touch. This keeps the primary action in the header
 * and moves the rest in here, where every entry still says what it does.
 *
 * Styling follows `MultiSelect`, which is the other dropdown in the app.
 */
export function ActionMenu({
  items = [],
  groups,
  label = 'More actions',
  className,
  trigger,
  testId,
  disabled,
  align = 'end',
  variant = 'default',
}: {
  items?: ActionMenuItem[];
  /** Labelled sections; used instead of `items` when given. */
  groups?: ActionMenuGroup[];
  /** Accessible name for the trigger. */
  label?: string;
  className?: string;
  /** Trigger content; defaults to the vertical-dots icon. */
  trigger?: React.ReactNode;
  /** data-testid on the trigger. */
  testId?: string;
  disabled?: boolean;
  align?: 'start' | 'center' | 'end';
  variant?: 'default' | 'flat';
}) {
  const sections: ActionMenuGroup[] = groups ?? [{ items }];
  const visible = sections.flatMap((g) => g.items.filter(Boolean));
  if (visible.length === 0) return null;
  const flat = variant === 'flat';

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={label}
        title={label}
        disabled={disabled}
        data-testid={testId}
        className={cn(
          flat
            ? FLAT.trigger
            : 'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[9px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] outline-none transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)] data-[state=open]:border-[var(--border-strong)] data-[state=open]:text-[var(--text)]',
          className
        )}
      >
        {trigger ?? (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="5" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="19" r="1.6" />
          </svg>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={flat ? 4 : 6}
          collisionPadding={8}
          className={
            flat
              ? FLAT.content
              : 'z-50 min-w-[200px] overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow)]'
          }
        >
          {sections.map((group, gi) => (
            <DropdownMenu.Group key={group.label ?? gi}>
              {group.label && (
                <DropdownMenu.Label
                  className={flat ? FLAT.label : 'px-2.5 pb-1 pt-2 text-[11px] text-[var(--text-3)]'}
                >
                  {group.label}
                </DropdownMenu.Label>
              )}
              {group.items.filter(Boolean).map((item) => {
                const tone = item.tone ?? (item.destructive ? 'danger' : undefined);
                const cls = flat
                  ? cn(FLAT.item, tone && FLAT.tone[tone])
                  : cn(
                      'flex cursor-pointer select-none items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-[13px] outline-none',
                      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                      item.destructive
                        ? 'text-[var(--danger)] hover:bg-[var(--t-danger-bg)] focus:bg-[var(--t-danger-bg)]'
                        : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus:bg-[var(--surface-2)] focus:text-[var(--text)]'
                    );
                const body = (
                  <>
                    {item.icon}
                    <span className="truncate">{item.label}</span>
                    {item.checked && (
                      <svg
                        className={cn('ml-auto shrink-0', flat && FLAT.tone.success)}
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </>
                );
                return (
                  <DropdownMenu.Item
                    key={item.label}
                    disabled={item.disabled}
                    onSelect={item.onSelect}
                    asChild={!!item.href}
                    data-testid={item.href ? undefined : item.testId}
                    className={item.href ? undefined : cls}
                  >
                    {item.href ? (
                      <Link href={item.href} className={cls} data-testid={item.testId}>
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </DropdownMenu.Item>
                );
              })}
            </DropdownMenu.Group>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

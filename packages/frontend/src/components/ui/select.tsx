'use client';

import * as Select from '@radix-ui/react-select';
import { cn } from '@/lib/utils';

const NONE = '__NONE__';

export interface AppSelectOption {
  value: string;
  label: string;
  /** Leading icon, shown in the list and in the trigger. */
  icon?: React.ReactNode;
  testId?: string;
  /** Extra classes for the item (a state colour). */
  className?: string;
}

export interface AppSelectGroup {
  label: string;
  options: AppSelectOption[];
}

interface AppSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Flat list. Ignored when `groups` is given. */
  options?: AppSelectOption[];
  /** Labelled sections (Radix Select groups). */
  groups?: AppSelectGroup[];
  className?: string;
  disabled?: boolean;
  /** The trigger is a button, not a <select>, so it needs an explicit name. */
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-invalid'?: boolean;
  /** data-testid on the trigger. */
  testId?: string;
  /** Shown in the trigger instead of the selected option's label. */
  valueLabel?: React.ReactNode;
  /** Replaces the default chevron. */
  chevron?: React.ReactNode;
  /** Replace the default list and item classes. */
  contentClassName?: string;
  itemClassName?: string;
  groupLabelClassName?: string;
}

const CONTENT =
  'bg-[var(--background)] border border-[var(--border)] rounded-md shadow-md min-w-[var(--radix-select-trigger-width)] max-h-60 overflow-auto z-50';
const ITEM =
  'px-3 py-1.5 text-sm cursor-pointer outline-none select-none hover:bg-[var(--accent)] focus:bg-[var(--accent)] data-[disabled]:opacity-50 data-[disabled]:pointer-events-none';
const GROUP_LABEL = 'px-3 pb-0.5 pt-1.5 text-[11px] text-[var(--muted-foreground)]';

export function AppSelect({
  value,
  onValueChange,
  options = [],
  groups,
  className,
  disabled,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-invalid': ariaInvalid,
  testId,
  chevron,
  valueLabel,
  contentClassName,
  itemClassName,
  groupLabelClassName,
}: AppSelectProps) {
  const radixValue = value === '' ? NONE : value;

  const item = (opt: AppSelectOption) => (
    <Select.Item
      key={opt.value === '' ? NONE : opt.value}
      value={opt.value === '' ? NONE : opt.value}
      data-testid={opt.testId}
      className={cn(itemClassName ?? ITEM, opt.className)}
    >
      <Select.ItemText>
        {opt.icon ? (
          <span className="inline-flex items-center gap-1.5">
            {opt.icon}
            {opt.label}
          </span>
        ) : (
          opt.label
        )}
      </Select.ItemText>
    </Select.Item>
  );

  return (
    <Select.Root
      value={radixValue}
      onValueChange={(v) => onValueChange(v === NONE ? '' : v)}
      disabled={disabled}
    >
      <Select.Trigger
        className={cn('flex items-center justify-between gap-2', className)}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-invalid={ariaInvalid || undefined}
        data-testid={testId}
      >
        <Select.Value>{valueLabel}</Select.Value>
        <Select.Icon asChild>
          {chevron ?? (
            <svg
              className="w-4 h-4 text-[var(--muted-foreground)] flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
            </svg>
          )}
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className={contentClassName ?? CONTENT}
        >
          <Select.Viewport>
            {groups
              ? groups.map((g) => (
                  <Select.Group key={g.label}>
                    <Select.Label className={groupLabelClassName ?? GROUP_LABEL}>
                      {g.label}
                    </Select.Label>
                    {g.options.map(item)}
                  </Select.Group>
                ))
              : options.map(item)}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

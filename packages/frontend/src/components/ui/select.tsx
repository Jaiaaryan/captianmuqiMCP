'use client';

import type { ReactNode } from 'react';
import * as Select from '@radix-ui/react-select';

const NONE = '__NONE__';

interface AppSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: {
    value: string;
    label: string;
    /** Shown before the label in the list. */
    icon?: ReactNode;
    testId?: string;
  }[];
  className?: string;
  /** Replaces the default list styling (border, background, spacing). */
  contentClassName?: string;
  /** Replaces the default item styling. */
  itemClassName?: string;
  /** Replaces the default chevron. */
  chevron?: ReactNode;
  /** data-testid of the trigger. */
  testId?: string;
  disabled?: boolean;
  /** The trigger is a button, not a <select>, so it needs an explicit name. */
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

export function AppSelect({
  value,
  onValueChange,
  options,
  className,
  contentClassName,
  itemClassName,
  chevron,
  testId,
  disabled,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: AppSelectProps) {
  const radixValue = value === '' ? NONE : value;

  return (
    <Select.Root
      value={radixValue}
      onValueChange={(v) => onValueChange(v === NONE ? '' : v)}
      disabled={disabled}
    >
      <Select.Trigger
        className={`flex items-center justify-between gap-2 ${className ?? ''}`}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        data-testid={testId}
      >
        <Select.Value />
        {chevron ? (
          <Select.Icon>{chevron}</Select.Icon>
        ) : (
          <Select.Icon asChild>
            <svg
              className="w-4 h-4 text-[var(--muted-foreground)] flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
            </svg>
          </Select.Icon>
        )}
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className={
            contentClassName ??
            'bg-[var(--background)] border border-[var(--border)] rounded-md shadow-md min-w-[var(--radix-select-trigger-width)] max-h-60 overflow-auto z-50'
          }
        >
          <Select.Viewport>
            {options.map((opt) => (
              <Select.Item
                key={opt.value === '' ? NONE : opt.value}
                value={opt.value === '' ? NONE : opt.value}
                data-testid={opt.testId}
                className={
                  itemClassName ??
                  'px-3 py-1.5 text-sm cursor-pointer outline-none select-none hover:bg-[var(--accent)] focus:bg-[var(--accent)] data-[disabled]:opacity-50 data-[disabled]:pointer-events-none'
                }
              >
                {opt.icon}
                <Select.ItemText>{opt.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Field = HTMLInputElement | HTMLTextAreaElement;

export interface TabPlaceholderOptions {
  /** The field's current value. */
  value: string;
  /** The example shown as placeholder; empty or undefined turns the behaviour off. */
  placeholder: string | undefined;
  /** Sets the value (the component's own onChange path). */
  onAccept: (value: string) => void;
}

/**
 * Tab (no modifiers) in an empty field with a placeholder accepts the placeholder
 * as the value, caret at the end. Shift+Tab, a field with text, or no placeholder:
 * Tab does what it always does.
 *
 *   const tab = useTabPlaceholder({ value, placeholder, onAccept: setValue });
 *   <div className="relative">
 *     <input value={value} placeholder={placeholder} onKeyDown={tab.onKeyDown}
 *            onFocus={tab.onFocus} onBlur={tab.onBlur} />
 *     <TabHint show={tab.hint} />
 *   </div>
 *
 * Returns `{ onKeyDown, onFocus, onBlur, hint }`; `hint` is true while the field
 * is empty and focused. Chain your own handlers if the field already has them.
 */
export function useTabPlaceholder<T extends Field = Field>({ value, placeholder, onAccept }: TabPlaceholderOptions) {
  const [focused, setFocused] = useState(false);
  const accept = useRef(onAccept);
  useEffect(() => {
    accept.current = onAccept;
  });

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<T>) => {
      if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return;
      const el = e.currentTarget;
      if (el.value !== '' || !placeholder) return;
      e.preventDefault();
      accept.current(placeholder);
      const end = placeholder.length;
      requestAnimationFrame(() => {
        if (document.activeElement === el) el.setSelectionRange(end, end);
      });
    },
    [placeholder],
  );
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);

  return { onKeyDown, onFocus, onBlur, hint: focused && value === '' && !!placeholder };
}

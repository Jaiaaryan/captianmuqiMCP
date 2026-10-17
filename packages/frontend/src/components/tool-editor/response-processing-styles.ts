/**
 * Class strings shared by the Response Processing panel: square, grayscale
 * skeleton, no boxes. Editable things carry a 1px bottom line; state (invalid,
 * skip, fail, ok) is the only thing that gets colour, from the --t-* tokens.
 */

/** The bottom line that marks a control as editable. */
const LINE = 'border-b border-[var(--border-strong)]';

/** Bottom line colour for a field's state. */
export const LINE_TONE = {
  danger: 'border-[var(--t-danger-fg)]!',
  warn: 'border-[var(--t-warn-fg)]!',
} as const;
export type FieldTone = keyof typeof LINE_TONE;

/** Text colour for a state. */
export const TONE_TEXT = {
  danger: 'text-[var(--t-danger-fg)]',
  warn: 'text-[var(--t-warn-fg)]',
  success: 'text-[var(--t-success-fg)]',
  muted: 'text-[var(--text-3)]',
} as const;

/** A dropdown trigger: value + chevron over the editable line. */
export const TRIGGER =
  `inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 ${LINE} bg-transparent px-1 text-[12.5px] text-[var(--text)] outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-3)] data-[state=open]:bg-[var(--surface-3)] aria-[invalid=true]:border-[var(--t-danger-fg)] disabled:pointer-events-none disabled:text-[var(--text-3)] focus-visible:outline-none!`;

/** Header-level trigger (not inside a row). */
export const HEADER_TRIGGER = TRIGGER;

export const CONTENT =
  'z-50 min-w-[var(--radix-select-trigger-width)] max-h-72 overflow-auto bg-[var(--surface)] py-1 shadow-[var(--shadow)] focus-visible:outline-none! [&_*:focus-visible]:outline-none!';

export const ITEM =
  'flex cursor-pointer select-none items-center px-2.5 py-1.5 text-[12.5px] text-[var(--text)] outline-none data-[highlighted]:bg-[var(--surface-2)] data-[state=checked]:font-medium data-[disabled]:pointer-events-none data-[disabled]:text-[var(--text-3)] focus-visible:outline-none!';

export const GROUP_LABEL = 'px-2.5 pb-0.5 pt-1.5 text-[11px] uppercase tracking-[0.04em] text-[var(--text-3)]';

/** Monospace text field over the editable line; its own fill on hover and focus, no ring. */
export const CELL =
  `h-6 min-w-0 ${LINE} bg-transparent px-1 font-mono text-[12.5px] text-[var(--text)] outline-none placeholder:italic placeholder:text-[var(--text-3)] hover:bg-[var(--surface-2)] focus:bg-[var(--surface-3)] aria-[invalid=true]:border-[var(--t-danger-fg)] focus-visible:outline-none!`;

/** Hides the number spinners. */
export const NO_SPIN =
  '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

/** Plain text button: icon + label. */
export const TEXT_BUTTON =
  'inline-flex h-6 items-center gap-1.5 px-1 text-[12.5px] text-[var(--text)] outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] disabled:pointer-events-none disabled:text-[var(--text-3)] focus-visible:outline-none!';

/**
 * Class strings shared by the Response Processing panel (shadcn feel): 6px
 * controls, 8px cards, no borders. Two surface levels: step cards and the
 * response tree sit on --surface-2; fields, params and code on --surface.
 * Nothing is smaller than 14px. Colour only for state, and bright semantic
 * colours only for text and icons (filled "on" uses --ok-fill).
 */

/** Text colour for a state. */
export const TONE_TEXT = {
  danger: 'text-[var(--t-danger-fg)]',
  warn: 'text-[var(--t-warn-fg)]',
  success: 'text-[var(--t-success-fg)]',
  muted: 'text-[var(--text-3)]',
} as const;
export type FieldTone = 'danger' | 'warn';

const FOCUS = 'outline-none focus-visible:outline-none! focus-visible:ring-2 focus-visible:ring-[var(--brand)]';

/** An icon + text row: everything that pairs a glyph with a word sits in one. */
export const ROW = 'inline-flex items-center leading-none';

/** Dropdown trigger on a host surface (header): 32px, surface-2. */
export const SELECT = `${ROW} h-8 gap-1.5 rounded-md bg-[var(--surface-2)] px-3 text-sm leading-none text-[var(--text)] [&>span]:inline-flex [&>span]:items-center hover:bg-[var(--surface-3)] data-[state=open]:bg-[var(--surface-3)] disabled:pointer-events-none disabled:text-[var(--text-3)] ${FOCUS}`;

/**
 * Step-card title row: the processor select, the mode select and the `⋯` trigger
 * share one 32px box and one centre. `leading-none` comes after `text-sm` because
 * AppSelect merges classes with tailwind-merge, which drops a `leading-*` placed
 * before a font size; `[&>span]` centres Radix's `Select.Value` span, which would
 * otherwise sit an inline-flex label on a 20px text baseline (2.5px high).
 */
const TITLE_CONTROL = `${ROW} h-8 gap-1.5 rounded-md bg-transparent px-1.5 text-sm leading-none [&>span]:inline-flex [&>span]:items-center [&>span]:leading-none hover:bg-[var(--surface-3)] data-[state=open]:bg-[var(--surface-3)] ${FOCUS}`;

/** Dropdown trigger inside a step card: no fill of its own, text-2. */
export const SELECT_FLAT = `${TITLE_CONTROL} text-[var(--text-2)] hover:text-[var(--text)]`;

/** The mode dropdown inside a step card: the value in --text. */
export const SELECT_MODE = `${TITLE_CONTROL} text-[var(--text)]`;

/** The `⋯` trigger of a step card (ActionMenu flat; its own `py` is reset). */
export const MENU_TRIGGER = `${ROW} h-8 rounded-md px-1 py-0 leading-none text-[var(--text-3)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]`;

/** Lists open over the sheet (z-80, above the app sidebar's z-70). */
export const MENU =
  'z-[90] min-w-[var(--radix-select-trigger-width)] max-h-80 overflow-auto rounded-md bg-[var(--surface)] p-1 shadow-[var(--shadow)] focus-visible:outline-none! [&_*:focus-visible]:outline-none!';

export const MENU_ITEM =
  'flex cursor-pointer select-none items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-sm leading-none text-[var(--text)] outline-none data-[highlighted]:bg-[var(--surface-2)] data-[state=checked]:font-medium data-[disabled]:pointer-events-none data-[disabled]:text-[var(--text-3)] focus-visible:outline-none!';

/** ActionMenu (flat) overrides: the same list look as MENU. */
export const ACTION_MENU = 'z-[90] min-w-[200px] rounded-md p-1';
export const ACTION_ITEM = 'gap-2 rounded-[4px] text-sm leading-none';

export const GROUP_LABEL = 'px-2.5 pb-1 pt-2 text-sm text-[var(--text-3)]';

/** Buttons: secondary (surface-2), primary (inverted), ghost (no fill). */
const BTN = `${ROW} h-9 shrink-0 gap-2 rounded-md px-3.5 text-sm font-medium disabled:pointer-events-none disabled:opacity-50 ${FOCUS}`;
export const BTN_SECONDARY = `${BTN} bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--surface-3)]`;
export const BTN_PRIMARY = `${BTN} bg-[var(--text)] text-[var(--surface)] hover:opacity-90`;
export const BTN_GHOST = `${ROW} h-[30px] shrink-0 gap-2 rounded-md px-2 text-sm text-[var(--text-2)] hover:bg-[var(--surface-3)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-50 ${FOCUS}`;

/** Monospace value box on --surface (params, pipe values). */
export const VALUE_INPUT =
  `h-[30px] min-w-0 rounded-md bg-[var(--surface)] px-2.5 font-mono text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:ring-2 focus:ring-[var(--brand)] aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--t-danger-fg)] focus-visible:outline-none!`;

/** Hides the number spinners. */
export const NO_SPIN =
  '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

/** Width of a monospace field, sized to its content. */
export function chWidth(text: string, placeholder = '', min = 3, pad = 0): React.CSSProperties {
  return { width: `calc(${Math.max(min, (text || placeholder).length)}ch + ${pad}px)` };
}

/* ------------------------------------------------------------------ */
/*  Dense line style (sandbox script parameters): unchanged            */
/* ------------------------------------------------------------------ */

const LINE = 'border-b border-[var(--border-strong)]';

/** A dropdown trigger: value + chevron over the editable line. */
export const TRIGGER =
  `inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 ${LINE} bg-transparent px-1 text-[12.5px] text-[var(--text)] outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-3)] data-[state=open]:bg-[var(--surface-3)] aria-[invalid=true]:border-[var(--t-danger-fg)] disabled:pointer-events-none disabled:text-[var(--text-3)] focus-visible:outline-none!`;

export const CONTENT =
  'z-50 min-w-[var(--radix-select-trigger-width)] max-h-72 overflow-auto bg-[var(--surface)] py-1 shadow-[var(--shadow)] focus-visible:outline-none! [&_*:focus-visible]:outline-none!';

export const ITEM =
  'flex cursor-pointer select-none items-center px-2.5 py-1.5 text-[12.5px] text-[var(--text)] outline-none data-[highlighted]:bg-[var(--surface-2)] data-[state=checked]:font-medium data-[disabled]:pointer-events-none data-[disabled]:text-[var(--text-3)] focus-visible:outline-none!';

/** Monospace text field over the editable line; its own fill on hover and focus, no ring. */
export const CELL =
  `h-6 min-w-0 ${LINE} bg-transparent px-1 font-mono text-[12.5px] text-[var(--text)] outline-none placeholder:italic placeholder:text-[var(--text-3)] hover:bg-[var(--surface-2)] focus:bg-[var(--surface-3)] aria-[invalid=true]:border-[var(--t-danger-fg)] focus-visible:outline-none!`;

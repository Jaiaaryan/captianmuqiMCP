// Class strings shared by the compact table-style editors (the parameters of a script, the
// steps of a processing chain): a select trigger, its list and items, and a text cell. The
// controls sit flush in a table cell, so they carry no border of their own.

export const TRIGGER =
  'inline-flex h-8 w-full items-center justify-between gap-1.5 border-0 bg-transparent px-2 text-[12.5px] text-[var(--text)] outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] data-[state=open]:bg-[var(--surface-2)] disabled:text-[var(--text-3)] focus-visible:outline-none!';

export const CONTENT =
  'z-50 min-w-[var(--radix-select-trigger-width)] max-h-72 overflow-auto bg-[var(--surface)] py-1 shadow-[var(--shadow)] focus-visible:outline-none! [&_*:focus-visible]:outline-none!';

export const ITEM =
  'flex cursor-pointer select-none items-center gap-2 px-2.5 py-1.5 text-[12.5px] text-[var(--text)] outline-none data-[highlighted]:bg-[var(--surface-2)] data-[state=checked]:font-medium';

export const CELL =
  'h-8 border-0 bg-transparent px-2 text-[12.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)] hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] disabled:text-[var(--text-3)]';

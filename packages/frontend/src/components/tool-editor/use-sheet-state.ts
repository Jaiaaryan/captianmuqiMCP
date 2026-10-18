'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** The URL hash while the Response Processing sheet is open. */
export const SHEET_HASH = '#processing';

/** Where the sheet should land when it opens: a step to expand, a field to focus, a preview to run. */
export interface SheetRequest {
  nonce: number;
  stepId?: string;
  focus?: 'id' | 'reads';
  preview?: boolean;
}

// With two tool editors on the page (a new one and an edited one), only the
// latest mounted one answers ⌘. and Esc.
const owners: symbol[] = [];

function setHash(open: boolean) {
  const { pathname, search, hash } = window.location;
  if (open === (hash === SHEET_HASH)) return;
  // replaceState: no navigation, no history entry. Keep Next's own history state.
  window.history.replaceState(window.history.state, '', `${pathname}${search}${open ? SHEET_HASH : ''}`);
}

/**
 * Open/close state of the Response Processing sheet: `#processing` in the URL
 * while open (and open on mount when it is there), ⌘. / Ctrl+. toggles from
 * anywhere on the page, Esc closes (unless something inside handled it).
 */
export function useSheetState(enabled: boolean) {
  const [isOpen, setOpen] = useState(
    () => typeof window !== 'undefined' && window.location.hash === SHEET_HASH,
  );
  const [request, setRequest] = useState<SheetRequest | null>(null);
  const open = enabled && isOpen;
  const nonce = useRef(0);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const openSheet = useCallback((req?: Omit<SheetRequest, 'nonce'>) => {
    if (req) setRequest({ ...req, nonce: ++nonce.current });
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  // URL hash follows the state; leaving the editor drops it.
  useEffect(() => {
    if (!enabled) return;
    setHash(open);
  }, [open, enabled]);
  useEffect(() => () => setHash(false), []);

  useEffect(() => {
    if (!enabled) return;
    const me = Symbol('rp-sheet');
    owners.push(me);
    const mine = () => owners[owners.length - 1] === me;

    // Capture: ⌘. must win over Monaco (its Quick Fix binding).
    const onToggleKey = (e: KeyboardEvent) => {
      if (!mine() || e.key !== '.' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen((o) => !o);
    };
    // Bubble: a field, a menu or the preview that handles Esc first keeps the sheet open.
    const onEscape = (e: KeyboardEvent) => {
      if (!mine() || !openRef.current || e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener('keydown', onToggleKey, true);
    document.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('keydown', onToggleKey, true);
      document.removeEventListener('keydown', onEscape);
      const i = owners.indexOf(me);
      if (i >= 0) owners.splice(i, 1);
    };
  }, [enabled]);

  return { open, request, openSheet, close };
}

// One stack per shortcut: the save keys answer for the latest mounted editor only.
const saveOwners: symbol[] = [];

/**
 * ⌘S / Ctrl+S runs `save` (the editor's Update Tool) while the tool editor is
 * mounted, page or sheet: one capture-phase listener per editor, so the sheet
 * (part of the same editor) never adds a second one, and the browser's save
 * dialog never shows. With `canSave` false (invalid form, save in flight) the
 * key is swallowed and nothing else happens.
 */
export function useSaveShortcut(save: () => void, canSave: boolean) {
  const latest = useRef({ save, canSave });
  useEffect(() => {
    latest.current = { save, canSave };
  }, [save, canSave]);

  useEffect(() => {
    const me = Symbol('tool-save');
    saveOwners.push(me);
    const onSaveKey = (e: KeyboardEvent) => {
      if (saveOwners[saveOwners.length - 1] !== me) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || e.isComposing || !latest.current.canSave) return;
      // Until the next render reports `saving`, a second press does nothing.
      latest.current = { ...latest.current, canSave: false };
      latest.current.save();
    };
    window.addEventListener('keydown', onSaveKey, true);
    return () => {
      window.removeEventListener('keydown', onSaveKey, true);
      const i = saveOwners.indexOf(me);
      if (i >= 0) saveOwners.splice(i, 1);
    };
  }, []);
}

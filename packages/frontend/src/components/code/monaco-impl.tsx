'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { activateLibs, releaseLibs, setupJavaScript, setupMonaco, type ExtraLib } from './monaco-setup';
import { THEME, watchTheme } from './monaco-theme';
import { FONT_FAMILY, FONT_SIZE, LINE_HEIGHT, PAD, SCROLLBAR, TEXT_LEFT, editorHeight } from './monaco-layout';

// Square corners and no focus outline inside the editor and its widgets.
const CSS = `
.amcp-monaco .monaco-editor, .amcp-monaco .monaco-editor * { border-radius: 0 !important; }
.amcp-monaco .monaco-editor *:focus-visible, .amcp-monaco .monaco-editor:focus-visible { outline: none !important; }
.amcp-monaco .monaco-editor .suggest-widget, .amcp-monaco .monaco-editor .monaco-hover { box-shadow: var(--shadow) !important; }
`;

export interface MonacoImplProps {
  value: string;
  onChange: (value: string) => void;
  language: 'javascript' | 'json';
  extraLibs?: ExtraLib[];
  /** Extra TS diagnostic codes to hide (1108 is always hidden). */
  ignoreDiagnostics?: number[];
  minLines: number;
  maxLines: number;
  /** Accessible name of Monaco's own input. */
  editorLabel: string;
  testId?: string;
  onSubmit?: () => void;
  onEscape?: () => void;
  /** Directory of the model's URI: decides which snippet providers answer. */
  modelDir: string;
  onReady: () => void;
  /**
   * Called once the editor is shown: the selection (offsets) to take over when the
   * user had already focused the stand-in, else null (focus stays where it is).
   */
  claimFocus?: () => [number, number] | null;
  /** Ghost text (`--text-3`) while the model is empty; Tab then inserts it. */
  placeholder?: string;
  fontSize?: number;
  lineHeight?: number;
}

export default function MonacoImpl({
  value,
  onChange,
  language,
  extraLibs = [],
  ignoreDiagnostics = [],
  minLines,
  maxLines,
  editorLabel,
  testId,
  onSubmit,
  onEscape,
  modelDir,
  onReady,
  claimFocus,
  placeholder,
  fontSize = FONT_SIZE,
  lineHeight = LINE_HEIGHT,
}: MonacoImplProps) {
  const monaco = setupMonaco();
  const isJs = language === 'javascript';
  if (isJs) setupJavaScript();
  const owner = useId().replace(/[^\w-]/g, '');
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const clamp = (lines: number) => editorHeight(lines, minLines, maxLines, lineHeight);
  const [height, setHeight] = useState(() => clamp(value.split('\n').length));

  // Latest props for callbacks registered once at mount.
  const latest = useRef({ value, extraLibs, ignoreDiagnostics, onSubmit, onEscape, claimFocus, placeholder });
  useEffect(() => {
    latest.current = { value, extraLibs, ignoreDiagnostics, onSubmit, onEscape, claimFocus, placeholder };
  });

  // Tab accepts the placeholder only while the model is empty: a context key of
  // this editor alone (keybindings are shared by every editor on the page).
  const acceptKey = `amcpAcceptPlaceholder_${owner.replace(/-/g, '_')}`;
  const syncAccept = useRef<() => void>(() => {});
  useEffect(() => {
    editorRef.current?.updateOptions({ placeholder: placeholder ?? '' });
    syncAccept.current();
  }, [placeholder]);

  const libsKey = JSON.stringify(extraLibs) + JSON.stringify(ignoreDiagnostics);
  useEffect(() => {
    if (isJs) activateLibs(owner, extraLibs, ignoreDiagnostics);
    // libsKey stands for both arrays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, libsKey, isJs]);

  // Uncontrolled editor: only a value that did not come from the editor itself
  // (undo of a step, a preset, a reload) is pushed back in. Echoing every
  // keystroke through React state would drop keys typed between renders.
  // A render may still carry a value the editor has already moved past, so
  // every recently emitted value counts as an echo, not just the last one.
  const emitted = useRef<Set<string>>(new Set([value]));
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || emitted.current.has(value) || value === editor.getValue()) return;
    emitted.current = new Set([value]);
    const model = editor.getModel();
    if (model) editor.executeEdits('external', [{ range: model.getFullModelRange(), text: value }]);
  }, [value]);

  useEffect(() => watchTheme(monaco), [monaco]);
  useEffect(() => () => releaseLibs(owner), [owner]);

  const onMount: OnMount = (editor, m) => {
    editorRef.current = editor;
    // Text typed into the stand-in while the editor was being created.
    const model = editor.getModel();
    if (model && editor.getValue() !== latest.current.value) {
      emitted.current = new Set([latest.current.value]);
      model.setValue(latest.current.value);
    }
    const fit = () => {
      const lines = editor.getModel()?.getLineCount() ?? 1;
      setHeight(clamp(Math.ceil((editor.getContentHeight() - PAD) / lineHeight)));
      editor.updateOptions({ lineNumbers: lines > 20 ? 'on' : 'off' });
    };
    editor.onDidContentSizeChange(fit);
    fit();
    if (isJs)
      editor.onDidFocusEditorText(() =>
        activateLibs(owner, latest.current.extraLibs, latest.current.ignoreDiagnostics, true),
      );
    // ⌘↵ / Ctrl↵ belongs to the page (Preview, Run): Monaco would insert a line.
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => {
      if (latest.current.onSubmit) latest.current.onSubmit();
      else
        containerRef.current?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true }),
        );
    });
    // Esc with no editor widget open belongs to the page (close the preview, a menu).
    editor.addCommand(
      m.KeyCode.Escape,
      () => {
        if (latest.current.onEscape) latest.current.onEscape();
        else
          containerRef.current?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      },
      '!suggestWidgetVisible && !findWidgetVisible && !parameterHintsVisible && !renameInputVisible && !inSnippetMode && !hasMultipleSelections && !markersNavigationVisible',
    );
    const canAccept = editor.createContextKey<boolean>(acceptKey, false);
    syncAccept.current = () =>
      canAccept.set(!!latest.current.placeholder && (editor.getModel()?.getValueLength() ?? 1) === 0);
    editor.onDidChangeModelContent(() => syncAccept.current());
    syncAccept.current();
    editor.addCommand(
      m.KeyCode.Tab,
      () => {
        const text = latest.current.placeholder;
        const current = editor.getModel();
        if (!text || !current) return;
        editor.executeEdits('placeholder', [{ range: current.getFullModelRange(), text }]);
        const end = current.getPositionAt(text.length);
        editor.setPosition(end);
        editor.pushUndoStop();
      },
      `${acceptKey} && editorTextFocus && !suggestWidgetVisible && !inSnippetMode`,
    );
    // Swap only once Monaco has painted its lines (it renders on an animation
    // frame), so the stand-in's text never gives way to an empty box.
    let frames = 0;
    const painted = () => {
      const el = containerRef.current;
      if (el && !el.querySelector('.view-lines .view-line') && ++frames < 30) {
        requestAnimationFrame(painted);
        return;
      }
      frames = 0;
      onReady();
      requestAnimationFrame(takeFocus);
    };
    // Focus moves only if the user had put it in the stand-in; the caret comes along.
    // Wait until the swap has rendered: a hidden editor cannot take focus.
    const takeFocus = () => {
      const el = containerRef.current;
      if (el && getComputedStyle(el).visibility === 'hidden' && ++frames < 30) {
        requestAnimationFrame(takeFocus);
        return;
      }
      const claimed = latest.current.claimFocus?.();
      if (!claimed || !model) return;
      const start = model.getPositionAt(claimed[0]);
      const end = model.getPositionAt(claimed[1]);
      editor.setSelection(new m.Selection(start.lineNumber, start.column, end.lineNumber, end.column));
      editor.focus();
    };
    requestAnimationFrame(painted);
  };

  return (
    <div
      ref={containerRef}
      data-testid={testId ? `${testId}-editor` : undefined}
      className="amcp-monaco w-full focus-within:bg-[var(--surface-2)]"
      style={{ height }}
    >
      <style>{CSS}</style>
      <Editor
        defaultValue={value}
        onChange={(v) => {
          const text = v ?? '';
          emitted.current.add(text);
          if (emitted.current.size > 200) emitted.current = new Set([text]);
          onChange(text);
        }}
        language={language}
        path={`file://${modelDir}${owner}.${language === 'json' ? 'json' : 'js'}`}
        theme={THEME}
        loading={null}
        onMount={onMount}
        options={{
          ariaLabel: editorLabel,
          placeholder: placeholder ?? '',
          fontFamily: FONT_FAMILY,
          fontSize,
          lineHeight,
          minimap: { enabled: false },
          lineNumbers: 'off',
          lineDecorationsWidth: TEXT_LEFT,
          lineNumbersMinChars: 3,
          glyphMargin: false,
          folding: false,
          renderLineHighlight: 'none',
          overviewRulerLanes: 0,
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          scrollBeyondLastLine: false,
          scrollbar: {
            useShadows: false,
            verticalScrollbarSize: SCROLLBAR,
            horizontalScrollbarSize: SCROLLBAR,
            alwaysConsumeMouseWheel: false,
          },
          padding: { top: PAD / 2, bottom: PAD / 2 },
          automaticLayout: true,
          fixedOverflowWidgets: true,
          bracketPairColorization: { enabled: false },
          guides: { indentation: false },
          contextmenu: false,
          // Paste-as and drop-into read the system clipboard (navigator.clipboard.read) on every
          // paste, which the browser may refuse (NotAllowedError) or answer with a permission
          // prompt. Plain paste needs neither.
          pasteAs: { enabled: false },
          dropIntoEditor: { enabled: false },
          wordWrap: 'on',
          tabSize: 2,
          quickSuggestions: { other: true, comments: false, strings: false },
          suggest: { showWords: false },
        }}
      />
    </div>
  );
}

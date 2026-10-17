'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { activateLibs, releaseLibs, setupMonaco, type ExtraLib } from './monaco-setup';
import { THEME, watchTheme } from './monaco-theme';
import { LINE_HEIGHT } from './monaco-field';

const PAD = 8;

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
}: MonacoImplProps) {
  const monaco = setupMonaco();
  const owner = useId().replace(/[^\w-]/g, '');
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const clamp = (lines: number) =>
    Math.min(maxLines, Math.max(minLines, lines)) * LINE_HEIGHT + PAD;
  const [height, setHeight] = useState(() => clamp(value.split('\n').length));

  // Latest props for callbacks registered once at mount.
  const latest = useRef({ extraLibs, ignoreDiagnostics, onSubmit, onEscape });
  useEffect(() => {
    latest.current = { extraLibs, ignoreDiagnostics, onSubmit, onEscape };
  });

  const libsKey = JSON.stringify(extraLibs) + JSON.stringify(ignoreDiagnostics);
  useEffect(() => {
    activateLibs(owner, extraLibs, ignoreDiagnostics);
    // libsKey stands for both arrays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, libsKey]);

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
    const fit = () => {
      const lines = editor.getModel()?.getLineCount() ?? 1;
      setHeight(clamp(Math.ceil((editor.getContentHeight() - PAD) / LINE_HEIGHT)));
      editor.updateOptions({ lineNumbers: lines > 20 ? 'on' : 'off' });
    };
    editor.onDidContentSizeChange(fit);
    fit();
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
    onReady();
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
          fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12.5,
          lineHeight: LINE_HEIGHT,
          minimap: { enabled: false },
          lineNumbers: 'off',
          lineDecorationsWidth: 6,
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
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
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

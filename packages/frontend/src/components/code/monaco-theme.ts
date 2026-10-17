'use client';

import type { Monaco } from './monaco-setup';

/**
 * One grayscale theme, `amcp`, built from the app's CSS variables at runtime.
 * Syntax is told apart by lightness and weight only: keywords --text bold,
 * strings --text-2, comments --text-3, numbers --text. No hue anywhere.
 */

const VARS = ['--bg', '--surface', '--surface-2', '--surface-3', '--text', '--text-2', '--text-3'] as const;
type Var = (typeof VARS)[number];

/** `rrggbb` (no leading hash) from `#rgb`, `#rrggbb` or `rgb(r, g, b)`. */
function toHex(raw: string): string {
  const s = raw.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (short) return `${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const long = /^#([0-9a-f]{6})/i.exec(s);
  if (long) return long[1].toLowerCase();
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s);
  if (rgb) return [rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return '';
}

function readVars(): Record<Var, string> {
  const cs = getComputedStyle(document.documentElement);
  const out = {} as Record<Var, string>;
  for (const v of VARS) out[v] = toHex(cs.getPropertyValue(v));
  return out;
}

export const THEME = 'amcp';

export function defineAmcpTheme(monaco: Monaco) {
  const v = readVars();
  const dark = document.documentElement.classList.contains('dark');
  const c = (name: Var, alpha = '') => (v[name] ? `#${v[name]}${alpha}` : '');
  const clear = c('--surface', '00');

  const symbolKeys = [
    'array', 'boolean', 'class', 'color', 'constant', 'constructor', 'enumerator', 'enumeratorMember',
    'event', 'field', 'file', 'folder', 'function', 'interface', 'key', 'keyword', 'method', 'module',
    'namespace', 'null', 'number', 'object', 'operator', 'package', 'property', 'reference', 'snippet',
    'string', 'struct', 'text', 'typeParameter', 'unit', 'variable',
  ];

  const colors: Record<string, string> = {
    foreground: c('--text'),
    focusBorder: clear,
    contrastBorder: clear,
    'widget.shadow': c('--bg', '66'),
    'editor.background': clear,
    'editor.foreground': c('--text'),
    'editorCursor.foreground': c('--text'),
    'editor.selectionBackground': c('--surface-3'),
    'editor.inactiveSelectionBackground': c('--surface-3', 'aa'),
    'editor.selectionHighlightBackground': c('--surface-3', '88'),
    'editor.wordHighlightBackground': c('--surface-3', '88'),
    'editor.wordHighlightStrongBackground': c('--surface-3'),
    'editor.findMatchBackground': c('--surface-3'),
    'editor.findMatchHighlightBackground': c('--surface-3', '88'),
    'editor.lineHighlightBackground': clear,
    'editor.lineHighlightBorder': clear,
    'editorLineNumber.foreground': c('--text-3'),
    'editorLineNumber.activeForeground': c('--text-2'),
    'editorIndentGuide.background1': c('--surface-3'),
    'editorIndentGuide.activeBackground1': c('--text-3'),
    'editorWhitespace.foreground': c('--surface-3'),
    'editorBracketMatch.background': c('--surface-3'),
    'editorBracketMatch.border': clear,
    'editorError.foreground': c('--text'),
    'editorWarning.foreground': c('--text-2'),
    'editorInfo.foreground': c('--text-3'),
    'editorHint.foreground': c('--text-3'),
    'editorGutter.background': clear,
    'editorOverviewRuler.border': clear,
    'editorWidget.background': c('--surface'),
    'editorWidget.foreground': c('--text'),
    'editorWidget.border': c('--surface-3'),
    'editorSuggestWidget.background': c('--surface'),
    'editorSuggestWidget.border': c('--surface-3'),
    'editorSuggestWidget.foreground': c('--text-2'),
    'editorSuggestWidget.selectedBackground': c('--surface-2'),
    'editorSuggestWidget.selectedForeground': c('--text'),
    'editorSuggestWidget.selectedIconForeground': c('--text'),
    'editorSuggestWidget.highlightForeground': c('--text'),
    'editorSuggestWidget.focusHighlightForeground': c('--text'),
    'editorHoverWidget.background': c('--surface'),
    'editorHoverWidget.foreground': c('--text'),
    'editorHoverWidget.border': c('--surface-3'),
    'editorHoverWidget.statusBarBackground': c('--surface-2'),
    'editorMarkerNavigation.background': c('--surface'),
    'editorMarkerNavigationError.background': c('--text-2'),
    'editorMarkerNavigationWarning.background': c('--text-3'),
    'editorLink.activeForeground': c('--text'),
    'list.hoverBackground': c('--surface-2'),
    'list.hoverForeground': c('--text'),
    'list.activeSelectionBackground': c('--surface-2'),
    'list.activeSelectionForeground': c('--text'),
    'list.inactiveSelectionBackground': c('--surface-2'),
    'list.focusBackground': c('--surface-2'),
    'list.focusForeground': c('--text'),
    'list.highlightForeground': c('--text'),
    'list.focusHighlightForeground': c('--text'),
    'list.focusOutline': clear,
    'textLink.foreground': c('--text'),
    'textLink.activeForeground': c('--text'),
    'textCodeBlock.background': c('--surface-2'),
    'scrollbar.shadow': clear,
    'scrollbarSlider.background': c('--text-3', '33'),
    'scrollbarSlider.hoverBackground': c('--text-3', '55'),
    'scrollbarSlider.activeBackground': c('--text-3', '77'),
    'input.background': c('--surface-2'),
    'input.foreground': c('--text'),
    'input.border': clear,
    'inputOption.activeBorder': clear,
    'inputValidation.errorBackground': c('--surface-2'),
    'inputValidation.errorBorder': c('--text'),
  };
  for (const k of symbolKeys) colors[`symbolIcon.${k}Foreground`] = c('--text-2');
  for (let i = 1; i <= 6; i++) colors[`editorBracketHighlight.foreground${i}`] = c('--text-2');
  for (const k of Object.keys(colors)) if (!colors[k]) delete colors[k];

  const fg = (name: Var) => v[name] || undefined;
  monaco.editor.defineTheme(THEME, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: false,
    rules: [
      { token: '', foreground: fg('--text') },
      { token: 'keyword', foreground: fg('--text'), fontStyle: 'bold' },
      { token: 'string', foreground: fg('--text-2') },
      { token: 'string.escape', foreground: fg('--text-2'), fontStyle: 'bold' },
      { token: 'regexp', foreground: fg('--text-2') },
      { token: 'comment', foreground: fg('--text-3'), fontStyle: 'italic' },
      { token: 'number', foreground: fg('--text') },
      { token: 'type', foreground: fg('--text') },
      { token: 'identifier', foreground: fg('--text') },
      { token: 'delimiter', foreground: fg('--text-2') },
      { token: 'operator', foreground: fg('--text-2') },
      { token: 'key', foreground: fg('--text') },
      { token: 'string.key.json', foreground: fg('--text') },
      { token: 'string.value.json', foreground: fg('--text-2') },
    ],
    colors,
  });
}

/** Re-define and re-apply the theme whenever <html> switches light/dark. */
export function watchTheme(monaco: Monaco): () => void {
  defineAmcpTheme(monaco);
  monaco.editor.setTheme(THEME);
  const observer = new MutationObserver(() => {
    defineAmcpTheme(monaco);
    monaco.editor.setTheme(THEME);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
  return () => observer.disconnect();
}

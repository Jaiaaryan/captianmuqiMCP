import type * as Monaco from 'monaco-editor';

/** Models of Response Processing script steps live here; only they are offered the snippets. */
export const RP_MODEL_DIR = '/amcp/rp/';

/**
 * Starting points for a script step's body, as snippets (snippet syntax: `$1` and
 * `${1:x}` are tab stops, `\\` escapes a backslash). `value` is what `reads`
 * resolved to, `response` the whole response before this step, `params` the step's.
 */
const SNIPPETS: { label: string; detail: string; body: string }[] = [
  {
    label: 'convert',
    detail: 'value × rate, 2 decimals',
    body: 'return builtins.currency(value, ${1:(params.rate ?? 0.92)});',
  },
  {
    label: 'clean',
    detail: 'trim, collapse whitespace',
    body: "return String(value).trim().replace(/\\\\s+/g, ' ');",
  },
  {
    label: 'filter',
    detail: 'keep matching items',
    body: 'return { ...value, ${1:items}: value.${1:items}.filter((i) => ${2:i.moq <= 100}) };',
  },
];

let registered = false;

export function registerResponseProcessingSnippets(monaco: typeof Monaco) {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider('javascript', {
    provideCompletionItems(model, position) {
      if (!model.uri.path.startsWith(RP_MODEL_DIR)) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: SNIPPETS.map((s) => ({
          label: s.label,
          detail: s.detail,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: s.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })),
      };
    },
  });
}

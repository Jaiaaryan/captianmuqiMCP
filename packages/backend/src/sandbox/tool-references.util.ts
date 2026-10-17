/**
 * Which tools a script's source calls: `tools.name(...)` and `tools['name'](...)`.
 *
 * Used when a script is saved, to add what the author did not declare. It reads
 * the text only and is deliberately conservative about what counts as a call:
 * comments and string contents are ignored, and `tools.list` / `tools.describe`
 * are the sandbox's own helpers, not tools. A computed name (`tools[name]`) cannot
 * be known from the text; it is reported as `dynamic` so the author declares it.
 *
 * This is a convenience, not a security control. What a saved script may call is
 * decided by its declared tools at run time, whatever the text says.
 */
export interface ToolReferences {
  /** Distinct tool names, in order of first appearance. */
  names: string[];
  /** True when the code indexes `tools` with something other than a plain string. */
  dynamic: boolean;
}

/** Members of `tools` that belong to the sandbox API, not to a connector. */
const SANDBOX_API = new Set(['list', 'describe']);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The same code with comments blanked and string contents replaced by `s`, so a
 * pattern only ever sees real code. Positions and line breaks are preserved.
 */
function maskNonCode(code: string): string {
  const out = code.split('');
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && code[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) if (code[k] !== '\n') out[k] = ' ';
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      const stop = Math.min(j, n);
      for (let k = i + 1; k < stop; k++) if (code[k] !== '\n') out[k] = 's';
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

export function findToolReferences(code: string): ToolReferences {
  const masked = maskNonCode(code);
  const names: string[] = [];
  const add = (name: string) => {
    if (!SANDBOX_API.has(name) && !names.includes(name)) names.push(name);
  };

  // `tools.name`, but not `something.tools.name` or `mytools.name`.
  for (const match of masked.matchAll(/(?<![\w$.])tools\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    add(match[1]);
  }

  let dynamic = false;
  for (const match of masked.matchAll(/(?<![\w$.])tools\s*\[/g)) {
    const afterBracket = match.index + match[0].length;
    // A plain string literal: masked, its contents are `s` runs between like quotes.
    const literal = /^\s*(["'`])s*\1\s*\]/.exec(masked.slice(afterBracket));
    if (!literal) {
      dynamic = true;
      continue;
    }
    const quote = literal[1];
    const open = afterBracket + literal[0].indexOf(quote);
    // Masked, the literal's contents hold no quote, so the next one closes it.
    const close = masked.indexOf(quote, open + 1);
    const text = code.slice(open + 1, close);
    if (IDENTIFIER.test(text)) add(text);
    else dynamic = true;
  }

  return { names, dynamic };
}

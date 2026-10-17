/**
 * TypeScript declarations for Code mode: the `tools` a script may call (typed
 * from each tool's JSON Schema), `args`, `util` and `console`.
 */

export type JSONSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema | JSONSchema[];
  enum?: unknown[];
  const?: unknown;
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
  additionalProperties?: boolean | JSONSchema;
  [key: string]: unknown;
};

export interface ToolDeclInput {
  name: string;
  description?: string | null;
  parameters?: JSONSchema | null;
  outputSchema?: JSONSchema | null;
}

const MAX_DEPTH = 8;

function propKey(k: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
}

function wrap(t: string): string {
  return /[|&]/.test(t) && !/^\{/.test(t) ? `(${t})` : t;
}

/** `/** text *\/` with `*\/` defused; empty for no text. */
function jsdoc(text: string | null | undefined, indent: string): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  const body = t.replace(/\*\//g, '* /').split('\n');
  if (body.length === 1) return `${indent}/** ${body[0]} */\n`;
  return `${indent}/**\n${body.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`;
}

function isSchema(v: unknown): v is JSONSchema {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON Schema -> TS type text. Unknown shapes are `unknown`. */
export function schemaToTs(schema: unknown, depth = 0, indent = ''): string {
  if (!isSchema(schema) || depth > MAX_DEPTH) return 'unknown';
  if (Array.isArray(schema.enum) && schema.enum.length) {
    return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  }
  if ('const' in schema && schema.const !== undefined) return JSON.stringify(schema.const);
  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union) && union.length) {
    return [...new Set(union.map((s) => wrap(schemaToTs(s, depth + 1, indent))))].join(' | ');
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    return schema.allOf.map((s) => wrap(schemaToTs(s, depth + 1, indent))).join(' & ');
  }
  if (Array.isArray(schema.type)) {
    return [...new Set(schema.type.map((t) => schemaToTs({ ...schema, type: t }, depth, indent)))].join(' | ');
  }
  const type = schema.type ?? (schema.properties ? 'object' : schema.items ? 'array' : undefined);
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
      return `${wrap(schemaToTs(items, depth + 1, indent))}[]`;
    }
    case 'object': {
      const props = Object.entries(schema.properties ?? {});
      const required = new Set(schema.required ?? []);
      const extra = schema.additionalProperties;
      if (props.length === 0) {
        return isSchema(extra) ? `Record<string, ${schemaToTs(extra, depth + 1, indent)}>` : 'Record<string, unknown>';
      }
      const inner = `${indent}  `;
      const lines = props.map(
        ([k, s]) =>
          `${jsdoc(isSchema(s) ? (s.description as string | undefined) : undefined, inner)}${inner}${propKey(k)}${
            required.has(k) ? '' : '?'
          }: ${schemaToTs(s, depth + 1, inner)};`,
      );
      if (isSchema(extra)) lines.push(`${inner}[key: string]: ${schemaToTs(extra, depth + 1, inner)} | undefined;`);
      return `{\n${lines.join('\n')}\n${indent}}`;
    }
    default:
      return 'unknown';
  }
}

function hasRequired(schema: JSONSchema | null | undefined): boolean {
  return !!schema && Array.isArray(schema.required) && schema.required.length > 0;
}

export function declarationsFromTools(tools: ToolDeclInput[]): string {
  const seen = new Set<string>();
  const methods: string[] = [];
  for (const t of tools) {
    if (!t.name || seen.has(t.name)) continue;
    seen.add(t.name);
    const params = t.parameters ? schemaToTs(t.parameters, 0, '  ') : 'Record<string, unknown>';
    const out = t.outputSchema ? schemaToTs(t.outputSchema, 0, '  ') : 'unknown';
    const optional = t.parameters && !hasRequired(t.parameters) ? '?' : '';
    methods.push(`${jsdoc(t.description, '  ')}  ${propKey(t.name)}(args${optional}: ${params}): Promise<${out}>;`);
  }
  return [
    'declare const tools: {',
    ...methods,
    '  /** Names of the tools this script may call. */',
    '  list(): string[];',
    '  describe(name: string): Promise<unknown>;',
    '};',
    '/** The arguments of this run. */',
    'declare const args: Record<string, unknown>;',
    'declare const util: {',
    '  daysAgo(n: number): string;',
    '  startOfMonth(d?: string | Date): string;',
    '  endOfMonth(d?: string | Date): string;',
    '  groupBy<T>(rows: T[], key: (r: T) => string): Record<string, T[]>;',
    '  sum<T>(rows: T[], f?: (r: T) => number): number;',
    '};',
    'declare const console: {',
    '  log(...a: unknown[]): void;',
    '  info(...a: unknown[]): void;',
    '  warn(...a: unknown[]): void;',
    '  error(...a: unknown[]): void;',
    '  debug(...a: unknown[]): void;',
    '};',
    '',
  ].join('\n');
}

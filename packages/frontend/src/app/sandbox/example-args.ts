import type { SandboxParametersSchema } from '@/lib/api';

/** The Arguments field's example when the script declares no parameters. */
export const STATIC_ARGS_EXAMPLE = '{"asOf": "2026-10-15"}';

type Schema = { type?: unknown; enum?: unknown; items?: unknown } | null | undefined;

const isDate = (n: string) =>
  /(date|since|until|asof)$/i.test(n) || /(^|_)(from|to|day|at|on)$/i.test(n) || /[a-z](At|On)$/.test(n);
const isCount = (n: string) => /(limit|count|size|top|max|min|days|hours)$/i.test(n) || n === 'n';
const IDENT = /^[A-Za-z_$][\w$]*$/;

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One example value for a parameter, by its enum, type and name. */
export function exampleValue(name: string, schema: Schema): unknown {
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema?.type) {
    case 'integer':
    case 'number':
      return isCount(name) ? 10 : 1;
    case 'boolean':
      return true;
    case 'array': {
      const item = exampleValue(name.replace(/s$/, ''), schema?.items as Schema);
      return item === undefined ? [] : [item];
    }
    case 'object':
      return {};
    case 'string':
      return isDate(name) ? today() : name.replace(/_/g, ' ');
    default:
      return undefined;
  }
}

/** `{"a": 1, "b": "x"}` for the script's declared parameters, else the static example. */
export function argsExample(parameters: SandboxParametersSchema | null | undefined): string {
  const entries = Object.entries(parameters?.properties ?? {});
  if (entries.length === 0) return STATIC_ARGS_EXAMPLE;
  const parts = entries.map(([k, s]) => `${JSON.stringify(k)}: ${JSON.stringify(exampleValue(k, s) ?? null)}`);
  return `{${parts.join(', ')}}`;
}

/** `return await tools.<first tool>({ a: 1 });` with the tool's required arguments, else `return {};`. */
export function codeExample(tools: { name: string; parameters?: unknown }[] | null | undefined): string {
  const tool = tools?.[0];
  if (!tool) return 'return {};';
  const p = (tool.parameters ?? {}) as { properties?: Record<string, Schema>; required?: unknown };
  const required = Array.isArray(p.required) ? p.required.filter((r): r is string => typeof r === 'string') : [];
  const args = required
    .filter((k) => p.properties?.[k])
    .map((k) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${JSON.stringify(exampleValue(k, p.properties?.[k]) ?? null)}`);
  const call = IDENT.test(tool.name) ? `tools.${tool.name}` : `tools[${JSON.stringify(tool.name)}]`;
  return `return await ${call}(${args.length ? `{ ${args.join(', ')} }` : '{}'});`;
}

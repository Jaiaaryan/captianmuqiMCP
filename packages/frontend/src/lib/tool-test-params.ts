type Schema = Record<string, unknown>;

function schemaObject(value: unknown): Schema {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Schema
    : {};
}

/** Examples make a useful test; optional fields without a value stay omitted. */
export function toolTestParams(parameters: unknown, envKeys: string[] = []): Record<string, unknown> {
  const schema = schemaObject(parameters);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const supplied = new Set(envKeys);
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(schemaObject(schema.properties))) {
    if (supplied.has(name)) continue;
    const prop = schemaObject(value);
    const example = prop.example ?? (Array.isArray(prop.examples) ? prop.examples[0] : undefined);
    const fallback = Array.isArray(prop.enum) ? prop.enum[0] : undefined;
    if (example !== undefined) result[name] = example;
    else if (prop.default !== undefined) result[name] = prop.default;
    else if (fallback !== undefined) result[name] = fallback;
    else if (required.has(name)) {
      if (prop.type === 'number' || prop.type === 'integer') result[name] = prop.minimum ?? 0;
      else if (prop.type === 'boolean') result[name] = false;
      else if (prop.type === 'array') result[name] = [];
      else if (prop.type === 'object') result[name] = {};
      else result[name] = '';
    }
  }
  return result;
}

/** Catch missing inputs before an empty path segment turns into an upstream 404. */
export function toolTestInputError(
  inputs: unknown,
  parameters: unknown,
  path: string = '',
  envKeys: string[] = [],
): string | null {
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    return 'Input parameters must be a JSON object.';
  }
  const schema = schemaObject(parameters);
  const required = new Set<string>(
    Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === 'string') : [],
  );
  for (const match of path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) required.add(match[1]);
  const supplied = new Set(envKeys);
  const values = inputs as Record<string, unknown>;
  for (const name of required) {
    if (supplied.has(name)) continue;
    const value = values[name];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      return `Enter a value for required parameter "${name}".`;
    }
  }
  return null;
}

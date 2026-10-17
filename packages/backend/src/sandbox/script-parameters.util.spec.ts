import { z } from 'zod';
import {
  inferParameters,
  mergeParameters,
  toZodShape,
  validateParameters,
  type ParametersSchema,
} from './script-parameters.util';

const names = (code: string) => inferParameters(code).names;

describe('inferParameters', () => {
  it('finds args.<name>, in order of first appearance, once each', () => {
    expect(names('const a = args.days; return args.threshold + args.days + args.as_of;')).toEqual([
      'days',
      'threshold',
      'as_of',
    ]);
  });

  it('finds optional chaining and bracket access with either quote', () => {
    expect(names(`return [args?.a, args['b'], args["c"], args [ 'd' ]];`)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores a bracket key that is not a plain identifier string', () => {
    expect(names(`args['two words']; args[key]; args['']; args[\`x\`];`)).toEqual([]);
  });

  it('reads destructuring of args: a, b: c, d = 1', () => {
    expect(names('const { a, b: c, d = 1 } = args; return a;')).toEqual(['a', 'b', 'd']);
    expect(names('let {x} = args || {}; var { y = [1, 2], z = {} } = args;')).toEqual(['x', 'y', 'z']);
  });

  it('ignores destructuring of something else, rest elements and computed keys', () => {
    expect(names('const { a } = other; const { ...rest } = args; const { [k]: v } = args;')).toEqual([]);
  });

  it('ignores comments', () => {
    expect(names('// args.nope\n/* args.also_no\n args.nor */ return args.yes;')).toEqual(['yes']);
  });

  it('ignores string literals but reads template expressions', () => {
    expect(names(`const s = "args.no"; const t = 'args.neither'; return \`n=\${args.days} args.text\`;`)).toEqual([
      'days',
    ]);
    expect(names('return `a ${ `b ${args.deep}` } c`;')).toEqual(['deep']);
  });

  it('does not take another object\'s args, a longer identifier or object members', () => {
    expect(names('myargs.a; other.args.b; xargs.c; args.toString(); args.hasOwnProperty("z")')).toEqual([]);
  });

  it('finds nothing when the script reads no arguments', () => {
    expect(names('return (await tools.x({})).length;')).toEqual([]);
    expect(names('')).toEqual([]);
  });

  it('survives unterminated strings, comments and templates', () => {
    expect(() => names('const s = "oops\nreturn args.a; /* never closed')).not.toThrow();
    expect(names('const s = "oops\nreturn args.a;')).toEqual(['a']);
    expect(() => names('return `open ${args.a')).not.toThrow();
  });
});

describe('mergeParameters', () => {
  const schema = (
    properties: Record<string, any>,
    required: string[] = [],
  ): ParametersSchema => ({ type: 'object', properties, required });

  it('is null without names or existing parameters', () => {
    expect(mergeParameters([], null)).toBeNull();
    expect(mergeParameters([], undefined)).toBeNull();
    // An author-set schema whose names all left the code stays a (now empty)
    // schema: the script remains a tool, with no parameters.
    expect(mergeParameters([], schema({ a: { type: 'string' } }, ['a']))).toEqual({
      type: 'object',
      properties: {},
      required: [],
    });
  });

  it('adds each new name as a required string', () => {
    expect(mergeParameters(['days', 'as_of'], null)).toEqual(
      schema({ days: { type: 'string' }, as_of: { type: 'string' } }, ['days', 'as_of']),
    );
  });

  it('keeps what the author set for names still read', () => {
    const existing = schema(
      { days: { type: 'number', description: 'Look-back window' }, as_of: { type: 'string' } },
      ['days'],
    );
    const merged = mergeParameters(['days', 'as_of', 'limit'], existing)!;
    expect(merged.properties.days).toEqual({ type: 'number', description: 'Look-back window' });
    // as_of was set optional by the author and stays so; limit is new, so required.
    expect(merged.required).toEqual(['days', 'limit']);
    expect(merged.properties.limit).toEqual({ type: 'string' });
  });

  it('drops names the code no longer reads, and their required entry', () => {
    const existing = schema({ a: { type: 'number' }, b: { type: 'number' } }, ['a', 'b']);
    expect(mergeParameters(['a'], existing)).toEqual(schema({ a: { type: 'number' } }, ['a']));
  });

  it('keeps an unreferenced parameter marked x-keep', () => {
    const existing = schema({ a: { type: 'number', 'x-keep': true }, b: { type: 'number' } }, ['a', 'b']);
    const merged = mergeParameters(['c'], existing)!;
    expect(Object.keys(merged.properties)).toEqual(['a', 'c']);
    expect(merged.required).toEqual(['a', 'c']);
  });

  it('does not mutate its input and tolerates garbage in the stored value', () => {
    const existing = schema({ a: { type: 'number' } }, ['a']);
    const copy = JSON.parse(JSON.stringify(existing));
    mergeParameters(['b'], existing);
    expect(existing).toEqual(copy);
    expect(mergeParameters(['a'], 'nonsense')).toEqual(schema({ a: { type: 'string' } }, ['a']));
    expect(mergeParameters(['a'], { properties: { a: 5 } })).toEqual(
      schema({ a: { type: 'string' } }, ['a']),
    );
  });
});

describe('validateParameters', () => {
  const ok = (properties: Record<string, any>, extra: Record<string, unknown> = {}) => ({
    type: 'object',
    properties,
    required: [],
    ...extra,
  });

  it('accepts a well-formed schema', () => {
    expect(
      validateParameters(
        ok(
          {
            days: { type: 'integer', description: 'Days' },
            kind: { type: 'string', enum: ['a', 'b'] },
            level: { type: 'number', enum: [1, 2] },
            flag: { type: 'boolean' },
            ids: { type: 'array', items: { type: 'string' } },
            any: { type: 'object', 'x-keep': true },
          },
          { required: ['days'] },
        ),
      ),
    ).toBeNull();
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a wrong type', { type: 'string', properties: {} }],
    ['no properties object', { type: 'object' }],
    ['an unknown top-level field', { ...ok({ a: { type: 'string' } }), additionalProperties: true }],
  ])('rejects %s', (_label, schema) => {
    expect(validateParameters(schema)).toEqual(expect.any(String));
  });

  it('accepts an empty properties object: a tool with no parameters', () => {
    expect(validateParameters({ type: 'object', properties: {} })).toBeNull();
    expect(validateParameters({ type: 'object', properties: {}, required: [] })).toBeNull();
  });

  it('keeps an explicitly empty schema in merge, and nulls only when nothing was set', () => {
    expect(mergeParameters([], { type: 'object', properties: {} })).toEqual({
      type: 'object',
      properties: {},
      required: [],
    });
    expect(mergeParameters([], null)).toBeNull();
    expect(mergeParameters([], undefined)).toBeNull();
  });

  it('allows 20 parameters and rejects 21', () => {
    const many = (n: number) =>
      ok(Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { type: 'string' }])));
    expect(validateParameters(many(20))).toBeNull();
    expect(validateParameters(many(21))).toMatch(/at most 20/);
  });

  it('checks names', () => {
    expect(validateParameters(ok({ _ok1: { type: 'string' } }))).toBeNull();
    expect(validateParameters(ok({ [`a${'b'.repeat(63)}`]: { type: 'string' } }))).toBeNull();
    for (const bad of ['1a', 'a-b', 'a b', '', 'a'.repeat(65), 'é']) {
      expect(validateParameters(ok({ [bad]: { type: 'string' } }))).toMatch(/name/);
    }
  });

  it('checks types', () => {
    expect(validateParameters(ok({ a: { type: 'date' } }))).toMatch(/needs a type/);
    expect(validateParameters(ok({ a: {} }))).toMatch(/needs a type/);
    expect(validateParameters(ok({ a: 'string' }))).toMatch(/must be an object/);
    expect(validateParameters(ok({ a: { type: 'string', default: 'x' } }))).toMatch(/unknown field/);
  });

  it('bounds the description at 500 characters', () => {
    expect(validateParameters(ok({ a: { type: 'string', description: 'x'.repeat(500) } }))).toBeNull();
    expect(validateParameters(ok({ a: { type: 'string', description: 'x'.repeat(501) } }))).toMatch(/500/);
    expect(validateParameters(ok({ a: { type: 'string', description: 5 } }))).toMatch(/text/);
  });

  it('checks enums are non-empty primitives of the declared type', () => {
    expect(validateParameters(ok({ a: { type: 'string', enum: [] } }))).toMatch(/enum/);
    expect(validateParameters(ok({ a: { type: 'string', enum: [1] } }))).toMatch(/enum/);
    expect(validateParameters(ok({ a: { type: 'number', enum: ['x'] } }))).toMatch(/enum/);
    expect(validateParameters(ok({ a: { type: 'string', enum: [{}] } }))).toMatch(/enum/);
    expect(validateParameters(ok({ a: { type: 'array', enum: ['x'] } }))).toMatch(/enum/);
    expect(validateParameters(ok({ a: { type: 'string', enum: 'x' } }))).toMatch(/enum/);
  });

  it('checks items belong to arrays and have a primitive type', () => {
    expect(validateParameters(ok({ a: { type: 'array' } }))).toBeNull();
    expect(validateParameters(ok({ a: { type: 'array', items: { type: 'integer' } } }))).toBeNull();
    expect(validateParameters(ok({ a: { type: 'array', items: { type: 'object' } } }))).toMatch(/items/);
    expect(validateParameters(ok({ a: { type: 'string', items: { type: 'string' } } }))).toMatch(/arrays only/);
  });

  it('checks required names a parameter', () => {
    expect(validateParameters(ok({ a: { type: 'string' } }, { required: ['b'] }))).toMatch(/not a parameter/);
    expect(validateParameters(ok({ a: { type: 'string' } }, { required: 'a' }))).toMatch(/required/);
  });

  it('accepts what mergeParameters produces', () => {
    expect(validateParameters(mergeParameters(['a', 'b'], null))).toBeNull();
  });
});

describe('toZodShape', () => {
  const shape = toZodShape({
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Who' },
      days: { type: 'integer' },
      ratio: { type: 'number' },
      on: { type: 'boolean' },
      kind: { type: 'string', enum: ['a', 'b'] },
      level: { type: 'number', enum: [1, 2] },
      only: { type: 'number', enum: [7] },
      tags: { type: 'array', items: { type: 'string' } },
      rows: { type: 'array' },
      extra: { type: 'object' },
    },
    required: ['name', 'days'],
  });
  const object = z.object(shape);

  it('maps every type', () => {
    const good = {
      name: 'x',
      days: 3,
      ratio: 1.5,
      on: true,
      kind: 'a',
      level: 2,
      only: 7,
      tags: ['t'],
      rows: [1, 'x', null],
      extra: { k: 1 },
    };
    expect(object.safeParse(good).success).toBe(true);
    for (const bad of [
      { name: 5 },
      { days: 1.5 },
      { ratio: '1' },
      { on: 'yes' },
      { kind: 'c' },
      { level: 3 },
      { only: 8 },
      { tags: [1] },
      { rows: 'x' },
      { extra: [] },
    ]) {
      expect(object.safeParse({ name: 'x', days: 3, ...bad }).success).toBe(false);
    }
  });

  it('makes only the required ones mandatory', () => {
    expect(object.safeParse({ name: 'x', days: 3 }).success).toBe(true);
    expect(object.safeParse({ name: 'x' }).success).toBe(false);
    expect(object.safeParse({ days: 3 }).success).toBe(false);
  });

  it('carries the description', () => {
    expect(shape.name.description).toBe('Who');
  });

  it('is an empty shape for no schema', () => {
    expect(toZodShape(null)).toEqual({});
    expect(toZodShape({ type: 'object' })).toEqual({});
  });
});

import { findToolReferences } from './tool-references.util';

describe('findToolReferences', () => {
  it('finds tools called with a dot', () => {
    const code = `
      const orders = await tools.erp_orders_list({ limit: 5 });
      const items = await tools . erp_items_list({});
      return orders.length + items.length;`;
    expect(findToolReferences(code)).toEqual({ names: ['erp_orders_list', 'erp_items_list'], dynamic: false });
  });

  it('finds tools called with a quoted name, whatever the quote', () => {
    const code = `await tools['a_tool']({}); await tools["b_tool"]({}); await tools[\`c_tool\`]({});`;
    expect(findToolReferences(code)).toEqual({ names: ['a_tool', 'b_tool', 'c_tool'], dynamic: false });
  });

  it('lists each tool once, in order of first appearance', () => {
    expect(findToolReferences('tools.b(); tools.a(); tools.b();').names).toEqual(['b', 'a']);
  });

  it('does not count the sandbox helpers as tools', () => {
    const code = `const all = tools.list(); const d = await tools.describe('x'); await tools.real_tool({});`;
    expect(findToolReferences(code)).toEqual({ names: ['real_tool'], dynamic: false });
  });

  it('ignores comments', () => {
    const code = `
      // tools.commented_out()
      /* tools.in_block() and
         tools['in_block_too']() */
      await tools.real({});`;
    expect(findToolReferences(code)).toEqual({ names: ['real'], dynamic: false });
  });

  it('ignores tool names that only appear inside text', () => {
    const code = `console.log('call tools.not_a_call() later'); const s = "tools['also_not']"; await tools.real({});`;
    expect(findToolReferences(code)).toEqual({ names: ['real'], dynamic: false });
  });

  it('is not fooled by a comment marker inside a string', () => {
    const code = `const url = 'http://example.com/x'; await tools.after_the_url({});`;
    expect(findToolReferences(code).names).toEqual(['after_the_url']);
  });

  it('does not take a property of something else called tools', () => {
    const code = `const o = { tools: { x() {} } }; o.tools.x(); mytools.y(); await tools.real({});`;
    expect(findToolReferences(code).names).toEqual(['real']);
  });

  it('flags a computed tool name as dynamic', () => {
    expect(findToolReferences('const n = "x"; await tools[n]({});')).toEqual({ names: [], dynamic: true });
    expect(findToolReferences('await tools["a" + "b"]({}); await tools.known({});')).toEqual({
      names: ['known'],
      dynamic: true,
    });
  });

  it('flags a template literal with an interpolation as dynamic', () => {
    expect(findToolReferences('await tools[`erp_${kind}_list`]({});')).toEqual({ names: [], dynamic: true });
  });

  it('flags a quoted name that is not an identifier as dynamic', () => {
    expect(findToolReferences("await tools['has space']({});").dynamic).toBe(true);
  });

  it('copes with unterminated comments and strings', () => {
    expect(findToolReferences('await tools.a({}); /* never closed tools.b()').names).toEqual(['a']);
    expect(findToolReferences("await tools.a({}); const s = 'never closed tools.b()").names).toEqual(['a']);
  });

  it('returns nothing for code that calls no tool', () => {
    expect(findToolReferences('return 1 + 1;')).toEqual({ names: [], dynamic: false });
  });
});

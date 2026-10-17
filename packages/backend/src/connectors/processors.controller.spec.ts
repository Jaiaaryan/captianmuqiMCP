import { ProcessorsController } from './processors.controller';

const CHAIN = {
  version: 1,
  steps: [
    {
      id: 'convert_to_eur',
      processor: 'number_scale@1',
      each: '$.items[*]',
      reads: 'price_usd',
      writes: 'price_eur',
      mode: 'add',
      params: { factor: 0.92, round: 2 },
    },
  ],
};

const OFFERS = { items: [{ itemNo: 'A-1', price_usd: 54.67 }, { itemNo: 'A-2', price_usd: 75.87 }] };

describe('ProcessorsController', () => {
  const controller = new ProcessorsController();

  describe('GET /api/processors', () => {
    it('publishes every processor with its contract, so a chain can be written against it', () => {
      const res: any = controller.list();
      const byName = new Map<string, any>(res.processors.map((p: any) => [p.name, p]));
      expect([...byName.keys()]).toEqual([
        'number_scale',
        'number_offset',
        'number_vat',
        'number_round',
        'text_clean',
        'text_truncate',
        'value_map',
      ]);
      const scale: any = byName.get('number_scale');
      expect(scale.ref).toBe('number_scale@1');
      expect(scale.input).toMatchObject({ type: 'number' });
      expect(scale.output).toMatchObject({ type: 'number' });
      expect(scale.parameters.find((p: any) => p.name === 'factor')).toMatchObject({
        type: 'number',
        required: true,
      });
      // A default is published so the dashboard can show it as a placeholder.
      expect(byName.get('number_round')!.parameters[0]).toMatchObject({ name: 'decimals', default: 2 });
    });

    it('explains the write modes and the limits a chain is bounded by', () => {
      const res: any = controller.list();
      expect(res.writeModes.map((m: any) => m.mode)).toEqual(['add', 'replace', 'upsert']);
      expect(res.limits.maxSteps).toBeGreaterThan(0);
      expect(res.limits.maxTargets).toBeGreaterThan(0);
    });

    it('publishes no code or implementation detail', () => {
      const res: any = controller.list();
      for (const p of res.processors) {
        expect(p).not.toHaveProperty('apply');
        expect(JSON.stringify(p)).not.toContain('function');
      }
    });
  });

  describe('POST /api/processors/validate', () => {
    it('accepts a usable chain', () => {
      expect(controller.validate({ processors: CHAIN })).toEqual({ valid: true });
    });

    it('returns the first problem instead of throwing, so an editor can show it', () => {
      const res: any = controller.validate({
        processors: { steps: [{ id: 'a', processor: 'nope', reads: 'a', writes: 'b' }] },
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('not a known processor');
    });

    it('treats no chain as valid: a tool may simply have none', () => {
      expect(controller.validate({})).toEqual({ valid: true });
    });
  });

  describe('POST /api/processors/dry-run', () => {
    it('runs a chain over a pasted response, with no tool or connector involved', () => {
      const res: any = controller.dryRun({ processors: CHAIN, sample: OFFERS });
      expect(res.ok).toBe(true);
      expect(res.result.items[0].price_eur).toBe(50.3);
      expect(res.result.items[1].price_eur).toBe(69.8);
      expect(res.steps[0]).toMatchObject({ id: 'convert_to_eur', targets: 2, written: 2 });
      expect(res.resultBytes).toBeGreaterThan(res.rawBytes);
    });

    it('names the step and the path of a refused value, and returns the sample unedited', () => {
      const res: any = controller.dryRun({
        processors: CHAIN,
        sample: { items: [{ itemNo: 'A-1', price_usd: 'n/a' }] },
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('step convert_to_eur: $.items[0].price_usd is not a number');
      expect(res.failedStep).toBe('convert_to_eur');
      expect(res.failedPath).toBe('$.items[0].price_usd');
      expect(res.result.items[0].price_eur).toBeUndefined();
    });

    it('reports an unusable chain without running it', () => {
      const res: any = controller.dryRun({
        processors: { steps: [{ id: 'a', processor: 'number_scale@1', reads: 'a', writes: 'b' }] },
        sample: OFFERS,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('needs the parameter "factor"');
      expect(res.steps).toBeUndefined();
    });

    it('says there is nothing to run when no chain was sent', () => {
      const res: any = controller.dryRun({ sample: OFFERS });
      expect(res).toMatchObject({ ok: true, chainActive: false, steps: [], result: OFFERS });
    });
  });
});

'use client';

import { useEffect, useState } from 'react';
import { connectors as connectorsApi, mcpServers, sandbox, type SandboxBenchmark } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, StatusPill } from '@/components/ui/badge';
import { AppSelect } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { errorText, formatBytes, formatMs, formatReduction, formatTokens, parseArgs, pretty } from './format';
import { BlockTitle, Pre } from './result-panel';

const INPUT =
  'w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--brand)]';

const genericCode = (tool: string) => `// The same question as the raw call, answered inside the gateway.
const res = await tools.${tool}({});
const rows = Array.isArray(res) ? res : (res.rows ?? []);
return { rows: rows.length };
`;

// Sample questions for the public Bundesbank and Coinbase connectors. Each script
// calls several tools; the raw call is the first one the model would otherwise
// have to read itself. Raw arguments are worked out when the sample is loaded,
// so the date windows match the script's.
const unix = () => Math.floor(Date.now() / 1000);
const json = (v: unknown) => JSON.stringify(v, null, 2);

const DEMOS = [
  {
    id: 'bundesbank',
    label: 'Bundesbank: euro this year and the Bund curve (7 calls)',
    connector: 'Bundesbank',
    tool: 'bundesbank_get_exchange_rates',
    needs: ['bundesbank_get_exchange_rates', 'bundesbank_get_bund_yields'],
    toolArgs: () => json({ currency: 'USD', startPeriod: `${new Date().getUTCFullYear()}-01-01` }),
    code: `// How has the euro moved this year against five currencies, and where is the Bund curve?
// Seven calls in one script: five exchange-rate series and the 2- and 10-year Bund yields.
const startPeriod = new Date().getUTCFullYear() + '-01-01';

// Bundesbank answers in SDMX-JSON: values sit in observations keyed by position and
// the dates in the structure. Days without a fixing come back as null.
const points = (res) => {
  const { structure, dataSets } = res.data;
  const dates = structure.dimensions.observation[0].values;
  const series = Object.values(dataSets[0].series)[0];
  return Object.entries(series.observations)
    .filter(([, v]) => v[0] !== null)
    .map(([i, v]) => ({ date: dates[i].id, value: Number(v[0]) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
};
const pct = (a, b) => Math.round(((b - a) / a) * 10000) / 100;

const currencies = ['USD', 'GBP', 'CHF', 'JPY', 'CNY'];
const [rates, bund2, bund10] = await Promise.all([
  Promise.all(currencies.map((currency) => tools.bundesbank_get_exchange_rates({ currency, startPeriod }))),
  tools.bundesbank_get_bund_yields({ maturityYears: '02', startPeriod }),
  tools.bundesbank_get_bund_yields({ maturityYears: '10', startPeriod }),
]);

const euro = rates.map((res, i) => {
  const p = points(res);
  const values = p.map((x) => x.value);
  return {
    currency: currencies[i],
    first: p[0].value,
    last: p.at(-1).value,
    changePct: pct(p[0].value, p.at(-1).value),
    low: Math.min(...values),
    high: Math.max(...values),
  };
});
const yieldOf = (res) => {
  const p = points(res);
  return { start: p[0].value, latest: p.at(-1).value, date: p.at(-1).date };
};
const y2 = yieldOf(bund2), y10 = yieldOf(bund10);

return {
  from: startPeriod,
  euroAgainst: euro.sort((a, b) => b.changePct - a.changePct),
  bundYields: { '2y': y2, '10y': y10 },
  curveSlopeBp: Math.round((y10.latest - y2.latest) * 100),
};
`,
  },
  {
    id: 'coinbase',
    label: 'Coinbase: 30 days of five coins with live spreads (11 calls)',
    connector: 'Coinbase',
    tool: 'coinbase_get_candles',
    needs: ['coinbase_get_server_time', 'coinbase_get_candles', 'coinbase_get_product_book'],
    toolArgs: () =>
      json({ product_id: 'BTC-USD', granularity: 'SIX_HOUR', start: String(unix() - 30 * 86400), end: String(unix()), limit: 120 }),
    code: `// How did BTC, ETH, SOL, XRP and DOGE do over the last 30 days, and how tight is each book now?
// Eleven calls in one script: the server clock, then candles and the order book of each pair.
// Prices only, not advice.
const pairs = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD'];
const now = Number((await tools.coinbase_get_server_time({})).epochSeconds);
const start = String(now - 30 * 86400), end = String(now);
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

const rows = [];
for (const product_id of pairs) {
  // One pair at a time keeps clear of Coinbase's per-IP rate limit; its two calls run together.
  const [hist, book] = await Promise.all([
    tools.coinbase_get_candles({ product_id, granularity: 'SIX_HOUR', start, end, limit: 120 }),
    tools.coinbase_get_product_book({ product_id, limit: 10 }),
  ]);
  const candles = hist.candles.slice().sort((a, b) => Number(a.start) - Number(b.start));
  const closes = candles.map((c) => Number(c.close));
  const returns = closes.slice(1).map((x, i) => Math.log(x / closes[i]));
  const mean = util.sum(returns) / returns.length;
  const sd = Math.sqrt(util.sum(returns, (r) => (r - mean) ** 2) / (returns.length - 1));
  rows.push({
    pair: product_id,
    last: Number(book.last),
    change30dPct: round(((closes.at(-1) - closes[0]) / closes[0]) * 100, 2),
    low30d: Math.min(...candles.map((c) => Number(c.low))),
    high30d: Math.max(...candles.map((c) => Number(c.high))),
    volatilityPct: round(sd * Math.sqrt(4 * 365) * 100, 1), // annualised from 6-hour returns
    spreadBps: Number(Number(book.spread_bps).toPrecision(3)),
  });
}

return { asOf: new Date(now * 1000).toISOString(), pairs: rows.sort((a, b) => b.change30dPct - a.change30dPct) };
`,
  },
] as const;

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">{label}</div>
      <div className="font-mono text-[18px] font-semibold">{value}</div>
      {hint && <div className="text-[11px] text-[var(--text-3)]">{hint}</div>}
    </div>
  );
}

export function BenchmarkTab({ serverId, token, canWrite }: { serverId: string; token: string; canWrite: boolean }) {
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [tool, setTool] = useState('');
  const [toolArgs, setToolArgs] = useState('');
  const [code, setCode] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SandboxBenchmark | null>(null);
  const [demo, setDemo] = useState<(typeof DEMOS)[number] | null>(null);

  // The tools of the connectors assigned to this server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const server = await mcpServers.get(serverId, token);
        const ids: string[] = (server.connectors ?? []).map((c: any) => c.connector?.id ?? c.connectorId).filter(Boolean);
        const full = await Promise.all(ids.map((id) => connectorsApi.get(id, token)));
        const names = full.flatMap((c: any) => (c.tools ?? []).map((t: any) => t.name as string)).sort();
        if (cancelled) return;
        setToolNames(names);
        if (names.length > 0) {
          setTool(names[0]);
          setCode(genericCode(names[0]));
        }
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, token]);

  const pick = (name: string) => {
    setTool(name);
    setCode(genericCode(name));
    setDemo(null);
    setResult(null);
  };

  const applyDemo = (d: (typeof DEMOS)[number]) => {
    setTool(d.tool);
    setToolArgs(d.toolArgs());
    setCode(d.code);
    setDemo(d);
    setResult(null);
  };

  // The samples are always offered; they run only where their connector is on this server.
  const missing = demo ? demo.needs.filter((n) => !toolNames.includes(n)) : [];

  const run = async () => {
    const args = parseArgs(toolArgs);
    if (!args.ok) {
      setError(args.message);
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await sandbox.benchmark(serverId, { toolName: tool, toolArgs: args.value, code }, token));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRunning(false);
    }
  };

  const raw = result?.raw;
  const script = result?.script;

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5">
        <div>
          <div className="text-[14px] font-semibold">Raw tool call against a script</div>
          <p className="mt-1 max-w-[680px] text-[12.5px] leading-relaxed text-[var(--text-2)]">
            Calls one read-only tool once, the way a model would see it, and runs a script that answers the same question
            inside the gateway. Compares what each path puts in front of the model. Tokens are estimated as bytes ÷ 4. A
            script may call several tools, while the raw column is always a single call: for a question that needs more
            than one tool, the raw column is only the first response the model would have to read.
          </p>
        </div>

        <div className="space-y-2">
          <div className="text-[11.5px] font-semibold text-[var(--text-2)]">Sample scripts</div>
          <div className="flex flex-wrap gap-2">
            {DEMOS.map((d) => (
              <Button key={d.id} type="button" variant="outlineBrand" size="sm" onClick={() => applyDemo(d)}>
                {d.label}
              </Button>
            ))}
          </div>
          {missing.length > 0 && (
            <div className="rounded-lg bg-[var(--t-warn-bg)] px-3.5 py-2.5 text-[12.5px] text-[var(--t-warn-fg)]">
              This server does not have {missing.map((n) => <code key={n} className="mr-1 font-mono">{n}</code>)}
              so the sample cannot run here. Add the {demo?.connector} connector to this server first.
            </div>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-[11.5px] font-semibold text-[var(--text-2)]" id="bench-tool-label">
                Tool to call directly
              </label>
              <AppSelect
                aria-labelledby="bench-tool-label"
                value={tool}
                onValueChange={pick}
                className="h-9 w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 font-mono text-[12.5px] text-[var(--text-2)]"
                options={toolNames.length ? toolNames.map((n) => ({ value: n, label: n })) : [{ value: '', label: 'No tools on this server' }]}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[11.5px] font-semibold text-[var(--text-2)]" htmlFor="bench-tool-args">
                Tool arguments (JSON, optional)
              </label>
              <textarea
                id="bench-tool-args"
                spellCheck={false}
                rows={4}
                className={cn(INPUT, 'py-2 font-mono text-xs')}
                value={toolArgs}
                onChange={(e) => setToolArgs(e.target.value)}
                placeholder='{"from": "2026-09-01", "to": "2026-10-01"}'
              />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-[11.5px] font-semibold text-[var(--text-2)]" htmlFor="bench-code">
              Script that answers the same question
            </label>
            <textarea
              id="bench-code"
              spellCheck={false}
              rows={10}
              className={cn(INPUT, 'py-2 font-mono text-xs leading-relaxed')}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void run()} disabled={running || !tool || !code.trim() || !canWrite} size="lg">
            {running ? 'Running both…' : 'Run both'}
          </Button>
          {!canWrite && <span className="text-[12px] text-[var(--text-3)]">Viewers cannot run benchmarks.</span>}
          <span className="text-[12px] text-[var(--text-3)]">
            Only read-only tools can be called for real. The tool is called once, and the script once.
          </span>
        </div>
        {error && <div role="alert" className="rounded-lg bg-[var(--t-danger-bg)] px-3.5 py-2.5 text-[12.5px] text-[var(--t-danger-fg)]">{error}</div>}
      </Card>

      {result && (
        <div className="space-y-4" data-testid="benchmark-result">
          {result.reduction && (
            <Card className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-5 py-4" style={{ background: 'var(--t-success-bg)' }}>
              <span className="text-[34px] font-semibold leading-none" style={{ color: 'var(--t-success-fg)' }} data-testid="reduction-bytes">
                {formatReduction(raw?.bytes ?? 0, script?.bytes ?? 0) ?? `−${result.reduction.bytesPct}%`}
              </span>
              <span className="text-[14px]" style={{ color: 'var(--t-success-fg)' }}>
                reaches the model ({result.reduction.bytesPct}% fewer bytes, {result.reduction.tokensPct}% fewer est. tokens)
              </span>
            </Card>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <div className="text-[13px] font-semibold">Raw tool call</div>
                {raw && (raw.ok ? <StatusPill tone="neutral">everything goes to the model</StatusPill> : <StatusPill tone="danger">failed</StatusPill>)}
              </div>
              {raw?.ok ? (
                <div className="grid grid-cols-3 gap-3">
                  <Metric label="To the model" value={formatBytes(raw.bytes ?? 0)} />
                  <Metric label="Est. tokens" value={formatTokens(raw.estTokens ?? 0)} hint="bytes ÷ 4" />
                  <Metric label="Latency" value={formatMs(raw.ms)} />
                </div>
              ) : (
                <div className="text-[12.5px] text-[var(--danger)]">{raw?.error ?? 'The call failed.'}</div>
              )}
            </Card>
            <Card className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <div className="text-[13px] font-semibold">Sandbox script</div>
                {script ? (
                  script.ok ? <StatusPill tone="success" dot="var(--ok)">answered</StatusPill> : <StatusPill tone="danger">{script.error?.code}</StatusPill>
                ) : (
                  <Badge tone="neutral">not run</Badge>
                )}
              </div>
              {script ? (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <Metric label="To the model" value={formatBytes(script.bytes)} />
                    <Metric label="Est. tokens" value={formatTokens(script.estTokens)} hint="bytes ÷ 4" />
                    <Metric label="Latency" value={formatMs(script.ms)} />
                  </div>
                  <div className="text-[12px] text-[var(--text-3)]">
                    {script.connectorCalls} connector call{script.connectorCalls === 1 ? '' : 's'}; pulled{' '}
                    <span className="font-mono text-[var(--text-2)]">{formatBytes(script.bytesFromConnectors)}</span> inside the gateway.
                  </div>
                  {script.ok ? (
                    <div>
                      <BlockTitle>Answer</BlockTitle>
                      <Pre maxH="max-h-48">{pretty(script.result)}</Pre>
                    </div>
                  ) : (
                    <div className="rounded-lg bg-[var(--t-danger-bg)] px-3.5 py-2.5 text-[12.5px] text-[var(--t-danger-fg)]">
                      {script.error?.message}
                      {script.error?.hint && <div className="mt-1 opacity-80">Hint: {script.error.hint}</div>}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-[12.5px] text-[var(--text-3)]">The script was not run because the raw call failed.</div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

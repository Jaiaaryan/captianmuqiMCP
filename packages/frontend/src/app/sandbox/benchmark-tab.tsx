'use client';

import { useMemo, useState } from 'react';
import { Play } from 'lucide-react';
import { sandbox, type SandboxBenchmark } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, StatusPill } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { TabHint } from '@/components/ui/tab-hint';
import { Icon } from '@/components/tool-editor/icon';
import { useTabPlaceholder } from '@/lib/use-tab-placeholder';
import { cn } from '@/lib/utils';
import { errorText, formatBytes, formatMs, formatReduction, formatTokens, parseArgs, pretty } from './format';
import { BlockTitle, Pre } from './result-panel';
import type { SandboxData } from './use-sandbox-data';
import {
  exampleArgs,
  exampleScriptArgs,
  genericCode,
  isReadOnlyName,
  presetsFor,
  toJson,
  type BenchmarkPreset,
  type SchemaLike,
} from './benchmark-presets';

const FIELD =
  'w-full rounded-md bg-[var(--surface-2)] px-3 py-2 font-mono text-[14px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus-visible:ring-2 focus-visible:ring-[var(--brand)]';
const LABEL = 'mb-1.5 block text-[14px] font-semibold text-[var(--text-2)]';

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">{label}</div>
      <div className="font-mono text-[18px] font-semibold">{value}</div>
      {hint && <div className="text-[11px] text-[var(--text-3)]">{hint}</div>}
    </div>
  );
}

/** A JSON field whose placeholder Tab accepts. */
function ArgsField({
  id,
  label,
  value,
  onChange,
  placeholder,
  rows,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  rows: number;
}) {
  const tab = useTabPlaceholder<HTMLTextAreaElement>({ value, placeholder, onAccept: onChange });
  return (
    <div>
      <label className={LABEL} htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <textarea
          id={id}
          spellCheck={false}
          rows={rows}
          className={cn(FIELD, tab.hint && 'pr-12')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder || undefined}
          onKeyDown={tab.onKeyDown}
          onFocus={tab.onFocus}
          onBlur={tab.onBlur}
        />
        <TabHint show={tab.hint} className="top-2 translate-y-0" />
      </div>
    </div>
  );
}

interface Draft {
  tool: string;
  toolArgs: string;
  code: string;
  scriptArgs: string;
}

export function BenchmarkTab({
  serverId,
  token,
  canWrite,
  data,
}: {
  serverId: string;
  token: string;
  canWrite: boolean;
  data: SandboxData;
}) {
  const { toolNames, catalogTools, scripts, serverError, refreshRuns } = data;
  const schemas = useMemo(
    () => new Map((catalogTools ?? []).map((t) => [t.name, (t.parameters ?? null) as SchemaLike | null])),
    [catalogTools],
  );
  const presets = useMemo(
    () => presetsFor(toolNames, catalogTools?.map((t) => ({ name: t.name, parameters: t.parameters as SchemaLike | null })) ?? null),
    [toolNames, catalogTools],
  );

  // Until the user picks, the first tool of the server and a generic script for it.
  const [pickedTool, setTool] = useState<string | null>(null);
  const [pickedCode, setCode] = useState<string | null>(null);
  const [toolArgs, setToolArgs] = useState('');
  const [scriptArgs, setScriptArgs] = useState('');
  const [presetId, setPresetId] = useState('');
  const [scriptId, setScriptId] = useState('');
  const [script, setScript] = useState<{ name: string; argsExample: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SandboxBenchmark | null>(null);
  const [ranScript, setRanScript] = useState<string | null>(null);

  const tool = pickedTool ?? toolNames[0] ?? '';
  const code = pickedCode ?? (tool ? genericCode(tool, exampleArgs(schemas.get(tool))) : '');
  const error = runError ?? serverError;
  const preset = presets.find((p) => p.id === presetId) ?? null;

  const toolPlaceholder = toJson(exampleArgs(schemas.get(tool)));
  const scriptPlaceholder = script?.argsExample ?? toJson(preset?.args);

  const reset = () => {
    setResult(null);
    setError(null);
  };

  const pickTool = (name: string) => {
    setTool(name);
    setToolArgs('');
    setCode(genericCode(name, exampleArgs(schemas.get(name))));
    setScriptArgs('');
    setPresetId('');
    setScriptId('');
    setScript(null);
    reset();
  };

  const fill = (p: BenchmarkPreset): Draft => {
    const draft = { tool: p.toolName, toolArgs: toJson(p.toolArgs), code: p.code, scriptArgs: toJson(p.args) };
    setPresetId(p.id);
    setScriptId('');
    setScript(null);
    setTool(draft.tool);
    setToolArgs(draft.toolArgs);
    setCode(draft.code);
    setScriptArgs(draft.scriptArgs);
    reset();
    return draft;
  };

  const pickScript = async (id: string) => {
    const summary = scripts?.find((s) => s.id === id);
    if (!summary) return;
    setScriptId(id);
    setPresetId('');
    reset();
    try {
      const full = await sandbox.script(id, token);
      const argsExample = toJson(exampleScriptArgs(full.parameters as SchemaLike | null));
      const rawTool = full.uses.flatMap((u) => u.tools).find((t) => toolNames.includes(t) && isReadOnlyName(t));
      setScript({ name: full.name, argsExample });
      setCode(full.code);
      setScriptArgs(argsExample);
      if (rawTool) {
        setTool(rawTool);
        setToolArgs('');
      }
    } catch (err) {
      setError(errorText(err));
    }
  };

  const run = async (draft: Draft, name: string | null) => {
    const callArgs = parseArgs(draft.toolArgs);
    if (!callArgs.ok) return setError(callArgs.message);
    const args = parseArgs(draft.scriptArgs);
    if (!args.ok) return setError(args.message);
    setRunning(true);
    setError(null);
    setResult(null);
    setRanScript(name);
    try {
      setResult(
        await sandbox.benchmark(
          serverId,
          { toolName: draft.tool, toolArgs: callArgs.value, code: draft.code, ...(args.value ? { args: args.value } : {}) },
          token,
        ),
      );
      void refreshRuns(); // the script half is recorded as a run
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRunning(false);
    }
  };

  const runPreset = () => {
    const p = preset ?? presets[0];
    if (p) void run(fill(p), null);
  };

  const raw = result?.raw;
  const scriptResult = result?.script;
  const blocked = running || !canWrite;

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[260px] max-w-[420px] flex-1">
            <label className={LABEL} id="bench-example-label" htmlFor="bench-example">
              Examples
            </label>
            <Combobox
              id="bench-example"
              aria-labelledby="bench-example-label"
              testId="bench-examples"
              value={presetId}
              onChange={(id) => {
                const p = presets.find((x) => x.id === id);
                if (p) fill(p);
              }}
              options={presets.map((p) => ({ value: p.id, label: p.title, meta: p.id.startsWith('tool:') ? undefined : p.toolName }))}
              placeholder={presets[0]?.title ?? '—'}
            />
          </div>
          <Button
            variant="secondary"
            onClick={runPreset}
            disabled={blocked || !presets.length}
            aria-label="Run"
            title={(preset ?? presets[0])?.title}
            className="h-9 gap-1.5 rounded-md border-0 bg-[var(--surface-2)] px-3 text-[14px] leading-none text-[var(--text)] hover:bg-[var(--surface-3)]"
          >
            <Icon as={Play} />
            Run
          </Button>
          {!canWrite && <Badge tone="neutral">Viewer</Badge>}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <div>
              <label className={LABEL} id="bench-tool-label" htmlFor="bench-tool">
                Tool
              </label>
              <Combobox
                id="bench-tool"
                aria-labelledby="bench-tool-label"
                testId="bench-tool"
                mono
                value={tool}
                onChange={pickTool}
                options={toolNames.map((n) => ({ value: n, label: n }))}
                placeholder="—"
              />
            </div>
            <ArgsField
              id="bench-tool-args"
              label="Tool args"
              value={toolArgs}
              onChange={setToolArgs}
              placeholder={toolPlaceholder}
              rows={4}
            />
          </div>
          <div className="space-y-3">
            <div>
              <label className={LABEL} id="bench-script-label" htmlFor="bench-script">
                Script
              </label>
              <Combobox
                id="bench-script"
                aria-labelledby="bench-script-label"
                testId="bench-script"
                mono
                value={scriptId}
                onChange={(id) => void pickScript(id)}
                options={(scripts ?? []).map((s) => ({ value: s.id, label: s.name }))}
                placeholder="—"
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="bench-code">
                Code
              </label>
              <textarea
                id="bench-code"
                spellCheck={false}
                rows={12}
                wrap="off"
                className={FIELD}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <ArgsField
              id="bench-script-args"
              label="Script args"
              value={scriptArgs}
              onChange={setScriptArgs}
              placeholder={scriptPlaceholder}
              rows={3}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => void run({ tool, toolArgs, code, scriptArgs }, script?.name ?? null)}
            disabled={blocked || !tool || !code.trim()}
            className="h-10 rounded-md px-4 text-[14px]"
          >
            {running ? 'Running…' : 'Run benchmark'}
          </Button>
        </div>
        {error && (
          <div role="alert" className="rounded-md bg-[var(--t-danger-bg)] px-3.5 py-2.5 text-[14px] text-[var(--t-danger-fg)]">
            {error}
          </div>
        )}
      </Card>

      {result && (
        <div className="space-y-4" data-testid="benchmark-result">
          {result.reduction && (
            <Card className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-5 py-4" style={{ background: 'var(--t-success-bg)' }}>
              <span className="text-[34px] font-semibold leading-none" style={{ color: 'var(--t-success-fg)' }} data-testid="reduction-bytes">
                {formatReduction(raw?.bytes ?? 0, scriptResult?.bytes ?? 0) ?? `−${result.reduction.bytesPct}%`}
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
                {ranScript && (
                  <span className="font-mono text-[14px] text-[var(--text-2)]" data-testid="benchmark-script-name">
                    {ranScript}
                  </span>
                )}
                {scriptResult ? (
                  scriptResult.ok ? <StatusPill tone="success" dot="var(--ok)">answered</StatusPill> : <StatusPill tone="danger">{scriptResult.error?.code}</StatusPill>
                ) : (
                  <Badge tone="neutral">not run</Badge>
                )}
              </div>
              {scriptResult ? (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <Metric label="To the model" value={formatBytes(scriptResult.bytes)} />
                    <Metric label="Est. tokens" value={formatTokens(scriptResult.estTokens)} hint="bytes ÷ 4" />
                    <Metric label="Latency" value={formatMs(scriptResult.ms)} />
                  </div>
                  <div className="text-[12px] text-[var(--text-3)]">
                    {scriptResult.connectorCalls} connector call{scriptResult.connectorCalls === 1 ? '' : 's'}; pulled{' '}
                    <span className="font-mono text-[var(--text-2)]">{formatBytes(scriptResult.bytesFromConnectors)}</span> inside the gateway.
                  </div>
                  {scriptResult.ok ? (
                    <div>
                      <BlockTitle>Answer</BlockTitle>
                      <Pre maxH="max-h-48">{pretty(scriptResult.result)}</Pre>
                    </div>
                  ) : (
                    <div className="rounded-lg bg-[var(--t-danger-bg)] px-3.5 py-2.5 text-[12.5px] text-[var(--t-danger-fg)]">
                      {scriptResult.error?.message}
                      {scriptResult.error?.hint && <div className="mt-1 opacity-80">Hint: {scriptResult.error.hint}</div>}
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

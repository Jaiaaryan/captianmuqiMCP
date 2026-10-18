'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Icon } from '@/components/tool-editor/icon';
import {
  connectors as connectorsApi,
  mcpServers,
  sandbox,
  tools as toolsApi,
  type SandboxCapabilities,
  type SandboxParametersSchema,
} from '@/lib/api';
import { FieldRow, NameField, ReadValue, SaveError, SaveMark, Switch, errorSentence, useSave } from './drawer-fields';

// What the drawer can change in place, per node kind. Every editor loads its
// own record, writes through the existing REST client, and calls `onSaved` so
// the page reloads the graph (counts and labels).

export interface EditorProps {
  token: string;
  /** VIEWER: values only. */
  canWrite: boolean;
  isAdmin: boolean;
  onSaved: () => void;
}

const SECTION = 'mt-4 flex flex-col';
const TITLE = 'pb-1 text-[14px] font-semibold text-[var(--text)]';

function useRecord<T>(load: () => Promise<T>, key: string): { data: T | null; error: string | null; set: (t: T) => void } {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null }>({ key: '', data: null, error: null });
  useEffect(() => {
    let current = true;
    load()
      .then((data) => current && setState({ key, data, error: null }))
      .catch((err) => current && setState({ key, data: null, error: errorSentence(err) }));
    return () => {
      current = false;
    };
    // `key` names the record; `load` is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback((data: T) => setState({ key, data, error: null }), [key]);
  return state.key === key ? { data: state.data, error: state.error, set } : { data: null, error: null, set };
}

function LoadError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="mt-4 text-[14px] font-medium text-[var(--t-danger-fg)]">
      {error}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Connector: name, enabled, base URL                                 */
/* ------------------------------------------------------------------ */

interface ConnectorRecord {
  id: string;
  name: string;
  isActive?: boolean;
  baseUrl?: string;
}

export function ConnectorEditor({ connectorId, token, canWrite, onSaved }: EditorProps & { connectorId: string }) {
  const { data, error, set } = useRecord<ConnectorRecord>(() => connectorsApi.get(connectorId, token), `c:${connectorId}`);
  const [nameState, saveName] = useSave();
  const [activeState, saveActive] = useSave();
  if (!data) return <LoadError error={error} />;

  return (
    <section data-testid="flow-edit-connector" className={SECTION}>
      <FieldRow label="name">
        {canWrite ? (
          <>
            <SaveMark state={nameState} testId="flow-edit-name-status" />
            <NameField
              label="Name"
              testId="flow-edit-name"
              value={data.name}
              onSave={(name) =>
                saveName(async () => {
                  await connectorsApi.update(connectorId, { name }, token);
                  set({ ...data, name });
                  onSaved();
                })
              }
            />
          </>
        ) : (
          <span className="truncate text-[14px]">{data.name}</span>
        )}
      </FieldRow>
      <SaveError state={nameState} testId="flow-edit-name-error" />
      {typeof data.isActive === 'boolean' && (
        <>
          <FieldRow label="enabled">
            <SaveMark state={activeState} />
            {canWrite ? (
              <Switch
                on={data.isActive}
                label="Connector enabled"
                testId="flow-edit-enabled"
                disabled={activeState.phase === 'saving'}
                onToggle={() =>
                  void saveActive(async () => {
                    const isActive = !data.isActive;
                    await connectorsApi.update(connectorId, { isActive }, token);
                    set({ ...data, isActive });
                    onSaved();
                  })
                }
              />
            ) : (
              <ReadValue on={data.isActive} testId="flow-edit-enabled" />
            )}
          </FieldRow>
          <SaveError state={activeState} />
        </>
      )}
      {data.baseUrl && (
        <FieldRow label="base URL">
          <span data-testid="flow-edit-base-url" title={data.baseUrl} className="min-w-0 truncate font-mono text-[14px] text-[var(--text-2)]">
            {data.baseUrl}
          </span>
        </FieldRow>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  MCP server: name, connectors attached                              */
/* ------------------------------------------------------------------ */

interface ServerRecord {
  id: string;
  name: string;
  connectors?: { connectorId?: string; connector?: { id: string; name: string } }[];
}

interface ServerData {
  server: ServerRecord;
  all: { id: string; name: string }[];
  attached: string[];
}

function ConnectorSwitch({
  connector,
  on,
  canWrite,
  onToggle,
}: {
  connector: { id: string; name: string };
  on: boolean;
  canWrite: boolean;
  onToggle: (next: boolean) => Promise<unknown>;
}) {
  const [state, save] = useSave();
  return (
    <>
      <FieldRow label={connector.name} testId={`flow-edit-server-connector-${connector.id}`}>
        <SaveMark state={state} />
        {canWrite ? (
          <Switch
            on={on}
            label={connector.name}
            testId={`flow-edit-attach-${connector.id}`}
            disabled={state.phase === 'saving'}
            onToggle={() => void save(() => onToggle(!on))}
          />
        ) : (
          <ReadValue on={on} testId={`flow-edit-attach-${connector.id}`} />
        )}
      </FieldRow>
      <SaveError state={state} />
    </>
  );
}

export function ServerEditor({ serverId, token, canWrite, onSaved }: EditorProps & { serverId: string }) {
  const { data, error, set } = useRecord<ServerData>(async () => {
    const [server, all] = await Promise.all([mcpServers.get(serverId, token), connectorsApi.list(token)]);
    const attached = (server.connectors ?? [])
      .map((c: { connectorId?: string; connector?: { id: string } }) => c.connectorId ?? c.connector?.id)
      .filter((id: string | undefined): id is string => !!id);
    return {
      server,
      all: (all ?? []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })),
      attached,
    };
  }, `s:${serverId}`);
  const [nameState, saveName] = useSave();
  if (!data) return <LoadError error={error} />;

  const toggle = async (id: string, next: boolean) => {
    const ids = next ? [...new Set([...data.attached, id])] : data.attached.filter((x) => x !== id);
    await mcpServers.assignConnectors(serverId, ids, token);
    set({ ...data, attached: ids });
    onSaved();
  };

  return (
    <section data-testid="flow-edit-server" className={SECTION}>
      <FieldRow label="name">
        {canWrite ? (
          <>
            <SaveMark state={nameState} />
            <NameField
              label="Name"
              testId="flow-edit-name"
              value={data.server.name}
              onSave={(name) =>
                saveName(async () => {
                  await mcpServers.update(serverId, { name }, token);
                  set({ ...data, server: { ...data.server, name } });
                  onSaved();
                })
              }
            />
          </>
        ) : (
          <span className="truncate text-[14px]">{data.server.name}</span>
        )}
      </FieldRow>
      <SaveError state={nameState} />
      <div className={`${TITLE} mt-3`}>
        Connectors <span className="font-mono font-normal text-[var(--text-3)]">{data.attached.length}/{data.all.length}</span>
      </div>
      {data.all.map((c) => (
        <ConnectorSwitch
          key={c.id}
          connector={c}
          on={data.attached.includes(c.id)}
          canWrite={canWrite}
          onToggle={(next) => toggle(c.id, next)}
        />
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Tool / processing / mapping: Response Processing on or off         */
/* ------------------------------------------------------------------ */

interface ToolRecord {
  id: string;
  responseMapping: Record<string, unknown> | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function ProcessingEditor({
  connectorId,
  toolId,
  token,
  canWrite,
  onSaved,
}: EditorProps & { connectorId: string; toolId: string }) {
  const { data, error, set } = useRecord<ToolRecord | null>(async () => {
    const list = await toolsApi.list(connectorId, token);
    const t = (list ?? []).find((x: { id: string }) => x.id === toolId);
    return t ? { id: t.id, responseMapping: isObject(t.responseMapping) ? t.responseMapping : null } : null;
  }, `t:${connectorId}:${toolId}`);
  const [state, save] = useSave();
  const chain = data && isObject(data.responseMapping?.responseProcessing) ? data.responseMapping.responseProcessing : null;
  const on = !!chain && chain.enabled !== false;
  const steps = chain && Array.isArray(chain.steps) ? chain.steps.length : 0;

  return (
    <section data-testid="flow-edit-processing" className={SECTION}>
      <LoadError error={error} />
      {data && (
        <>
          <FieldRow label="Response Processing">
            <SaveMark state={state} testId="flow-edit-rp-status" />
            {chain ? (
              canWrite ? (
                <Switch
                  on={on}
                  label="Response Processing enabled"
                  testId="flow-edit-rp"
                  disabled={state.phase === 'saving'}
                  onToggle={() =>
                    void save(async () => {
                      // Only `enabled` changes; the rest of the mapping goes back as it was read.
                      const responseMapping = {
                        ...data.responseMapping,
                        responseProcessing: { ...chain, enabled: !on },
                      };
                      await toolsApi.update(connectorId, toolId, { responseMapping }, token);
                      set({ ...data, responseMapping });
                      onSaved();
                    })
                  }
                />
              ) : (
                <ReadValue on={on} testId="flow-edit-rp" />
              )
            ) : (
              <span data-testid="flow-edit-rp" data-state="none" className="font-mono text-[14px] text-[var(--text-3)]">
                0 steps
              </span>
            )}
          </FieldRow>
          {chain && (
            <FieldRow label="steps">
              <span className="font-mono text-[14px] tabular-nums text-[var(--text-2)]">{steps}</span>
            </FieldRow>
          )}
          <SaveError state={state} testId="flow-edit-rp-error" />
        </>
      )}
      <Link
        href={`/connectors/${connectorId}#processing`}
        data-testid="flow-edit-tool-link"
        className="mt-1 inline-flex h-8 items-center gap-1.5 self-start rounded-md px-2 text-[14px] font-medium text-[var(--text)] outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none!"
      >
        Edit
        <Icon as={ArrowRight} />
      </Link>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Script: exposed as a tool, Level 3 capabilities                    */
/* ------------------------------------------------------------------ */

interface ScriptRecord {
  parameters: SandboxParametersSchema | null;
  capabilities: SandboxCapabilities | null;
  ownedByYou: boolean;
}

const NO_PARAMETERS: SandboxParametersSchema = { type: 'object', properties: {}, required: [] };

export function ScriptEditor({ scriptId, token, canWrite, isAdmin, onSaved }: EditorProps & { scriptId: string }) {
  const { data, error, set } = useRecord<ScriptRecord>(async () => {
    const s = await sandbox.script(scriptId, token);
    return { parameters: s.parameters ?? null, capabilities: s.capabilities ?? null, ownedByYou: !!s.ownedByYou };
  }, `sc:${scriptId}`);
  // The schema the script had before it was switched off, to switch it back on as it was.
  const [previous, setPrevious] = useState<SandboxParametersSchema | null>(null);
  const [toolState, saveTool] = useSave();
  const [envState, saveEnv] = useSave();
  const [httpState, saveHttp] = useSave();
  if (!data) return <LoadError error={error} />;

  const author = canWrite && data.ownedByYou;
  // An administrator may switch capabilities in a request that changes nothing else.
  const capsWritable = canWrite && (data.ownedByYou || isAdmin);
  const isTool = data.parameters !== null;
  const caps = data.capabilities ?? {};

  const setCap = (key: 'env' | 'http', run: typeof saveEnv) =>
    void run(async () => {
      const capabilities = { ...caps, [key]: !caps[key] };
      await sandbox.updateScript(scriptId, { capabilities }, token);
      set({ ...data, capabilities });
      onSaved();
    });

  return (
    <section data-testid="flow-edit-script" className={SECTION}>
      <FieldRow label="tool">
        <SaveMark state={toolState} />
        {author ? (
          <Switch
            on={isTool}
            label="Offered as an MCP tool"
            testId="flow-edit-script-tool"
            disabled={toolState.phase === 'saving'}
            onToggle={() =>
              void saveTool(async () => {
                const parameters = isTool ? null : (previous ?? NO_PARAMETERS);
                const saved = await sandbox.updateScript(scriptId, { parameters }, token);
                if (isTool) setPrevious(data.parameters);
                set({ ...data, parameters: saved?.parameters ?? parameters });
                onSaved();
              })
            }
          />
        ) : (
          <ReadValue on={isTool} testId="flow-edit-script-tool" />
        )}
      </FieldRow>
      <SaveError state={toolState} />
      {canWrite && (
        <>
          <FieldRow label="env">
            <SaveMark state={envState} />
            {capsWritable ? (
              <Switch
                on={!!caps.env}
                label="Connector variables"
                testId="flow-edit-script-env"
                disabled={envState.phase === 'saving'}
                onToggle={() => setCap('env', saveEnv)}
              />
            ) : (
              <ReadValue on={!!caps.env} testId="flow-edit-script-env" />
            )}
          </FieldRow>
          <SaveError state={envState} />
          <FieldRow label="http">
            <SaveMark state={httpState} />
            {capsWritable ? (
              <Switch
                on={!!caps.http}
                label="Outbound HTTP"
                testId="flow-edit-script-http"
                disabled={httpState.phase === 'saving'}
                onToggle={() => setCap('http', saveHttp)}
              />
            ) : (
              <ReadValue on={!!caps.http} testId="flow-edit-script-http" />
            )}
          </FieldRow>
          <SaveError state={httpState} />
        </>
      )}
    </section>
  );
}

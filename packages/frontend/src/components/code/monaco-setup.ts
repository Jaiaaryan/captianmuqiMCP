'use client';

/**
 * Self-hosted Monaco: the editor and its workers come from our own bundle,
 * never a CDN. Imported only from client code loaded with `ssr: false`.
 *
 * Workers: Turbopack bundles `new Worker(new URL(<pkg path>, import.meta.url))`
 * as a separate module-worker entry. The package's export map turns
 * `monaco-editor/<x>.js` into `esm/vs/<x>.js`.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import { registerResponseProcessingSnippets } from './rp-snippets';

/** TS diagnostics never shown: the code is a function body, not a module. */
export const IGNORE_RETURN_OUTSIDE_FUNCTION = 1108;
/** Code mode runs the body inside an async function: top-level await is fine. */
export const IGNORE_TOP_LEVEL_AWAIT = [1375, 1378];

let configured = false;

export function setupMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === 'typescript' || label === 'javascript') {
        return new Worker(new URL('monaco-editor/language/typescript/ts.worker.js', import.meta.url), {
          type: 'module',
        });
      }
      if (label === 'json') {
        return new Worker(new URL('monaco-editor/language/json/json.worker.js', import.meta.url), {
          type: 'module',
        });
      }
      return new Worker(new URL('monaco-editor/editor/editor.worker.js', import.meta.url), { type: 'module' });
    },
  };

  loader.config({ monaco });

  const js = monaco.typescript.javascriptDefaults;
  js.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    allowJs: true,
    allowNonTsExtensions: true,
    checkJs: true,
    noLib: false,
    lib: ['esnext'],
    // Every editor is its own module: two script steps may both declare `const x`.
    // (ts.ModuleDetectionKind.Force; declaration files stay global.)
    moduleDetection: 3,
  });
  js.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [IGNORE_RETURN_OUTSIDE_FUNCTION],
  });
  js.setEagerModelSync(true);
  registerResponseProcessingSnippets(monaco);
  return monaco;
}

export type Monaco = typeof monaco;

/* ------------------------------------------------------------------ */
/*  Extra libs: one editor's declarations at a time                    */
/* ------------------------------------------------------------------ */

export interface ExtraLib {
  path: string;
  content: string;
}

let activeOwner: string | null = null;

/**
 * `javascriptDefaults` is global; the editor with focus (or the first one)
 * owns the declarations and the ignored diagnostic codes.
 */
export function activateLibs(owner: string, libs: ExtraLib[], ignore: number[], force = false) {
  if (!force && activeOwner !== null && activeOwner !== owner) return;
  activeOwner = owner;
  const js = monaco.typescript.javascriptDefaults;
  js.setExtraLibs(libs.map((l) => ({ filePath: l.path, content: l.content })));
  js.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [IGNORE_RETURN_OUTSIDE_FUNCTION, ...ignore],
  });
}

export function releaseLibs(owner: string) {
  if (activeOwner === owner) activeOwner = null;
}

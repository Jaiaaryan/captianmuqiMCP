'use client';

/**
 * Self-hosted Monaco: the editor and its workers come from our own bundle,
 * never a CDN. Reached only through `monaco-preload` (client, on demand).
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
let javascriptConfigured = false;

/** Editor core and workers only; every language service waits for a field of its language. */
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
  return monaco;
}

/**
 * The JavaScript language service: compiler options, diagnostics, snippets. Called
 * by JavaScript fields only, so a JSON field never configures it. Monaco starts
 * the TypeScript worker on the first JavaScript model, not here.
 */
export function setupJavaScript() {
  if (javascriptConfigured) return;
  javascriptConfigured = true;
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
let appliedLibs = '[]';
let appliedIgnore = '';

/**
 * `javascriptDefaults` is global; the editor with focus (or the first one)
 * owns the declarations and the ignored diagnostic codes. Unchanged values are
 * not re-applied: new diagnostics options restart the TypeScript worker.
 */
export function activateLibs(owner: string, libs: ExtraLib[], ignore: number[], force = false) {
  if (!force && activeOwner !== null && activeOwner !== owner) return;
  activeOwner = owner;
  const js = monaco.typescript.javascriptDefaults;
  const libsKey = JSON.stringify(libs);
  if (libsKey !== appliedLibs) {
    appliedLibs = libsKey;
    js.setExtraLibs(libs.map((l) => ({ filePath: l.path, content: l.content })));
  }
  const ignoreKey = ignore.join(',');
  if (ignoreKey !== appliedIgnore) {
    appliedIgnore = ignoreKey;
    js.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      diagnosticCodesToIgnore: [IGNORE_RETURN_OUTSIDE_FUNCTION, ...ignore],
    });
  }
}

export function releaseLibs(owner: string) {
  if (activeOwner === owner) activeOwner = null;
}

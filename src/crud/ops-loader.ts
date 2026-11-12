import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isFlowFile, type FlowPlace } from '../flow/flow.js';
import type { Type } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { PHASE_BANDS, type Phase } from './op-context.js';

/** `<folder of the calling file>/<name>`. A service passes `opsFolder(import.meta.url)`. */
export function opsFolder(moduleUrl: string, name = 'ops'): string {
  return join(dirname(fileURLToPath(moduleUrl)), name);
}

export interface LoadedStep {
  /** Path relative to the ops folder, e.g. `deactivate/010-check-open-work.ts`. */
  file: string;
  number: number;
  phase: Phase;
  /** The step object or class instance. Typed loosely: its context type depends on the operation. */
  impl: Partial<Record<Phase, (c: never) => Promise<void>>> & { when?(c: never): boolean; describe?: string };
}

/** An operation's `500-execute.ts`: replaces the main change. */
export interface LoadedExecute {
  file: string;
  impl: { run(c: never, original: () => Promise<void>): Promise<void>; describe?: string };
}

/** Folders every entity has. `save` holds steps shared by create and update; `list` those shared by all lists. */
export const WRITE_OPS = ['save', 'create', 'update', 'delete', 'list'] as const;

/** `list-<view>` is a named list (`GET /?view=<view>`), `view-<name>` a read of one record (`GET /:id/views/<name>`). */
const NAMED_OP = /^(?:list|view)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Folders whose main change is a query, not a write: no `execute.ts`. */
const READ_OP = /^(?:list|view)(?:-|$)/;

/** Always number 500, so it sorts between the before (4xx) and after (501+) files. */
const EXECUTE_FILE = /^500-execute(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.(?:js|ts)$/;
const STEP_FILE = /^(\d{3})-(check|before|after)-[a-z0-9]+(?:-[a-z0-9]+)*\.(?:js|ts)$/;
const PHASES: Phase[] = ['check', 'before', 'after'];

/** The steps of each operation of one entity, in run order. */
export class OpsRegistry {
  constructor(
    private readonly folders: ReadonlyMap<string, LoadedStep[]> = new Map(),
    private readonly executes: ReadonlyMap<string, LoadedExecute> = new Map(),
  ) {}

  /** The operation's `500-execute.ts`; create and update also look in `save/`. */
  execute(op: string): LoadedExecute | undefined {
    return this.executes.get(op) ?? (op === 'create' || op === 'update' ? this.executes.get('save') : undefined);
  }

  /** Steps for an operation: `create` and `update` also get the `save` steps, a `list-<view>` the `list` steps; merged by number. */
  steps(op: string): LoadedStep[] {
    const own = this.folders.get(op) ?? [];
    const shared = op === 'create' || op === 'update' ? 'save' : op.startsWith('list-') ? 'list' : null;
    if (!shared) return own;
    return [...(this.folders.get(shared) ?? []), ...own].sort((a, b) => a.number - b.number);
  }

  has(op: string): boolean {
    return this.folders.has(op);
  }

  names(): string[] {
    return [...this.folders.keys()];
  }
}

/** The `src/...ts` path to edit for a file of the ops folder, even when running from `dist`. */
export function sourceOf(root: string, path: string): string {
  return relative(process.cwd(), join(root, path)).replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
}

const fail = (root: string, path: string, message: string): never => {
  throw new Error(`[ops] ${sourceOf(root, path)}: ${message}`);
};

/**
 * Reads `<root>/<operation>/NNN-<phase>-<name>.ts` files. Strict on purpose: a misnamed file,
 * a duplicate number, a number outside its phase's band, a step implementing the wrong phase,
 * or a folder that is no operation of this entity stops the app at boot instead of being skipped.
 * `500-execute.ts` (at most one per operation) replaces the operation's main change.
 * Other files not starting with a digit and sub-folders are helpers (`_state.ts`, `_shared/`) and are left alone.
 */
export async function loadOps(root: string | null, moduleRef: ModuleRef, actionNames: readonly string[], model?: FlowPlace['model']): Promise<OpsRegistry> {
  if (!root || !existsSync(root)) return new OpsRegistry();
  const allowed = new Set<string>([...WRITE_OPS, ...actionNames]);
  const folders = new Map<string, LoadedStep[]>();
  const executes = new Map<string, LoadedExecute>();

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!allowed.has(entry.name) && !NAMED_OP.test(entry.name)) {
      fail(root, entry.name, `no such operation; expected one of ${[...allowed].join(', ')}, list-<view> or view-<name>`);
    }
    const loaded = await loadFolder(root, entry.name, moduleRef, model);
    folders.set(entry.name, loaded.steps);
    if (loaded.execute) executes.set(entry.name, loaded.execute);
  }
  for (const own of ['create', 'update']) {
    if (executes.has('save') && executes.has(own)) fail(root, executes.get(own)!.file, 'save/500-execute.ts already replaces this write; keep one');
  }

  // Folders that share steps must not reuse a number: `save` with create/update, `list` with every list-<view>.
  const merged = [['save', 'create'], ['save', 'update'], ...[...folders.keys()].filter((n) => n.startsWith('list-')).map((n) => ['list', n])];
  for (const [shared, own] of merged) {
    const seen = new Map<number, string>();
    for (const loaded of [...(folders.get(shared!) ?? []), ...(folders.get(own!) ?? [])]) {
      const clash = seen.get(loaded.number);
      if (clash) fail(root, loaded.file, `number ${loaded.number} is also used by ${clash}`);
      seen.set(loaded.number, loaded.file);
    }
  }
  return new OpsRegistry(folders, executes);
}

async function loadDefault(root: string, file: string, moduleRef: ModuleRef, what: string): Promise<object> {
  const exported = ((await import(pathToFileURL(join(root, file)).href)) as { default?: unknown }).default;
  if (!exported) fail(root, file, `must \`export default\` ${what} or an @Injectable() class`);
  return typeof exported === 'function' ? moduleRef.create(exported as Type<object>) : (exported as object);
}

async function loadFolder(root: string, folder: string, moduleRef: ModuleRef, model?: FlowPlace['model']): Promise<{ steps: LoadedStep[]; execute?: LoadedExecute }> {
  const steps: LoadedStep[] = [];
  const byNumber = new Map<number, string>();
  let execute: LoadedExecute | undefined;

  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    const name = entry.name;
    if (!entry.isDirectory() && EXECUTE_FILE.test(name)) {
      const file = `${folder}/${name}`;
      if (READ_OP.test(folder)) fail(root, file, 'lists and views have no execute file; shape the query in before steps');
      const impl = (await loadDefault(root, file, moduleRef, 'an execute({ run }) object')) as LoadedExecute['impl'];
      if (typeof impl.run !== 'function') fail(root, file, 'must implement run(c, original)');
      execute = { file: file.replace(/\.js$/, '.ts'), impl };
      continue;
    }
    if (!entry.isDirectory() && (name === 'flow.ts' || name === 'flow.js')) {
      fail(root, `${folder}/${name}`, 'flows are numbered like every step file: NNN-check|before|after-<name>.ts with checkFlow / beforeFlow / afterFlow');
    }
    if (entry.isDirectory() || !/^\d/.test(name) || name.endsWith('.d.ts') || !/\.(?:js|ts)$/.test(name)) continue;
    const file = `${folder}/${name}`;
    if (/^\d{3}-execute\b/.test(name)) fail(root, file, 'the execute file is always 500-execute.ts or 500-execute-<name>.ts');

    const match = STEP_FILE.exec(name);
    if (!match) fail(root, file, 'step files are named NNN-check|before|after-kebab-name.ts, or 500-execute.ts');
    const number = Number(match![1]);
    const phase = match![2] as Phase;
    const [low, high] = PHASE_BANDS[phase];
    if (number < low || number > high) fail(root, file, `${phase} steps are numbered ${low}-${high}`);
    const clash = byNumber.get(number);
    if (clash) fail(root, file, `number ${number} is also used by ${clash}`);
    byNumber.set(number, file);

    let impl = (await loadDefault(root, file, moduleRef, 'a step object')) as LoadedStep['impl'];
    // A flow file (data) is bound to the phase its name says and checked now, so a mistake fails boot.
    if (isFlowFile(impl)) {
      try {
        impl = impl.bindPhase(phase, { file, op: folder, model }) as unknown as LoadedStep['impl'];
      } catch (error) {
        fail(root, file, error instanceof Error ? error.message : String(error));
      }
    }

    if (typeof impl[phase] !== 'function') fail(root, file, `must implement ${phase}()`);
    const extra = PHASES.filter((other) => other !== phase && typeof impl[other] === 'function');
    if (extra.length) fail(root, file, `implements ${extra.join(', ')}() too; a step file has one phase`);

    steps.push({ file: file.replace(/\.js$/, '.ts'), number, phase, impl });
  }
  return { steps: steps.sort((a, b) => a.number - b.number), execute };
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ModuleRef } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Phase } from '../crud/op-context.js';
import { loadOps } from '../crud/ops-loader.js';
import { Flow } from './builtin-kinds.js';
import { afterFlow, beforeFlow, checkFlow, flow, isFlowFile } from './flow.js';
import { boot, flowCtx, MemoryDb } from './testing.spec-helpers.js';

const PHASES: Phase[] = ['check', 'before', 'after'];

/** Every built-in kind: a valid step, the phases it may run in, and whether it works on records, lists or both. */
const KINDS: Array<[string, unknown, Phase[], 'row' | 'list' | 'any']> = [
  ['block', Flow.block({ message: 'm' }), PHASES, 'any'],
  ['warn', Flow.warn({ message: 'm' }), ['check'], 'any'],
  ['require', Flow.require({ fields: ['a'] }), PHASES, 'any'],
  ['unique', Flow.unique({ model: 'A', fields: ['a'] }), PHASES, 'row'],
  ['notReferenced', Flow.notReferenced({ probes: [{ model: 'A', field: 'f', message: 'm' }] }), PHASES, 'row'],
  ['lookup', Flow.lookup({ model: 'A', where: { id: 1 }, as: 'a' }), PHASES, 'any'],
  ['find', Flow.find({ model: 'A', where: { id: 1 }, as: 'a' }), PHASES, 'any'],
  ['match', Flow.match({ model: 'A', field: 'f', values: 'data.v', as: 'a' }), PHASES, 'any'],
  ['let', Flow.let({ values: { a: '1' } }), PHASES, 'any'],
  ['state', Flow.state({ values: { a: '1' } }), PHASES, 'any'],
  ['assign', Flow.assign({ values: { 'state.a': '1' } }), PHASES, 'any'],
  ['set', Flow.set({ values: { a: '1' } }), ['before'], 'row'],
  ['create', Flow.create({ model: 'A', values: {} }), ['before', 'after'], 'any'],
  ['createMany', Flow.createMany({ model: 'A', rows: 'data.r' }), ['before', 'after'], 'any'],
  ['update', Flow.update({ model: 'A', where: { id: 1 }, values: {} }), ['before', 'after'], 'any'],
  ['destroy', Flow.destroy({ model: 'A', where: { id: 1 } }), ['before', 'after'], 'any'],
  ['syncChildren', Flow.syncChildren({ model: 'A', parent: { p: 1 }, key: 'k', values: 'data.v' }), ['before', 'after'], 'any'],
  ['if', Flow.if({ test: 'true', then: [] }), PHASES, 'any'],
  ['forEach', Flow.forEach({ items: 'data.v', as: 'x', steps: [] }), PHASES, 'any'],
  ['try', Flow.try({ steps: [] }), PHASES, 'any'],
  ['stop', Flow.stop(), PHASES, 'any'],
  ['do', Flow.do('code', () => undefined), PHASES, 'any'],
  ['call', Flow.call({ method: 'm' }), PHASES, 'any'],
  ['where', Flow.where({ values: {} }), ['before'], 'list'],
  ['decorate', Flow.decorate({ values: {} }), ['after'], 'list'],
];

describe('where each kind may run', () => {
  it('the table covers every built-in kind', () => {
    expect(KINDS.map(([name]) => name).sort()).toEqual(Object.keys(Flow).sort());
  });

  it.each(KINDS)('%s', (name, step, phases, target) => {
    for (const phase of PHASES) {
      for (const op of ['save', 'delete', 'list', 'list-open']) {
        const isList = op.startsWith('list');
        const allowed = phases.includes(phase) && (target === 'any' || (target === 'list') === isList);
        const bind = boot([step], phase, { op }, { m: () => undefined });
        if (allowed) expect(bind, `${name} in ${op}/${phase}`).not.toThrow();
        else expect(bind, `${name} in ${op}/${phase}`).toThrow(phases.includes(phase) ? /works on (lists|records)/ : new RegExp(`"${name}" runs in .* steps, not ${phase}`));
      }
    }
  });
});

describe('phase helpers and file names', () => {
  const place = { file: 'x.ts', op: 'save' };

  it('checkFlow / beforeFlow / afterFlow bind only to their own phase', () => {
    const files = { check: checkFlow({ steps: [] }), before: beforeFlow({ steps: [] }), after: afterFlow({ steps: [] }) };
    for (const [own, file] of Object.entries(files)) {
      for (const phase of PHASES) {
        if (phase === own) expect(file.bindPhase(phase, place)[phase]).toBeTypeOf('function');
        else expect(() => file.bindPhase(phase, place)).toThrow(`this is a ${own} flow (${own}Flow) but the file name says ${phase}: rename the file or change the helper`);
      }
    }
  });

  it('plain flow binds to any phase, and only that phase gets a function', () => {
    for (const phase of PHASES) {
      const bound = flow({ steps: [] }).bindPhase(phase, place);
      expect(Object.keys(bound).sort()).toEqual(['describe', phase].sort());
    }
  });

  it('a flow describes itself with its own line when given', () => {
    expect(flow({ steps: [Flow.stop()], describe: 'nothing to see' }).bindPhase('check', place).describe).toBe('nothing to see');
    expect(flow({ steps: [] }).bindPhase('check', place).describe).toBe('');
  });

  it('needs a steps list, also inside', () => {
    expect(() => flow({} as never)).toThrow('A flow needs `steps`');
    expect(isFlowFile(checkFlow({ steps: [] }))).toBe(true);
    expect(isFlowFile({ isFlow: true })).toBe(false);
    expect(isFlowFile(null)).toBe(false);
  });

  it('an unknown kind fails boot with its position', () => {
    expect(boot([Flow.stop(), { kind: 'nope' }])).toThrow(/steps\[1\]: unknown step kind "nope"/);
  });
});

describe('the ops loader', () => {
  const flowModule = pathToFileURL(fileURLToPath(new URL('./flow.ts', import.meta.url))).href;
  const builtins = pathToFileURL(fileURLToPath(new URL('./builtin-kinds.ts', import.meta.url))).href;
  const roots: string[] = [];
  /** An ops folder with the given files: `{ 'save/010-check-x.ts': source }`. */
  const opsRoot = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'ops-flow-spec-'));
    roots.push(root);
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), source);
    }
    return root;
  };
  const source = (body: string) => `import { checkFlow, beforeFlow, afterFlow, flow } from '${flowModule}';\nimport { Flow } from '${builtins}';\nexport default ${body};\n`;
  const load = (root: string) => loadOps(root, {} as ModuleRef, [], { name: 'Charge', attributes: ['id', 'name'] });

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('an unnumbered flow.ts fails boot', async () => {
    await expect(load(opsRoot({ 'save/flow.ts': source('flow({ steps: [] })') }))).rejects.toThrow(/save\/flow.ts: flows are numbered like every step file: NNN-check\|before\|after-<name>.ts/);
  });

  it('a helper that disagrees with the file name fails boot, naming the file', async () => {
    await expect(load(opsRoot({ 'save/010-check-name.ts': source("beforeFlow({ steps: [Flow.set({ values: { name: \"'x'\" } })] })") }))).rejects.toThrow(
      /\[ops\] .*save\/010-check-name.ts: this is a before flow \(beforeFlow\) but the file name says check/,
    );
  });

  it('an unknown name fails boot with the file and the step position', async () => {
    await expect(load(opsRoot({ 'save/020-check-rules.ts': source("checkFlow({ steps: [Flow.require({ fields: ['name'] }), Flow.block({ message: 'm', when: 'brnch.id = 1' })] })") }))).rejects.toThrow(
      /save\/020-check-rules.ts: steps\[1\]: "brnch.id = 1": unknown name "brnch"/,
    );
  });

  it('a field the model does not have fails boot with the file', async () => {
    await expect(load(opsRoot({ 'save/410-before-x.ts': source("beforeFlow({ steps: [Flow.set({ values: { nmae: \"'x'\" } })] })") }))).rejects.toThrow(/save\/410-before-x.ts: steps\[0\]: Charge has no field "nmae"/);
  });

  it('a good flow is bound to the phase of its file and runs there', async () => {
    const registry = await load(opsRoot({ 'save/010-check-name.ts': source("checkFlow({ steps: [Flow.require({ fields: ['name'] })] })"), 'save/410-before-code.ts': source("beforeFlow({ steps: [Flow.set({ values: { name: 'upper(data.name)' } })] })") }));
    const [check, before] = registry.steps('create');
    expect(check).toMatchObject({ file: 'save/010-check-name.ts', number: 10, phase: 'check', impl: { describe: 'require name' } });
    expect(before).toMatchObject({ file: 'save/410-before-code.ts', number: 410, phase: 'before' });
    const c = flowCtx(new MemoryDb(), { dto: { name: 'frt' }, row: {} });
    await check!.impl.check!(c as never);
    await before!.impl.before!(c as never);
    expect(c.row).toEqual({ name: 'FRT' });
    expect(check!.impl.before).toBeUndefined();
  });
});

import type { Phase } from '../crud/op-context.js';
import { compileExpression } from '../expr/evaluate.js';
import './builtin-kinds.js';
import { expressionNames } from '../expr/parse.js';
import { stepKind, type FlowStep, type FlowStepIn, type StepTarget } from './kinds.js';
import { FlowRun, type FlowContext, type FlowMethod } from './run.js';

export interface FlowDefinition<M = any> {
  /** The program, in order. The phase is the file's (`NNN-<phase>-<name>.ts`). */
  steps: FlowStep<M>[];
  /** Set by `checkFlow` / `beforeFlow` / `afterFlow`: the phase the steps were typed for, checked against the file name. */
  phase?: Phase;
  /** Code the steps call by name (`{ kind: 'call', method: 'splitPayments' }`): the part that is not repetitive. */
  methods?: Record<string, FlowMethod>;
  /** One line for the flow document; default: the steps' own lines. */
  describe?: string;
}

/** Where the loader puts a flow: the phase from the file name, the operation folder. */
export interface FlowPlace {
  file: string;
  op: string;
  /** The operation model's name and attributes, when known: field names in the flow are checked against them. */
  model?: { name: string; attributes: readonly string[] };
}

/** A flow file's default export. The loader binds it to the phase its file name says. */
export interface FlowFile {
  readonly isFlow: true;
  readonly definition: FlowDefinition;
  bindPhase(phase: Phase, place: FlowPlace): { describe: string } & Partial<Record<Phase, (c: never) => Promise<void>>>;
}

const targetOf = (op: string): Exclude<StepTarget, 'any'> => (op === 'list' || op.startsWith('list-') ? 'list' : 'row');

/** Checks a step list for a phase and target; returns the description lines. Throws with the step's position. */
function check(steps: readonly FlowStep[], phase: Phase, target: Exclude<StepTarget, 'any'>, methods: Record<string, FlowMethod>, path: string, model?: FlowPlace['model']): string[] {
  const known = model ? new Set(model.attributes) : null;
  const field = (at: string, name: string, where: string) => {
    if (known && !known.has(name)) throw new Error(`${at}: ${model!.name} has no field "${name}" (${where})`);
  };
  if (!Array.isArray(steps)) throw new Error(`${path}: steps must be a list`);
  return steps.flatMap((step, index) => {
    const at = `${path}[${index}]`;
    const { kind: name, when, describe } = step as { kind: string; when?: unknown; describe?: string };
    const kind = stepKind(name);
    if (!kind) throw new Error(`${at}: unknown step kind "${name}"`);
    if (kind.phases && !kind.phases.includes(phase)) throw new Error(`${at}: "${name}" runs in ${kind.phases.join(' or ')} steps, not ${phase}`);
    if (kind.target && kind.target !== 'any' && kind.target !== target) throw new Error(`${at}: "${name}" works on ${kind.target === 'list' ? 'lists' : 'records'}`);
    if (when !== undefined && typeof when !== 'string') throw new Error(`${at}: when is an expression (text)`);
    const args = step as unknown as Record<string, unknown>;
    for (const expr of [...(when ? [when] : []), ...(kind.expressions?.(args) ?? [])]) {
      if (typeof expr !== 'string') continue;
      let compiled;
      try {
        compiled = compileExpression(expr);
      } catch (error) {
        throw new Error(`${at}: "${expr}": ${error instanceof Error ? error.message : String(error)}`);
      }
      // `row.x` and `before.x` read the operation's record: x must be one of its fields.
      for (const name of expressionNames(compiled.ast)) {
        const [root, attribute] = name.split('.');
        if ((root === 'row' || root === 'before') && attribute) field(at, attribute, `"${expr}"`);
      }
    }
    for (const name of kind.fields?.(args) ?? []) field(at, name, name);
    const problem = kind.validate?.(args);
    if (problem) throw new Error(`${at}: ${problem}`);
    if (name === 'call' && typeof args.method === 'string' && !methods[args.method]) throw new Error(`${at}: no method "${args.method}" in this flow`);
    const line = `${describe ?? kind.describe(args)}${when ? ` (when ${when})` : ''}`;
    const nested = (kind.children?.(args) ?? []).flatMap((list, n) => check(list, phase, target, methods, `${at}.${n}`, model).map((child) => `  ${child}`));
    return [line, ...nested];
  });
}

/**
 * A step file written as data: `ops/<op>/NNN-<phase>-<name>.ts`, numbered like every step file,
 * so flows and code steps interleave in any order. `checkFlow` / `beforeFlow` / `afterFlow` type the
 * steps for their phase (and the loader checks the file name agrees); `flow` takes any steps. Checked when the app boots (kinds, phases,
 * expressions, methods); a mistake fails boot with the file name.
 *
 * ```ts
 * export default flow<Charge>({
 *   steps: [
 *     { kind: 'require', fields: ['name'] },
 *     { kind: 'unique', fields: ['name'], caseInsensitive: true, message: 'Charge "{data.name}" already exists' },
 *   ],
 * });
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function flow<M = unknown>(definition: FlowDefinition<M>): FlowFile {
  const methods = definition.methods ?? {};
  if (!Array.isArray(definition.steps)) throw new Error('A flow needs `steps`');
  return {
    isFlow: true,
    definition,
    bindPhase(phase, place) {
      const steps = definition.steps;
      if (definition.phase && definition.phase !== phase) {
        throw new Error(`this is a ${definition.phase} flow (${definition.phase}Flow) but the file name says ${phase}: rename the file or change the helper`);
      }
      const lines = check(steps as FlowStep[], phase, targetOf(place.op), methods, 'steps', place.model);
      const run = async (c: FlowContext) => {
        await new FlowRun(c, phase, place.file, methods).steps(steps as FlowStep[]);
      };
      return { describe: definition.describe ?? lines.join('; '), [phase]: run };
    },
  };
}

/** A flow for a `NNN-check-*` file: only kinds allowed in checks (read only, issues) compile. */
export function checkFlow<M = unknown>(definition: Omit<FlowDefinition<M>, 'steps' | 'phase'> & { steps: FlowStepIn<'check', M>[] }): FlowFile {
  return flow<M>({ ...definition, steps: definition.steps as FlowStep<M>[], phase: 'check' });
}

/** A flow for a `NNN-before-*` file (after every check passed, before the main change). */
export function beforeFlow<M = unknown>(definition: Omit<FlowDefinition<M>, 'steps' | 'phase'> & { steps: FlowStepIn<'before', M>[] }): FlowFile {
  return flow<M>({ ...definition, steps: definition.steps as FlowStep<M>[], phase: 'before' });
}

/** A flow for a `NNN-after-*` file (after the main change, same transaction). */
export function afterFlow<M = unknown>(definition: Omit<FlowDefinition<M>, 'steps' | 'phase'> & { steps: FlowStepIn<'after', M>[] }): FlowFile {
  return flow<M>({ ...definition, steps: definition.steps as FlowStep<M>[], phase: 'after' });
}

export function isFlowFile(value: unknown): value is FlowFile {
  return typeof value === 'object' && value !== null && (value as FlowFile).isFlow === true && typeof (value as FlowFile).bindPhase === 'function';
}

/** Runs a flow as the loader would, for unit tests: `await runFlow(file, 'check', fakeOpContext({...}))`. */
export async function runFlow(file: FlowFile, phase: Phase, c: unknown, place: FlowPlace = { file: 'test', op: 'test' }): Promise<void> {
  const bound = file.bindPhase(phase, place);
  await bound[phase]!(c as never);
}

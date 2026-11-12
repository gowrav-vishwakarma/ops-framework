import type { Phase } from '../crud/op-context.js';
import { compileExpression } from '../expr/evaluate.js';
import './builtin-kinds.js';
import { expressionNames } from '../expr/parse.js';
import { stepKind, type FlowStep, type FlowStepIn, type StepTarget } from './kinds.js';
import { FlowRun, type FlowContext, type FlowMethod } from './run.js';

export interface FlowDefinition<M = any> {
  /** A numbered file (`NNN-<phase>-<name>.ts`): its steps, in the phase its name says. */
  steps?: FlowStep<M>[];
  /**
   * The operation's `flow.ts`: steps per phase in one file. Each list runs at the start of its
   * phase, before the numbered step files of that phase.
   */
  check?: FlowStepIn<'check', M>[];
  before?: FlowStepIn<'before', M>[];
  after?: FlowStepIn<'after', M>[];
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
  /** Phases a `flow.ts` has steps for (empty for a numbered file's `steps`). */
  phases(): Phase[];
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
 * Step files written as data. Either one operation's rules in its `ops/<op>/flow.ts`, grouped by
 * phase (`{ check: [...], before: [...], after: [...] }`), or one numbered file
 * `ops/<op>/NNN-<phase>-<name>.ts` with `steps`, exactly where a code step would go. Checked when the app boots (kinds, phases,
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
  const phased = (['check', 'before', 'after'] as const).filter((phase) => definition[phase] !== undefined);
  if (definition.steps && phased.length) throw new Error('A flow has either `steps` (a numbered file) or `check` / `before` / `after` (an operation\'s flow.ts), not both');
  if (!definition.steps && !phased.length) throw new Error('A flow needs `steps`, or `check` / `before` / `after` lists');
  return {
    isFlow: true,
    definition,
    phases: () => [...phased],
    bindPhase(phase, place) {
      const steps = definition.steps ?? definition[phase];
      if (!steps) throw new Error(`no ${phase} steps in this flow`);
      const lines = check(steps as FlowStep[], phase, targetOf(place.op), methods, definition.steps ? 'steps' : phase, place.model);
      const run = async (c: FlowContext) => {
        await new FlowRun(c, phase, place.file, methods).steps(steps as FlowStep[]);
      };
      return { describe: definition.describe ?? lines.join('; '), [phase]: run };
    },
  };
}

export function isFlowFile(value: unknown): value is FlowFile {
  return typeof value === 'object' && value !== null && (value as FlowFile).isFlow === true && typeof (value as FlowFile).bindPhase === 'function';
}

/** Runs a flow as the loader would, for unit tests: `await runFlow(file, 'check', fakeOpContext({...}))`. */
export async function runFlow(file: FlowFile, phase: Phase, c: unknown, place: FlowPlace = { file: 'test', op: 'test' }): Promise<void> {
  const bound = file.bindPhase(phase, place);
  await bound[phase]!(c as never);
}

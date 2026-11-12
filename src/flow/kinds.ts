import type { Model } from 'sequelize-typescript';
import type { Phase } from '../crud/op-context.js';
import type { FlowRun } from './run.js';

/**
 * Step kinds a flow may use, by name -> arguments, for the model `M` of the flow (`flow<Charge>`).
 * Built-in kinds are declared in `builtin-kinds.ts`; a project adds its own by declaration merging
 * (same type parameter), says where they may run in `FlowKindPhases`, and registers them with
 * `defineStepKind`:
 *
 * ```ts
 * declare module '@ops/framework' {
 *   interface FlowStepKinds<M> { normalizeDecimals: { rate?: Field<M>[] } }
 *   interface FlowKindPhases { normalizeDecimals: 'before' }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-object-type
export interface FlowStepKinds<M = any> {}

/** Phases a kind may run in, when not all of them (`set: 'before'`). Checked by the compiler and at boot. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FlowKindPhases {}

/**
 * An attribute of the flow's model: `flow<Charge>` accepts `'name' | 'defaultValue' | ...` and
 * refuses a typo. Without a model, any text.
 */
export type Field<M> = unknown extends M ? string : M extends Model ? Exclude<Extract<keyof M, string>, keyof Model | '_attributes' | '_creationAttributes'> : Extract<keyof M, string>;

/** What every step may carry besides its kind's arguments. */
export interface StepCommon {
  /** Runs the step only when this expression is true. */
  when?: string;
  /** One line for the flow document, instead of the kind's own description. */
  describe?: string;
}

type Kinds<M> = FlowStepKinds<M>;
type PhasesOf<K> = K extends keyof FlowKindPhases ? FlowKindPhases[K] : Phase;

/** Any step (a numbered file's `steps`, the lists inside `if` and `forEach`). */
export type FlowStep<M = any> = { [K in keyof Kinds<M>]: { kind: K } & StepCommon & Kinds<M>[K] }[keyof Kinds<M>];

/** A step allowed in phase `P`: what a `flow.ts` accepts under `check`, `before` or `after`. */
export type FlowStepIn<P extends Phase, M = any> = {
  [K in keyof Kinds<M>]: P extends PhasesOf<K> ? { kind: K } & StepCommon & Kinds<M>[K] : never;
}[keyof Kinds<M>];

/** Where a step runs: a record operation (`c.row`), a list (`c.where`, `c.rows`), or either. */
export type StepTarget = 'row' | 'list' | 'any';

/** What a kind checks at boot, and what it does when the flow runs. */
export interface StepKind<A = Record<string, unknown>> {
  name: string;
  /** Phases the kind may run in. Default: all. Writes belong in `before`/`after`. */
  phases?: readonly Phase[];
  target?: StepTarget;
  /** Every expression in the arguments, parsed and checked at boot. */
  expressions?(args: A): string[];
  /** Attributes of the operation's model the arguments name, checked against the model at boot. */
  fields?(args: A): string[];
  /** Nested step lists (`if`, `forEach`), checked with the same phase and target. */
  children?(args: A): FlowStep[][];
  /** Extra checks of the arguments; return a message to fail boot. */
  validate?(args: A): string | null;
  /** `'stop'` ends the flow (the remaining steps of this file do not run). */
  run(run: FlowRun, args: A): Promise<void | 'stop'>;
  describe(args: A): string;
}

const KINDS = new Map<string, StepKind<never>>();

/** Registers a step kind (built-in or the project's). Names are unique. */
export function defineStepKind<K extends keyof FlowStepKinds>(kind: StepKind<FlowStepKinds[K]> & { name: K }): void;
export function defineStepKind(kind: StepKind<never>): void;
export function defineStepKind(kind: StepKind<never>): void {
  if (KINDS.has(kind.name)) throw new Error(`Step kind "${kind.name}" is already defined`);
  KINDS.set(kind.name, kind);
}

export function stepKind(name: string): StepKind<Record<string, unknown>> | undefined {
  return KINDS.get(name) as StepKind<Record<string, unknown>> | undefined;
}

export function stepKindNames(): string[] {
  return [...KINDS.keys()].sort();
}

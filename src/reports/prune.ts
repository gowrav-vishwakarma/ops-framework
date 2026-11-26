import { expressionNames, parseExpression } from '../expr/parse.js';
import type { Rdl2Output, Rdl2Report, Rdl2RunRequest, Rdl2Stage, Rdl2StageBase } from './language.js';
import { computedKind } from './stages.js';

/**
 * Column pruning: the report rewritten to work out only what is asked for. Steps are walked from
 * the output back to the sources; each keeps the columns a later step reads and its own keys, so a
 * source joins no relation, a formula is not worked out, and a computed stage (`cost`,
 * `engine`) works nothing out for a column nobody shows. Row counts never change: grouping keys, join and match keys, and the steps
 * that add or drop rows (periods, balance, filters) are kept whole.
 *
 * `columns` are each step's columns from compiling the report unpruned, so the report has been
 * checked before anything is taken out of it.
 */

/** Columns wanted from a step; `null` is every column (the step stays as it is). */
type Need = Set<string> | null;

/** Column names an expression reads; `null` when it does not parse (the compiler then says why). */
function namesOf(...sources: (string | undefined)[]): string[] | null {
  const out = new Set<string>();
  try {
    for (const src of sources) if (src?.trim()) expressionNames(parseExpression(src), out);
  } catch {
    return null;
  }
  return [...out];
}

/** The output as a bare run (`request.bare`) reads it: the columns, without totals, sums or drill-downs. */
export function bareOutput(output: Rdl2Output): Rdl2Output {
  return {
    stage: output.stage,
    columns: output.columns.map((column) => {
      const plain = { ...column };
      delete plain.total;
      delete plain.drill;
      return plain;
    }),
    ...(output.pageSize !== undefined ? { pageSize: output.pageSize } : {}),
  };
}

/** The output columns a run needs: the ones shown, and what they and the output's layout read. */
export function outputNeeds(
  output: Rdl2Output,
  request: Pick<Rdl2RunRequest, 'columns' | 'sort' | 'where'>,
  available: readonly string[],
): Set<string> | null {
  const declared = output.columns.map((column) => column.column);
  if (!declared.length) return null;
  const shown = new Set(
    request.columns?.length ? request.columns.filter((column) => declared.includes(column)) : declared,
  );
  const out = new Set<string>(shown);
  const add = (...columns: (string | undefined | null)[]) => {
    for (const column of columns) if (column) out.add(column);
  };
  for (const column of output.columns) {
    // A row opens its voucher or report from the first column that drills, shown or not.
    const drill = column.drill;
    if (drill && 'voucher' in drill && drill.voucher) add(drill.voucher.id, drill.voucher.type);
    if (drill && 'report' in drill) add(...Object.values(drill.params));
    if (!shown.has(column.column)) continue;
    add(column.caption, column.toneBy, ...(namesOf(column.total) ?? []));
  }
  add(...(output.sort ?? []).map((item) => item.column), ...(request.sort ?? []).map((item) => item.column));
  add(...(output.groups ?? []).map((group) => group.column), output.pageBy);
  add(...(output.cards ?? []).map((card) => card.column));
  for (const footer of output.footers ?? []) add(...(namesOf(footer.where) ?? []));
  add(...whereColumns(request.where));
  return new Set([...out].filter((column) => available.includes(column)));
}

/** Columns a grid filter (`{ $and: [{ column: { $op: value } }] }`) names. */
function whereColumns(where: unknown, out: string[] = []): string[] {
  if (Array.isArray(where)) {
    for (const item of where) whereColumns(item, out);
  } else if (where && typeof where === 'object') {
    for (const [key, value] of Object.entries(where)) {
      if (key.startsWith('$')) whereColumns(value, out);
      else out.push(key);
    }
  }
  return out;
}

/** A step that passes its input through unchanged: what a stage becomes when nothing reads what it adds. */
function passThrough(stage: { id: string; from: string }): Rdl2Stage {
  return { kind: 'derive', id: stage.id, from: stage.from, columns: [] };
}

function union(...lists: (Iterable<string> | null)[]): Set<string> | null {
  const out = new Set<string>();
  for (const list of lists) {
    if (list === null) return null;
    for (const item of list) out.add(item);
  }
  return out;
}

function without(set: Set<string>, drop: Iterable<string>): Set<string> {
  const out = new Set(set);
  for (const item of drop) out.delete(item);
  return out;
}

/** The step rewritten to give `need`, and what it then needs from each step it reads. */
function pruneStage(given: Rdl2StageBase, need: Set<string>, columns: ReadonlyMap<string, readonly string[]>): { stage: Rdl2Stage | Rdl2StageBase; inputs: [string, Need][] } {
  const computed = computedKind(given.kind);
  if (computed && given.from) {
    // Its figures are worked out only when a later step reads one of them: the columns it adds to its input's.
    const before = new Set(columns.get(given.from) ?? []);
    const added = (columns.get(given.id) ?? []).filter((column) => !before.has(column));
    if (!added.some((column) => need.has(column))) return { stage: passThrough({ id: given.id, from: given.from }), inputs: [[given.from, need]] };
    return { stage: given, inputs: [[given.from, union(without(need, added), computed.reads(given))]] };
  }
  const stage = given as Rdl2Stage;
  switch (stage.kind) {
    case 'source':
      return { stage: { ...stage, fields: stage.fields.filter((field) => need.has(field.as)) }, inputs: [] };
    case 'filter':
      return { stage, inputs: [[stage.from, union(need, namesOf(stage.where))]] };
    case 'derive': {
      const kept = stage.columns.filter((column) => need.has(column.as));
      const derived = stage.columns.map((column) => column.as);
      return {
        stage: {
          ...stage,
          columns: kept,
          ...(stage.keep ? { keep: stage.keep.filter((column) => need.has(column)) } : {}),
        },
        inputs: [[stage.from, union(without(need, derived), namesOf(...kept.map((column) => column.expr)))]],
      };
    }
    case 'aggregate': {
      const having = namesOf(stage.having);
      if (!having) return { stage, inputs: [[stage.from, null]] };
      const measures = stage.measures.filter((measure) => need.has(measure.as) || having.includes(measure.as));
      return {
        stage: { ...stage, measures },
        inputs: [
          [
            stage.from,
            union(
              stage.groupBy,
              namesOf(...measures.flatMap((measure) => [measure.expr, measure.where, measure.orderBy])),
            ),
          ],
        ],
      };
    }
    case 'window': {
      const kept = stage.columns.filter((column) => need.has(column.as));
      const reads = namesOf(
        ...kept.flatMap((column) => [column.expr, ...(column.orderBy ?? []).map((item) => item.expr)]),
      );
      return {
        stage: { ...stage, columns: kept },
        inputs: [
          [
            stage.from,
            union(
              without(
                need,
                stage.columns.map((column) => column.as),
              ),
              kept.flatMap((column) => column.partitionBy ?? []),
              reads,
            ),
          ],
        ],
      };
    }
    case 'join': {
      const kept = stage.columns.filter((column) => need.has(column.as));
      return {
        stage: { ...stage, columns: kept },
        inputs: [
          [
            stage.from,
            union(
              without(
                need,
                stage.columns.map((column) => column.as),
              ),
              stage.on.map((pair) => pair.left),
            ),
          ],
          [
            stage.with,
            union(
              stage.on.map((pair) => pair.right),
              kept.map((column) => column.column),
            ),
          ],
        ],
      };
    }
    case 'exists':
      return {
        stage,
        inputs: [
          [
            stage.from,
            union(
              need,
              stage.on.map((pair) => pair.left),
            ),
          ],
          [
            stage.in,
            union(
              stage.on.map((pair) => pair.right),
              namesOf(stage.where),
            ),
          ],
        ],
      };
    case 'top':
      return {
        stage,
        inputs: [[stage.from, union(need, stage.partitionBy, namesOf(...stage.orderBy.map((item) => item.expr)))]],
      };
    case 'pivot': {
      const keys = stage.keys.filter((key) => need.has(key.as));
      // The compiler needs at least one key.
      const next = { ...stage, keys: keys.length ? keys : stage.keys.slice(0, 1) };
      if (!stage.total || !need.has(stage.total)) delete next.total;
      return {
        stage: next,
        inputs: [[stage.from, union(stage.rows, [stage.column], namesOf(stage.measure.expr))]],
      };
    }
    case 'balance':
      return {
        stage,
        inputs: [
          [
            stage.from,
            union(stage.keys, [stage.date], namesOf(stage.periodFrom, stage.periodTo, stage.inward, stage.outward)),
          ],
        ],
      };
    case 'classify':
      if (!need.has(stage.as)) return { stage: passThrough(stage), inputs: [[stage.from, need]] };
      return {
        stage,
        inputs: [[stage.from, union(without(need, [stage.as]), namesOf(...stage.rules.map((rule) => rule.when)))]],
      };
    case 'fifo': {
      const as = stage.as || 'remaining';
      if (!need.has(as)) return { stage: passThrough(stage), inputs: [[stage.from, need]] };
      return {
        stage,
        inputs: [
          [
            stage.from,
            union(
              without(need, [as]),
              stage.keys,
              namesOf(stage.inward, stage.outward, ...stage.order.map((item) => item.expr)),
            ),
          ],
        ],
      };
    }
    case 'periods':
      return { stage, inputs: [[stage.from, union(without(need, [stage.as || 'period']), [stage.date])]] };
    case 'union':
      return {
        stage: {
          ...stage,
          keep: [...need],
          parts: stage.parts.map((part) => ({
            from: part.from,
            ...(part.set
              ? { set: Object.fromEntries(Object.entries(part.set).filter(([column]) => need.has(column))) }
              : {}),
          })),
        },
        inputs: stage.parts.map((part): [string, Need] => {
          const set = Object.entries(part.set ?? {});
          return [
            part.from,
            union(
              without(
                need,
                set.map(([column]) => column),
              ),
              namesOf(...set.filter(([column]) => need.has(column)).map(([, expr]) => expr)),
            ),
          ];
        }),
      };
    case 'native':
      return { stage, inputs: stage.from ? [[stage.from, null]] : [] };
    default:
      return { stage, inputs: inputsOf(stage).map((id): [string, Need] => [id, null]) };
  }
}

/**
 * The report with only what `wanted` (output columns) needs. Steps the output does not reach stay
 * as they are. Reports with a native stage are left whole: its code may read any column.
 */
export function pruneReport<R extends Rdl2Report<Rdl2StageBase>>(report: R, wanted: Iterable<string>, columns: ReadonlyMap<string, readonly string[]>): R {
  if (report.stages.some((stage) => stage.kind === 'native')) return report;
  const needs = new Map<string, Need>([[report.output.stage, new Set(wanted)]]);
  const rewritten = new Map<string, Rdl2StageBase>();
  for (const stage of [...report.stages].reverse()) {
    const reached = needs.get(stage.id);
    const own = columns.get(stage.id);
    let need: Need = reached === undefined || !own ? null : reached;
    if (need) {
      // Only its own columns, in its order; at least one, so the step still selects something.
      const kept = own!.filter((column) => need!.has(column));
      need = new Set(kept.length ? kept : own!.slice(0, 1));
    }
    const { stage: next, inputs } = need
      ? pruneStage(stage, need, columns)
      : { stage, inputs: inputsOf(stage).map((id): [string, Need] => [id, null]) };
    rewritten.set(stage.id, next);
    for (const [id, cols] of inputs) {
      const before = needs.get(id);
      needs.set(id, before === undefined ? cols : union(before, cols));
    }
  }
  return { ...report, stages: report.stages.map((stage) => rewritten.get(stage.id) ?? stage) } as R;
}

function inputsOf(given: Rdl2StageBase): string[] {
  if (computedKind(given.kind)) return given.from ? [given.from] : [];
  const stage = given as Rdl2Stage;
  switch (stage.kind) {
    case 'source':
      return [];
    case 'union':
      return stage.parts.map((part) => part.from);
    case 'join':
      return [stage.from, stage.with];
    case 'exists':
      return [stage.from, stage.in];
    case 'native':
      return stage.from ? [stage.from] : [];
    default:
      return [stage.from];
  }
}

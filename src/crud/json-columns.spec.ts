import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'vitest';
import { Issues } from './issues.js';
import { resetPayloadWarnings, payloadWarnings } from '../payload/check-payload.js';
import { applyJsonColumns, checkJson, JsonField, jsonListShape, jsonMapShape, mergeJson } from './json-columns.js';

class Ref {
  @JsonField.number() id?: number;
  @JsonField.text() name?: string;
}

class Component {
  @JsonField.text() component?: string;
  @JsonField.number() length?: number;
}

class Section {
  @JsonField.bool() enable?: boolean;
  @JsonField.number() digits?: number;
  @JsonField.number({ numeric: true }) duration?: number | string;
  @JsonField.oneOf(['FIFO', 'FEFO']) method?: string;
  @JsonField.object(() => Ref, { or: ['number'] }) branch?: Ref | number;
  @JsonField.list(() => Component) components?: Component[];
  @JsonField.list('text') types?: string[];
  @JsonField.map(() => Ref) series?: Record<string, Ref | null>;
  @JsonField.any() open?: unknown;
}

describe('checkJson', () => {
  it('keeps a valid value as it is', () => {
    const input = {
      enable: true,
      digits: 3,
      duration: '12',
      method: 'FEFO',
      branch: { id: 1, name: 'HO' },
      components: [{ component: 'MRP', length: 5 }],
      types: ['SI'],
      series: { SI: { id: 4, name: 'Sales' }, POS: null },
      open: { anything: [1] },
    };
    const result = checkJson(Section, input, { path: 'section' });
    expect(result.problems).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.value).toEqual(input);
  });

  it('accepts null and missing fields, and a record stored as its id', () => {
    expect(checkJson(Section, { enable: null, branch: 1 }).problems).toEqual([]);
    expect(checkJson(Section, null).value).toBeNull();
  });

  it('refuses wrong types with their paths, all at once', () => {
    const result = checkJson(
      Section,
      { enable: 'yes', digits: '3', method: 'LIFO', branch: 'HO', components: [{ length: 'x' }], types: [1], series: { SI: { id: 'a' }, PI: 5 } },
      { path: 'section' },
    );
    const paths = result.problems.map((problem) => problem.path).sort();
    expect(paths).toEqual([
      'section.branch',
      'section.components.0.length',
      'section.digits',
      'section.enable',
      'section.method',
      'section.series.PI',
      'section.series.SI.id',
      'section.types',
    ]);
    expect(checkJson(Section, 'text', { path: 'section' }).problems).toEqual([{ path: 'section', message: 'section must be an object' }]);
  });

  it('drops unknown keys at every depth and names them', () => {
    const result = checkJson(Section, { enable: true, extra: 1, branch: { id: 1, gstn: { password: 'x' } }, components: [{ component: 'MRP', padding: 2 }], series: { SI: { id: 1, more: true } } }, { path: 's' });
    expect(result.value).toEqual({ enable: true, branch: { id: 1 }, components: [{ component: 'MRP' }], series: { SI: { id: 1 } } });
    expect(result.dropped.sort()).toEqual(['s.branch.gstn', 's.components.0.padding', 's.extra', 's.series.SI.more']);
  });

  it('keeps unknown keys sent back unchanged from the stored value, drops new or changed ones', () => {
    const stored = { enable: false, legacy: { a: 1 }, other: 1 };
    const result = checkJson(Section, { enable: true, legacy: { a: 1 }, other: 2, fresh: true }, { path: 's', stored });
    expect(result.value).toEqual({ enable: true, legacy: { a: 1 } });
    expect(result.kept).toEqual(['s.legacy']);
    expect(result.dropped.sort()).toEqual(['s.fresh', 's.other']);
  });

  it('replaces the column: keys the input leaves out are not taken from the stored value', () => {
    const result = checkJson(Section, { enable: true }, { stored: { enable: false, digits: 2 } });
    expect(result.value).toEqual({ enable: true });
  });
});

describe('jsonMapShape', () => {
  it('checks a column that is a map of entries', () => {
    const Series = jsonMapShape(() => Ref);
    const ok = checkJson(Series, { SI: { id: 1, name: 'Sales', extra: 1 }, POS: null }, { path: 'defaults' });
    expect(ok.value).toEqual({ SI: { id: 1, name: 'Sales' }, POS: null });
    expect(ok.dropped).toEqual(['defaults.SI.extra']);
    const bad = checkJson(Series, { SI: { id: 'x' }, PI: 3 }, { path: 'defaults' });
    expect(bad.problems.map((problem) => problem.path).sort()).toEqual(['defaults.PI', 'defaults.SI.id']);
    const kept = checkJson(Series, { SI: { id: 1, old: true } }, { path: 'defaults', stored: { SI: { id: 1, old: true } } });
    expect(kept.value).toEqual({ SI: { id: 1, old: true } });
    expect(kept.kept).toEqual(['defaults.SI.old']);
  });
});

describe('jsonListShape', () => {
  it('checks a column that is a list of entries', () => {
    const Rows = jsonListShape(() => Ref);
    const ok = checkJson(Rows, [{ id: 1, name: 'a', extra: 1 }], { path: 'rows' });
    expect(ok.value).toEqual([{ id: 1, name: 'a' }]);
    expect(ok.dropped).toEqual(['rows.0.extra']);
    expect(checkJson(Rows, [{ id: 'x' }], { path: 'rows' }).problems.map((problem) => problem.path)).toEqual(['rows.0.id']);
    expect(checkJson(Rows, { id: 1 }, { path: 'rows' }).problems).toEqual([{ path: 'rows', message: 'rows must be an array' }]);
  });
});

describe('applyJsonColumns', () => {
  const target = (dto: Record<string, unknown>, before: Record<string, unknown> | null = null) => {
    const values: Record<string, unknown> = {};
    class Row {
      set(key: string, value: unknown) {
        values[key] = value;
      }
    }
    return { c: { dto, before, row: new Row(), issues: new Issues() }, values };
  };

  it('sets the checked value of each sent column and reports problems as field errors', () => {
    const { c, values } = target({ section: { enable: true, junk: 1 }, other: { digits: 'x' } });
    applyJsonColumns(c, { section: Section, other: Section, unsent: Section });
    expect(values).toEqual({ section: { enable: true }, other: { digits: 'x' } });
    expect(c.issues.fields).toEqual({ 'other.digits': ['digits must be a number'] });
  });

  it('with merge, a partial save changes only the keys it sends; null clears a key; a null column stays null', () => {
    const before = { section: { enable: true, digits: 2, legacy: 'x' }, other: { enable: false, digits: 3 } };
    const { c, values } = target({ section: { digits: 4, fresh: 1 }, other: null }, before);
    applyJsonColumns(c, { section: Section, other: Section }, 'Row', { merge: true });
    // The unknown `fresh` is still dropped; the stored keys not sent (an unknown one too) stay.
    expect(values).toEqual({ section: { enable: true, digits: 4, legacy: 'x' }, other: null });
    const cleared = target({ section: { digits: null } }, before);
    applyJsonColumns(cleared.c, { section: Section }, 'Row', { merge: true });
    expect(cleared.values.section).toEqual({ enable: true, digits: null, legacy: 'x' });
  });
});

describe('applyJsonColumns: unknown keys by payload strictness', () => {
  const target = (dto: Record<string, unknown>, before: Record<string, unknown> | null = null) => {
    const values: Record<string, unknown> = {};
    class Row {
      set(key: string, value: unknown) {
        values[key] = value;
      }
    }
    return { c: { dto, before, row: new Row(), issues: new Issues() }, values };
  };
  beforeEach(() => resetPayloadWarnings());

  it('warn: dropped as before (a stored one sent back unchanged kept) and reported per column', () => {
    const { c, values } = target({ section: { enable: true, junk: 1, legacy: 'x' } }, { section: { legacy: 'x' } });
    applyJsonColumns(c, { section: Section }, 'Row', { strict: 'warn' });
    expect(values).toEqual({ section: { enable: true, legacy: 'x' } });
    expect(c.issues.fields).toEqual({});
    expect(payloadWarnings()).toEqual([
      { endpoint: 'Row section', field: 'section.junk', count: 1 },
      { endpoint: 'Row section', field: 'section.legacy', count: 1 },
    ]);
  });

  it('error: every unknown key refused, a stored one sent back unchanged too; the column is not set', () => {
    const { c, values } = target({ section: { enable: true, junk: 1, legacy: 'x' } }, { section: { legacy: 'x' } });
    applyJsonColumns(c, { section: Section }, 'Row', { strict: 'error' });
    expect(c.issues.fields).toEqual({ 'section.junk': ['junk is not a field of this payload'], 'section.legacy': ['legacy is not a field of this payload'] });
    expect(values).toEqual({});
  });

  it('error: a save with no unknown key is taken as usual (merged with merge)', () => {
    const { c, values } = target({ section: { digits: 4 } }, { section: { enable: true, digits: 2 } });
    applyJsonColumns(c, { section: Section }, 'Row', { strict: 'error', merge: true });
    expect(c.issues.fields).toEqual({});
    expect(values).toEqual({ section: { enable: true, digits: 4 } });
  });
});

describe('mergeJson', () => {
  it('merges objects at every depth; lists and values replace; nothing stored takes what was sent', () => {
    const stored = { a: { b: 1, c: { d: 1, e: 2 } }, list: [1, 2], v: 1, o: 5 };
    expect(mergeJson(stored, { a: { c: { e: 3 } }, list: [3], o: { x: 1 } })).toEqual({ a: { b: 1, c: { d: 1, e: 3 } }, list: [3], v: 1, o: { x: 1 } });
    expect(mergeJson(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(mergeJson(null, { a: 1 })).toEqual({ a: 1 });
    expect(stored.a.c).toEqual({ d: 1, e: 2 });
  });
});

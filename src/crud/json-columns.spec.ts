import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Issues } from './issues.js';
import { applyJsonColumns, checkJson, JsonField } from './json-columns.js';

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
});

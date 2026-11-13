import { describe, expect, it } from 'vitest';
import { chunkedBulkCreate } from './bulk-chunks.js';

describe('bulkCreate in batches', () => {
  const recorder = () => {
    const calls: number[] = [];
    const original = async function (this: unknown, records: readonly object[]) {
      calls.push(records.length);
      return records.map((r) => ({ ...r, saved: true }));
    };
    return { calls, original };
  };

  it('one statement up to the batch size', async () => {
    const { calls, original } = recorder();
    const rows = Array.from({ length: 3 }, (_, i) => ({ i }));
    await chunkedBulkCreate(original, 3)(rows);
    expect(calls).toEqual([3]);
  });

  it('several statements beyond it, every row back in order, the options passed each time', async () => {
    const calls: Array<{ n: number; options: unknown }> = [];
    const original = async function (this: unknown, records: readonly object[], options?: object) {
      calls.push({ n: records.length, options });
      return records.map((r) => ({ ...r }));
    };
    const rows = Array.from({ length: 7 }, (_, i) => ({ i }));
    const t = { id: 'tx' };
    const created = (await chunkedBulkCreate(original, 3)(rows, { transaction: t })) as Array<{ i: number }>;
    expect(calls.map((c) => c.n)).toEqual([3, 3, 1]);
    expect(calls.every((c) => (c.options as { transaction: unknown }).transaction === t)).toBe(true);
    expect(created.map((r) => r.i)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('keeps the model as `this`', async () => {
    let seen: unknown;
    const original = async function (this: unknown, records: readonly object[]) {
      seen = this;
      return [...records];
    };
    const model = { name: 'Lines' };
    await chunkedBulkCreate(original, 2).call(model, [{}, {}, {}]);
    expect(seen).toBe(model);
  });
});

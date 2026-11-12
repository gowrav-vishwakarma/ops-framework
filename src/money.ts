/** Postgres DECIMAL columns arrive as strings. Treat empty as zero. */
export function num(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

export function sum<T>(items: readonly T[], pick: (item: T) => unknown): number {
  return round2(items.reduce((total, item) => total + num(pick(item)), 0));
}

/**
 * Amount in minor units (paise, cents) from a decimal string or number with at most two decimals,
 * so totals are compared as integers with no floating-point drift. Throws on any other format.
 */
export function parseStrictPaise(amount: string | number): number {
  const str = String(amount).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(str)) {
    throw new Error(`Invalid currency format: "${amount}". Expected decimal string format like "1250.00" or "500".`);
  }
  const [whole, fraction = ''] = str.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export const toPaise = parseStrictPaise;
/** Minor units back to a two-decimal string (`125000` -> `"1250.00"`). */
export const fromPaise = (paise: number): string => (paise / 100).toFixed(2);
/** Minor units back to a number (`125000` -> `1250`). */
export const fromPaiseToNumber = (paise: number): number => Math.round(paise) / 100;

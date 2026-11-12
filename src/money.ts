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

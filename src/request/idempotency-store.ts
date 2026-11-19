/** The few Redis commands the store needs (ioredis's signatures). */
export interface IdempotencyRedis {
  set(key: string, value: string, px: 'PX', milliseconds: number, nx: 'NX'): Promise<'OK' | null>;
  set(key: string, value: string, px: 'PX', milliseconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

/** What one key holds: the first save running, or its answer. */
type Entry = { state: 'running'; hash: string } | { state: 'done'; hash: string; status: number; body: unknown };

/** What a save with a key may do. */
export type IdempotencyStart =
  /** Nobody used the key yet: this save runs (and holds the key). */
  | { state: 'first' }
  /** The first save with the key is still running. */
  | { state: 'running' }
  /** The key was used for another body. */
  | { state: 'reused' }
  /** The key's save is done: its answer, to send again. */
  | { state: 'replay'; status: number; body: unknown };

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

/**
 * Idempotency keys in Redis, first wins (`SET NX`), so every pod sees one owner per key: the first save holds the key
 * while it runs (for its slot and a minute, so a crashed pod does not hold it for a day), then keeps its answer for
 * `ttlMs` (24 h). A failed save gives the key back, so a corrected retry with the same key can save.
 */
export class IdempotencyStore {
  constructor(
    private readonly redis: IdempotencyRedis,
    private readonly ttlMs = IDEMPOTENCY_TTL_MS,
  ) {}

  async start(key: string, hash: string, runningMs: number): Promise<IdempotencyStart> {
    // Twice: the key may expire between the refused SET and the GET.
    for (let attempt = 0; attempt < 2; attempt++) {
      const won = await this.redis.set(key, JSON.stringify({ state: 'running', hash } satisfies Entry), 'PX', Math.ceil(runningMs), 'NX');
      if (won === 'OK') return { state: 'first' };
      const raw = await this.redis.get(key);
      if (raw === null) continue;
      const entry = JSON.parse(raw) as Entry;
      if (entry.hash !== hash) return { state: 'reused' };
      if (entry.state === 'running') return { state: 'running' };
      return { state: 'replay', status: entry.status, body: entry.body };
    }
    return { state: 'running' };
  }

  /** The first save's answer, kept for replays. */
  async finish(key: string, hash: string, status: number, body: unknown): Promise<void> {
    await this.redis.set(key, JSON.stringify({ state: 'done', hash, status, body: body ?? null } satisfies Entry), 'PX', this.ttlMs);
  }

  /** The save failed: the key is free again. */
  async release(key: string): Promise<void> {
    await this.redis.del(key);
  }

  onApplicationShutdown(): void {
    (this.redis as { disconnect?: () => void }).disconnect?.();
  }
}

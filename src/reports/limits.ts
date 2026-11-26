import type { ReportLimits } from './options.js';

/**
 * Report run limits (`reports.limits`). A missing or out-of-range value falls back to the default, so a bad setting can
 * never make a run unbounded.
 *
 *   timeoutMs  Longest a report query may run.               Default 30000, 1000 to 300000.
 *   workMem    Sort and hash memory for one report query.    Default: the server's own setting. 4MB to 256MB, raised
 *              only inside the report's own transaction and never below what the database already has. Postgres may
 *              use it once per sort or hash step and per parallel worker, so keep it modest on small servers.
 *   maxRuns    Report runs at the same time in this process;  Default 3, 1 to 20.
 *              more wait their turn, which bounds the memory all reports use together.
 */
export interface ResolvedReportLimits {
  timeoutMs: number;
  /** A Postgres size such as `16MB`, or null to keep the server's setting. */
  workMem: { text: string; bytes: number } | null;
  maxRuns: number;
}

const MB = 1024 * 1024;
const UNITS: Record<string, number> = { kb: 1024, mb: MB, gb: 1024 * MB };

function whole(given: number | undefined, fallback: number, min: number, max: number): number {
  return given !== undefined && Number.isInteger(given) && given >= min && given <= max ? given : fallback;
}

/** `16MB`, `512kB`, `1GB` → bytes; null when it is not a size Postgres takes. */
export function sizeBytes(raw: string): number | null {
  const match = /^\s*(\d+)\s*(kB|MB|GB)\s*$/i.exec(raw);
  if (!match) return null;
  return Number(match[1]) * UNITS[match[2]!.toLowerCase()]!;
}

/** A valid size in range, else null: the server's own setting stays. */
function memory(raw: string | null | undefined): { text: string; bytes: number } | null {
  if (!raw) return null;
  const bytes = sizeBytes(raw);
  if (bytes === null || bytes < 4 * MB || bytes > 256 * MB) return null;
  return { text: raw.trim(), bytes };
}

export function reportLimits(given: Partial<ReportLimits> = {}): ResolvedReportLimits {
  return {
    timeoutMs: whole(given.timeoutMs, 30000, 1000, 300000),
    workMem: memory(given.workMem),
    maxRuns: whole(given.maxRuns, 3, 1, 20),
  };
}

/**
 * At most `size` holders at once; the rest wait in order. A waiter gives up after `waitMs`, so a
 * stuck report cannot hold others forever.
 */
export class RunGate {
  private active = 0;
  private readonly waiting: { start: () => void; timer: NodeJS.Timeout }[] = [];

  constructor(private readonly size: number) {}

  async run<T>(waitMs: number, busy: () => Error, fn: () => Promise<T>): Promise<T> {
    await this.enter(waitMs, busy);
    try {
      return await fn();
    } finally {
      this.leave();
    }
  }

  private enter(waitMs: number, busy: () => Error): Promise<void> {
    if (this.active < this.size) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        start: () => {
          clearTimeout(entry.timer);
          this.active += 1;
          resolve();
        },
        timer: setTimeout(() => {
          const at = this.waiting.indexOf(entry);
          if (at >= 0) this.waiting.splice(at, 1);
          reject(busy());
        }, waitMs),
      };
      this.waiting.push(entry);
    });
  }

  private leave(): void {
    this.active -= 1;
    this.waiting.shift()?.start();
  }
}

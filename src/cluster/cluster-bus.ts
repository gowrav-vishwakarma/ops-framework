import { Logger } from '@nestjs/common';

export type BusHandler<T = unknown> = (payload: T) => void | Promise<void>;

/**
 * Fire-and-forget messages to every process of the deployment: cache invalidation (placement,
 * ACL, settings). Not for business events: a process that is down misses the message, so every
 * cache that listens here also has a short TTL as a backstop. Business events use the outbox.
 */
export abstract class ClusterBus {
  /** True when messages reach other processes (Redis). False: this process only. */
  abstract readonly distributed: boolean;
  /** How long a broadcast may take to reach every process. Callers wait this before relying on it. */
  abstract readonly settleMs: number;

  protected readonly logger = new Logger('ClusterBus');
  private readonly handlers = new Map<string, Set<BusHandler>>();

  /** Sends `payload` to every process, this one included. */
  abstract publish<T>(topic: string, payload: T): Promise<void>;

  /** Runs `handler` for every message on `topic`, from any process. Returns the unsubscribe. */
  subscribe<T>(topic: string, handler: BusHandler<T>): () => void {
    const set = this.handlers.get(topic) ?? new Set<BusHandler>();
    set.add(handler as BusHandler);
    this.handlers.set(topic, set);
    return () => set.delete(handler as BusHandler);
  }

  /** Delivers one received message to this process's handlers. A failing handler is logged, never thrown. */
  protected async deliver(topic: string, payload: unknown): Promise<void> {
    for (const handler of this.handlers.get(topic) ?? []) {
      try {
        await handler(payload);
      } catch (error) {
        this.logger.error(`Handler of "${topic}" failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** One process: delivery is a direct call. The default when no Redis is configured. */
export class LocalBus extends ClusterBus {
  readonly distributed = false;
  readonly settleMs = 0;

  async publish<T>(topic: string, payload: T): Promise<void> {
    await this.deliver(topic, payload);
  }
}

/** Topics the framework itself publishes. */
export const BUS_TOPICS = {
  /** `{ companyId }`: the company's route changed (move, disable); drop cached placements. */
  placement: 'framework.placement',
  /** `{ companyId }`: roles or overrides changed; drop cached permission sets. */
  acl: 'framework.acl',
  /** `{ companyId }`: settings changed. */
  settings: 'framework.settings',
} as const;

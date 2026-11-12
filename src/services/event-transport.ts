import type { EventEnvelope } from './envelope.js';
import type { Subscription } from './dispatcher.js';

export type Deliver = (subscription: Subscription, envelope: EventEnvelope) => Promise<void>;

/**
 * Carries published events to subscribers. `publish` resolves once the event is safely handed over
 * (the outbox row is then marked published); it throws when it could not be, and the sweeper
 * publishes it again later. Subscribers are idempotent per event id, so a repeat is harmless.
 */
export abstract class EventTransport {
  abstract readonly name: string;
  abstract publish(envelope: EventEnvelope): Promise<void>;
  /** Starts consuming for this process's subscribers. */
  abstract start(subscriptions: Subscription[], deliver: Deliver): Promise<void>;
  abstract stop(): Promise<void>;
}

/**
 * One process: publishing delivers to every subscriber right away. A subscriber that fails makes
 * `publish` throw, so the event stays unpublished and the sweeper retries it; the subscribers that
 * already succeeded skip it then.
 */
export class LocalEventTransport extends EventTransport {
  readonly name = 'local';
  private subscriptions: Subscription[] = [];
  private deliver: Deliver | null = null;

  async publish(envelope: EventEnvelope): Promise<void> {
    if (!this.deliver) throw new Error('Event transport not started');
    const failures: unknown[] = [];
    for (const subscription of this.subscriptions) {
      if (subscription.contract.name !== envelope.contract || subscription.event !== envelope.event) continue;
      await this.deliver(subscription, envelope).catch((error: unknown) => failures.push(error));
    }
    if (failures.length) throw failures[0];
  }

  async start(subscriptions: Subscription[], deliver: Deliver): Promise<void> {
    this.subscriptions = subscriptions;
    this.deliver = deliver;
  }

  async stop(): Promise<void> {
    this.deliver = null;
  }
}

import { Injectable, Logger } from '@nestjs/common';

export interface Notification {
  /** Users of the company who should see it. */
  userIds: number[];
  title: string;
  body?: string;
}

/**
 * Where steps send "tell these users" messages. Today it logs; push, email and in-app inbox plug in
 * here later without touching any step. Call it from `c.afterCommit` so nobody is told about a
 * change that was rolled back.
 */
@Injectable()
export class Notifier {
  private readonly logger = new Logger('Notifier');

  async send(companyId: number, notification: Notification): Promise<void> {
    this.logger.log(`company ${companyId} -> users [${notification.userIds.join(', ')}]: ${notification.title}`);
  }
}

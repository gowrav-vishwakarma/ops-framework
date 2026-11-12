import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { errorOf, type CallEnvelope, type CallReply } from './envelope.js';
import { sign } from './signing.js';

/** Path of the service endpoint, under the app's global prefix. */
export const CALLS_PATH = '_ops/calls';

const RETRYABLE = new Set([502, 503, 504]);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Calls a contract that another deployment answers, over plain internal HTTP (load-balanced by the
 * platform: a Kubernetes Service, ECS Service Connect). Signed with the shared service secret.
 * Queries, and commands that carry an idempotency key, are retried on network errors and 502-504:
 * the receiving side runs a keyed command once.
 */
@Injectable()
export class RemoteCalls {
  private readonly logger = new Logger('RemoteCalls');

  constructor(@Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions) {}

  endpointOf(contract: string): string | undefined {
    return this.options.services?.endpoints?.[contract];
  }

  async call(envelope: CallEnvelope, retryable: boolean, timeoutMs = 15_000): Promise<unknown> {
    const base = this.endpointOf(envelope.contract);
    const secret = this.options.services?.secret;
    if (!base) throw new ServiceUnavailableException(`Contract "${envelope.contract}" is not answered by this process and has no endpoint`);
    if (!secret) throw new ServiceUnavailableException('services.secret is required to call another deployment');
    const body = JSON.stringify(envelope);
    const attempts = retryable ? 3 : 1;
    let last: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const timestamp = Date.now();
      try {
        const response = await fetch(`${base.replace(/\/$/, '')}/${CALLS_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-ops-ts': String(timestamp), 'x-ops-sig': sign(secret, timestamp, body) },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (RETRYABLE.has(response.status) && attempt < attempts) {
          last = new ServiceUnavailableException(`${envelope.contract} answered ${response.status}`);
        } else {
          const reply = (await response.json()) as CallReply;
          if (reply.ok) return reply.result;
          throw errorOf(reply);
        }
      } catch (error) {
        if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
        last = error;
        this.logger.warn(`${envelope.contract}.${envelope.call} attempt ${attempt} failed: ${error.message}`);
      }
      if (attempt < attempts) await sleep(100 * 4 ** (attempt - 1));
    }
    throw last instanceof ServiceUnavailableException ? last : new ServiceUnavailableException(`${envelope.contract} is unreachable`);
  }
}

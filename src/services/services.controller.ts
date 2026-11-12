import { Body, Controller, ForbiddenException, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { ServiceDispatcher } from './dispatcher.js';
import { replyOf, type CallEnvelope, type CallReply } from './envelope.js';
import { CALLS_PATH } from './remote-calls.js';
import { verify } from './signing.js';

/**
 * Where other deployments call the contracts this process answers. Not a user route: no user token,
 * a service signature instead. Replies are always 200 with `{ ok }`, so a load balancer's 5xx is
 * never mistaken for a handler's answer. Expose it on the internal network only.
 */
@Controller()
export class ServicesController {
  constructor(
    private readonly dispatcher: ServiceDispatcher,
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
  ) {}

  @Public()
  @Post(CALLS_PATH)
  @HttpCode(200)
  async call(@Body() envelope: CallEnvelope, @Headers('x-ops-ts') ts?: string, @Headers('x-ops-sig') sig?: string): Promise<CallReply> {
    const secret = this.options.services?.secret;
    if (!secret || !sig || !verify(secret, Number(ts), JSON.stringify(envelope), sig)) throw new ForbiddenException('Bad service signature');
    try {
      return { ok: true, result: await this.dispatcher.call(envelope) };
    } catch (error) {
      return replyOf(error);
    }
  }
}

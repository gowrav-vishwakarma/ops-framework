import { Inject, Injectable, InternalServerErrorException, Optional, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { ServiceClient } from '../services/service-client.js';
import { PlacementResolver } from '../tenancy/placement.js';
import { TenantSessions, type SessionProfile } from './contracts.js';

/** What a refresh token stands for. */
export interface RefreshGrant {
  platformUserId: number;
  companyId: number;
  /** The choice made with the company (role...), reused when the session is renewed. */
  choice?: Record<string, unknown>;
}

/**
 * Where refresh tokens are kept: the project's own table on its control plane. Only a hash of the
 * token is ever given to the store.
 */
export abstract class RefreshTokenStore {
  abstract save(record: RefreshGrant & { tokenHash: string; expiresAt: Date; userAgent: string | null }): Promise<void>;
  /** Revokes the token and returns what it was for; null when unknown, expired or already used. Must be atomic. */
  abstract consume(tokenHash: string): Promise<RefreshGrant | null>;
  abstract revoke(tokenHash: string): Promise<void>;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * The token half of sign-in, for a project's platform service. The project checks the password,
 * memberships, licenses and whatever else it has; this issues the tokens:
 *  - `loginToken`: between the password and the company choice (`typ: 'login'`);
 *  - `profiles`: how each tenant sees the person, for the company picker;
 *  - `open`: asks the company's tenant (`TenantSessions.open`) and signs the company token with the
 *    routing epoch, plus a rotating refresh token kept by the project's `RefreshTokenStore`;
 *  - `redeem` / `revoke`: refresh-token rotation and sign-out.
 */
@Injectable()
export class SessionTokens {
  constructor(
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
    private readonly jwt: JwtService,
    private readonly placements: PlacementResolver,
    private readonly services: ServiceClient,
    @Optional() private readonly store?: RefreshTokenStore,
  ) {}

  loginToken(platformUserId: number, extra: Record<string, unknown> = {}): Promise<string> {
    return this.jwt.signAsync({ ...extra, sub: platformUserId, typ: 'login' }, { expiresIn: (this.options.auth.loginTtl ?? '10m') as never });
  }

  /** An admin token (`typ: 'admin'`): the project's admin sign-in calls this after its own checks. */
  adminToken(adminId: number, claims: Record<string, unknown> = {}): Promise<string> {
    if (!this.options.admin) throw new InternalServerErrorException('FrameworkOptions.admin is not set');
    return this.jwt.signAsync({ ...claims, sub: adminId, typ: 'admin' }, { expiresIn: (this.options.admin.tokenTtl ?? '8h') as never });
  }

  /** The person's profile in each company, asked of each company's tenant; null where it could not answer. */
  async profiles(platformUserId: number, companyIds: number[]): Promise<Map<number, SessionProfile | null>> {
    const sessions = this.services.for(TenantSessions);
    const answers = await Promise.all(
      companyIds.map((companyId) => sessions.query('profile', { platformUserId }, { companyId }).catch(() => null)),
    );
    return new Map(companyIds.map((companyId, index) => [companyId, answers[index] ?? null]));
  }

  /** Opens a company. Call it after the project's own checks (membership, license). */
  async open(platformUserId: number, companyId: number, options: { choice?: Record<string, unknown>; userAgent?: string } = {}): Promise<TokenPair> {
    const placement = await this.placements.resolve({ companyId });
    const session = await this.services.for(TenantSessions).command('open', { platformUserId, choice: options.choice }, { companyId });
    // The framework's claims last: a tenant cannot change who, where or which epoch.
    const accessToken = await this.jwt.signAsync({ ...session.claims, uid: session.userId, sub: platformUserId, cmp: companyId, ep: placement.epoch, typ: 'access' });
    const refreshToken = randomBytes(32).toString('base64url');
    await this.requireStore().save({
      platformUserId,
      companyId,
      choice: options.choice,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + (this.options.auth.refreshTtlDays ?? 30) * 86_400_000),
      userAgent: options.userAgent?.slice(0, 255) ?? null,
    });
    return { accessToken, refreshToken };
  }

  /** Uses up a refresh token. The project re-checks access, then calls `open` with the grant. */
  async redeem(refreshToken: string): Promise<RefreshGrant> {
    const grant = await this.requireStore().consume(hashToken(refreshToken));
    if (!grant) throw new UnauthorizedException('Session expired');
    return grant;
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.requireStore().revoke(hashToken(refreshToken));
  }

  private requireStore(): RefreshTokenStore {
    if (!this.store) throw new InternalServerErrorException('No RefreshTokenStore provider: the platform module must provide one');
    return this.store;
  }
}

import Ductape from '@ductape/sdk';
import { ActorContext, UserRole } from '../../common/types/index.js';
import { SessionTokenPayload } from './identity.service.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';

export interface DuctapeSessionData {
  role: UserRole;
  customerId?: string;
  actorType: 'user' | 'agent' | 'system';
  scope?: string[];
  email: string;
}

export interface DuctapeSessionConfig {
  product?: string;
  env?: string;
  defaultTag?: string;
}

export class DuctapeSessionService {
  private readonly product: string;
  private readonly env: string;
  private readonly defaultTag: string;

  constructor(
    private readonly ductape: Ductape,
    config: DuctapeSessionConfig = {}
  ) {
    this.product = config.product || process.env.DUCTAPE_PRODUCT || 'commerce-backend';
    this.env = config.env || process.env.DUCTAPE_ENV || 'dev';
    this.defaultTag = config.defaultTag || 'user-session';
  }

  public async createSession(
    userId: string,
    data: DuctapeSessionData
  ): Promise<{ token: string; tag: string }> {
    const tag = this.defaultTag;
    const session = await this.ductape.sessions.start({
      product: this.product,
      env: this.env,
      tag,
      data: {
        ...data,
        sub: userId,
      },
    });

    return {
      token: session.token,
      tag,
    };
  }

  public async verifySession(token: string, tag?: string): Promise<SessionTokenPayload> {
    const res = await this.ductape.sessions
      .verify({
        product: this.product,
        env: this.env,
        tag: tag || this.defaultTag,
        token,
      })
      .catch(() => null);

    if (!res || !res.valid) {
      throw new UnauthorizedError('Invalid or expired Ductape session token.');
    }

    const data = (res.data || {}) as Record<string, unknown>;
    return {
      sub: String(data.sub || res.sessionId || 'unknown'),
      email: String(data.email || 'user@ductape.internal'),
      role: (data.role as UserRole) || 'customer',
      customerId: typeof data.customerId === 'string' ? data.customerId : null,
      actorType: (data.actorType as 'user' | 'agent' | 'system') || 'user',
      scope: Array.isArray(data.scope) ? (data.scope as string[]) : undefined,
    };
  }

  public async revokeSession(sessionId: string, tag?: string): Promise<void> {
    await this.ductape.sessions
      .revoke({
        product: this.product,
        env: this.env,
        tag: tag || this.defaultTag,
        sessionId,
      })
      .catch((err) => {
        console.error('[DuctapeSession] Failed to revoke session on Ductape:', err);
      });
  }

  public toActorContext(payload: SessionTokenPayload): ActorContext {
    return {
      actorId: payload.sub,
      actorType: payload.actorType,
      role: payload.role,
      customerId: payload.customerId ?? undefined,
      scope: payload.scope,
    };
  }
}

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { IDatabaseClient } from '../../common/database/index.js';
import { CryptoUtils } from '../../common/utils/crypto.js';
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../../common/errors/app-error.js';
import { Customer, User, UserRole, ActorType, ActorContext } from '../../common/types/index.js';

export interface CreateCustomerInput {
  email: string;
  name: string;
}

export interface RegisterUserInput {
  email: string;
  password: string;
  role: UserRole;
  name?: string;
  customerId?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    role: UserRole;
    customerId?: string | null;
  };
}

export interface SessionTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  customerId?: string | null;
  actorType: ActorType;
  scope?: string[];
}

export class IdentityService {
  private readonly jwtSecret: string;
  private readonly saltRounds = 10;

  constructor(
    private readonly db: IDatabaseClient,
    jwtSecret = process.env.JWT_SECRET || 'dev_secret_jwt_key_change_in_production'
  ) {
    this.jwtSecret = jwtSecret;
  }

  public async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    const existing = await this.db.query<Customer>(
      'SELECT id, email, name, created_at FROM customers WHERE email = $1',
      [input.email.toLowerCase()]
    );
    if (existing.rowCount > 0) {
      return existing.rows[0];
    }

    const id = CryptoUtils.generateId('cus');
    const res = await this.db.query<Customer>(
      `INSERT INTO customers (id, email, name, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id, email, name, created_at`,
      [id, input.email.toLowerCase(), input.name]
    );

    return res.rows[0];
  }

  public async registerUser(input: RegisterUserInput): Promise<User> {
    if (!input.email || !input.password) {
      throw new ValidationError('Email and password are required');
    }

    const existing = await this.db.query<User>(
      'SELECT id FROM users WHERE email = $1',
      [input.email.toLowerCase()]
    );
    if (existing.rowCount > 0) {
      throw new ConflictError(`User with email '${input.email}' already exists.`);
    }

    let customerId = input.customerId;
    if (!customerId && input.role === 'customer') {
      const customer = await this.createCustomer({
        email: input.email,
        name: input.name || input.email.split('@')[0],
      });
      customerId = customer.id;
    }

    const passwordHash = await bcrypt.hash(input.password, this.saltRounds);
    const userId = CryptoUtils.generateId('usr');

    const res = await this.db.query<User>(
      `INSERT INTO users (id, email, password_hash, role, customer_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, email, password_hash, role, customer_id, created_at`,
      [userId, input.email.toLowerCase(), passwordHash, input.role, customerId ?? null]
    );

    return res.rows[0];
  }

  public async login(input: LoginInput): Promise<AuthTokens> {
    const res = await this.db.query<User>(
      'SELECT id, email, password_hash, role, customer_id, created_at FROM users WHERE email = $1',
      [input.email.toLowerCase()]
    );

    if (res.rowCount === 0) {
      throw new UnauthorizedError('Invalid email or password.');
    }

    const user = res.rows[0];
    const passwordMatch = await bcrypt.compare(input.password, user.password_hash);
    if (!passwordMatch) {
      throw new UnauthorizedError('Invalid email or password.');
    }

    const payload: SessionTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      customerId: user.customer_id,
      actorType: user.role === 'agent' ? 'agent' : 'user',
    };

    const accessToken = jwt.sign(payload, this.jwtSecret, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ sub: user.id }, this.jwtSecret, { expiresIn: '7d' });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        customerId: user.customer_id,
      },
    };
  }

  public verifyToken(token: string): SessionTokenPayload {
    try {
      const decoded = jwt.verify(token, this.jwtSecret) as SessionTokenPayload;
      return decoded;
    } catch {
      throw new UnauthorizedError('Invalid or expired authentication token.');
    }
  }

  public createAgentToken(
    agentId: string,
    role: UserRole = 'agent',
    scope: string[] = ['*'],
    customerId?: string
  ): string {
    const payload: SessionTokenPayload = {
      sub: agentId,
      email: `${agentId}@agent.internal`,
      role,
      actorType: 'agent',
      scope,
      customerId,
    };
    return jwt.sign(payload, this.jwtSecret, { expiresIn: '24h' });
  }

  public toActorContext(tokenOrPayload: string | SessionTokenPayload): ActorContext {
    const payload = typeof tokenOrPayload === 'string' ? this.verifyToken(tokenOrPayload) : tokenOrPayload;
    return {
      actorId: payload.sub,
      actorType: payload.actorType,
      role: payload.role,
      customerId: payload.customerId ?? undefined,
      scope: payload.scope,
    };
  }
}

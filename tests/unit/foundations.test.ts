import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '../test-db.js';
import { IDatabaseClient } from '../../src/common/database/index.js';
import { StateMachine } from '../../src/common/state-machine/index.js';
import {
  AppError,
  InvalidTransitionError,
  IdempotencyConflictError,
  UnauthorizedError,
  InsufficientInventoryError,
} from '../../src/common/errors/app-error.js';
import { IdempotencyService } from '../../src/modules/idempotency/idempotency.service.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';

describe('Milestone 2: Foundations Test Suite', () => {
  let db: IDatabaseClient;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db.close();
  });

  describe('1. Standard Error Shape & Types', () => {
    it('serializes errors with code, message, details, and hint', () => {
      const err = new InsufficientInventoryError({
        unavailableProducts: [{ productId: 'prod_1', requestedQty: 5, availableQty: 2 }],
      });

      const json = err.toJSON();
      expect(err.statusCode).toBe(409);
      expect(json).toEqual({
        error: {
          code: 'INSUFFICIENT_INVENTORY',
          message: 'One or more requested items do not have sufficient available inventory.',
          details: {
            unavailableProducts: [{ productId: 'prod_1', requestedQty: 5, availableQty: 2 }],
          },
          hint: 'Reduce the requested quantities or remove out-of-stock items and try again.',
        },
      });
    });
  });

  describe('2. State Machine Transitions', () => {
    it('allows valid order happy path transitions', () => {
      expect(() => StateMachine.validateOrderTransition('pending', 'awaiting_payment')).not.toThrow();
      expect(() => StateMachine.validateOrderTransition('awaiting_payment', 'paid')).not.toThrow();
      expect(() => StateMachine.validateOrderTransition('paid', 'fulfilled')).not.toThrow();
      expect(() => StateMachine.validateOrderTransition('fulfilled', 'shipped')).not.toThrow();
      expect(() => StateMachine.validateOrderTransition('shipped', 'delivered')).not.toThrow();
    });

    it('enforces cancellation rules per PRD', () => {
      expect(StateMachine.canCancelOrder('pending')).toBe(true);
      expect(StateMachine.canCancelOrder('awaiting_payment')).toBe(true);
      expect(StateMachine.canCancelOrder('paid')).toBe(true);
      expect(StateMachine.canCancelOrder('shipped')).toBe(false);
      expect(StateMachine.canCancelOrder('delivered')).toBe(false);

      expect(() => StateMachine.validateOrderTransition('pending', 'cancelled')).not.toThrow();
      expect(() => StateMachine.validateOrderTransition('awaiting_payment', 'cancelled')).not.toThrow();
      expect(() => StateMachine.validateOrderTransition('paid', 'cancelled')).not.toThrow();

      // Illegal cancellation from shipped
      expect(() => StateMachine.validateOrderTransition('shipped', 'cancelled')).toThrow(InvalidTransitionError);
    });

    it('rejects backwards and illegal order transitions', () => {
      expect(() => StateMachine.validateOrderTransition('delivered', 'pending')).toThrow(InvalidTransitionError);
      expect(() => StateMachine.validateOrderTransition('cancelled', 'paid')).toThrow(InvalidTransitionError);
    });

    it('validates payment intent transitions', () => {
      expect(() => StateMachine.validatePaymentIntentTransition('created', 'processing')).not.toThrow();
      expect(() => StateMachine.validatePaymentIntentTransition('processing', 'succeeded')).not.toThrow();
      expect(() => StateMachine.validatePaymentIntentTransition('succeeded', 'failed')).toThrow(InvalidTransitionError);
    });

    it('validates reservation transitions', () => {
      expect(() => StateMachine.validateReservationTransition('held', 'committed')).not.toThrow();
      expect(() => StateMachine.validateReservationTransition('held', 'released')).not.toThrow();
      expect(() => StateMachine.validateReservationTransition('held', 'expired')).not.toThrow();
      expect(() => StateMachine.validateReservationTransition('committed', 'released')).toThrow(InvalidTransitionError);
    });
  });

  describe('3. Idempotency Service', () => {
    it('executes action once and returns cached result on identical replay', async () => {
      const idempotency = new IdempotencyService(db);
      let executionCount = 0;

      const payload = { amount: 5000, currency: 'NGN' };

      // First call
      const first = await idempotency.runIdempotent('idemp_test_1', 'checkout', payload, async () => {
        executionCount++;
        return { orderId: 'ord_123', status: 'awaiting_payment' };
      });

      expect(first.cached).toBe(false);
      expect(first.data).toEqual({ orderId: 'ord_123', status: 'awaiting_payment' });
      expect(executionCount).toBe(1);

      // Second call (replay with exact same payload)
      const second = await idempotency.runIdempotent('idemp_test_1', 'checkout', payload, async () => {
        executionCount++;
        return { orderId: 'ord_999', status: 'unexpected' };
      });

      expect(second.cached).toBe(true);
      expect(second.data).toEqual({ orderId: 'ord_123', status: 'awaiting_payment' });
      expect(executionCount).toBe(1); // operation was not re-executed
    });

    it('throws IdempotencyConflictError if key reused with different payload', async () => {
      const idempotency = new IdempotencyService(db);

      await idempotency.runIdempotent('idemp_test_conflict', 'checkout', { amount: 5000 }, async () => {
        return { status: 'ok' };
      });

      // Different payload with same key
      await expect(
        idempotency.runIdempotent('idemp_test_conflict', 'checkout', { amount: 9999 }, async () => {
          return { status: 'conflict' };
        })
      ).rejects.toThrow(IdempotencyConflictError);
    });
  });

  describe('4. Audit Log Service', () => {
    it('records append-only audit entries and queries them with filters', async () => {
      const audit = new AuditService(db);

      const entry1 = await audit.record({
        actorId: 'usr_1',
        actorType: 'user',
        action: 'order.created',
        entity: 'order',
        entityId: 'ord_100',
        after: { status: 'pending', total: 4000 },
      });

      const entry2 = await audit.record({
        actorId: 'agent_bot',
        actorType: 'agent',
        action: 'order.cancelled',
        entity: 'order',
        entityId: 'ord_100',
        before: { status: 'pending' },
        after: { status: 'cancelled' },
      });

      expect(entry1.id).toBeDefined();
      expect(entry2.actor_type).toBe('agent');

      const logs = await audit.listLogs({ entity: 'order', entityId: 'ord_100' });
      expect(logs.length).toBe(2);
      expect(logs[0].action).toBe('order.cancelled'); // latest first
      expect(logs[1].action).toBe('order.created');
    });
  });

  describe('5. Identity & Auth Service', () => {
    it('registers user, hashes password, and authenticates with JWT tokens', async () => {
      const identity = new IdentityService(db, 'test_jwt_secret');

      const user = await identity.registerUser({
        email: 'alice@example.com',
        password: 'securePassword123!',
        role: 'customer',
        name: 'Alice Johnson',
      });

      expect(user.id).toBeDefined();
      expect(user.email).toBe('alice@example.com');
      expect(user.customer_id).toBeDefined();
      expect(user.password_hash).not.toBe('securePassword123!');

      // Login
      const auth = await identity.login({
        email: 'alice@example.com',
        password: 'securePassword123!',
      });

      expect(auth.accessToken).toBeDefined();
      expect(auth.user.email).toBe('alice@example.com');

      // Verify token
      const claims = identity.verifyToken(auth.accessToken);
      expect(claims.sub).toBe(user.id);
      expect(claims.role).toBe('customer');
      expect(claims.customerId).toBe(user.customer_id);
      expect(claims.actorType).toBe('user');
    });

    it('rejects invalid password', async () => {
      const identity = new IdentityService(db, 'test_jwt_secret');

      await identity.registerUser({
        email: 'bob@example.com',
        password: 'correctPassword',
        role: 'customer',
      });

      await expect(
        identity.login({
          email: 'bob@example.com',
          password: 'wrongPassword',
        })
      ).rejects.toThrow(UnauthorizedError);
    });

    it('generates agent tokens with actor_type = agent and custom scope', () => {
      const identity = new IdentityService(db, 'test_jwt_secret');
      const token = identity.createAgentToken('agent_007', 'agent', ['orders:read', 'orders:write']);

      const claims = identity.verifyToken(token);
      expect(claims.sub).toBe('agent_007');
      expect(claims.actorType).toBe('agent');
      expect(claims.scope).toEqual(['orders:read', 'orders:write']);
    });
  });
});

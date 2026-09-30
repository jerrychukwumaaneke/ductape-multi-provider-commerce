import { Router, Response, NextFunction } from 'express';
import { CheckoutSaga } from '../../modules/orders/checkout-saga.js';
import { OrderService } from '../../modules/orders/orders.service.js';
import { IdentityService } from '../../modules/identity/identity.service.js';
import { AuthenticatedRequest, createAuthMiddleware } from '../middleware/auth.js';
import { ForbiddenError, ValidationError } from '../../common/errors/app-error.js';
import { OrderStatus } from '../../common/types/index.js';

export function createOrdersRouter(
  checkoutSaga: CheckoutSaga,
  orderService: OrderService,
  identityService: IdentityService
): Router {
  const router = Router();
  const auth = createAuthMiddleware(identityService);

  router.post('/checkout', auth.authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const idempotencyKey = (req.headers['idempotency-key'] as string) || req.body.idempotency_key;
      if (!idempotencyKey) {
        throw new ValidationError('Idempotency-Key header is required for checkout');
      }

      const { items, currency, provider, callback_url, ttl_minutes } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        throw new ValidationError('items array is required and must not be empty');
      }

      const customerId = req.actor?.customerId || 'cus_anonymous';

      const result = await checkoutSaga.executeCheckout(
        {
          customerId,
          email: `${customerId}@example.com`,
          items,
          idempotencyKey,
          currency,
          provider,
          callbackUrl: callback_url,
          ttlMinutes: ttl_minutes,
        },
        req.actor
      );

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/orders/:id', auth.authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const order = await orderService.getOrder(req.params.id as string);
      if (req.actor?.role !== 'admin' && req.actor?.customerId && order.customer_id !== req.actor.customerId) {
        throw new ForbiddenError('You do not have access to view this order');
      }
      res.json(order);
    } catch (err) {
      next(err);
    }
  });

  router.get('/orders', auth.authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const limit = Number(req.query.limit) || 20;
      const offset = Number(req.query.offset) || 0;
      const status = req.query.status as OrderStatus | undefined;

      let customerId = req.query.customer_id as string | undefined;
      if (req.actor?.role !== 'admin') {
        customerId = req.actor?.customerId;
      }

      const orders = await orderService.listOrders({
        customerId,
        status,
        limit,
        offset,
      });

      res.json({ orders, limit, offset });
    } catch (err) {
      next(err);
    }
  });

  router.post('/orders/:id/cancel', auth.authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const order = await orderService.getOrder(req.params.id as string);
      if (req.actor?.role !== 'admin' && req.actor?.customerId && order.customer_id !== req.actor.customerId) {
        throw new ForbiddenError('You do not have permission to cancel this order');
      }

      const cancelled = await orderService.cancelOrder(req.params.id as string, req.actor);
      res.json(cancelled);
    } catch (err) {
      next(err);
    }
  });

  router.patch(
    '/orders/:id/status',
    auth.authenticate,
    auth.requireRole('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { status } = req.body;
        if (!status) {
          throw new ValidationError('status is required');
        }

        const updated = await orderService.updateOrderStatus(req.params.id as string, status, req.actor);
        res.json(updated);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

import { Router, Response, NextFunction } from 'express';
import { PaymentService } from '../../modules/payments/payments.service.js';
import { IdentityService } from '../../modules/identity/identity.service.js';
import { AuthenticatedRequest, createAuthMiddleware } from '../middleware/auth.js';
import { ValidationError } from '../../common/errors/app-error.js';

export function createPaymentsRouter(
  paymentService: PaymentService,
  identityService: IdentityService
): Router {
  const router = Router();
  const auth = createAuthMiddleware(identityService);

  router.post('/payments', auth.authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const idempotencyKey = (req.headers['idempotency-key'] as string) || req.body.idempotency_key;
      if (!idempotencyKey) {
        throw new ValidationError('Idempotency-Key header is required');
      }

      const { order_id, amount_minor, currency, email, provider, callback_url } = req.body;
      if (!order_id || amount_minor === undefined || !currency) {
        throw new ValidationError('order_id, amount_minor, and currency are required');
      }

      const intent = await paymentService.createPaymentIntent({
        orderId: order_id,
        amountMinor: Number(amount_minor),
        currency,
        email: email || 'payer@example.com',
        idempotencyKey,
        provider,
        callbackUrl: callback_url,
      });

      res.status(201).json(intent);
    } catch (err) {
      next(err);
    }
  });

  router.get('/payments/:id', auth.authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const intent = await paymentService.getPaymentIntent(req.params.id as string);
      res.json(intent);
    } catch (err) {
      next(err);
    }
  });

  router.post('/payments/:id/cancel', auth.authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const intent = await paymentService.getPaymentIntent(req.params.id as string);
      const provider = paymentService['router'].getProvider(intent.provider);
      if (provider && intent.provider_ref) {
        await provider.cancelPayment(intent.provider_ref);
      }
      res.json({ message: 'Payment cancelled successfully' });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/payments/:id/refund',
    auth.authenticate,
    auth.requireRole('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { amount_minor } = req.body;
        const refund = await paymentService.refundPayment(
          req.params.id as string,
          amount_minor !== undefined ? Number(amount_minor) : undefined
        );
        res.json(refund);
      } catch (err) {
        next(err);
      }
    }
  );

  router.get('/transactions', auth.authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const paymentIntentId = req.query.payment_intent_id as string | undefined;
      const transactions = await paymentService.listTransactions(paymentIntentId);
      res.json({ transactions });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

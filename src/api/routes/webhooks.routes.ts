import { Router, Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { CheckoutSaga } from '../../modules/orders/checkout-saga.js';
import { renderCallbackStatusHtml } from '../views/receipt.template.js';

export function redactSensitiveHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'verif-hash' || lower === 'authorization' || lower === 'cookie') {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

export function logIncomingWebhook(provider: string, headers: Record<string, unknown>, rawBody: Buffer | string): void {
  try {
    const logDir = path.resolve(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = process.env.WEBHOOK_LOG_FILE || path.join(logDir, 'incoming-webhooks.log');
    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      provider,
      headers: redactSensitiveHeaders(headers),
      rawBody: typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'),
    }) + '\n';
    fs.appendFileSync(logFile, logEntry, 'utf8');
  } catch (err) {
    console.error('[Webhook Logger] Failed to log incoming raw webhook:', err);
  }
}

export function createWebhooksRouter(checkoutSaga: CheckoutSaga): Router {
  const router = Router();
  const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);

  router.post('/:provider', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = req.params.provider as string;

      // Register /webhooks/mock only when NODE_ENV=test
      if (provider === 'mock' && !isTestEnv) {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Endpoint /webhooks/mock is only registered when NODE_ENV=test',
          },
        });
        return;
      }

      const rawBody = (req as any).rawBody || Buffer.from(JSON.stringify(req.body));
      const headers = req.headers as Record<string, string | string[] | undefined>;

      // Log raw webhook request before any parsing or processing (with sensitive headers redacted)
      logIncomingWebhook(provider, headers, rawBody);

      const payload = req.body;
      const result = await checkoutSaga.processPaymentWebhook(provider, rawBody, headers, payload);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  const handleBrowserReturn = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = (req.params.provider || req.query.provider) as string | undefined;

      // Register /webhooks/mock only when NODE_ENV=test
      if (provider === 'mock' && !isTestEnv) {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Endpoint /webhooks/mock is only registered when NODE_ENV=test',
          },
        });
        return;
      }

      // Extract reference from possible payment gateway parameters:
      // Paystack: ?reference=... or ?trxref=...
      // Flutterwave: ?tx_ref=... or ?transaction_id=... or ?reference=...
      // Stripe: ?payment_intent=...
      const reference = (
        req.query.reference ||
        req.query.trxref ||
        req.query.tx_ref ||
        req.query.transaction_id ||
        req.query.payment_intent
      ) as string | undefined;

      const wantsJson = req.headers.accept?.includes('application/json') || req.query.format === 'json';

      const sendHtml = (statusCode: number, html: string) => {
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;"
        );
        res.status(statusCode).send(html);
      };

      // If no reference was provided (e.g. direct visit to /webhooks/paystack)
      if (!reference) {
        if (wantsJson) {
          res.status(200).json({
            status: 'ok',
            provider: provider || 'all',
            message: 'Webhook and redirect callback receiver is operational.',
          });
          return;
        }
        sendHtml(
          200,
          renderCallbackStatusHtml({
            provider: provider || 'Gateway',
            title: 'Gateway Callback Receiver Active',
            status: 'info',
            message: 'This endpoint is operational and ready to receive payment provider redirects and webhooks.',
          })
        );
        return;
      }

      // Explicit cancellation check (e.g. Flutterwave ?status=cancelled or ?status=failed)
      const queryStatus = (req.query.status as string)?.toLowerCase();
      if (queryStatus === 'cancelled' || queryStatus === 'failed') {
        if (wantsJson) {
          res.status(200).json({
            success: false,
            status: queryStatus,
            provider,
            reference,
            message: `Payment was ${queryStatus} by customer or provider.`,
          });
          return;
        }
        sendHtml(
          200,
          renderCallbackStatusHtml({
            provider,
            title: 'Payment Incomplete',
            status: 'warning',
            reference,
            message: `The payment session was ${queryStatus}. No charges were completed.`,
          })
        );
        return;
      }

      // Reconcile payment with provider and commit order if succeeded
      try {
        const result = await checkoutSaga.handlePaymentReturn(reference, provider);

        if (wantsJson) {
          res.status(result.success ? 200 : 400).json(result);
          return;
        }

        const amountFormatted = result.order?.total_minor
          ? `${(result.order.total_minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${result.order.currency}`
          : undefined;

        sendHtml(
          200,
          renderCallbackStatusHtml({
            provider,
            title: result.success ? 'Payment Successful!' : 'Payment Pending or Incomplete',
            status: result.success ? 'success' : 'warning',
            reference: result.reference,
            orderId: result.orderId,
            amountFormatted,
            message: result.message,
          })
        );
      } catch (reconErr: any) {
        console.warn(`[Webhooks GET /${provider || ''}] Payment return fallback for ${reference}:`, reconErr.message);

        if (wantsJson) {
          res.status(200).json({
            success: true,
            status: 'processing',
            provider,
            reference,
            message: 'Payment return received. Final status will be reconciled via background provider webhook.',
          });
          return;
        }

        sendHtml(
          200,
          renderCallbackStatusHtml({
            provider,
            title: 'Payment Received',
            status: 'info',
            reference,
            message: 'Thank you! Your payment response was received. Order confirmation is being finalized.',
          })
        );
      }
    } catch (err) {
      next(err);
    }
  };

  router.get('/:provider', handleBrowserReturn);
  router.get('/', handleBrowserReturn);

  return router;
}

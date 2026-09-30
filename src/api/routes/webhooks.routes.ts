import { Router, Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { CheckoutSaga } from '../../modules/orders/checkout-saga.js';

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

  return router;
}

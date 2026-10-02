import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { CheckoutSaga } from '../modules/orders/checkout-saga.js';
import { IdentityService } from '../modules/identity/identity.service.js';
import { InventoryService } from '../modules/inventory/inventory.service.js';
import { NotificationService } from '../modules/notifications/notifications.service.js';
import { OrderService } from '../modules/orders/orders.service.js';
import { PaymentService } from '../modules/payments/payments.service.js';
import { errorHandler } from './middleware/error-handler.js';
import { createAuthRouter } from './routes/auth.routes.js';
import { createProductsRouter } from './routes/products.routes.js';
import { createOrdersRouter } from './routes/orders.routes.js';
import { createPaymentsRouter } from './routes/payments.routes.js';
import { createWebhooksRouter } from './routes/webhooks.routes.js';
import { createNotificationsRouter } from './routes/notifications.routes.js';

export interface AppDependencies {
  identityService: IdentityService;
  inventoryService: InventoryService;
  orderService: OrderService;
  paymentService: PaymentService;
  notificationService: NotificationService;
  checkoutSaga: CheckoutSaga;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();

  // Trust proxy for reverse proxies / load balancers
  app.set('trust proxy', 1);

  // 1. Security Headers via Helmet
  app.use(helmet());

  // 2. CORS Allowlist
  const rawOrigins = process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,https://checkout.paystack.com,https://checkout.flutterwave.com';
  const allowedOrigins = rawOrigins.split(',').map((o) => o.trim());

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
          callback(null, true);
        } else {
          callback(new Error(`Blocked by CORS policy: origin '${origin}' not allowed`));
        }
      },
      credentials: true,
    })
  );

  // 3. General Rate Limiter (exempts /webhooks/* and /health, skipped during tests)
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) =>
      process.env.NODE_ENV === 'test' ||
      Boolean(process.env.VITEST) ||
      req.path === '/health' ||
      req.path.startsWith('/webhooks'),
  });
  app.use(limiter);

  // Stricter Rate Limiter for /auth/login (10 per 15 minutes)
  const authLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: {
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many login attempts. Please try again after 15 minutes.',
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (_req) => process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST),
  });
  app.use('/auth/login', authLoginLimiter);

  // 4. JSON body parser with 1MB size limit and rawBody capture for webhook signature verification
  app.use(
    express.json({
      limit: '1mb',
      verify: (req: Request, _res: Response, buf: Buffer) => {
        (req as any).rawBody = buf;
      },
    })
  );

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Root endpoint redirect
  app.get('/', (_req: Request, res: Response) => {
    res.redirect('/products');
  });

  // Mount API modules
  app.use('/auth', createAuthRouter(deps.identityService));
  app.use('/', createProductsRouter(deps.inventoryService, deps.identityService));
  app.use('/', createOrdersRouter(deps.checkoutSaga, deps.orderService, deps.identityService));
  app.use('/', createPaymentsRouter(deps.paymentService, deps.identityService));
  app.use('/webhooks', createWebhooksRouter(deps.checkoutSaga));
  app.use('/', createNotificationsRouter(deps.notificationService, deps.identityService));

  // Catch-all 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found on this server.',
      },
    });
  });

  // Global error handler
  app.use(errorHandler);

  return app;
}

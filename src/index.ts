import 'dotenv/config';
import { PostgresDatabaseClient, DuctapeDatabaseClient, IDatabaseClient } from './common/database/index.js';
import { PaymentIntent } from './common/types/index.js';
import { getDuctapeClient } from './common/ductape/index.js';
import { DuctapeJobScheduler } from './common/ductape/jobs.js';
import { IdentityService } from './modules/identity/identity.service.js';
import { InventoryService } from './modules/inventory/inventory.service.js';
import { OrderService } from './modules/orders/orders.service.js';
import { PaymentService } from './modules/payments/payments.service.js';
import { PaymentRouter } from './modules/payments/router.js';
import { MockPaymentProvider } from './modules/payments/providers/mock.provider.js';
import { PaystackPaymentProvider } from './modules/payments/providers/paystack.provider.js';
import { FlutterwavePaymentProvider } from './modules/payments/providers/flutterwave.provider.js';
import { StripePaymentProvider } from './modules/payments/providers/stripe.provider.js';
import { DuctapeApiPaymentProvider } from './modules/payments/providers/ductape-api.provider.js';
import { DuctapeSecretResolver } from './modules/payments/secrets.js';
import { NotificationService } from './modules/notifications/notifications.service.js';
import { MockTransport, HttpWebhookTransport, DuctapeNotificationTransport } from './modules/notifications/transports/index.js';
import { IdempotencyService } from './modules/idempotency/idempotency.service.js';
import { AuditService } from './modules/audit/audit.service.js';
import { CheckoutSaga } from './modules/orders/checkout-saga.js';
import { seedNotificationTemplates } from './modules/notifications/seed-templates.js';
import { seedProducts } from './db/seed-products.js';
import { seedDefaultUsers } from './db/seed-users.js';
import { runMigrations } from './db/migrate.js';
import { createApp } from './api/app.js';
import { McpCommerceServer } from './mcp/server.js';

export async function bootstrap() {
  // Initialize Ductape Platform SDK
  const ductape = getDuctapeClient();
  const secretResolver = new DuctapeSecretResolver(ductape);
  const secrets = await secretResolver.resolveProviderSecrets();

  // Resolve Database Client (Ductape Databases or PostgreSQL connection pool)
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/commerce_db';
  const remoteDbUrl = process.env.DATABASE_URL &&
    !process.env.DATABASE_URL.includes('localhost') &&
    !process.env.DATABASE_URL.includes('127.0.0.1')
      ? process.env.DATABASE_URL
      : undefined;

  const db = process.env.USE_DUCTAPE_DB === 'true'
    ? new DuctapeDatabaseClient(ductape, { connectionUrl: remoteDbUrl })
    : new PostgresDatabaseClient(connectionString);

  // Ensure database client is connected and ready before any operations run
  if (typeof db.connect === 'function') {
    const targetDesc = remoteDbUrl
      ? remoteDbUrl.replace(/:[^:@/]+@/, ':****@')
      : 'Ductape Workspace Registered Secret ($Secret{DB_COMMERCE_BACKEND_COMMERCE_DB_SND_URL} -> localhost:5432)';
    console.log(`[DatabaseBootstrap] Configured connection endpoint: ${targetDesc}`);

    const maxConnectAttempts = 5;
    const baseDelayMs = 1500;
    let connected = false;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxConnectAttempts; attempt++) {
      const startTime = Date.now();
      console.log(`[DatabaseBootstrap] Attempting database connection (attempt ${attempt}/${maxConnectAttempts})...`);
      try {
        await db.connect();
        const durationMs = Date.now() - startTime;
        console.log(`[DatabaseBootstrap] Database connection established successfully in ${durationMs}ms.`);
        connected = true;
        break;
      } catch (err: any) {
        lastError = err;
        const durationMs = Date.now() - startTime;
        const isInstant = durationMs < 500;
        console.error(
          `[DatabaseBootstrap] Connection attempt ${attempt}/${maxConnectAttempts} failed after ${durationMs}ms (${isInstant ? 'instant refusal' : 'timeout/slow failure'}): ${err.message || String(err)}`
        );
        if (attempt < maxConnectAttempts) {
          const delay = baseDelayMs * attempt;
          console.log(`[DatabaseBootstrap] Retrying database connection in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (!connected) {
      console.error(`[DatabaseBootstrap] All ${maxConnectAttempts} database connection attempts failed.`);
      throw lastError;
    }
  }

  // Ensure all schema tables exist before any queries or seeds run
  await runMigrations(db);

  // Seed default notification templates idempotently
  await seedNotificationTemplates(db);

  // Seed default catalog products and inventory idempotently
  await seedProducts(db);

  // Seed default customer & admin users idempotently
  await seedDefaultUsers(db);

  const identityService = new IdentityService(db);
  const auditService = new AuditService(db);
  const idempotencyService = new IdempotencyService(db);
  const inventoryService = new InventoryService(db);
  const orderService = new OrderService(db, inventoryService, auditService);

  // Setup Payment Providers & Router
  const router = new PaymentRouter();

  // Paystack
  const paystackKey = secrets.paystackSecretKey;
  if (paystackKey) {
    router.register(new PaystackPaymentProvider({ secretKey: paystackKey }));
  }

  // Flutterwave
  const flwKey = secrets.flutterwaveSecretKey;
  const flwHash = secrets.flutterwaveSecretHash;
  if (flwKey) {
    router.register(
      new FlutterwavePaymentProvider({
        secretKey: flwKey,
        secretHash: flwHash || '',
      })
    );
  }

  // Stripe
  const stripeKey = secrets.stripeSecretKey;
  const stripeWhSec = secrets.stripeWebhookSecret;
  if (stripeKey && stripeWhSec) {
    router.register(
      new StripePaymentProvider({
        secretKey: stripeKey,
        webhookSecret: stripeWhSec,
      })
    );
  }

  // Ductape API Provider (via ductape.api.run)
  if (process.env.DUCTAPE_API_PROVIDER === 'true') {
    router.register(new DuctapeApiPaymentProvider(ductape, { appTag: 'paystack' }));
  }

  // Fallback Mock provider
  router.register(new MockPaymentProvider('mock'));

  const paymentService = new PaymentService(db, router);

  // Setup Notifications (Ductape Notification Transport or fallback transports)
  const emailTransport = process.env.USE_DUCTAPE_NOTIF === 'true'
    ? new DuctapeNotificationTransport(ductape)
    : new MockTransport();
  const webhookTransport = new HttpWebhookTransport(5000);
  const notificationService = new NotificationService(db, emailTransport, webhookTransport);

  // Checkout Saga
  const checkoutSaga = new CheckoutSaga(
    db,
    orderService,
    inventoryService,
    paymentService,
    notificationService,
    idempotencyService,
    auditService
  );

  // Outbox Service & Worker
  const outboxService = paymentService.getOutboxService();
  outboxService.startWorker(Number(process.env.OUTBOX_INTERVAL_MS) || 2000);

  // Ductape Job Scheduler (for reservation expiry and retries)
  const jobScheduler = new DuctapeJobScheduler(ductape, inventoryService);
  await jobScheduler.registerReservationExpiryJob();
  jobScheduler.startLocalReaper(Number(process.env.REAPER_INTERVAL_MS) || 3000);

  // Reconciliation worker for stuck payment intents (Item 4)
  const reconcilerIntervalMs = Number(process.env.RECONCILER_INTERVAL_MS) || 60000;
  const reconcilerTimer = setInterval(() => {
    paymentService
      .reconcileStuckPaymentIntents(15, 50, async (tx: IDatabaseClient, intent: PaymentIntent) => {
        await inventoryService.commitReservations(intent.order_id, tx);
      })
      .catch((err) => console.error('[Reconciler] Error running reconciliation job:', err));
  }, reconcilerIntervalMs);
  if (reconcilerTimer.unref) reconcilerTimer.unref();

  // Express HTTP App
  const app = createApp({
    identityService,
    inventoryService,
    orderService,
    paymentService,
    notificationService,
    checkoutSaga,
  });

  // MCP Server
  const mcpServer = new McpCommerceServer(
    db,
    identityService,
    orderService,
    inventoryService,
    paymentService,
    notificationService,
    checkoutSaga,
    auditService
  );

  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => {
    console.log(`[Commerce Backend on Ductape] HTTP server listening on port ${port}`);
  });

  return { app, server, db, mcpServer, ductape, jobScheduler, outboxService };
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  bootstrap().catch((err) => {
    console.error('[Commerce Backend on Ductape] Fatal error during startup:', err);
    process.exit(1);
  });
}

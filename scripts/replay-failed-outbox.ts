import 'dotenv/config';
import { getDuctapeClient } from '../src/common/ductape/index.js';
import { DuctapeDatabaseClient } from '../src/common/database/ductape.database.js';
import { PostgresDatabaseClient, IDatabaseClient } from '../src/common/database/index.js';
import { OutboxRecord } from '../src/modules/outbox/outbox.service.js';
import { InventoryService } from '../src/modules/inventory/inventory.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { OrderService } from '../src/modules/orders/orders.service.js';
import { PaymentService } from '../src/modules/payments/payments.service.js';
import { PaymentRouter } from '../src/modules/payments/router.js';
import { PaystackPaymentProvider } from '../src/modules/payments/providers/paystack.provider.js';
import { FlutterwavePaymentProvider } from '../src/modules/payments/providers/flutterwave.provider.js';
import { MockPaymentProvider } from '../src/modules/payments/providers/mock.provider.js';
import { NotificationService } from '../src/modules/notifications/notifications.service.js';
import { MockTransport } from '../src/modules/notifications/transports/index.js';
import { IdempotencyService } from '../src/modules/idempotency/idempotency.service.js';
import { CheckoutSaga } from '../src/modules/orders/checkout-saga.js';
import { seedNotificationTemplates } from '../src/modules/notifications/seed-templates.js';

async function main() {
  const filter = process.argv[2];

  let db: IDatabaseClient;
  const isDuctape = process.env.USE_DUCTAPE_DB === 'true' || Boolean(process.env.DUCTAPE_ACCESS_KEY);
  if (isDuctape) {
    const ductape = getDuctapeClient();
    const ductapeEnv = process.env.DUCTAPE_ENV || 'snd';
    const ductapeProduct = process.env.DUCTAPE_PRODUCT || 'xavier_space:commerce_backend';
    await ductape.databases.connect({
      env: ductapeEnv,
      product: ductapeProduct,
      database: 'commerce_db',
    });
    db = new DuctapeDatabaseClient(ductape);
  } else {
    const connStr = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/commerce_db';
    db = new PostgresDatabaseClient(connStr);
  }

  // Ensure notification templates are seeded before replaying
  await seedNotificationTemplates(db);

  console.log(`\n======================================================`);
  console.log(`         REPLAY FAILED OUTBOX EVENTS`);
  if (filter) {
    console.log(`         Filter: ${filter}`);
  }
  console.log(`======================================================\n`);

  // Query failed rows
  let failedQuery = "SELECT id, event_type, retry_count, last_error, created_at FROM outbox WHERE status = 'failed'";
  const queryParams: unknown[] = [];
  if (filter) {
    if (filter.startsWith('obx_')) {
      failedQuery += " AND id = $1";
    } else {
      failedQuery += " AND event_type = $1";
    }
    queryParams.push(filter);
  }
  failedQuery += " ORDER BY created_at ASC";

  const failedRows = await db.query<OutboxRecord>(failedQuery, queryParams);
  console.log(`Found ${failedRows.rowCount} failed outbox event(s).\n`);

  if (failedRows.rowCount === 0) {
    console.log('No failed rows to replay.');
    await db.close();
    return;
  }

  for (const row of failedRows.rows) {
    console.log(`- [${row.id}] ${row.event_type} (retries: ${row.retry_count}) - Last error: ${row.last_error}`);
  }

  // Re-queue rows back to pending
  const ids = failedRows.rows.map((r) => r.id);
  const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(', ');
  const updateRes = await db.query(
    `UPDATE outbox
     SET status = 'pending', retry_count = 0, scheduled_for = NOW(), claimed_at = NULL, last_error = NULL
     WHERE id IN (${placeholders})`,
    ids
  );

  console.log(`\nRe-queued ${updateRes.rowCount} event(s) to 'pending' with retry_count = 0 and scheduled_for = NOW().`);

  // Initialize services and register handlers via CheckoutSaga
  const inventoryService = new InventoryService(db);
  const auditService = new AuditService(db);
  const orderService = new OrderService(db, inventoryService, auditService);
  const router = new PaymentRouter();

  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (paystackKey) {
    router.register(new PaystackPaymentProvider({ secretKey: paystackKey }));
  }
  const flwKey = process.env.FLUTTERWAVE_SECRET_KEY;
  const flwHash = process.env.FLUTTERWAVE_SECRET_HASH;
  if (flwKey && flwHash) {
    router.register(new FlutterwavePaymentProvider({ secretKey: flwKey, secretHash: flwHash }));
  }
  router.register(new MockPaymentProvider('mock'));

  const paymentService = new PaymentService(db, router);
  const outboxService = paymentService.getOutboxService();
  const notificationService = new NotificationService(db, new MockTransport());
  const idempotencyService = new IdempotencyService(db);

  // Registers all handlers (notification.send, payment.*_refund, inventory.release)
  new CheckoutSaga(
    db,
    orderService,
    inventoryService,
    paymentService,
    notificationService,
    idempotencyService,
    auditService
  );

  // Process pending events
  const runResult = await outboxService.processPending();
  console.log(`Replay processing result: ${runResult.processed} processed, ${runResult.failed} failed.\n`);

  await db.close();
}

main().catch((err) => {
  console.error('[replay-failed-outbox] Fatal error:', err);
  process.exit(1);
});

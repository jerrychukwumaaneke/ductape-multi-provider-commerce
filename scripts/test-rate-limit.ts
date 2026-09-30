process.env.NODE_ENV = 'production';
import { createApp } from '../src/api/app.js';
import { createTestDatabase } from '../tests/test-db.js';
import { IdentityService } from '../src/modules/identity/identity.service.js';
import { InventoryService } from '../src/modules/inventory/inventory.service.js';
import { OrderService } from '../src/modules/orders/orders.service.js';
import { PaymentService } from '../src/modules/payments/payments.service.js';
import { PaymentRouter } from '../src/modules/payments/router.js';
import { MockPaymentProvider } from '../src/modules/payments/providers/mock.provider.js';
import { NotificationService } from '../src/modules/notifications/notifications.service.js';
import { MockTransport } from '../src/modules/notifications/transports/index.js';
import { IdempotencyService } from '../src/modules/idempotency/idempotency.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { CheckoutSaga } from '../src/modules/orders/checkout-saga.js';

async function main() {
  const db = await createTestDatabase();
  const identityService = new IdentityService(db);
  const auditService = new AuditService(db);
  const idempotencyService = new IdempotencyService(db);
  const inventoryService = new InventoryService(db);
  const orderService = new OrderService(db, inventoryService, auditService);

  const router = new PaymentRouter();
  router.register(new MockPaymentProvider('mock'));
  const paymentService = new PaymentService(db, router);

  const mockTransport = new MockTransport();
  const notifService = new NotificationService(db, mockTransport, mockTransport);

  const checkoutSaga = new CheckoutSaga(
    db,
    orderService,
    inventoryService,
    paymentService,
    notifService,
    idempotencyService,
    auditService
  );

  const app = createApp({
    identityService,
    inventoryService,
    orderService,
    paymentService,
    notificationService: notifService,
    checkoutSaga,
  });

  const server = app.listen(8999, '127.0.0.1', () => {
    console.log('RATE_LIMIT_SERVER_READY on http://127.0.0.1:8999');
  });

  process.on('SIGINT', () => {
    server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

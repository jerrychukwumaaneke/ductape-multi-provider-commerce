import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '../test-db.js';
import { IDatabaseClient } from '../../src/common/database/index.js';
import { InventoryService } from '../../src/modules/inventory/inventory.service.js';
import { OrderService } from '../../src/modules/orders/orders.service.js';
import { PaymentService } from '../../src/modules/payments/payments.service.js';
import { PaymentRouter } from '../../src/modules/payments/router.js';
import { MockPaymentProvider } from '../../src/modules/payments/providers/mock.provider.js';
import { NotificationService } from '../../src/modules/notifications/notifications.service.js';
import { MockTransport } from '../../src/modules/notifications/transports/index.js';
import { IdempotencyService } from '../../src/modules/idempotency/idempotency.service.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { CheckoutSaga } from '../../src/modules/orders/checkout-saga.js';

describe('Milestone 6: Checkout Saga End-to-End Orchestration', () => {
  let db: IDatabaseClient;
  let inventoryService: InventoryService;
  let orderService: OrderService;
  let paymentService: PaymentService;
  let notifService: NotificationService;
  let mockTransport: MockTransport;
  let mockProvider: MockPaymentProvider;
  let idempotencyService: IdempotencyService;
  let auditService: AuditService;
  let checkoutSaga: CheckoutSaga;

  beforeEach(async () => {
    db = await createTestDatabase();
    inventoryService = new InventoryService(db);
    auditService = new AuditService(db);
    orderService = new OrderService(db, inventoryService, auditService);
    idempotencyService = new IdempotencyService(db);

    const router = new PaymentRouter();
    mockProvider = new MockPaymentProvider();
    router.register(mockProvider);
    paymentService = new PaymentService(db, router);

    mockTransport = new MockTransport();
    notifService = new NotificationService(db, mockTransport, mockTransport);

    checkoutSaga = new CheckoutSaga(
      db,
      orderService,
      inventoryService,
      paymentService,
      notifService,
      idempotencyService,
      auditService
    );

    // Setup templates & customer
    await notifService.createTemplate({
      key: 'order_confirmed',
      channel: 'email',
      category: 'transactional',
      subject: 'Order {{order_id}} Confirmed',
      body: 'Thank you {{customer_name}}, order total: {{total}}',
      required_vars: ['order_id', 'customer_name', 'total'],
    });

    await db.query("INSERT INTO customers (id, email, name) VALUES ('cus_buyer', 'buyer@saga.test', 'Saga Buyer')");
  });

  afterEach(async () => {
    await db.close();
  });

  describe('1. Happy Path: Checkout -> Payment Webhook -> Stock Commit -> Notification', () => {
    it('executes full checkout saga successfully', async () => {
      const { product } = await inventoryService.createProduct({
        sku: 'LAPTOP-PRO',
        name: 'Pro Laptop',
        price_minor: 150000,
        currency: 'USD',
        initial_stock: 5,
      });

      // 1. Checkout
      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_buyer',
        email: 'buyer@saga.test',
        idempotencyKey: 'idemp_saga_happy',
        currency: 'USD',
        items: [{ productId: product.id, qty: 2 }],
      });

      expect(checkout.order.status).toBe('awaiting_payment');
      expect(checkout.order.total_minor).toBe(300000);
      expect(checkout.paymentIntent.status).toBe('processing');

      // Inventory: on_hand = 5, reserved = 2
      const invBefore = await inventoryService.getInventory(product.id);
      expect(invBefore.on_hand).toBe(5);
      expect(invBefore.reserved).toBe(2);

      // 2. Webhook arrives (payment succeeded)
      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 300000, 'USD');
      const webhookRes = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      expect(webhookRes.duplicate).toBe(false);
      expect(webhookRes.order?.status).toBe('paid');

      // 3. Stock committed: on_hand = 3, reserved = 0!
      const invAfter = await inventoryService.getInventory(product.id);
      expect(invAfter.on_hand).toBe(3);
      expect(invAfter.reserved).toBe(0);

      // 4. Notification sent
      expect(mockTransport.sentMessages.length).toBe(1);
      expect(mockTransport.sentMessages[0].subject).toContain('Confirmed');
    });
  });

  describe('2. Failure Path: Payment Failed Webhook -> Stock Release', () => {
    it('releases held stock when payment fails', async () => {
      const { product } = await inventoryService.createProduct({
        sku: 'HEADPHONES-BT',
        name: 'Bluetooth Headphones',
        price_minor: 8000,
        currency: 'USD',
        initial_stock: 4,
      });

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_buyer',
        email: 'buyer@saga.test',
        idempotencyKey: 'idemp_saga_fail',
        items: [{ productId: product.id, qty: 1 }],
      });

      expect((await inventoryService.getInventory(product.id)).reserved).toBe(1);

      // Simulate payment failure
      mockProvider.shouldDeclineVerify = true;
      const sim = mockProvider.simulateWebhookPayload(
        checkout.paymentIntent.provider_ref!,
        8000,
        'USD',
        'charge.failed'
      );

      const webhookRes = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      expect(webhookRes.order?.status).toBe('payment_failed');

      // Stock released: on_hand = 4, reserved = 0
      const invAfter = await inventoryService.getInventory(product.id);
      expect(invAfter.on_hand).toBe(4);
      expect(invAfter.reserved).toBe(0);
    });
  });

  describe('3. Edge Case: Late Payment Webhook After Expiry -> Auto Refund', () => {
    it('automatically refunds payment if webhook arrives after order expiration', async () => {
      const { product } = await inventoryService.createProduct({
        sku: 'SMART-WATCH',
        name: 'Smart Watch',
        price_minor: 25000,
        currency: 'USD',
        initial_stock: 2,
      });

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_buyer',
        email: 'buyer@saga.test',
        idempotencyKey: 'idemp_saga_late',
        items: [{ productId: product.id, qty: 1 }],
      });

      // Advance time / force reservation expiry
      await db.query(
        "UPDATE reservations SET expires_at = NOW() - INTERVAL '10 minutes' WHERE order_id = $1",
        [checkout.order.id]
      );
      await inventoryService.expireOldReservations();

      const orderExpired = await orderService.getOrder(checkout.order.id);
      expect(orderExpired.status).toBe('expired');

      // Now a late success webhook arrives from provider!
      mockProvider.shouldDeclineVerify = false;
      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 25000, 'USD');

      const webhookRes = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      expect(webhookRes.latePaymentRefunded).toBe(true);

      // Check transactions to ensure refund was recorded
      const txns = await paymentService.listTransactions(checkout.paymentIntent.id);
      const refundTxn = txns.find((t) => t.type === 'refund');
      expect(refundTxn).toBeDefined();
      expect(refundTxn?.amount_minor).toBe(25000);
      expect(refundTxn?.status).toBe('succeeded');
    });
  });

  describe('4. Order Cancellation: Paid Order Cancellation & Outbox Refund Reliability (Item 1)', () => {
    it('cancels paid order, restocks inventory, and writes refund to outbox in same transaction; provider failure leaves queued refund intact', async () => {
      const { product } = await inventoryService.createProduct({
        sku: 'HEADPHONES-ANC',
        name: 'ANC Headphones',
        price_minor: 50000,
        currency: 'USD',
        initial_stock: 5,
      });

      // 1. Checkout 2 items
      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_buyer',
        email: 'buyer@saga.test',
        idempotencyKey: 'idemp_cancel_paid',
        items: [{ productId: product.id, qty: 2 }],
      });

      // 2. Webhook arrives, payment succeeds -> order is paid, inventory committed
      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 100000, 'USD');
      await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      const paidOrder = await orderService.getOrder(checkout.order.id);
      expect(paidOrder.status).toBe('paid');
      const invPaid = await inventoryService.getInventory(product.id);
      expect(invPaid.on_hand).toBe(3);
      expect(invPaid.reserved).toBe(0);

      // 3. Cancel the paid order
      const cancelledOrder = await orderService.cancelOrder(checkout.order.id, { actorId: 'cus_buyer', actorType: 'user' });
      expect(cancelledOrder.status).toBe('cancelled');

      // Assert inventory is restocked: on_hand is back to 5
      const invRestocked = await inventoryService.getInventory(product.id);
      expect(invRestocked.on_hand).toBe(5);
      expect(invRestocked.reserved).toBe(0);

      // Assert refund was written to outbox table in the same transaction
      const outboxRes = await db.query<any>(
        "SELECT id, event_type, payload, status, retry_count FROM outbox WHERE event_type = 'payment.order_cancellation_refund'"
      );
      expect(outboxRes.rowCount).toBe(1);
      const outboxRecord = outboxRes.rows[0];
      expect(outboxRecord.status).toBe('pending');
      const payload = typeof outboxRecord.payload === 'string' ? JSON.parse(outboxRecord.payload) : outboxRecord.payload;
      expect(payload.orderId).toBe(checkout.order.id);
      expect(payload.intentId).toBe(checkout.paymentIntent.id);
      expect(payload.amountMinor).toBe(100000);

      // 4. Simulate payment provider outage/failure when processing refund
      const outbox = paymentService.getOutboxService();
      const origRefund = mockProvider.refund.bind(mockProvider);
      mockProvider.refund = async () => {
        throw new Error('Provider 503 Service Unavailable: simulated outage');
      };

      // 5. Worker processes outbox -> provider fails
      const result = await outbox.processPending();
      expect(result.failed).toBe(1);

      // Crucial assertion: provider failure must NOT leave a restocked order without a queued refund
      const outboxAfterFail = await db.query<any>(
        "SELECT id, status, retry_count, last_error FROM outbox WHERE id = $1",
        [outboxRecord.id]
      );
      expect(outboxAfterFail.rowCount).toBe(1);
      expect(outboxAfterFail.rows[0].status).toBe('pending'); // Scheduled for retry with backoff
      expect(outboxAfterFail.rows[0].retry_count).toBe(1);
      expect(outboxAfterFail.rows[0].last_error).toContain('Provider 503');

      // Order is still cancelled, inventory is still restocked
      const orderStillCancelled = await orderService.getOrder(checkout.order.id);
      expect(orderStillCancelled.status).toBe('cancelled');
      const invStillRestocked = await inventoryService.getInventory(product.id);
      expect(invStillRestocked.on_hand).toBe(5);

      // 6. Provider recovers -> mockProvider lists the executed refund -> retry succeeds
      mockProvider.refund = origRefund;
      const mockRefundRecord = {
        id: 'ref_recovered_123',
        reference: checkout.paymentIntent.provider_ref!,
        amountMinor: 100000,
        status: 'succeeded' as const,
        rawResponse: {
          id: 'ref_recovered_123',
          amount: 100000,
          created_at: new Date().toISOString(),
        },
      };
      (mockProvider as any).refundsList.push(mockRefundRecord);

      // Clear scheduled_for so it can be claimed immediately
      await db.query("UPDATE outbox SET scheduled_for = NULL WHERE id = $1", [outboxRecord.id]);
      const retryResult = await outbox.processPending();
      expect(retryResult.processed).toBe(1);

      const outboxCompleted = await db.query<any>(
        "SELECT id, status FROM outbox WHERE id = $1",
        [outboxRecord.id]
      );
      expect(outboxCompleted.rows[0].status).toBe('completed');

      // Transaction recorded
      const txns = await paymentService.listTransactions(checkout.paymentIntent.id);
      const refundTxn = txns.find((t) => t.type === 'refund');
      expect(refundTxn).toBeDefined();
      expect(refundTxn?.status).toBe('succeeded');
      expect(refundTxn?.amount_minor).toBe(100000);
    });
  });
});

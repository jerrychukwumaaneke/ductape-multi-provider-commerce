import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '../test-db.js';
import { IDatabaseClient } from '../../src/common/database/index.js';
import { PaymentService } from '../../src/modules/payments/payments.service.js';
import { PaymentRouter } from '../../src/modules/payments/router.js';
import { PaystackPaymentProvider } from '../../src/modules/payments/providers/paystack.provider.js';
import { FlutterwavePaymentProvider } from '../../src/modules/payments/providers/flutterwave.provider.js';
import { MockPaymentProvider } from '../../src/modules/payments/providers/mock.provider.js';
import { OrderService } from '../../src/modules/orders/orders.service.js';
import { InventoryService } from '../../src/modules/inventory/inventory.service.js';
import { NotificationService } from '../../src/modules/notifications/notifications.service.js';
import { MockTransport } from '../../src/modules/notifications/transports/index.js';
import { IdempotencyService } from '../../src/modules/idempotency/idempotency.service.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { CheckoutSaga } from '../../src/modules/orders/checkout-saga.js';
import { CryptoUtils } from '../../src/common/utils/crypto.js';
import { UnauthorizedError, ValidationError } from '../../src/common/errors/app-error.js';

describe('Milestone 10: Inbound Webhook Verification & Saga Flow', () => {
  let db: IDatabaseClient;
  let router: PaymentRouter;
  let paystackProvider: PaystackPaymentProvider;
  let flutterwaveProvider: FlutterwavePaymentProvider;
  let mockProvider: MockPaymentProvider;
  let paymentService: PaymentService;
  let orderService: OrderService;
  let inventoryService: InventoryService;
  let notifService: NotificationService;
  let idempotencyService: IdempotencyService;
  let auditService: AuditService;
  let checkoutSaga: CheckoutSaga;

  const testPaystackSecret = 'sk_test_mock_paystack_secret_123456789';
  const testFlwSecret = 'FLWSECK_TEST-mock_flw_secret_123456789';
  const testFlwSecretHash = 'test_flw_secret_hash_value_987654321';

  beforeEach(async () => {
    db = await createTestDatabase();
    router = new PaymentRouter();

    paystackProvider = new PaystackPaymentProvider({
      secretKey: testPaystackSecret,
    });
    flutterwaveProvider = new FlutterwavePaymentProvider({
      secretKey: testFlwSecret,
      secretHash: testFlwSecretHash,
    });
    mockProvider = new MockPaymentProvider('mock');

    router.register(paystackProvider);
    router.register(flutterwaveProvider);
    router.register(mockProvider);

    paymentService = new PaymentService(db, router);
    inventoryService = new InventoryService(db);
    auditService = new AuditService(db);
    orderService = new OrderService(db, inventoryService, auditService);

    const mockTransport = new MockTransport();
    notifService = new NotificationService(db, mockTransport, mockTransport);
    idempotencyService = new IdempotencyService(db);

    checkoutSaga = new CheckoutSaga(
      db,
      orderService,
      inventoryService,
      paymentService,
      notifService,
      idempotencyService,
      auditService
    );

    // Seed test customer & product
    await db.query("INSERT INTO customers (id, email, name) VALUES ('cus_w1', 'customer@example.com', 'Webhook Customer')");
    await inventoryService.createProduct({
      sku: 'SKU_WEBHOOK_1',
      name: 'Webhook Product',
      price_minor: 10000, // 100.00 NGN
      currency: 'NGN',
      initial_stock: 20,
    });
  });

  afterEach(async () => {
    await db.close();
  });

  describe('1. Raw-Body HMAC-SHA512 Verification (Paystack)', () => {
    it('accepts valid Paystack signature computed via HMAC-SHA512 over raw body', () => {
      const rawPayload = JSON.stringify({
        event: 'charge.success',
        data: {
          id: 991234,
          reference: 'ref_paystack_123',
          amount: 10000,
          currency: 'NGN',
          status: 'success',
        },
      });

      const signature = CryptoUtils.createHmacSha512(rawPayload, testPaystackSecret);
      const isValid = paystackProvider.verifyWebhookSignature(rawPayload, {
        'x-paystack-signature': signature,
      });

      expect(isValid).toBe(true);
    });

    it('rejects tampered body or invalid signature in constant time', () => {
      const rawPayload = JSON.stringify({
        event: 'charge.success',
        data: { id: 991234, reference: 'ref_paystack_123' },
      });

      const validSig = CryptoUtils.createHmacSha512(rawPayload, testPaystackSecret);
      const tamperedBody = rawPayload.replace('991234', '991235');

      // Tampered payload with original signature
      const isTamperedValid = paystackProvider.verifyWebhookSignature(tamperedBody, {
        'x-paystack-signature': validSig,
      });
      expect(isTamperedValid).toBe(false);

      // Wrong signature
      const isWrongSigValid = paystackProvider.verifyWebhookSignature(rawPayload, {
        'x-paystack-signature': '0000000000000000000000000000000000000000000000000000000000000000',
      });
      expect(isWrongSigValid).toBe(false);

      // Missing signature header
      const isMissingValid = paystackProvider.verifyWebhookSignature(rawPayload, {});
      expect(isMissingValid).toBe(false);
    });
  });

  describe('2. Constant-Time Secret Hash Verification (Flutterwave)', () => {
    it('accepts valid Flutterwave verif-hash matching configured secret hash', () => {
      const rawPayload = JSON.stringify({
        event: 'charge.completed',
        data: { id: 881234, tx_ref: 'ref_flw_123', status: 'successful', amount: 100 },
      });

      const isValid = flutterwaveProvider.verifyWebhookSignature(rawPayload, {
        'verif-hash': testFlwSecretHash,
      });

      expect(isValid).toBe(true);
    });

    it('rejects invalid or tampered verif-hash', () => {
      const rawPayload = JSON.stringify({
        event: 'charge.completed',
        data: { id: 881234, tx_ref: 'ref_flw_123' },
      });

      const isInvalid = flutterwaveProvider.verifyWebhookSignature(rawPayload, {
        'verif-hash': 'wrong_hash_value',
      });

      expect(isInvalid).toBe(false);
    });
  });

  describe('3. Provider-Side Verification & Amount/Currency Tamper Protection', () => {
    it('rejects payment when provider reports amount mismatch (underpayment attack)', async () => {
      // 1. Create order for 10000 minor units
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_amt_tamper_1',
        provider: 'mock',
      });

      // 2. Mock provider simulates transaction where provider reported amount is 100 instead of 10000
      mockProvider.setMockPayment(checkout.paymentIntent.provider_ref!, {
        id: checkout.paymentIntent.provider_ref!,
        reference: checkout.paymentIntent.provider_ref!,
        amountMinor: 100, // Attacker paid 1 NGN instead of 100 NGN
        currency: 'NGN',
        status: 'succeeded',
      });

      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 100, 'NGN');

      // 3. Webhook handler must throw ValidationError and abort transition
      await expect(
        paymentService.handleWebhook('mock', sim.rawBody, sim.headers, sim.payload)
      ).rejects.toThrow(ValidationError);

      // Verify payment intent remained 'processing' and order remained 'awaiting_payment'
      const intentAfter = await paymentService.getPaymentIntent(checkout.paymentIntent.id);
      expect(intentAfter.status).toBe('processing');

      const orderAfter = await orderService.getOrder(checkout.order.id);
      expect(orderAfter.status).toBe('awaiting_payment');
    });

    it('rejects payment when provider reports currency mismatch', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_curr_tamper_1',
        provider: 'mock',
      });

      mockProvider.setMockPayment(checkout.paymentIntent.provider_ref!, {
        id: checkout.paymentIntent.provider_ref!,
        reference: checkout.paymentIntent.provider_ref!,
        amountMinor: 10000,
        currency: 'USD', // Mismatched currency
        status: 'succeeded',
      });

      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'USD');

      await expect(
        paymentService.handleWebhook('mock', sim.rawBody, sim.headers, sim.payload)
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('4. Unique-Constraint Deduplication', () => {
    it('safely deduplicates duplicate webhook events via UNIQUE(provider, provider_event_id)', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_dedupe_flow_1',
        provider: 'mock',
      });

      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'NGN');

      // First webhook delivery
      const first = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);
      expect(first.duplicate).toBe(false);
      expect(first.order?.status).toBe('paid');

      // Duplicate webhook delivery
      const second = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);
      expect(second.duplicate).toBe(true);

      // Verify webhook_events table has exactly 1 entry for this event
      const expectedEvtId = mockProvider.parseWebhookEvent(sim.payload, sim.rawBody).eventId;
      const evtRes = await db.query(
        'SELECT COUNT(*) as count FROM webhook_events WHERE provider = $1 AND provider_event_id = $2',
        ['mock', expectedEvtId]
      );
      expect(Number(evtRes.rows[0].count)).toBe(1);
    });
  });

  describe('5. Commit on Success & Release on Failure', () => {
    it('happy path: commits held reservation (on_hand -= qty, reserved -= qty) when paid', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const invBefore = await inventoryService.getInventory(product.id);
      expect(invBefore.on_hand).toBe(20);
      expect(invBefore.reserved).toBe(0);

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 2 }],
        idempotencyKey: 'idemp_commit_test_1',
        provider: 'mock',
      });

      // While awaiting payment: on_hand = 20, reserved = 2, available = 18
      const invDuring = await inventoryService.getInventory(product.id);
      expect(invDuring.on_hand).toBe(20);
      expect(invDuring.reserved).toBe(2);

      // Webhook arrives with success
      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 20000, 'NGN');
      const webhookRes = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      expect(webhookRes.duplicate).toBe(false);
      expect(webhookRes.order?.status).toBe('paid');

      // After commit: on_hand = 18, reserved = 0, available = 18
      const invAfter = await inventoryService.getInventory(product.id);
      expect(invAfter.on_hand).toBe(18);
      expect(invAfter.reserved).toBe(0);

      // Reservation status is 'committed'
      const resRows = await db.query<{ status: string }>(
        'SELECT status FROM reservations WHERE order_id = $1',
        [checkout.order.id]
      );
      expect(resRows.rows[0].status).toBe('committed');
    });

    it('failure path: releases held reservation (reserved -= qty) when payment fails', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 3 }],
        idempotencyKey: 'idemp_fail_test_1',
        provider: 'mock',
      });

      // Configure mock provider to report failed status on verification
      mockProvider.setMockPayment(checkout.paymentIntent.provider_ref!, {
        id: checkout.paymentIntent.provider_ref!,
        reference: checkout.paymentIntent.provider_ref!,
        amountMinor: 30000,
        currency: 'NGN',
        status: 'failed',
      });

      const sim = mockProvider.simulateWebhookPayload(
        checkout.paymentIntent.provider_ref!,
        30000,
        'NGN',
        'charge.failed'
      );

      const webhookRes = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);
      expect(webhookRes.order?.status).toBe('payment_failed');

      // Reserved stock released back to inventory pool
      const invAfter = await inventoryService.getInventory(product.id);
      expect(invAfter.reserved).toBe(0);

      const resRows = await db.query<{ status: string }>(
        'SELECT status FROM reservations WHERE order_id = $1',
        [checkout.order.id]
      );
      expect(resRows.rows[0].status).toBe('released');
    });
  });

  describe('6. Late Payment Handling (Auto-Refund on Expired or Cancelled Order)', () => {
    it('automatically refunds payment and leaves inventory untouched if order was already cancelled', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_late_cancel_1',
        provider: 'mock',
      });

      // Customer cancels order before paying
      await orderService.cancelOrder(checkout.order.id, 'Customer changed mind');

      const invAfterCancel = await inventoryService.getInventory(product.id);
      expect(invAfterCancel.reserved).toBe(0);

      // Now, a late success webhook arrives from the payment gateway
      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'NGN');
      const webhookRes = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      expect(webhookRes.latePaymentRefunded).toBe(true);
      expect(webhookRes.order?.status).toBe('cancelled');

      // Verify refund transaction was recorded
      const txns = await paymentService.listTransactions(checkout.paymentIntent.id);
      const refundTxn = txns.find((t) => t.type === 'refund');
      expect(refundTxn).toBeDefined();
      expect(refundTxn?.amount_minor).toBe(10000);
      expect(refundTxn?.status).toBe('succeeded');

      // Verify inventory was NOT double-decremented or corrupted
      const invFinal = await inventoryService.getInventory(product.id);
      expect(invFinal.reserved).toBe(0);
    });

    it('automatically refunds payment if order had already expired via reaper', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_late_expire_1',
        provider: 'mock',
      });

      // Artificially expire the reservation in DB
      await db.query(
        "UPDATE reservations SET expires_at = NOW() - INTERVAL '5 minutes' WHERE order_id = $1",
        [checkout.order.id]
      );

      // Run reaper worker
      const reaped = await inventoryService.reapExpiredReservations();
      expect(reaped).toBe(1);

      const orderAfterExpiry = await orderService.getOrder(checkout.order.id);
      expect(orderAfterExpiry.status).toBe('expired');

      // Late success webhook arrives
      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'NGN');
      const webhookRes = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      expect(webhookRes.latePaymentRefunded).toBe(true);

      // Verify refund recorded
      const txns = await paymentService.listTransactions(checkout.paymentIntent.id);
      expect(txns.some((t) => t.type === 'refund')).toBe(true);
    });

    it('late payment with intent failed but order awaiting_payment and reservation held: honors payment, commits reservation, marks paid (Item 2)', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_late_failed_held_1',
        provider: 'mock',
      });

      // Mark payment intent failed (e.g. by reconciler), while order is awaiting_payment and reservation is held
      await db.query("UPDATE payment_intents SET status = 'failed' WHERE id = $1", [checkout.paymentIntent.id]);

      // Late success webhook arrives
      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'NGN');
      const webhookRes = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      // Must HONOR payment (latePaymentRefunded is false/undefined, order is paid)
      expect(webhookRes.latePaymentRefunded).toBeFalsy();
      expect(webhookRes.order?.status).toBe('paid');

      // Verify order is paid in DB
      const order = await orderService.getOrder(checkout.order.id);
      expect(order.status).toBe('paid');

      // Verify stock reservation was committed: on_hand decremented, reserved is 0
      const inv = await inventoryService.getInventory(product.id);
      expect(inv.reserved).toBe(0);
      expect(inv.on_hand).toBe(19);

      // Verify payment intent was advanced to succeeded
      const intent = await paymentService.getPaymentIntent(checkout.paymentIntent.id);
      expect(intent.status).toBe('succeeded');

      // ZERO refund outbox events
      const refundOutbox = await db.query(
        "SELECT id FROM outbox WHERE event_type = 'payment.late_refund' AND payload->>'intentId' = $1",
        [checkout.paymentIntent.id]
      );
      expect(refundOutbox.rowCount).toBe(0);
    });

    it('late payment with intent failed and reservation expired (stock gone): refunds payment and leaves order expired (Item 2)', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_late_failed_reaped_1',
        provider: 'mock',
      });

      // Age reservation past TTL and reap it so stock is gone
      await db.query("UPDATE reservations SET expires_at = NOW() - INTERVAL '1 hour' WHERE order_id = $1", [
        checkout.order.id,
      ]);
      await inventoryService.reapExpiredReservations();

      // Mark payment intent failed
      await db.query("UPDATE payment_intents SET status = 'failed' WHERE id = $1", [checkout.paymentIntent.id]);

      // Late success webhook arrives
      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'NGN');
      const webhookRes = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      // Stock was gone, so it MUST refund
      expect(webhookRes.latePaymentRefunded).toBe(true);
      expect(webhookRes.order?.status).toBe('expired');

      // Outbox row written for late refund
      const outboxRows = await db.query<{ event_type: string; payload: any }>(
        "SELECT event_type, payload FROM outbox WHERE event_type = 'payment.late_refund' AND payload->>'intentId' = $1",
        [checkout.paymentIntent.id]
      );
      expect(outboxRows.rowCount).toBe(1);
    });

    it('simulates a crash mid-processing followed by a retry, ensuring atomic rollback and successful reprocessing', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_crash_retry_1',
        provider: 'mock',
      });

      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'NGN');
      const expectedEvtId = mockProvider.parseWebhookEvent(sim.payload, sim.rawBody).eventId;

      // Sabotage/simulate a server crash AFTER dedupe insert but BEFORE order status update
      let crashedOnce = false;
      const originalTransaction = db.transaction.bind(db);
      db.transaction = async (cb: any) => {
        if (!crashedOnce) {
          crashedOnce = true;
          return originalTransaction(async (txClient: any) => {
            // Forward calls until order update, then simulate crash
            const proxiedClient = {
              ...txClient,
              query: async (text: string, params?: unknown[]) => {
                if (text.includes('UPDATE orders SET status')) {
                  throw new Error('SIMULATED_CRASH_AFTER_DEDUPE_BEFORE_ORDER_UPDATE: crash mid-transaction');
                }
                return txClient.query(text, params);
              },
            };
            return cb(proxiedClient);
          });
        }
        return originalTransaction(cb);
      };

      // First webhook delivery fails due to crash after dedupe insert
      await expect(
        checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload)
      ).rejects.toThrow('SIMULATED_CRASH_AFTER_DEDUPE_BEFORE_ORDER_UPDATE');

      // Verify that webhook_events row was rolled back and NOT recorded
      const eventsBeforeRetry = await db.query(
        'SELECT * FROM webhook_events WHERE provider = $1 AND provider_event_id = $2',
        ['mock', expectedEvtId]
      );
      expect(eventsBeforeRetry.rowCount).toBe(0);

      // Verify payment intent was NOT marked succeeded
      const intentBeforeRetry = await paymentService.getPaymentIntent(checkout.paymentIntent.id);
      expect(intentBeforeRetry.status).toBe('processing');

      // Verify order was NOT marked paid
      const orderBeforeRetry = await orderService.getOrder(checkout.order.id);
      expect(orderBeforeRetry.status).toBe('awaiting_payment');

      // Restore DB transaction behavior
      db.transaction = originalTransaction;

      // Second attempt: provider retries with identical payload
      const retryRes = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      // Must NOT be treated as duplicate; must succeed!
      expect(retryRes.duplicate).toBe(false);
      expect(retryRes.order?.status).toBe('paid');
      expect(retryRes.paymentIntent?.status).toBe('succeeded');

      // Verify webhook_events row is now cleanly recorded
      const eventsAfterRetry = await db.query(
        'SELECT * FROM webhook_events WHERE provider = $1 AND provider_event_id = $2',
        ['mock', expectedEvtId]
      );
      expect(eventsAfterRetry.rowCount).toBe(1);

      // Verify reservation is committed
      const resRows = await db.query<{ status: string }>(
        'SELECT status FROM reservations WHERE order_id = $1',
        [checkout.order.id]
      );
      expect(resRows.rows[0].status).toBe('committed');
    });
  });

  describe('7. Verification Status Semantics (Item 3)', () => {
    it('returns non-2xx (503 retry) on pending, ongoing, or abandoned without recording webhook_events', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_pending_verify_1',
        provider: 'mock',
      });

      for (const status of ['pending', 'ongoing', 'abandoned'] as const) {
        mockProvider.simulatedVerifyStatus = status;

        const sim = mockProvider.simulateWebhookPayload(
          checkout.paymentIntent.provider_ref!,
          10000,
          'NGN'
        );

        let err: any;
        try {
          await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);
        } catch (e) {
          err = e;
        }

        expect(err).toBeDefined();
        expect(err.statusCode).toBe(503);
        expect(err.code).toBe('PAYMENT_PENDING');

        // Confirm NO event row was recorded in webhook_events
        const evtRes = await db.query(
          'SELECT * FROM webhook_events WHERE provider = $1 AND provider_event_id = $2',
          ['mock', `mock_charge.success_mock_evt_${checkout.paymentIntent.provider_ref}`]
        );
        expect(evtRes.rowCount).toBe(0);

        // Confirm order is still awaiting_payment and intent still processing
        const order = await orderService.getOrder(checkout.order.id);
        expect(order.status).toBe('awaiting_payment');
        const intent = await paymentService.getPaymentIntent(checkout.paymentIntent.id);
        expect(intent.status).toBe('processing');
      }

      // Reset simulated status
      mockProvider.simulatedVerifyStatus = 'succeeded';
    });
  });

  describe('8. Webhook Before Intent & Checkout Step 2->3 Safety (Item 4)', () => {
    it('returns 404 NotFoundError and does NOT record event when no matching intent exists', async () => {
      const nonExistentRef = 'ref_non_existent_intent_999';
      const sim = mockProvider.simulateWebhookPayload(nonExistentRef, 5000, 'NGN');

      let err: any;
      try {
        await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);
      } catch (e) {
        err = e;
      }

      expect(err).toBeDefined();
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('NOT_FOUND');

      // Assert event was NOT recorded in webhook_events
      const evtRes = await db.query(
        'SELECT * FROM webhook_events WHERE provider = $1 AND provider_event_id = $2',
        ['mock', `mock_charge.success_mock_evt_${nonExistentRef}`]
      );
      expect(evtRes.rowCount).toBe(0);
    });

    it('safely releases stock and fails order if createPayment throws in step 2->3', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];
      const initialInv = await inventoryService.getInventory(product.id);

      mockProvider.shouldFailCreate = true;

      let caughtErr: any;
      try {
        await checkoutSaga.executeCheckout({
          customerId: 'cus_w1',
          email: 'customer@example.com',
          items: [{ productId: product.id, qty: 2 }],
          idempotencyKey: 'idemp_step23_safety_fail',
          provider: 'mock',
        });
      } catch (e) {
        caughtErr = e;
      }

      mockProvider.shouldFailCreate = false;

      expect(caughtErr).toBeDefined();

      // Check that inventory reservation was released cleanly: reserved must be back to initialInv.reserved
      const invAfter = await inventoryService.getInventory(product.id);
      expect(invAfter.reserved).toBe(initialInv.reserved);
      expect(invAfter.on_hand).toBe(initialInv.on_hand);

      // Check that the order was marked payment_failed
      const ordersRes = await db.query<{ id: string; status: string }>(
        "SELECT id, status FROM orders WHERE idempotency_key = 'idemp_step23_safety_fail'"
      );
      expect(ordersRes.rowCount).toBe(1);
      expect(ordersRes.rows[0].status).toBe('payment_failed');
    });
  });

  describe('9. Unknown Events & Refund Callback (Item 5)', () => {
    it('ignores unknown event types with 200 without modifying order or intent state', async () => {
      const sim = mockProvider.simulateWebhookPayload('ref_ignored_123', 5000, 'NGN', 'invoice.updated');

      const result = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);
      expect(result.ignored).toBe(true);
      expect(result.duplicate).toBe(false);
    });

    it('records refund event and transaction when our own refund comes back as refund.processed / refund.success', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_refund_cb_1',
        provider: 'mock',
      });

      // Complete checkout payment
      const simPay = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'NGN');
      await checkoutSaga.processPaymentWebhook('mock', simPay.rawBody, simPay.headers, simPay.payload);

      // Now refund webhook comes in (simulating refund.processed from Paystack)
      const simRefund = mockProvider.simulateWebhookPayload(
        checkout.paymentIntent.provider_ref!,
        10000,
        'NGN',
        'refund.processed'
      );

      const refundResult = await checkoutSaga.processPaymentWebhook('mock', simRefund.rawBody, simRefund.headers, simRefund.payload);
      expect(refundResult.refunded).toBe(true);

      // Check refund transaction exists
      const txns = await paymentService.listTransactions(checkout.paymentIntent.id);
      expect(txns.some((t) => t.type === 'refund')).toBe(true);
    });
  });

  describe('10. Order Locking FOR UPDATE, Duplicate Payment Refund & Outbox Worker (Items 6, 8, 11)', () => {
    it('locks order FOR UPDATE and refunds a second payment on an already-paid order via Outbox', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_second_pay_1',
        provider: 'mock',
      });

      // First payment succeeds
      const sim1 = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'NGN');
      const pay1 = await checkoutSaga.processPaymentWebhook('mock', sim1.rawBody, sim1.headers, sim1.payload);
      expect(pay1.order?.status).toBe('paid');

      // Same payment intent arriving again is a clean no-op with 0 refunds (Item 1)
      const dupSame = await checkoutSaga.processPaymentWebhook('mock', sim1.rawBody, sim1.headers, sim1.payload);
      expect(dupSame.secondPaymentRefunded).toBeFalsy();

      // Second payment arrives with a DIFFERENT provider transaction/intent for the same order (Item 1)
      const secondIntent = await paymentService.createPaymentIntent({
        orderId: checkout.order.id,
        amountMinor: 10000,
        currency: 'NGN',
        email: 'customer@example.com',
        provider: 'mock',
        idempotencyKey: 'idemp_second_intent_key',
      });

      const sim2 = mockProvider.simulateWebhookPayload(secondIntent.paymentIntent.provider_ref!, 10000, 'NGN');
      const pay2 = await checkoutSaga.processPaymentWebhook('mock', sim2.rawBody, sim2.headers, sim2.payload);
      expect(pay2.secondPaymentRefunded).toBe(true);
      expect(pay2.order?.status).toBe('paid');

      // Verify outbox record for duplicate refund was created and processed
      const outboxRows = await db.query<{ event_type: string; status: string; payload: any }>(
        "SELECT event_type, status, payload FROM outbox WHERE event_type = 'payment.duplicate_refund'"
      );
      expect(outboxRows.rowCount).toBeGreaterThanOrEqual(1);
      expect(outboxRows.rows[0].status).toBe('completed');

      // Verify refund transaction recorded on second payment intent
      const txns = await paymentService.listTransactions(secondIntent.paymentIntent.id);
      expect(txns.some((t) => t.type === 'refund')).toBe(true);
    });

    it('outbox executes actions exactly once even across worker retries after commit', async () => {
      const outbox = paymentService.getOutboxService();
      let actionExecCount = 0;

      outbox.registerHandler('test.unique_action', async () => {
        actionExecCount++;
      });

      // Write pending outbox row
      await outbox.writeEvent('test.unique_action', { test: true });

      // First run processes it
      const res1 = await outbox.processPending();
      expect(res1.processed).toBe(1);
      expect(actionExecCount).toBe(1);

      // Second run finds 0 pending items -> exactly once execution
      const res2 = await outbox.processPending();
      expect(res2.processed).toBe(0);
      expect(actionExecCount).toBe(1);
    });

    it('simulates crash after provider refund but before marking outbox done, then retries, ensuring exactly one refund exists (Item 2)', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_outbox_refund_crash',
        provider: 'mock',
      });

      // Pay order
      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'NGN');
      await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      const outbox = paymentService.getOutboxService();
      const outboxId = await outbox.writeEvent('payment.duplicate_refund', {
        intentId: checkout.paymentIntent.id,
        amountMinor: 10000,
      });

      // Simulate first attempt: provider refund executes, but server crashes before outbox status update
      await paymentService.refundPayment(checkout.paymentIntent.id, 10000, outboxId);

      // Check that 1 refund exists right now, but outbox status is still 'pending'
      const txnsAfterCrash = await paymentService.listTransactions(checkout.paymentIntent.id);
      expect(txnsAfterCrash.filter((t) => t.type === 'refund').length).toBe(1);

      const outboxBeforeRetry = await db.query<{ status: string }>('SELECT status FROM outbox WHERE id = $1', [outboxId]);
      expect(outboxBeforeRetry.rows[0].status).toBe('pending');

      // Now worker retries and processes the pending outbox record
      const retryRes = await outbox.processPending();
      expect(retryRes.processed).toBe(1);

      // Confirm outbox record is marked completed
      const outboxAfterRetry = await db.query<{ status: string }>('SELECT status FROM outbox WHERE id = $1', [outboxId]);
      expect(outboxAfterRetry.rows[0].status).toBe('completed');

      // Confirm EXACTLY ONE refund transaction exists (no double refund)
      const txnsAfterRetry = await paymentService.listTransactions(checkout.paymentIntent.id);
      expect(txnsAfterRetry.filter((t) => t.type === 'refund').length).toBe(1);
    });

    it('crashes after claim then reclaims stuck processing rows (Item 2)', async () => {
      const outbox = paymentService.getOutboxService();
      let handled = false;
      outbox.registerHandler('test.crash_reclaim', async () => {
        handled = true;
      });

      // 1. Write an outbox event
      const eventId = await outbox.writeEvent('test.crash_reclaim', { action: 'crash_test' });

      // 2. Simulate worker claiming row, setting status to 'processing' and claimed_at = 10 minutes ago, then crashing
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      await db.query(
        "UPDATE outbox SET status = 'processing', claimed_at = $1 WHERE id = $2",
        [tenMinutesAgo, eventId]
      );

      // Verify row is stuck in 'processing' with claimed_at in the past
      const stuckRow = await db.query<{ status: string; claimed_at: Date }>(
        'SELECT status, claimed_at FROM outbox WHERE id = $1',
        [eventId]
      );
      expect(stuckRow.rows[0].status).toBe('processing');
      expect(stuckRow.rows[0].claimed_at).toBeDefined();

      // 3. Reclaim stuck processing rows beyond 5 minutes
      const reaped = await outbox.requeueStuckProcessing(5);
      expect(reaped).toBe(1);

      // Verify row is now re-queued to 'pending' with claimed_at reset to NULL
      const reclaimedRow = await db.query<{ status: string; claimed_at: Date | null }>(
        'SELECT status, claimed_at FROM outbox WHERE id = $1',
        [eventId]
      );
      expect(reclaimedRow.rows[0].status).toBe('pending');
      expect(reclaimedRow.rows[0].claimed_at).toBeNull();

      // 4. Run outbox worker to process the re-queued row
      const processRes = await outbox.processPending();
      expect(processRes.processed).toBe(1);
      expect(handled).toBe(true);

      const completedRow = await db.query<{ status: string }>(
        'SELECT status FROM outbox WHERE id = $1',
        [eventId]
      );
      expect(completedRow.rows[0].status).toBe('completed');
    });

    it('a row unclaimed for 10 minutes then claimed is not re-queued (Item 1)', async () => {
      const outbox = paymentService.getOutboxService();

      // 1. Write an outbox event
      const eventId = await outbox.writeEvent('test.unclaimed_then_claimed', { action: 'test' });

      // 2. Artificially age created_at to 10 minutes ago, but keep status = 'pending' and claimed_at = NULL
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      await db.query(
        "UPDATE outbox SET created_at = $1, status = 'pending', claimed_at = NULL WHERE id = $2",
        [tenMinutesAgo, eventId]
      );

      // 3. Worker now claims it: status = 'processing', claimed_at = NOW()
      await db.query(
        "UPDATE outbox SET status = 'processing', claimed_at = NOW() WHERE id = $1",
        [eventId]
      );

      // 4. Run requeueStuckProcessing(5). It must ONLY touch rows with claimed_at set AND older than 5 minutes.
      // Since claimed_at was just set (fresh), the row MUST NOT be re-queued!
      const reaped = await outbox.requeueStuckProcessing(5);
      expect(reaped).toBe(0);

      // Verify row remains in 'processing' status with its fresh claimed_at
      const rowAfter = await db.query<{ status: string; claimed_at: Date }>(
        'SELECT status, claimed_at FROM outbox WHERE id = $1',
        [eventId]
      );
      expect(rowAfter.rows[0].status).toBe('processing');
      expect(rowAfter.rows[0].claimed_at).toBeDefined();
    });

    it('runs the real claim path with a row created 10 minutes ago, then asserts requeueStuckProcessing(5) does not requeue it while its handler is running (Item 4)', async () => {
      const outbox = paymentService.getOutboxService();
      const eventId = await outbox.writeEvent('test.long_running_claim_active', { action: 'claim_test' });

      // Artificially age created_at to 10 minutes ago, status = 'pending', claimed_at = NULL
      await db.query("UPDATE outbox SET created_at = NOW() - INTERVAL '10 minutes', claimed_at = NULL WHERE id = $1", [
        eventId,
      ]);

      let handlerStartedResolve: () => void;
      const handlerStarted = new Promise<void>((r) => {
        handlerStartedResolve = r;
      });

      let finishHandlerResolve: () => void;
      const finishHandler = new Promise<void>((r) => {
        finishHandlerResolve = r;
      });

      outbox.registerHandler('test.long_running_claim_active', async () => {
        handlerStartedResolve();
        await finishHandler; // keep handler actively executing
      });

      // Start the real claim path
      const processPromise = outbox.processPending(10);

      // Wait until handler is actively executing
      await handlerStarted;

      // While handler is actively executing, invoke requeueStuckProcessing(5)
      const requeuedCount = await outbox.requeueStuckProcessing(5);
      expect(requeuedCount).toBe(0);

      // Verify row is still in status 'processing' with a fresh claimed_at set by the real claim path
      const inFlightRow = await db.query<{ status: string; claimed_at: any }>(
        'SELECT status, claimed_at FROM outbox WHERE id = $1',
        [eventId]
      );
      expect(inFlightRow.rows[0].status).toBe('processing');
      expect(inFlightRow.rows[0].claimed_at).not.toBeNull();

      // Complete the handler
      finishHandlerResolve!();
      const processResult = await processPromise;
      expect(processResult.processed).toBe(1);

      // Verify row transitioned to completed
      const completedRow = await db.query<{ status: string }>(
        'SELECT status FROM outbox WHERE id = $1',
        [eventId]
      );
      expect(completedRow.rows[0].status).toBe('completed');
    });

    it('refund outbox event fails twice then succeeds on third attempt with backoff (Item 2)', async () => {
      const outbox = paymentService.getOutboxService();
      let callCount = 0;

      outbox.registerHandler('payment.duplicate_refund_retry_test', async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error(`Transient gateway error on attempt ${callCount}`);
        }
      });

      // Write a refund event
      const eventId = await outbox.writeEvent('payment.duplicate_refund_retry_test', {
        refundAmount: 5000,
      });

      // Attempt 1: Fails
      const res1 = await outbox.processPending(10, 3);
      expect(res1.failed).toBe(1);
      expect(callCount).toBe(1);

      // Row status remains 'pending', retry_count is 1, scheduled_for is set in future
      const attempt1Row = await db.query<{ status: string; retry_count: number; scheduled_for: Date; last_error: string }>(
        'SELECT status, retry_count, scheduled_for, last_error FROM outbox WHERE id = $1',
        [eventId]
      );
      expect(attempt1Row.rows[0].status).toBe('pending');
      expect(attempt1Row.rows[0].retry_count).toBe(1);
      expect(attempt1Row.rows[0].scheduled_for).toBeDefined();
      expect(attempt1Row.rows[0].last_error).toContain('attempt 1');

      // Fast-forward scheduled_for to NOW() so it is eligible for retry
      await db.query("UPDATE outbox SET scheduled_for = NOW() - INTERVAL '1 second' WHERE id = $1", [eventId]);

      // Attempt 2: Fails
      const res2 = await outbox.processPending(10, 3);
      expect(res2.failed).toBe(1);
      expect(callCount).toBe(2);

      const attempt2Row = await db.query<{ status: string; retry_count: number; scheduled_for: Date; last_error: string }>(
        'SELECT status, retry_count, scheduled_for, last_error FROM outbox WHERE id = $1',
        [eventId]
      );
      // Because it's a refund event, retry cap is 10 (not 3), so it is still 'pending'
      expect(attempt2Row.rows[0].status).toBe('pending');
      expect(attempt2Row.rows[0].retry_count).toBe(2);
      expect(attempt2Row.rows[0].last_error).toContain('attempt 2');

      // Fast-forward scheduled_for to NOW()
      await db.query("UPDATE outbox SET scheduled_for = NOW() - INTERVAL '1 second' WHERE id = $1", [eventId]);

      // Attempt 3: Succeeds
      const res3 = await outbox.processPending(10, 3);
      expect(res3.processed).toBe(1);
      expect(callCount).toBe(3);

      const attempt3Row = await db.query<{ status: string; retry_count: number; processed_at: Date }>(
        'SELECT status, retry_count, processed_at FROM outbox WHERE id = $1',
        [eventId]
      );
      expect(attempt3Row.rows[0].status).toBe('completed');
      expect(attempt3Row.rows[0].retry_count).toBe(2);
      expect(attempt3Row.rows[0].processed_at).toBeDefined();
    });

    it('dead-letters the notification with an error if the customer row is missing (Item 3)', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      // Drop FK constraint in test memory DB to simulate missing/orphaned customer row
      await db.query('ALTER TABLE orders DROP CONSTRAINT orders_customer_id_fk').catch(() => {});

      // Insert an order referencing a missing/deleted customer
      const ghostOrderId = `ord_ghost_${Date.now()}`;
      await db.query(
        "INSERT INTO orders (id, customer_id, status, total_minor, currency, idempotency_key, created_at, updated_at) VALUES ($1, 'cus_non_existent_999', 'awaiting_payment', 10000, 'NGN', $2, NOW(), NOW())",
        [ghostOrderId, `idemp_ghost_${Date.now()}`]
      );
      // Create held reservation for this ghost order
      await db.query(
        "INSERT INTO reservations (id, order_id, product_id, qty, status, expires_at, created_at) VALUES ($1, $2, $3, 1, 'held', NOW() + INTERVAL '15 minutes', NOW())",
        [`res_${ghostOrderId}`, ghostOrderId, product.id]
      );
      await db.query('UPDATE inventory SET reserved = reserved + 1 WHERE product_id = $1', [product.id]);

      // Create payment intent
      const piId = `pi_${ghostOrderId}`;
      const piRef = `ref_${piId}`;
      await db.query(
        "INSERT INTO payment_intents (id, order_id, provider, provider_ref, amount_minor, currency, status, idempotency_key, created_at, updated_at) VALUES ($1, $2, 'mock', $3, 10000, 'NGN', 'processing', $4, NOW(), NOW())",
        [piId, ghostOrderId, piRef, `pi_idemp_${ghostOrderId}`]
      );

      mockProvider.setMockPayment(piRef, {
        id: piRef,
        reference: piRef,
        amountMinor: 10000,
        currency: 'NGN',
        status: 'succeeded',
      });

      const sim = mockProvider.simulateWebhookPayload(piRef, 10000, 'NGN');
      const webhookRes = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      // Order succeeds and is paid
      expect(webhookRes.order?.status).toBe('paid');

      // Outbox contains notification.dead_letter instead of notification.send
      const deadLetterOutbox = await db.query<{ payload: any; status: string }>(
        "SELECT payload, status FROM outbox WHERE event_type = 'notification.dead_letter'"
      );
      expect(deadLetterOutbox.rowCount).toBeGreaterThanOrEqual(1);
      const payload = typeof deadLetterOutbox.rows[0].payload === 'string'
        ? JSON.parse(deadLetterOutbox.rows[0].payload)
        : deadLetterOutbox.rows[0].payload;
      expect(payload.error).toContain('Customer record missing');

      // Process outbox to execute the dead-letter handler
      await paymentService.getOutboxService().processPending();

      // Notifications table has a failed dead_letter notification
      const deadLetterNotifs = await db.query<{ status: string; channel: string }>(
        "SELECT status, channel FROM notifications WHERE template_key = 'dead_letter'"
      );
      expect(deadLetterNotifs.rowCount).toBeGreaterThanOrEqual(1);
      expect(deadLetterNotifs.rows[0].status).toBe('failed');
    });

    it('dedupes against already logged refund: our own refund coming back as refund.processed has no double transaction (Item 5)', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_refund_dedupe_1',
        provider: 'mock',
      });

      // Pay order
      const simPay = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'NGN');
      await checkoutSaga.processPaymentWebhook('mock', simPay.rawBody, simPay.headers, simPay.payload);

      // Application explicitly issues a refund first
      await paymentService.refundPayment(checkout.paymentIntent.id, 10000);

      const txnsBeforeWebhook = await paymentService.listTransactions(checkout.paymentIntent.id);
      expect(txnsBeforeWebhook.filter((t) => t.type === 'refund').length).toBe(1);

      // Now the provider sends refund.processed webhook for that refund
      const simRefund = mockProvider.simulateWebhookPayload(
        checkout.paymentIntent.provider_ref!,
        10000,
        'NGN',
        'refund.processed'
      );
      const webhookRes = await checkoutSaga.processPaymentWebhook('mock', simRefund.rawBody, simRefund.headers, simRefund.payload);
      expect(webhookRes.refunded).toBe(true);

      // Verify that no second refund transaction was recorded
      const txnsAfterWebhook = await paymentService.listTransactions(checkout.paymentIntent.id);
      expect(txnsAfterWebhook.filter((t) => t.type === 'refund').length).toBe(1);
    });

    it('reconciliation job polls stuck processing intents and reconciles them when provider reports succeeded (Item 6)', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_stuck_recon_1',
        provider: 'mock',
      });

      // The intent is currently in 'processing' status
      expect(checkout.paymentIntent.status).toBe('processing');

      // Artificially age the intent to be stuck 30 minutes in the past
      await db.query(
        "UPDATE payment_intents SET created_at = NOW() - INTERVAL '30 minutes', updated_at = NOW() - INTERVAL '30 minutes' WHERE id = $1",
        [checkout.paymentIntent.id]
      );

      // Provider confirms the payment actually succeeded
      mockProvider.setMockPayment(checkout.paymentIntent.provider_ref!, {
        id: checkout.paymentIntent.provider_ref!,
        reference: checkout.paymentIntent.provider_ref!,
        amountMinor: 10000,
        currency: 'NGN',
        status: 'succeeded',
      });

      // Run reconciliation job with threshold of 15 minutes
      const reconResults = await paymentService.reconcileStuckPaymentIntents(15);
      expect(reconResults.length).toBeGreaterThanOrEqual(1);

      const reconciled = reconResults.find((r) => r.intentId === checkout.paymentIntent.id);
      expect(reconciled).toBeDefined();
      expect(reconciled?.newStatus).toBe('succeeded');
      expect(reconciled?.resolved).toBe(true);

      // Verify intent is now succeeded in DB
      const intentAfter = await paymentService.getPaymentIntent(checkout.paymentIntent.id);
      expect(intentAfter.status).toBe('succeeded');

      // Verify order is now paid in DB
      const orderAfter = await orderService.getOrder(checkout.order.id);
      expect(orderAfter.status).toBe('paid');

      // Verify reservations committed
      const resRows = await db.query<{ status: string }>('SELECT status FROM reservations WHERE order_id = $1', [checkout.order.id]);
      expect(resRows.rows[0].status).toBe('committed');
    });

    it('allows multiple partial refunds while sum <= charge and rejects when sum > charge (Item 2)', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_partial_ref_1',
        provider: 'mock',
      });

      // Pay 10,000 minor units
      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'NGN');
      await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      // Refund 1: 4,000 NGN
      const ref1 = await paymentService.refundPayment(checkout.paymentIntent.id, 4000, 'part_ref_1');
      expect(ref1.status).toBe('succeeded');

      // Refund 2: 3,000 NGN (cumulative 7,000 <= 10,000)
      const ref2 = await paymentService.refundPayment(checkout.paymentIntent.id, 3000, 'part_ref_2');
      expect(ref2.status).toBe('succeeded');

      // Refund 3: 4,000 NGN (cumulative 11,000 > 10,000 -> must reject with ValidationError)
      let caughtErr: any;
      try {
        await paymentService.refundPayment(checkout.paymentIntent.id, 4000, 'part_ref_3');
      } catch (e) {
        caughtErr = e;
      }
      expect(caughtErr).toBeDefined();
      expect(caughtErr.statusCode).toBe(422);

      // Verify that exactly 2 refund transactions were recorded and their sum is 7,000
      const txns = await paymentService.listTransactions(checkout.paymentIntent.id);
      const refunds = txns.filter((t) => t.type === 'refund');
      expect(refunds.length).toBe(2);
      const sum = refunds.reduce((s, r) => s + r.amount_minor, 0);
      expect(sum).toBe(7000);
    });

    it('handles crash between provider call and local insert: writes pending row first, queries provider on retry, and issues exactly one refund (Item 2)', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_crash_ref_1',
        provider: 'mock',
      });

      // Pay order
      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'NGN');
      await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      const refundIdempKey = 'ref_idemp_crash_test';
      const initialCallCount = mockProvider.refundCallCount;

      // Configure mock provider to throw AFTER creating the refund (simulating server crash before local DB update)
      mockProvider.shouldThrowAfterRefund = true;

      let crashErr: any;
      try {
        await paymentService.refundPayment(checkout.paymentIntent.id, 10000, refundIdempKey);
      } catch (e) {
        crashErr = e;
      }
      expect(crashErr).toBeDefined();
      expect(crashErr.message).toContain('SIMULATED_CRASH_POST_PROVIDER_REFUND');

      // The mock provider was called once
      expect(mockProvider.refundCallCount).toBe(initialCallCount + 1);

      // Verify a 'pending' transaction was written BEFORE the provider call
      const txnsDuringCrash = await paymentService.listTransactions(checkout.paymentIntent.id);
      const pendingTxn = txnsDuringCrash.find((t) => t.id === `txn_ref_${refundIdempKey}`);
      expect(pendingTxn).toBeDefined();
      expect(pendingTxn?.status).toBe('pending');

      // Reset the crash flag
      mockProvider.shouldThrowAfterRefund = false;

      // Retry the refund with the same idempotency key
      const retryResult = await paymentService.refundPayment(checkout.paymentIntent.id, 10000, refundIdempKey);
      expect(retryResult.status).toBe('succeeded');

      // Provider was NOT called a second time (query on retry prevented double-issuance)
      expect(mockProvider.refundCallCount).toBe(initialCallCount + 1);

      // Transaction row is now 'succeeded' and stores provider refund id
      const txnsAfterRetry = await paymentService.listTransactions(checkout.paymentIntent.id);
      const finalTxn = txnsAfterRetry.find((t) => t.id === `txn_ref_${refundIdempKey}`);
      expect(finalTxn?.status).toBe('succeeded');
      expect(finalTxn?.provider_ref).toBeDefined();
    });

    it('provider call succeeded, local update crashed, list returns empty -> exactly one provider refund call (Item 1)', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_refund_empty_list_test',
        provider: 'mock',
      });

      // Pay order
      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'NGN');
      await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      const refundIdempKey = 'ref_idemp_empty_list_crash';
      const initialCallCount = mockProvider.refundCallCount;

      // Provider throws after creating refund (simulating server crash before local update)
      mockProvider.shouldThrowAfterRefund = true;

      let crashErr: any;
      try {
        await paymentService.refundPayment(checkout.paymentIntent.id, 10000, refundIdempKey);
      } catch (e) {
        crashErr = e;
      }
      expect(crashErr).toBeDefined();
      expect(mockProvider.refundCallCount).toBe(initialCallCount + 1);

      // Verify pending row exists in local DB
      const pendingTxn = (await paymentService.listTransactions(checkout.paymentIntent.id)).find(
        (t) => t.id === `txn_ref_${refundIdempKey}`
      );
      expect(pendingTxn?.status).toBe('pending');
      expect(pendingTxn?.provider_ref).toBeNull();

      // Reset crash flag
      mockProvider.shouldThrowAfterRefund = false;

      // Mock provider's listRefunds returns empty [] (e.g. refund not indexed yet or provider lacks match)
      const origListRefunds = mockProvider.listRefunds.bind(mockProvider);
      mockProvider.listRefunds = async () => [];

      try {
        let retryErr: any;
        try {
          await paymentService.refundPayment(checkout.paymentIntent.id, 10000, refundIdempKey);
        } catch (e) {
          retryErr = e;
        }

        // Retry must fail or throw review error, NOT issue a new refund!
        expect(retryErr).toBeDefined();
        expect(retryErr.message).toContain('requires manual review');

        // Crucial invariant: exactly one provider refund call was made (no duplicate re-issuance!)
        expect(mockProvider.refundCallCount).toBe(initialCallCount + 1);

        // Transaction row is still 'pending' and flagged for manual review
        const finalTxn = (await paymentService.listTransactions(checkout.paymentIntent.id)).find(
          (t) => t.id === `txn_ref_${refundIdempKey}`
        );
        expect(finalTxn?.status).toBe('pending');
        expect((finalTxn?.raw_response as any)?.manual_review_required).toBe(true);
      } finally {
        mockProvider.listRefunds = origListRefunds;
      }
    });

    it('retry matcher treats refund with missing timestamp as no match rather than falling back to local time (Item 3)', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_refund_notime_1',
        provider: 'mock',
      });

      // Pay order
      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 10000, 'NGN');
      await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      // Simulate crash between provider call and local update
      mockProvider.shouldThrowAfterRefund = true;
      const refundIdempKey = 'refund_idemp_notime_key';
      try {
        await paymentService.refundPayment(checkout.paymentIntent.id, 10000, refundIdempKey);
      } catch (err) {
        // expected crash
      }

      mockProvider.shouldThrowAfterRefund = false;
      const initialCallCount = mockProvider.refundCallCount;

      // Mock listRefunds to return a refund matching amount, but WITHOUT createdAt / created_at timestamp
      const origListRefunds = mockProvider.listRefunds.bind(mockProvider);
      mockProvider.listRefunds = async () => [
        {
          id: 'ref_provider_no_timestamp',
          reference: checkout.paymentIntent.provider_ref!,
          amountMinor: 10000,
          status: 'succeeded',
          rawResponse: {
            id: 'ref_provider_no_timestamp',
            amount: 10000,
            // Notice: NO createdAt, created_at, or refunded_at!
          },
        },
      ];

      try {
        let retryErr: any;
        try {
          await paymentService.refundPayment(checkout.paymentIntent.id, 10000, refundIdempKey);
        } catch (e) {
          retryErr = e;
        }

        // Retry must treat the timestamp-less refund as NO MATCH and flag for manual review
        expect(retryErr).toBeDefined();
        expect(retryErr.message).toContain('requires manual review');

        // Crucial invariant: provider refund call was NOT re-issued
        expect(mockProvider.refundCallCount).toBe(initialCallCount);

        // Transaction row is still pending with manual_review_required
        const txn = (await paymentService.listTransactions(checkout.paymentIntent.id)).find(
          (t) => t.id === `txn_ref_${refundIdempKey}`
        );
        expect(txn?.status).toBe('pending');
        expect((txn?.raw_response as any)?.manual_review_required).toBe(true);
      } finally {
        mockProvider.listRefunds = origListRefunds;
      }
    });

    it('reconciler leaves pending intent as processing before TTL, and fails intent + releases stock when past TTL (Item 4)', async () => {
      const products = await inventoryService.listProducts();
      const product = products[0];

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 2 }],
        idempotencyKey: 'idemp_ttl_recon_1',
        provider: 'mock',
      });

      // Provider reports status is 'pending'
      mockProvider.simulatedVerifyStatus = 'pending';

      // Age payment intent 20 minutes in past, but reservation TTL is NOT expired yet (expires in 10 minutes)
      await db.query(
        "UPDATE payment_intents SET created_at = NOW() - INTERVAL '20 minutes' WHERE id = $1",
        [checkout.paymentIntent.id]
      );
      await db.query(
        "UPDATE reservations SET expires_at = NOW() + INTERVAL '10 minutes' WHERE order_id = $1",
        [checkout.order.id]
      );

      // Reconciler runs: should stay in 'processing' because reservation TTL not reached
      const recon1 = await paymentService.reconcileStuckPaymentIntents(15);
      const checkPending = recon1.find((r) => r.intentId === checkout.paymentIntent.id);
      expect(checkPending).toBeUndefined(); // not resolved, stays processing

      const intentStillProcessing = await paymentService.getPaymentIntent(checkout.paymentIntent.id);
      expect(intentStillProcessing.status).toBe('processing');

      // Now age reservation past its TTL (expired 5 minutes ago) and backoff past 5 minutes
      await db.query(
        "UPDATE reservations SET expires_at = NOW() - INTERVAL '5 minutes' WHERE order_id = $1",
        [checkout.order.id]
      );
      await db.query(
        "UPDATE payment_intents SET updated_at = NOW() - INTERVAL '6 minutes' WHERE id = $1",
        [checkout.paymentIntent.id]
      );

      // Reconciler runs again: now past TTL, should fail intent and release stock
      const recon2 = await paymentService.reconcileStuckPaymentIntents(15);
      const checkFailed = recon2.find((r) => r.intentId === checkout.paymentIntent.id);
      expect(checkFailed).toBeDefined();
      expect(checkFailed?.newStatus).toBe('failed');

      // Verify order status is expired
      const orderAfter = await orderService.getOrder(checkout.order.id);
      expect(orderAfter.status).toBe('expired');

      // Verify reservations marked released via shared release function
      const resAfter = await db.query<{ status: string }>('SELECT status FROM reservations WHERE order_id = $1', [checkout.order.id]);
      expect(resAfter.rows[0].status).toBe('released');

      // Reset mock provider verify status
      mockProvider.simulatedVerifyStatus = 'succeeded';
    });

    it('concurrent webhook and reconciler processing the same payment concurrently produces one commit and ZERO refunds (Item 1)', async () => {
      const product = await inventoryService.createProduct({
        sku: 'RACE_TEST_PROD',
        name: 'Race Test Product',
        price_minor: 5000,
        currency: 'NGN',
        initial_stock: 5,
      }).then((r) => r.product);

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 1 }],
        idempotencyKey: 'idemp_race_concurrent_1',
        provider: 'mock',
      });

      // Age the intent so reconciler considers it stuck
      await db.query(
        "UPDATE payment_intents SET created_at = NOW() - INTERVAL '30 minutes', updated_at = NOW() - INTERVAL '30 minutes' WHERE id = $1",
        [checkout.paymentIntent.id]
      );

      // Set mock provider to report succeeded
      mockProvider.setMockPayment(checkout.paymentIntent.provider_ref!, {
        id: checkout.paymentIntent.provider_ref!,
        reference: checkout.paymentIntent.provider_ref!,
        amountMinor: 5000,
        currency: 'NGN',
        status: 'succeeded',
      });

      const sim = mockProvider.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 5000, 'NGN');

      // Trigger webhook and reconciler concurrently on the SAME payment
      const [webhookRes, reconRes] = await Promise.all([
        checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload),
        paymentService.reconcileStuckPaymentIntents(15),
      ]);

      // Exactly ONE commit occurred
      const order = await orderService.getOrder(checkout.order.id);
      expect(order.status).toBe('paid');

      // Reservations committed: exactly 1 committed reservation
      const resRows = await db.query<{ status: string }>(
        'SELECT status FROM reservations WHERE order_id = $1',
        [checkout.order.id]
      );
      expect(resRows.rows.length).toBe(1);
      expect(resRows.rows[0].status).toBe('committed');

      // ZERO duplicate refunds created
      const duplicateRefundOutbox = await db.query(
        "SELECT id FROM outbox WHERE event_type = 'payment.duplicate_refund' AND payload->>'orderId' = $1",
        [checkout.order.id]
      );
      expect(duplicateRefundOutbox.rowCount).toBe(0);

      const refundTxns = await db.query(
        "SELECT id FROM transactions WHERE payment_intent_id = $1 AND type = 'refund'",
        [checkout.paymentIntent.id]
      );
      expect(refundTxns.rowCount).toBe(0);
    });

    it('intent-stuck-after-reaper: order expired by reaper, reconciler marks intent failed and releases stock (Item 4)', async () => {
      const product = await inventoryService.createProduct({
        sku: 'REAPER_RECON_PROD',
        name: 'Reaper Recon Product',
        price_minor: 8000,
        currency: 'NGN',
        initial_stock: 5,
      }).then((r) => r.product);

      const checkout = await checkoutSaga.executeCheckout({
        customerId: 'cus_w1',
        email: 'customer@example.com',
        items: [{ productId: product.id, qty: 2 }],
        idempotencyKey: 'idemp_reaper_recon_1',
        provider: 'mock',
      });

      // Age reservations past TTL and reap them
      await db.query(
        "UPDATE reservations SET expires_at = NOW() - INTERVAL '10 minutes' WHERE order_id = $1",
        [checkout.order.id]
      );
      const reaped = await inventoryService.reapExpiredReservations();
      expect(reaped).toBeGreaterThanOrEqual(1);

      const orderAfterReap = await orderService.getOrder(checkout.order.id);
      expect(orderAfterReap.status).toBe('expired');

      // Intent is still processing and stuck
      await db.query(
        "UPDATE payment_intents SET created_at = NOW() - INTERVAL '25 minutes', updated_at = NOW() - INTERVAL '25 minutes' WHERE id = $1",
        [checkout.paymentIntent.id]
      );

      mockProvider.simulatedVerifyStatus = 'failed';

      // Reconciler runs on stuck intent after reaper
      const reconResults = await paymentService.reconcileStuckPaymentIntents(15);
      const reapedIntentRecon = reconResults.find((r) => r.intentId === checkout.paymentIntent.id);
      expect(reapedIntentRecon).toBeDefined();
      expect(reapedIntentRecon?.newStatus).toBe('failed');

      const intentAfter = await paymentService.getPaymentIntent(checkout.paymentIntent.id);
      expect(intentAfter.status).toBe('failed');

      // Inventory invariants verified
      const inv = await inventoryService.getInventory(product.id);
      expect(inv.reserved).toBe(0);
      expect(inv.on_hand).toBe(5);

      mockProvider.simulatedVerifyStatus = 'succeeded';
    });
  });
});

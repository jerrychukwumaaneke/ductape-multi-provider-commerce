import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '../test-db.js';
import { IDatabaseClient } from '../../src/common/database/index.js';
import { PaymentService } from '../../src/modules/payments/payments.service.js';
import { PaymentRouter } from '../../src/modules/payments/router.js';
import { MockPaymentProvider } from '../../src/modules/payments/providers/mock.provider.js';
import { UnauthorizedError } from '../../src/common/errors/app-error.js';
import { runPaymentProviderContractSuite } from '../contracts/provider-contract.suite.js';

// 1. Run Shared Contract Test Suite on Mock Provider
runPaymentProviderContractSuite('Mock', () => {
  const mock = new MockPaymentProvider();
  return {
    provider: mock,
    generateValidWebhook: (ref: string, amount: number) => {
      const sim = mock.simulateWebhookPayload(ref, amount, 'NGN');
      return {
        rawBody: sim.rawBody,
        headers: sim.headers,
        payload: sim.payload,
      };
    },
  };
});

// 2. Integration Tests for PaymentService
describe('Milestone 5: Payment Service Integration & Webhook Ingestion', () => {
  let db: IDatabaseClient;
  let router: PaymentRouter;
  let mockProvider: MockPaymentProvider;
  let paymentService: PaymentService;

  beforeEach(async () => {
    db = await createTestDatabase();
    router = new PaymentRouter();
    mockProvider = new MockPaymentProvider();
    router.register(mockProvider);

    paymentService = new PaymentService(db, router);

    // Seed test customer & order
    await db.query("INSERT INTO customers (id, email, name) VALUES ('cus_1', 'buyer@test.com', 'Buyer One')");
    await db.query(
      "INSERT INTO orders (id, customer_id, status, total_minor, currency, idempotency_key) VALUES ('ord_100', 'cus_1', 'awaiting_payment', 5000, 'NGN', 'idemp_order_100')"
    );
  });

  afterEach(async () => {
    await db.close();
  });

  describe('Payment Intent Creation', () => {
    it('creates intent, sets status to processing, and returns checkoutUrl', async () => {
      const res = await paymentService.createPaymentIntent({
        orderId: 'ord_100',
        amountMinor: 5000,
        currency: 'NGN',
        email: 'buyer@test.com',
        idempotencyKey: 'pi_idemp_1',
      });

      expect(res.paymentIntent.id).toBeDefined();
      expect(res.paymentIntent.status).toBe('processing');
      expect(res.paymentIntent.amount_minor).toBe(5000);
      expect(res.checkoutUrl).toContain('https://mock.checkout.example.com');
    });

    it('returns existing intent on duplicate idempotencyKey without creating duplicates', async () => {
      const first = await paymentService.createPaymentIntent({
        orderId: 'ord_100',
        amountMinor: 5000,
        currency: 'NGN',
        email: 'buyer@test.com',
        idempotencyKey: 'pi_idemp_2',
      });

      const second = await paymentService.createPaymentIntent({
        orderId: 'ord_100',
        amountMinor: 5000,
        currency: 'NGN',
        email: 'buyer@test.com',
        idempotencyKey: 'pi_idemp_2',
      });

      expect(first.paymentIntent.id).toBe(second.paymentIntent.id);
    });
  });

  describe('Webhook Ingestion & Deduplication', () => {
    it('rejects webhooks with invalid signature', async () => {
      const { paymentIntent } = await paymentService.createPaymentIntent({
        orderId: 'ord_100',
        amountMinor: 5000,
        currency: 'NGN',
        email: 'buyer@test.com',
        idempotencyKey: 'pi_idemp_sig',
      });

      const sim = mockProvider.simulateWebhookPayload(paymentIntent.provider_ref!, 5000, 'NGN');

      // Send tampered signature
      await expect(
        paymentService.handleWebhook('mock', sim.rawBody, { 'x-mock-signature': 'invalid_signature_hex' }, sim.payload)
      ).rejects.toThrow(UnauthorizedError);
    });

    it('processes valid webhook, verifies with provider, updates intent and records transaction', async () => {
      const { paymentIntent } = await paymentService.createPaymentIntent({
        orderId: 'ord_100',
        amountMinor: 5000,
        currency: 'NGN',
        email: 'buyer@test.com',
        idempotencyKey: 'pi_idemp_valid',
      });

      const sim = mockProvider.simulateWebhookPayload(paymentIntent.provider_ref!, 5000, 'NGN');

      const result = await paymentService.handleWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      expect(result.duplicate).toBe(false);
      expect(result.paymentIntent?.status).toBe('succeeded');

      // Check transactions table
      const txns = await paymentService.listTransactions(paymentIntent.id);
      expect(txns.length).toBe(1);
      expect(txns[0].type).toBe('charge');
      expect(txns[0].amount_minor).toBe(5000);
      expect(txns[0].status).toBe('succeeded');
    });

    it('safely deduplicates duplicate webhook events without double processing', async () => {
      const { paymentIntent } = await paymentService.createPaymentIntent({
        orderId: 'ord_100',
        amountMinor: 5000,
        currency: 'NGN',
        email: 'buyer@test.com',
        idempotencyKey: 'pi_idemp_dedupe',
      });

      const sim = mockProvider.simulateWebhookPayload(paymentIntent.provider_ref!, 5000, 'NGN');

      // First webhook
      const first = await paymentService.handleWebhook('mock', sim.rawBody, sim.headers, sim.payload);
      expect(first.duplicate).toBe(false);

      // Duplicate webhook
      const second = await paymentService.handleWebhook('mock', sim.rawBody, sim.headers, sim.payload);
      expect(second.duplicate).toBe(true);

      // Exactly 1 transaction recorded
      const txns = await paymentService.listTransactions(paymentIntent.id);
      expect(txns.length).toBe(1);
    });
  });

  describe('Refunds', () => {
    it('refunds a succeeded payment intent and logs refund transaction', async () => {
      const { paymentIntent } = await paymentService.createPaymentIntent({
        orderId: 'ord_100',
        amountMinor: 5000,
        currency: 'NGN',
        email: 'buyer@test.com',
        idempotencyKey: 'pi_idemp_refund',
      });

      const sim = mockProvider.simulateWebhookPayload(paymentIntent.provider_ref!, 5000, 'NGN');
      await paymentService.handleWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      // Issue refund
      const refund = await paymentService.refundPayment(paymentIntent.id, 2500);
      expect(refund.status).toBe('succeeded');
      expect(refund.amountMinor).toBe(2500);

      const txns = await paymentService.listTransactions(paymentIntent.id);
      expect(txns.length).toBe(2);
      expect(txns[0].type).toBe('refund');
      expect(txns[0].amount_minor).toBe(2500);
    });
  });
});

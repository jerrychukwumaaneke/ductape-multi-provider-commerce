import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { runPaymentProviderContractSuite } from './provider-contract.suite.js';
import { FlutterwavePaymentProvider } from '../../src/modules/payments/providers/flutterwave.provider.js';
import { StripePaymentProvider } from '../../src/modules/payments/providers/stripe.provider.js';
import { MockPaymentProvider } from '../../src/modules/payments/providers/mock.provider.js';
import { PaymentRouter } from '../../src/modules/payments/router.js';
import { PaymentService } from '../../src/modules/payments/payments.service.js';
import { createTestDatabase } from '../test-db.js';
import { IDatabaseClient } from '../../src/common/database/index.js';
import { PaymentProvider } from '../../src/modules/payments/types.js';

// =================== 1. CONTRACT TEST: FLUTTERWAVE ===================
runPaymentProviderContractSuite('Flutterwave', () => {
  const secretHash = 'flw_webhook_secret_hash_123';
  const secretKey = 'FLWSECK_TEST-1234567890';

  const mockFlwFetch: typeof fetch = async (input, init) => {
    const urlStr = String(input);

    if (urlStr.includes('/payments')) {
      const body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          status: 'success',
          message: 'Payment link created',
          data: { link: `https://flutterwave.com/pay/${body.tx_ref}` },
        }),
        { status: 200 }
      );
    }

    if (urlStr.includes('/transactions/verify_by_reference')) {
      const u = new URL(urlStr);
      const txRef = u.searchParams.get('tx_ref');
      return new Response(
        JSON.stringify({
          status: 'success',
          data: {
            id: 888123,
            tx_ref: txRef,
            amount: 75, // 75 NGN -> 7500 minor units
            currency: 'NGN',
            status: 'successful',
          },
        }),
        { status: 200 }
      );
    }

    if (urlStr.includes('/refund')) {
      return new Response(
        JSON.stringify({
          status: 'success',
          data: { id: 999123, status: 'completed' },
        }),
        { status: 200 }
      );
    }

    return new Response(JSON.stringify({ status: 'error' }), { status: 400 });
  };

  const provider = new FlutterwavePaymentProvider({
    secretKey,
    secretHash,
    fetchFn: mockFlwFetch,
  });

  return {
    provider,
    generateValidWebhook: (ref: string, amount: number) => {
      const payload = {
        event: 'charge.completed',
        data: {
          id: 555123,
          tx_ref: ref,
          amount: amount / 100,
          currency: 'NGN',
          status: 'successful',
        },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const hash = crypto.createHmac('sha256', secretHash).update(rawBody.toString('utf8')).digest('hex');
      return {
        rawBody,
        headers: {
          'verif-hash': hash,
        },
        payload,
      };
    },
  };
});

// =================== 2. CONTRACT TEST: STRIPE ===================
runPaymentProviderContractSuite('Stripe', () => {
  const secretKey = 'sk_test_123456';
  const webhookSecret = 'whsec_test_secret_123';

  const mockStripeFetch: typeof fetch = async (input, init) => {
    const urlStr = String(input);

    if (urlStr.includes('/payment_intents') && init?.method === 'POST' && !urlStr.includes('/cancel')) {
      const params = new URLSearchParams(String(init?.body));
      const ref = params.get('metadata[reference]') || 'ref_test';
      const amount = Number(params.get('amount'));
      return new Response(
        JSON.stringify({
          id: `pi_test_${ref}`,
          amount,
          currency: params.get('currency') || 'usd',
          status: 'requires_payment_method',
          client_secret: 'pi_test_secret',
          metadata: { reference: ref },
        }),
        { status: 200 }
      );
    }

    if (urlStr.includes('/payment_intents/search') || (urlStr.includes('/payment_intents/') && init?.method === 'GET')) {
      let ref = 'ref_contract_test';
      if (urlStr.includes("metadata['reference']:")) {
        const match = urlStr.match(/metadata\['reference'\]:'([^']+)'/);
        if (match) ref = decodeURIComponent(match[1]);
      } else {
        const parts = urlStr.split('/');
        ref = decodeURIComponent(parts[parts.length - 1].split('?')[0]);
      }
      return new Response(
        JSON.stringify({
          id: `pi_test_${ref}`,
          amount: 7500,
          currency: 'usd',
          status: 'succeeded',
          metadata: { reference: ref },
        }),
        { status: 200 }
      );
    }

    if (urlStr.includes('/cancel')) {
      return new Response(JSON.stringify({ id: 'pi_test_123', status: 'canceled' }), { status: 200 });
    }

    if (urlStr.includes('/refunds')) {
      return new Response(JSON.stringify({ id: 're_test_123', amount: 3000, status: 'succeeded' }), {
        status: 200,
      });
    }

    return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
  };

  const provider = new StripePaymentProvider({
    secretKey,
    webhookSecret,
    fetchFn: mockStripeFetch,
  });

  return {
    provider,
    generateValidWebhook: (ref: string, amount: number) => {
      const payload = {
        id: `evt_stripe_${Date.now()}`,
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: `pi_test_${ref}`,
            amount,
            currency: 'usd',
            metadata: { reference: ref },
          },
        },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = crypto
        .createHmac('sha256', webhookSecret)
        .update(`${timestamp}.${rawBody.toString('utf8')}`)
        .digest('hex');

      return {
        rawBody,
        headers: {
          'stripe-signature': `t=${timestamp},v1=${signature}`,
        },
        payload,
      };
    },
  };
});

// =================== 3. ROUTING & FAILOVER TESTS ===================
describe('Milestone 8: Payment Router Rules & Safe Failover', () => {
  let db: IDatabaseClient;
  let router: PaymentRouter;
  let mockProvider: MockPaymentProvider;
  let paymentService: PaymentService;

  beforeEach(async () => {
    db = await createTestDatabase();
    router = new PaymentRouter();

    mockProvider = new MockPaymentProvider();
    router.register(mockProvider);

    await db.query("INSERT INTO customers (id, email, name) VALUES ('cus_router', 'router@test.com', 'Router Test')");
    await db.query(
      "INSERT INTO orders (id, customer_id, status, total_minor, currency, idempotency_key) VALUES ('ord_router_1', 'cus_router', 'awaiting_payment', 10000, 'USD', 'idemp_router_1')"
    );

    paymentService = new PaymentService(db, router);
  });

  afterEach(async () => {
    await db.close();
  });

  it('routes currency automatically (NGN -> paystack, USD -> stripe, KES -> flutterwave)', () => {
    const paystack = new MockPaymentProvider('paystack');
    const stripe = new MockPaymentProvider('stripe');
    const flutterwave = new MockPaymentProvider('flutterwave');

    const multiRouter = new PaymentRouter();
    multiRouter.register(paystack);
    multiRouter.register(stripe);
    multiRouter.register(flutterwave);

    expect(multiRouter.resolve({ currency: 'NGN' }).name).toBe('paystack');
    expect(multiRouter.resolve({ currency: 'USD' }).name).toBe('stripe');
    expect(multiRouter.resolve({ currency: 'KES' }).name).toBe('flutterwave');
  });

  it('respects explicit preferred provider overrides', () => {
    const paystack = new MockPaymentProvider('paystack');
    const stripe = new MockPaymentProvider('stripe');

    const multiRouter = new PaymentRouter();
    multiRouter.register(paystack);
    multiRouter.register(stripe);

    // Explicit preferred provider takes precedence over currency default
    const resolved = multiRouter.resolve({ currency: 'USD', preferredProvider: 'paystack' });
    expect(resolved.name).toBe('paystack');
  });

  it('safely fails over to secondary provider when primary fails and is confirmed not created', async () => {
    // Primary provider that fails on createPayment
    const primaryProvider: PaymentProvider = {
      name: 'primary_flaky',
      createPayment: async () => {
        throw new Error('Primary gateway timeout');
      },
      verifyPayment: async () => {
        throw new Error('Payment not found'); // Confirmed not created!
      },
      cancelPayment: async () => {},
      refund: async () => ({ id: 'ref', reference: 'ref', amountMinor: 0, status: 'succeeded', rawResponse: {} }),
      verifyWebhookSignature: () => true,
      parseWebhookEvent: () => ({ provider: 'primary_flaky', eventId: '1', type: 'charge.success', reference: 'ref', amountMinor: 100, currency: 'USD', rawPayload: {} }),
    };

    const secondaryProvider = new MockPaymentProvider('secondary_backup');

    const failoverRouter = new PaymentRouter();
    failoverRouter.register(primaryProvider);
    failoverRouter.register(secondaryProvider);

    const failoverService = new PaymentService(db, failoverRouter);

    const intent = await failoverService.createPaymentIntent({
      orderId: 'ord_router_1',
      amountMinor: 10000,
      currency: 'USD',
      email: 'router@test.com',
      idempotencyKey: 'idemp_failover_test',
    });

    expect(intent.paymentIntent).toBeDefined();
    expect(intent.paymentIntent.provider).toBe('secondary_backup');
    expect(intent.paymentIntent.status).toBe('processing');
  });

  it('aborts failover if payment was ambiguous or already created on primary to prevent double charging', async () => {
    // Primary gateway fails network response after having created the payment
    const ambiguousProvider: PaymentProvider = {
      name: 'ambiguous_provider',
      createPayment: async () => {
        throw new Error('Network dropped after charge created');
      },
      verifyPayment: async (ref: string) => {
        // Confirmed created on gateway!
        return {
          id: 'pay_created',
          reference: ref,
          amountMinor: 10000,
          currency: 'USD',
          status: 'pending',
          rawResponse: {},
        };
      },
      cancelPayment: async () => {},
      refund: async () => ({ id: 'ref', reference: 'ref', amountMinor: 0, status: 'succeeded', rawResponse: {} }),
      verifyWebhookSignature: () => true,
      parseWebhookEvent: () => ({ provider: 'ambiguous_provider', eventId: '1', type: 'charge.success', reference: 'ref', amountMinor: 100, currency: 'USD', rawPayload: {} }),
    };

    const backupProvider = new MockPaymentProvider('backup_provider');

    const ambiguousRouter = new PaymentRouter();
    ambiguousRouter.register(ambiguousProvider);
    ambiguousRouter.register(backupProvider);

    const ambiguousService = new PaymentService(db, ambiguousRouter);

    await expect(
      ambiguousService.createPaymentIntent({
        orderId: 'ord_router_1',
        amountMinor: 10000,
        currency: 'USD',
        email: 'router@test.com',
        idempotencyKey: 'idemp_ambiguous_test',
      })
    ).rejects.toThrow(/ambiguous/i);
  });
});

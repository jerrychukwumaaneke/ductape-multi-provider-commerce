import 'dotenv/config';
import http from 'node:http';
import Ductape from '@ductape/sdk';
import { DuctapeDatabaseClient } from '../src/common/database/ductape.database.js';
import { InventoryService } from '../src/modules/inventory/inventory.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { OrderService } from '../src/modules/orders/orders.service.js';
import { PaymentRouter } from '../src/modules/payments/router.js';
import { PaymentService } from '../src/modules/payments/payments.service.js';
import { MockPaymentProvider } from '../src/modules/payments/providers/mock.provider.js';
import { NotificationService } from '../src/modules/notifications/notifications.service.js';
import { MockTransport, HttpWebhookTransport } from '../src/modules/notifications/transports/index.js';
import { IdempotencyService } from '../src/modules/idempotency/idempotency.service.js';
import { CheckoutSaga } from '../src/modules/orders/checkout-saga.js';
import { IdentityService } from '../src/modules/identity/identity.service.js';
import { createApp } from '../src/api/app.js';
import { CryptoUtils } from '../src/common/utils/crypto.js';

process.env.USE_DUCTAPE_DB = 'true';
process.env.NODE_ENV = 'test';

async function main() {
  console.log('================================================================');
  console.log(' LIVE SIMULATION: DUCTAPE SDK TIMEOUT, ATOMICITY & IDEMPOTENCY ');
  console.log('================================================================');

  // 1. Initialize real Ductape SDK
  const ductapeClient = new Ductape({
    accessKey: process.env.DUCTAPE_ACCESS_KEY,
    product: process.env.DUCTAPE_PRODUCT || 'xavier_space:commerce_backend',
    env: process.env.DUCTAPE_ENV || 'snd',
  });
  if (process.env.DUCTAPE_WORKSPACE_ID) {
    ductapeClient.setWorkspaceId(process.env.DUCTAPE_WORKSPACE_ID);
  }
  (ductapeClient as any).redisCacheUnavailable = true;

  // Connect to live database via Ductape SDK
  await ductapeClient.databases.connect({
    env: process.env.DUCTAPE_ENV || 'snd',
    product: process.env.DUCTAPE_PRODUCT || 'xavier_space:commerce_backend',
    database: 'commerce_db',
  });

  const dbClient = new DuctapeDatabaseClient(ductapeClient);
  const inventoryService = new InventoryService(dbClient);
  const auditService = new AuditService(dbClient);
  const orderService = new OrderService(dbClient, inventoryService, auditService);
  const identityService = new IdentityService(dbClient);
  const paymentRouter = new PaymentRouter();
  const mockProv = new MockPaymentProvider('mock');
  paymentRouter.register(mockProv);
  const paymentService = new PaymentService(dbClient, paymentRouter);
  orderService.paymentService = paymentService;
  const notificationService = new NotificationService(
    dbClient,
    new MockTransport(),
    new HttpWebhookTransport(5000)
  );
  const idempotencyService = new IdempotencyService(dbClient);
  const checkoutSaga = new CheckoutSaga(
    dbClient,
    orderService,
    inventoryService,
    paymentService,
    notificationService,
    idempotencyService,
    auditService
  );

  const app = createApp({
    identityService,
    inventoryService,
    orderService,
    paymentService,
    notificationService,
    checkoutSaga,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(3099, '127.0.0.1', () => resolve()));
  console.log('HTTP Server listening on http://127.0.0.1:3099');

  const runId = CryptoUtils.generateId('sim');
  const customerId = `cus_sim_${runId}`;
  const productId = `prod_sim_${runId}`;
  let orderId = '';
  let intentId = '';
  let providerRef = '';
  let eventId = '';

  try {
    // 2. Setup baseline test rows in real cloud DB using proper schema
    console.log('\n--- Step 1: Seeding baseline test data in Ductape Cloud DB ---');
    await dbClient.query(
      'INSERT INTO customers (id, email, name, created_at) VALUES ($1, $2, $3, NOW())',
      [customerId, `${runId}@example.com`, `Sim User ${runId}`]
    );
    await dbClient.query(
      'INSERT INTO products (id, sku, name, price_minor, currency, active, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
      [productId, `SKU_${runId}`, 'Sim Product', 2500, 'NGN', true]
    );
    await dbClient.query(
      'INSERT INTO inventory (product_id, on_hand, reserved) VALUES ($1, $2, $3)',
      [productId, 10, 0]
    );

    // Execute checkout to get a real awaiting_payment order and processing intent
    const checkout = await checkoutSaga.executeCheckout({
      customerId,
      email: `${runId}@example.com`,
      items: [{ productId, qty: 2 }],
      idempotencyKey: `idemp_${runId}`,
      currency: 'NGN',
      provider: 'mock',
    });

    orderId = checkout.order.id;
    intentId = checkout.paymentIntent.id;
    providerRef = checkout.paymentIntent.provider_ref!;

    console.log(`Created Order: ${orderId}`);
    console.log(`Created Payment Intent: ${intentId}`);
    console.log(`Provider Reference: ${providerRef}`);

    // Prepare authentic signed webhook payload
    const simPayload = mockProv.simulateWebhookPayload(providerRef, 5000, 'NGN', 'charge.success');
    const parsed = mockProv.parseWebhookEvent(simPayload.payload, simPayload.rawBody);
    eventId = parsed.eventId;

    // Verify baseline state
    const baseOrd = await dbClient.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]);
    const basePi = await dbClient.query<{ status: string }>('SELECT status FROM payment_intents WHERE id = $1', [intentId]);
    const baseTxn = await dbClient.query('SELECT * FROM transactions WHERE payment_intent_id = $1', [intentId]);
    const baseEvt = await dbClient.query('SELECT * FROM webhook_events WHERE provider_event_id = $1', [eventId]);
    const baseInv = await dbClient.query<{ on_hand: number; reserved: number }>('SELECT on_hand, reserved FROM inventory WHERE product_id = $1', [productId]);

    console.log(`Baseline Order status:        ${baseOrd.rows[0].status} (expected: awaiting_payment)`);
    console.log(`Baseline Intent status:       ${basePi.rows[0].status} (expected: processing)`);
    console.log(`Baseline Transactions count:  ${baseTxn.rowCount} (expected: 0)`);
    console.log(`Baseline Webhook events count:${baseEvt.rowCount} (expected: 0)`);
    console.log(`Baseline Inventory:           on_hand=${baseInv.rows[0].on_hand}, reserved=${baseInv.rows[0].reserved} (expected: 10, 2)`);

    // 3. Simulate unreachable api.ductape.app with a 15,000ms timeout
    console.log('\n--- Step 2: Simulating unreachable api.ductape.app (15,000ms timeout) ---');

    // Save active auth session credentials to restore after simulation
    const savedToken = (ductapeClient as any).token;
    const savedPublicKey = (ductapeClient as any).public_key;
    const savedSession = (ductapeClient as any).session;

    const originalFetchUser = (ductapeClient as any).userApi.fetchUserByPrivateKey;
    let callCount = 0;

    // Invalidate auth credentials so the webhook request must re-authenticate
    (ductapeClient as any).token = null;
    (ductapeClient as any).public_key = null;
    (ductapeClient as any).session = null;

    // Intercept userApi.fetchUserByPrivateKey to simulate the real 15000ms axios timeout to api.ductape.app
    (ductapeClient as any).userApi.fetchUserByPrivateKey = async function (...args: any[]) {
      callCount++;
      if (callCount === 1) {
        console.log('[Simulation] Outbound auth request to https://api.ductape.app stalled... waiting for 15,000ms timeout');
        await new Promise((r) => setTimeout(r, 15000));
        throw new Error('timeout of 15000ms exceeded');
      }
      // Fail immediately on retry attempt
      throw new Error('timeout of 15000ms exceeded');
    };

    console.log(`Sending webhook POST http://127.0.0.1:3099/webhooks/mock...`);
    const startTime = Date.now();
    const failRes = await fetch('http://127.0.0.1:3099/webhooks/mock', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(simPayload.headers as any),
      },
      body: simPayload.rawBody.toString('utf8'),
    });
    const elapsedMs = Date.now() - startTime;
    const failStatus = failRes.status;
    const failBody = await failRes.text();

    console.log(`\n================================================================`);
    console.log(`>>> Webhook response returned in: ${elapsedMs} ms (~${(elapsedMs / 1000).toFixed(2)}s)`);
    console.log(`>>> HTTP Status Code: ${failStatus}`);
    console.log(`>>> Response Body: ${failBody}`);
    console.log(`================================================================`);

    // Restore real userApi implementation and auth session
    (ductapeClient as any).userApi.fetchUserByPrivateKey = originalFetchUser;
    (ductapeClient as any).token = savedToken;
    (ductapeClient as any).public_key = savedPublicKey;
    (ductapeClient as any).session = savedSession;

    // 4. Confirm NO partial rows were written
    console.log('\n--- Step 3: Verifying NO partial rows written to real database ---');
    const postFailOrd = await dbClient.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]);
    const postFailPi = await dbClient.query<{ status: string }>('SELECT status FROM payment_intents WHERE id = $1', [intentId]);
    const postFailTxn = await dbClient.query('SELECT * FROM transactions WHERE payment_intent_id = $1', [intentId]);
    const postFailEvt = await dbClient.query('SELECT * FROM webhook_events WHERE provider_event_id = $1', [eventId]);
    const postFailInv = await dbClient.query<{ on_hand: number; reserved: number }>('SELECT on_hand, reserved FROM inventory WHERE product_id = $1', [productId]);

    console.log(`Post-failure Order status:        ${postFailOrd.rows[0].status} (expected: awaiting_payment)`);
    console.log(`Post-failure Intent status:       ${postFailPi.rows[0].status} (expected: processing)`);
    console.log(`Post-failure Transactions count:  ${postFailTxn.rowCount} (expected: 0)`);
    console.log(`Post-failure Webhook events count:${postFailEvt.rowCount} (expected: 0)`);
    console.log(`Post-failure Inventory:           on_hand=${postFailInv.rows[0].on_hand}, reserved=${postFailInv.rows[0].reserved} (expected: 10, 2)`);

    if (
      postFailOrd.rows[0].status === 'awaiting_payment' &&
      postFailPi.rows[0].status === 'processing' &&
      postFailTxn.rowCount === 0 &&
      postFailEvt.rowCount === 0
    ) {
      console.log('✓ PASS: Atomicity verified. Zero partial rows committed to database.');
    } else {
      console.error('✗ FAIL: Inconsistent database state detected!');
    }

    // 5. Resend exact same webhook payload after connectivity restored
    console.log('\n--- Step 4: Resending exact same webhook with connectivity restored ---');
    const resendStart = Date.now();
    const resendRes = await fetch('http://127.0.0.1:3099/webhooks/mock', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(simPayload.headers as any),
      },
      body: simPayload.rawBody.toString('utf8'),
    });
    const resendElapsedMs = Date.now() - resendStart;
    const resendStatus = resendRes.status;
    const resendBody = await resendRes.text();

    console.log(`>>> Resend response returned in: ${resendElapsedMs} ms`);
    console.log(`>>> Resend HTTP Status: ${resendStatus}`);
    console.log(`>>> Resend Body: ${resendBody}`);

    // Verify DB state after resend
    const successOrd = await dbClient.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]);
    const successPi = await dbClient.query<{ status: string }>('SELECT status FROM payment_intents WHERE id = $1', [intentId]);
    const successTxn = await dbClient.query<{ type: string; status: string; amount_minor: number; provider_ref: string }>(
      'SELECT type, status, amount_minor, provider_ref FROM transactions WHERE payment_intent_id = $1',
      [intentId]
    );
    const successEvt = await dbClient.query('SELECT * FROM webhook_events WHERE provider_event_id = $1', [eventId]);
    const successInv = await dbClient.query<{ on_hand: number; reserved: number }>(
      'SELECT on_hand, reserved FROM inventory WHERE product_id = $1',
      [productId]
    );

    console.log(`Final Order status:        ${successOrd.rows[0].status} (expected: paid)`);
    console.log(`Final Intent status:       ${successPi.rows[0].status} (expected: succeeded)`);
    console.log(`Final Transactions count:  ${successTxn.rowCount} (expected: 1)`);
    if (successTxn.rowCount > 0) {
      console.log(`  -> Transaction: type=${successTxn.rows[0].type}, status=${successTxn.rows[0].status}, amount=${successTxn.rows[0].amount_minor}, ref=${successTxn.rows[0].provider_ref}`);
    }
    console.log(`Final Webhook events count:${successEvt.rowCount} (expected: 1)`);
    console.log(`Final Inventory:           on_hand=${successInv.rows[0].on_hand}, reserved=${successInv.rows[0].reserved} (expected: 8, 0)`);

    if (
      successOrd.rows[0].status === 'paid' &&
      successPi.rows[0].status === 'succeeded' &&
      successTxn.rowCount === 1 &&
      successEvt.rowCount === 1 &&
      successInv.rows[0].on_hand === 8 &&
      successInv.rows[0].reserved === 0
    ) {
      console.log('✓ PASS: Retry succeeded cleanly. Payment completed and inventory committed.');
    } else {
      console.error('✗ FAIL: Retry did not transition state as expected!');
    }

    // 6. Verify Idempotency (3rd send)
    console.log('\n--- Step 5: Duplicate webhook delivery to verify idempotency ---');
    const dupRes = await fetch('http://127.0.0.1:3099/webhooks/mock', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(simPayload.headers as any),
      },
      body: simPayload.rawBody.toString('utf8'),
    });
    const dupStatus = dupRes.status;
    const dupBody = await dupRes.text();
    console.log(`>>> Duplicate HTTP Status: ${dupStatus}`);
    console.log(`>>> Duplicate Body: ${dupBody}`);

    const dupTxn = await dbClient.query('SELECT * FROM transactions WHERE payment_intent_id = $1', [intentId]);
    console.log(`Final Transactions count after duplicate: ${dupTxn.rowCount} (expected: 1, exactly once)`);

    if (dupStatus === 200 && dupTxn.rowCount === 1) {
      console.log('✓ PASS: Idempotency holds. Zero duplicate transactions recorded.');
    } else {
      console.error('✗ FAIL: Duplicate delivery created extra records!');
    }

  } finally {
    console.log('\n--- Cleanup: Purging simulation records from live database ---');
    if (intentId) {
      await dbClient.query('DELETE FROM transactions WHERE payment_intent_id = $1', [intentId]).catch(() => {});
      await dbClient.query('DELETE FROM payment_intents WHERE id = $1', [intentId]).catch(() => {});
    }
    if (eventId) {
      await dbClient.query('DELETE FROM webhook_events WHERE provider_event_id = $1', [eventId]).catch(() => {});
    }
    if (orderId) {
      await dbClient.query('DELETE FROM reservations WHERE order_id = $1', [orderId]).catch(() => {});
      await dbClient.query('DELETE FROM order_items WHERE order_id = $1', [orderId]).catch(() => {});
      await dbClient.query('DELETE FROM orders WHERE id = $1', [orderId]).catch(() => {});
    }
    if (productId) {
      await dbClient.query('DELETE FROM inventory WHERE product_id = $1', [productId]).catch(() => {});
      await dbClient.query('DELETE FROM products WHERE id = $1', [productId]).catch(() => {});
    }
    if (customerId) {
      await dbClient.query('DELETE FROM customers WHERE id = $1', [customerId]).catch(() => {});
    }
    server.close();
    console.log('Cleanup complete. Server closed.');
    console.log('================================================================\n');
  }
}

main().catch((err) => {
  console.error('Fatal simulation error:', err);
  process.exit(1);
});

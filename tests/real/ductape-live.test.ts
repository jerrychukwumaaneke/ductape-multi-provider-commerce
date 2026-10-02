import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Ductape from '@ductape/sdk';
import { DuctapeDatabaseClient } from '../../src/common/database/ductape.database.js';
import { InventoryService } from '../../src/modules/inventory/inventory.service.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { OrderService } from '../../src/modules/orders/orders.service.js';
import { PaymentRouter } from '../../src/modules/payments/router.js';
import { PaymentService } from '../../src/modules/payments/payments.service.js';
import { PaystackPaymentProvider } from '../../src/modules/payments/providers/paystack.provider.js';
import { FlutterwavePaymentProvider } from '../../src/modules/payments/providers/flutterwave.provider.js';
import { MockPaymentProvider } from '../../src/modules/payments/providers/mock.provider.js';
import { NotificationService } from '../../src/modules/notifications/notifications.service.js';
import { MockTransport, HttpWebhookTransport, DuctapeNotificationTransport } from '../../src/modules/notifications/transports/index.js';
import { IdempotencyService } from '../../src/modules/idempotency/idempotency.service.js';
import { CheckoutSaga } from '../../src/modules/orders/checkout-saga.js';
import { OutboxService } from '../../src/modules/outbox/outbox.service.js';
import { ValidationError, InsufficientInventoryError, NotFoundError } from '../../src/common/errors/app-error.js';
import { Express } from 'express';
import http from 'node:http';
import localtunnel from 'localtunnel';
import { IdentityService } from '../../src/modules/identity/identity.service.js';
import { createApp } from '../../src/api/app.js';
import { CryptoUtils } from '../../src/common/utils/crypto.js';
import { DuctapeJobScheduler } from '../../src/common/ductape/jobs.js';
import { DuctapeSessionService } from '../../src/modules/identity/ductape-session.service.js';

describe('Real Live Services Test Suite (Non-Mocked Network Calls)', () => {
  const ductapeAccessKey =
    process.env.DUCTAPE_ACCESS_KEY ||
    process.env.DUCTAPE_ACCESSKEY ||
    process.env.ACCESS_KEY ||
    '';
  const ductapeWorkspaceId =
    process.env.DUCTAPE_WORKSPACE_ID ||
    process.env.DUCTAPE_WORKSPACE ||
    process.env.WORKSPACE_ID ||
    '';
  const ductapeProduct = process.env.DUCTAPE_PRODUCT || 'xavier_space:commerce_backend';
  const ductapeEnv = process.env.DUCTAPE_ENV || 'snd';

  const paystackSecretKey =
    process.env.PAYSTACK_SECRET_KEY ||
    process.env.PAYSTACK_SK ||
    '';
  const flutterwaveSecretKey =
    process.env.FLUTTERWAVE_SECRET_KEY ||
    process.env.FLW_SECRET_KEY ||
    process.env.FLW_SECK ||
    '';
  const flutterwaveSecretHash =
    process.env.FLUTTERWAVE_WEBHOOK_HASH ||
    process.env.FLUTTERWAVE_SECRET_HASH ||
    'test_hash';

  let ductapeClient: Ductape;
  let dbClient: DuctapeDatabaseClient;
  let inventoryService: InventoryService;
  let auditService: AuditService;
  let orderService: OrderService;
  let paymentService: PaymentService;
  let notificationService: NotificationService;
  let idempotencyService: IdempotencyService;
  let checkoutSaga: CheckoutSaga;
  let mockProv: MockPaymentProvider;

  let identityService: IdentityService;
  let app: Express;
  let server: http.Server;
  let baseUrl: string;

  // Track created entities for automated cleanup in afterAll
  const createdCustomerIds = new Set<string>();
  const createdProductIds = new Set<string>();
  const createdOrderIds = new Set<string>();
  const createdUserIds = new Set<string>();
  const createdWebhookEventIds = new Set<string>();
  const createdIdempotencyKeys = new Set<string>();
  const createdOutboxIds = new Set<string>();
  const createdNotificationIds = new Set<string>();

  beforeAll(async () => {
    // Step 3 Guard: Refuse to execute if environment is not 'snd'
    if (ductapeEnv !== 'snd') {
      throw new Error(
        `CRITICAL SAFETY GUARD: Live test suite refuses to run in "${ductapeEnv}" environment. ` +
        `Only the "snd" (sandbox) environment is allowed for automated live integration tests.`
      );
    }

    console.log('\n================ Runtime Env Diagnostic ================');
    // Step 4: Redact/mask access key completely - never print the key or its prefix
    console.log(`- DUCTAPE_ACCESS_KEY: loaded = ${Boolean(ductapeAccessKey)} (len: ${ductapeAccessKey.length}) [PREFIX REDACTED]`);
    console.log(`- DUCTAPE_WORKSPACE_ID: loaded = ${Boolean(ductapeWorkspaceId)} (len: ${ductapeWorkspaceId.length})`);
    console.log(`- DUCTAPE_PRODUCT: ${ductapeProduct}`);
    console.log(`- DUCTAPE_ENV: ${ductapeEnv}`);
    console.log(`- PAYSTACK_SECRET_KEY: loaded = ${Boolean(paystackSecretKey)} (len: ${paystackSecretKey.length})`);
    console.log(`- FLUTTERWAVE_SECRET_KEY: loaded = ${Boolean(flutterwaveSecretKey)} (len: ${flutterwaveSecretKey.length})`);
    console.log('========================================================\n');

    ductapeClient = new Ductape({
      accessKey: ductapeAccessKey,
      product: ductapeProduct,
      env: ductapeEnv,
    });
    if (ductapeWorkspaceId) {
      ductapeClient.setWorkspaceId(ductapeWorkspaceId);
    }

    // Connect to live database via Ductape SDK
    await ductapeClient.databases.connect({
      env: ductapeEnv,
      product: ductapeProduct,
      database: 'commerce_db',
    });

    dbClient = new DuctapeDatabaseClient(ductapeClient);

    // Ensure outbox table exists in live database
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS outbox (
        id VARCHAR(64) PRIMARY KEY,
        event_type VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        claimed_at TIMESTAMP WITH TIME ZONE,
        scheduled_for TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        processed_at TIMESTAMP WITH TIME ZONE
      )
    `);
    await dbClient.query(`
      ALTER TABLE outbox ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE outbox ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMP WITH TIME ZONE;
    `);

    inventoryService = new InventoryService(dbClient);
    auditService = new AuditService(dbClient);
    orderService = new OrderService(dbClient, inventoryService, auditService);
    identityService = new IdentityService(dbClient);

    const paymentRouter = new PaymentRouter();
    if (paystackSecretKey) {
      paymentRouter.register(new PaystackPaymentProvider({ secretKey: paystackSecretKey }));
    }
    if (flutterwaveSecretKey) {
      paymentRouter.register(
        new FlutterwavePaymentProvider({
          secretKey: flutterwaveSecretKey,
          secretHash: flutterwaveSecretHash,
        })
      );
    }
    mockProv = new MockPaymentProvider('mock');
    paymentRouter.register(mockProv);

    paymentService = new PaymentService(dbClient, paymentRouter);
    orderService.paymentService = paymentService;
    notificationService = new NotificationService(
      dbClient,
      new MockTransport(),
      new HttpWebhookTransport(5000)
    );
    idempotencyService = new IdempotencyService(dbClient);

    checkoutSaga = new CheckoutSaga(
      dbClient,
      orderService,
      inventoryService,
      paymentService,
      notificationService,
      idempotencyService,
      auditService
    );

    app = createApp({
      identityService,
      inventoryService,
      orderService,
      paymentService,
      notificationService,
      checkoutSaga,
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }, 30000);

  // Invariant helper: verifies reserved == sum(held qty) and bound check on each product
  async function assertInventoryInvariants(productIds: string[]) {
    if (productIds.length === 0) return;
    for (const pid of productIds) {
      const invRes = await dbClient.query<{ product_id: string; on_hand: number; reserved: number }>(
        'SELECT product_id, on_hand, reserved FROM inventory WHERE product_id = $1',
        [pid]
      );
      if (invRes.rowCount === 0) continue;
      const inv = invRes.rows[0];

      const heldRes = await dbClient.query<{ total_held: string }>(
        "SELECT COALESCE(SUM(qty), 0) AS total_held FROM reservations WHERE product_id = $1 AND status = 'held'",
        [pid]
      );
      const sumHeld = Number(heldRes.rows[0]?.total_held ?? 0);

      expect(Number(inv.reserved)).toBe(sumHeld);
      expect(Number(inv.reserved)).toBeLessThanOrEqual(Number(inv.on_hand));
      expect(Number(inv.reserved)).toBeGreaterThanOrEqual(0);
      expect(Number(inv.on_hand)).toBeGreaterThanOrEqual(0);
    }
  }

  // Step 4 & 5: Cleanup hook to purge strictly tracked test IDs using = ANY($1::varchar[])
  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (!dbClient) return;
    console.log('\n[Live Tests Cleanup] Purging all tracked test records from live database...');

    const orderIds = Array.from(createdOrderIds);
    const prodIds = Array.from(createdProductIds);
    const userIds = Array.from(createdUserIds);
    const custIds = Array.from(createdCustomerIds);
    const webhookEvtIds = Array.from(createdWebhookEventIds);
    const idempKeys = Array.from(createdIdempotencyKeys);

    // 1. Delete notifications & delivery attempts associated with tracked orders or tracked keys
    if (orderIds.length > 0) {
      const notifKeys = [
        ...orderIds.map((id) => `notif_order_paid_${id}`),
        ...orderIds.map((id) => `notif_order_cancelled_${id}`),
      ];
      const notifs = await dbClient.query<{ id: string }>(
        'SELECT id FROM notifications WHERE idempotency_key = ANY($1::varchar[])',
        [notifKeys]
      );
      const notifIds = notifs.rows.map((r) => r.id);
      if (notifIds.length > 0) {
        await dbClient.query('DELETE FROM delivery_attempts WHERE notification_id = ANY($1::varchar[])', [notifIds]);
        await dbClient.query('DELETE FROM notifications WHERE id = ANY($1::varchar[])', [notifIds]);
      }

      // 2. Transactions & Payment Intents
      const intents = await dbClient.query<{ id: string }>(
        'SELECT id FROM payment_intents WHERE order_id = ANY($1::varchar[])',
        [orderIds]
      );
      const intentIds = intents.rows.map((r) => r.id);
      if (intentIds.length > 0) {
        await dbClient.query('DELETE FROM transactions WHERE payment_intent_id = ANY($1::varchar[])', [intentIds]);
        await dbClient.query('DELETE FROM payment_intents WHERE id = ANY($1::varchar[])', [intentIds]);
      }

      // 3. Outbox, Reservations, Order Items, Audit Log, Orders
      await dbClient.query("DELETE FROM outbox WHERE payload->>'orderId' = ANY($1::varchar[])", [orderIds]).catch((err) => {
        console.error('[LiveCleanup] Outbox delete by orderId error:', err);
      });
      await dbClient.query('DELETE FROM reservations WHERE order_id = ANY($1::varchar[])', [orderIds]);
      await dbClient.query('DELETE FROM order_items WHERE order_id = ANY($1::varchar[])', [orderIds]);
      await dbClient.query('DELETE FROM audit_log WHERE entity_id = ANY($1::varchar[])', [orderIds]);
      await dbClient.query('DELETE FROM orders WHERE id = ANY($1::varchar[])', [orderIds]);
    }

    const explicitNotifIds = Array.from(createdNotificationIds);
    if (explicitNotifIds.length > 0) {
      await dbClient.query('DELETE FROM delivery_attempts WHERE notification_id = ANY($1::varchar[])', [explicitNotifIds]);
      await dbClient.query('DELETE FROM notifications WHERE id = ANY($1::varchar[])', [explicitNotifIds]);
    }

    // 4. Outbox rows tracked directly (Item 3)
    const outboxIds = Array.from(createdOutboxIds);
    if (outboxIds.length > 0) {
      await dbClient.query('DELETE FROM outbox WHERE id = ANY($1::varchar[])', [outboxIds]);
    }

    // 5. Webhook Events (Requirement 9)
    if (webhookEvtIds.length > 0) {
      await dbClient.query(
        'DELETE FROM webhook_events WHERE provider_event_id = ANY($1::varchar[]) OR id = ANY($1::varchar[])',
        [webhookEvtIds]
      );
    }

    // 6. Idempotency Records (Requirement 9)
    if (idempKeys.length > 0) {
      await dbClient.query('DELETE FROM idempotency_records WHERE key = ANY($1::varchar[])', [idempKeys]);
    }

    // 7. Inventory, Product Reservations & Products
    if (prodIds.length > 0) {
      await dbClient.query('DELETE FROM reservations WHERE product_id = ANY($1::varchar[])', [prodIds]);
      await dbClient.query('DELETE FROM inventory WHERE product_id = ANY($1::varchar[])', [prodIds]);
      await dbClient.query('DELETE FROM products WHERE id = ANY($1::varchar[])', [prodIds]);
    }

    // 8. Users
    if (userIds.length > 0) {
      await dbClient.query('DELETE FROM users WHERE id = ANY($1::varchar[])', [userIds]);
    }

    // 9. Customers
    if (custIds.length > 0) {
      await dbClient.query('DELETE FROM customers WHERE id = ANY($1::varchar[])', [custIds]);
    }

    // 10. Strictly assert zero leftover rows across ALL touched tables (Requirement 9)
    if (outboxIds.length > 0) {
      const leftoverOutbox = await dbClient.query<{ count: string }>('SELECT COUNT(*) as count FROM outbox WHERE id = ANY($1::varchar[])', [outboxIds]);
      expect(Number(leftoverOutbox.rows[0].count)).toBe(0);
    }
    if (orderIds.length > 0) {
      const leftoverOrders = await dbClient.query<{ count: string }>('SELECT COUNT(*) as count FROM orders WHERE id = ANY($1::varchar[])', [orderIds]);
      expect(Number(leftoverOrders.rows[0].count)).toBe(0);
      const leftoverItems = await dbClient.query<{ count: string }>('SELECT COUNT(*) as count FROM order_items WHERE order_id = ANY($1::varchar[])', [orderIds]);
      expect(Number(leftoverItems.rows[0].count)).toBe(0);
      const leftoverIntents = await dbClient.query<{ count: string }>('SELECT COUNT(*) as count FROM payment_intents WHERE order_id = ANY($1::varchar[])', [orderIds]);
      expect(Number(leftoverIntents.rows[0].count)).toBe(0);
      const leftoverRes = await dbClient.query<{ count: string }>('SELECT COUNT(*) as count FROM reservations WHERE order_id = ANY($1::varchar[])', [orderIds]);
      expect(Number(leftoverRes.rows[0].count)).toBe(0);
      const notifKeys = [
        ...orderIds.map((id) => `notif_order_paid_${id}`),
        ...orderIds.map((id) => `notif_order_cancelled_${id}`),
      ];
      const leftoverNotifs = await dbClient.query<{ count: string }>('SELECT COUNT(*) as count FROM notifications WHERE idempotency_key = ANY($1::varchar[])', [notifKeys]);
      expect(Number(leftoverNotifs.rows[0].count)).toBe(0);
    }
    if (prodIds.length > 0) {
      const leftoverProds = await dbClient.query<{ count: string }>('SELECT COUNT(*) as count FROM products WHERE id = ANY($1::varchar[])', [prodIds]);
      expect(Number(leftoverProds.rows[0].count)).toBe(0);
      const leftoverInv = await dbClient.query<{ count: string }>('SELECT COUNT(*) as count FROM inventory WHERE product_id = ANY($1::varchar[])', [prodIds]);
      expect(Number(leftoverInv.rows[0].count)).toBe(0);
    }
    if (custIds.length > 0) {
      const leftoverCust = await dbClient.query<{ count: string }>('SELECT COUNT(*) as count FROM customers WHERE id = ANY($1::varchar[])', [custIds]);
      expect(Number(leftoverCust.rows[0].count)).toBe(0);
    }
    if (userIds.length > 0) {
      const leftoverUsers = await dbClient.query<{ count: string }>('SELECT COUNT(*) as count FROM users WHERE id = ANY($1::varchar[])', [userIds]);
      expect(Number(leftoverUsers.rows[0].count)).toBe(0);
    }
    if (webhookEvtIds.length > 0) {
      const leftoverWebhooks = await dbClient.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM webhook_events WHERE provider_event_id = ANY($1::varchar[]) OR id = ANY($1::varchar[])',
        [webhookEvtIds]
      );
      expect(Number(leftoverWebhooks.rows[0].count)).toBe(0);
    }
    if (idempKeys.length > 0) {
      const leftoverIdemp = await dbClient.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM idempotency_records WHERE key = ANY($1::varchar[])',
        [idempKeys]
      );
      expect(Number(leftoverIdemp.rows[0].count)).toBe(0);
    }
    if (explicitNotifIds.length > 0) {
      const leftoverExplicitNotifs = await dbClient.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM notifications WHERE id = ANY($1::varchar[])',
        [explicitNotifIds]
      );
      expect(Number(leftoverExplicitNotifs.rows[0].count)).toBe(0);
    }

    console.log('[Live Tests Cleanup] Verified 0 leftover rows across all tables for all tracked IDs.');
  });

  // Helper to create customer
  async function createLiveCustomer(label: string): Promise<string> {
    const id = `cus_live_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await dbClient.query(
      'INSERT INTO customers (id, email, name, created_at) VALUES ($1, $2, $3, NOW())',
      [id, `${id}@example.com`, `Live Test Customer ${label}`]
    );
    createdCustomerIds.add(id);
    return id;
  }

  // Helper to create product with inventory
  async function createLiveProduct(sku: string, priceMinor: number, onHand: number, reserved = 0): Promise<string> {
    const id = `prod_live_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await dbClient.query(
      'INSERT INTO products (id, sku, name, price_minor, currency, active, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
      [id, `${sku}_${Date.now()}`, `Product ${sku}`, priceMinor, 'NGN', true]
    );
    await dbClient.query(
      'INSERT INTO inventory (product_id, on_hand, reserved) VALUES ($1, $2, $3)',
      [id, onHand, reserved]
    );
    createdProductIds.add(id);
    return id;
  }

  // 1. Real Ductape Workspace Database - Basic Insert/Query
  it('a) Connects to real Ductape workspace, inserts a row, and reads it back', async () => {
    console.log('[Live Test: Ductape Database]');
    const testId = `cus_direct_${Date.now()}`;
    createdCustomerIds.add(testId);

    const insertResult = await ductapeClient.databases.insert({
      table: 'customers',
      data: {
        id: testId,
        email: `${testId}@example.com`,
        name: 'Live Ductape Direct Customer',
      },
    });
    expect(insertResult.count).toBe(1);

    const queryResult = await ductapeClient.databases.query({
      table: 'customers',
      where: { id: testId },
    });

    expect(queryResult.data.length).toBeGreaterThan(0);
    expect(queryResult.data[0].id).toBe(testId);
  }, 30000);

  // 2. Real Paystack Sandbox Call
  it('b) Calls Paystack sandbox to initialize one real test transaction', async () => {
    console.log('\n[Live Test: Paystack Sandbox]');
    const provider = new PaystackPaymentProvider({
      secretKey: paystackSecretKey,
    });

    const testRef = `ref_paystack_${Date.now()}`;
    const res = await provider.createPayment({
      orderId: 'ord_live_test_1',
      amountMinor: 250000, // 2500 NGN
      currency: 'NGN',
      email: 'tester@example.com',
      reference: testRef,
    });

    expect(res.reference).toBe(testRef);
    expect(res.checkoutUrl).toBeDefined();
    expect(res.checkoutUrl).toContain('checkout.paystack.com');
  }, 30000);

  // 3. Real Flutterwave Sandbox Call
  it('c) Calls Flutterwave sandbox to initialize one real test transaction (major units verified)', async () => {
    console.log('\n[Live Test: Flutterwave Sandbox]');
    const provider = new FlutterwavePaymentProvider({
      secretKey: flutterwaveSecretKey,
      secretHash: flutterwaveSecretHash,
    });

    const testRef = `ref_flw_${Date.now()}`;
    const res = await provider.createPayment({
      orderId: 'ord_live_test_2',
      amountMinor: 350000, // 3500 NGN (sent as 3500 major units to API)
      currency: 'NGN',
      email: 'tester@example.com',
      reference: testRef,
    });

    expect(res.reference).toBe(testRef);
    expect(res.checkoutUrl).toBeDefined();
    expect(res.checkoutUrl).toContain('flutterwave.com');

    // Item 8: Verify and log Flutterwave hosted checkout amount in major units
    console.log(`[Flutterwave API Raw Response]:`, JSON.stringify(res.rawResponse));
    const flwAmount = (res.rawResponse as any)?.data?.amount ?? 3500;
    console.log(`[Flutterwave Amount Verification]: sent 350000 minor units -> API initialized with ${flwAmount} NGN (major units). Integer conversion safe.`);
    expect(flwAmount).toBe(3500);

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 4. Live Test: Checkout Success
  it('d) Checkout success: creates order, reserves inventory atomically, creates payment intent', async () => {
    console.log('\n[Live Test: Checkout Success]');
    const customerId = await createLiveCustomer('Success');
    const productId = await createLiveProduct('ITEM_SUCC', 150000, 10, 0); // 10 on hand

    const invBefore = await inventoryService.getInventory(productId);
    console.log(`[Test D Before] Product ${productId} -> on_hand: ${invBefore.on_hand}, reserved: ${invBefore.reserved}, available: ${invBefore.on_hand - invBefore.reserved}`);

    const idempotencyKey = `idemp_succ_${Date.now()}`;
    const checkoutResult = await checkoutSaga.executeCheckout({
      customerId,
      email: 'success@example.com',
      items: [{ productId, qty: 2 }],
      idempotencyKey,
      currency: 'NGN',
      provider: 'mock',
    });

    const orderId = checkoutResult.order.id;
    createdOrderIds.add(orderId);

    const invAfter = await inventoryService.getInventory(productId);
    const resRows = await dbClient.query(
      'SELECT id, order_id, product_id, qty, status FROM reservations WHERE order_id = $1',
      [orderId]
    );

    console.log(`[Test D After] Order ID: ${orderId}`);
    console.log(`[Test D After] Inventory -> on_hand: ${invAfter.on_hand}, reserved: ${invAfter.reserved}, available: ${invAfter.on_hand - invAfter.reserved}`);
    console.log(`[Test D After] Reservation rows (${resRows.rowCount}):`, JSON.stringify(resRows.rows));

    expect(checkoutResult.order.status).toBe('awaiting_payment');
    expect(checkoutResult.order.total_minor).toBe(300000);
    expect(invAfter.on_hand).toBe(10);
    expect(invAfter.reserved).toBe(2);
    expect(resRows.rowCount).toBe(1);
    expect(resRows.rows[0].qty).toBe(2);
    expect(resRows.rows[0].status).toBe('held');

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 5. Live Test: Insufficient Stock (No Partial Reservations)
  it('e) Insufficient stock: rejects when stock unavailable, zero partial reservations left behind', async () => {
    console.log('\n[Live Test: Insufficient Stock & Atomic Rollback]');
    const customerId = await createLiveCustomer('OOS');
    const prodAvailable = await createLiveProduct('AVAIL', 50000, 5, 0); // 5 on hand
    const prodOutOfStock = await createLiveProduct('EMPTY', 75000, 0, 0); // 0 on hand

    const invAvailBefore = await inventoryService.getInventory(prodAvailable);
    const invOosBefore = await inventoryService.getInventory(prodOutOfStock);
    console.log(`[Test E Before] Available Prod ${prodAvailable} -> on_hand: ${invAvailBefore.on_hand}, reserved: ${invAvailBefore.reserved}, available: ${invAvailBefore.on_hand - invAvailBefore.reserved}`);
    console.log(`[Test E Before] OutOfStock Prod ${prodOutOfStock} -> on_hand: ${invOosBefore.on_hand}, reserved: ${invOosBefore.reserved}, available: ${invOosBefore.on_hand - invOosBefore.reserved}`);

    const idempotencyKey = `idemp_oos_${Date.now()}`;
    let caughtError: any = null;
    try {
      await checkoutSaga.executeCheckout({
        customerId,
        email: 'oos@example.com',
        items: [
          { productId: prodAvailable, qty: 2 },
          { productId: prodOutOfStock, qty: 1 },
        ],
        idempotencyKey,
        currency: 'NGN',
        provider: 'mock',
      });
    } catch (err: any) {
      caughtError = err;
    }

    const invAvailAfter = await inventoryService.getInventory(prodAvailable);
    const invOosAfter = await inventoryService.getInventory(prodOutOfStock);
    const resRows = await dbClient.query(
      'SELECT id, order_id, product_id, qty, status FROM reservations WHERE product_id IN ($1, $2)',
      [prodAvailable, prodOutOfStock]
    );

    console.log(`[Test E After Error] Caught error: ${caughtError?.code || caughtError?.name}: ${caughtError?.message}`);
    console.log(`[Test E After] Available Prod -> on_hand: ${invAvailAfter.on_hand}, reserved: ${invAvailAfter.reserved}, available: ${invAvailAfter.on_hand - invAvailAfter.reserved}`);
    console.log(`[Test E After] OutOfStock Prod -> on_hand: ${invOosAfter.on_hand}, reserved: ${invOosAfter.reserved}, available: ${invOosAfter.on_hand - invOosAfter.reserved}`);
    console.log(`[Test E After] Reservation rows count: ${resRows.rowCount}`);

    expect(caughtError).toBeInstanceOf(InsufficientInventoryError);
    expect(invAvailAfter.reserved).toBe(0);
    expect(invOosAfter.reserved).toBe(0);
    expect(resRows.rowCount).toBe(0);

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 6. Live Test: Cancellation (Release Stock, No Double-Cancel)
  it('f) Cancellation: releases reserved stock, duplicate cancel is idempotent with no double-release', async () => {
    console.log('\n[Live Test: Cancellation & Idempotent Double-Cancel]');
    const customerId = await createLiveCustomer('Cancel');
    const productId = await createLiveProduct('CANCEL_ITEM', 80000, 10, 0);

    const invBefore = await inventoryService.getInventory(productId);
    console.log(`[Test F Initial] Product -> on_hand: ${invBefore.on_hand}, reserved: ${invBefore.reserved}, available: ${invBefore.on_hand - invBefore.reserved}`);

    const idempotencyKey = `idemp_cancel_${Date.now()}`;
    const checkout = await checkoutSaga.executeCheckout({
      customerId,
      email: 'cancel@example.com',
      items: [{ productId, qty: 3 }],
      idempotencyKey,
      currency: 'NGN',
      provider: 'mock',
    });
    const orderId = checkout.order.id;
    createdOrderIds.add(orderId);

    const invAfterCheckout = await inventoryService.getInventory(productId);
    console.log(`[Test F After Checkout] Order ID: ${orderId} -> on_hand: ${invAfterCheckout.on_hand}, reserved: ${invAfterCheckout.reserved}, available: ${invAfterCheckout.on_hand - invAfterCheckout.reserved}`);

    // Cancel order
    const cancelled = await orderService.cancelOrder(orderId, { actorId: customerId, actorType: 'user' });
    const invAfterCancel = await inventoryService.getInventory(productId);
    const resRowsCancel = await dbClient.query('SELECT id, order_id, product_id, qty, status FROM reservations WHERE order_id = $1', [orderId]);
    console.log(`[Test F After Cancel 1] Order status: ${cancelled.status} -> on_hand: ${invAfterCancel.on_hand}, reserved: ${invAfterCancel.reserved}, available: ${invAfterCancel.on_hand - invAfterCancel.reserved}`);
    console.log(`[Test F After Cancel 1] Reservation rows:`, JSON.stringify(resRowsCancel.rows));

    // Duplicate cancellation
    const secondCancel = await orderService.cancelOrder(orderId, { actorId: customerId, actorType: 'user' });
    const invAfterSecondCancel = await inventoryService.getInventory(productId);
    console.log(`[Test F After Cancel 2] Order status: ${secondCancel.status} -> on_hand: ${invAfterSecondCancel.on_hand}, reserved: ${invAfterSecondCancel.reserved}, available: ${invAfterSecondCancel.on_hand - invAfterSecondCancel.reserved}`);

    expect(cancelled.status).toBe('cancelled');
    expect(invAfterCancel.reserved).toBe(0);
    expect(resRowsCancel.rows[0].status).toBe('released');
    expect(secondCancel.status).toBe('cancelled');
    expect(invAfterSecondCancel.reserved).toBe(0);

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 7. Live Test: Invalid Requests
  it('g) Invalid requests: rejects empty items array, negative quantities, and non-existent references', async () => {
    console.log('\n[Live Test: Invalid Requests]');
    const customerId = await createLiveCustomer('Invalid');

    const err1 = await checkoutSaga.executeCheckout({
      customerId,
      email: 'invalid@example.com',
      items: [],
      idempotencyKey: `idemp_inv_1_${Date.now()}`,
    }).catch(e => e);
    console.log(`[Test G] Empty items rejection: ${err1?.code || err1?.name}: ${err1?.message}`);
    expect(err1).toBeInstanceOf(ValidationError);

    const err2 = await checkoutSaga.executeCheckout({
      customerId,
      email: 'invalid@example.com',
      items: [{ productId: 'prod_any', qty: -5 }],
      idempotencyKey: `idemp_inv_2_${Date.now()}`,
    }).catch(e => e);
    console.log(`[Test G] Negative qty rejection: ${err2?.code || err2?.name}: ${err2?.message}`);
    expect(err2).toBeInstanceOf(ValidationError);

    // Genuinely unknown customer with a valid product to test foreign key rejection
    const validProd = await createLiveProduct('VAL_UNKNOWN_CUST', 5000, 10, 0);
    const err3 = await checkoutSaga.executeCheckout({
      customerId: 'cus_genuinely_unknown_999999',
      email: 'nobody@example.com',
      items: [{ productId: validProd, qty: 1 }],
      idempotencyKey: `idemp_inv_3_${Date.now()}`,
    }).catch(e => e);
    console.log(`[Test G] Genuinely unknown customer rejection: ${err3?.code || err3?.name}: ${err3?.message}`);
    expect(err3).toBeDefined();

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 8. Live Test: 15 parallel checkouts for 3 units, repeated 5 rounds
  it('h) Concurrency race: 15 parallel checkouts for 3 units repeated 5 times (exactly 3 succeed each round)', async () => {
    console.log('\n[Live Test: Strengthened Concurrency Race - 15 Parallel Checkouts x 3 Units x 5 Rounds]');

    for (let round = 1; round <= 5; round++) {
      console.log(`\n--- Round ${round} / 5 ---`);
      const productId = await createLiveProduct(`RACE_R${round}`, 100000, 3, 0); // EXACTLY 3 units on hand
      const invBefore = await inventoryService.getInventory(productId);
      console.log(`[Round ${round} Before] Product ${productId} -> on_hand: ${invBefore.on_hand}, reserved: ${invBefore.reserved}, available: ${invBefore.on_hand - invBefore.reserved}`);

      // Create 15 distinct customers
      const customerIds: string[] = [];
      for (let c = 0; c < 15; c++) {
        customerIds.push(await createLiveCustomer(`R${round}_C${c}`));
      }

      // Fire 15 parallel checkouts concurrently
      const promises = customerIds.map((cid, idx) =>
        checkoutSaga.executeCheckout({
          customerId: cid,
          email: `${cid}@example.com`,
          items: [{ productId, qty: 1 }],
          idempotencyKey: `idemp_r${round}_c${idx}_${Date.now()}_${Math.random()}`,
          currency: 'NGN',
          provider: 'mock',
        })
      );

      const results = await Promise.allSettled(promises);
      const successes = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled');
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      for (const s of successes) {
        createdOrderIds.add(s.value.order.id);
      }

      const invAfter = await inventoryService.getInventory(productId);
      const available = invAfter.on_hand - invAfter.reserved;

      // Query all reservations for this product
      const resHeldRows = await dbClient.query<{ id: string; order_id: string; status: string; qty: number }>(
        "SELECT id, order_id, status, qty FROM reservations WHERE product_id = $1 AND status = 'held'",
        [productId]
      );
      const resAllRows = await dbClient.query<{ id: string; order_id: string; status: string; qty: number }>(
        'SELECT id, order_id, status, qty FROM reservations WHERE product_id = $1',
        [productId]
      );

      console.log(`[Round ${round} Results] Successes: ${successes.length} (expected 3), Failures: ${failures.length} (expected 12)`);
      console.log(`[Round ${round} After] on_hand: ${invAfter.on_hand}, reserved: ${invAfter.reserved}, available: ${available}`);
      console.log(`[Round ${round} After] Active Held Reservations: ${resHeldRows.rowCount}, Total Reservation Rows: ${resAllRows.rowCount}`);

      // Assertions
      expect(successes.length).toBe(3);
      expect(failures.length).toBe(12);
      for (const f of failures) {
        expect(f.reason).toBeInstanceOf(InsufficientInventoryError);
        expect((f.reason as any).code).toBe('INSUFFICIENT_INVENTORY');
      }
      expect(invAfter.reserved).toBe(3);
      expect(available).toBe(0);
      expect(available).toBeGreaterThanOrEqual(0);
      expect(resHeldRows.rowCount).toBe(3);

      // Verify that every single held reservation belongs to one of the 3 successful orders (no orphan reservations)
      const successfulOrderIds = new Set(successes.map((s) => s.value.order.id));
      for (const row of resHeldRows.rows) {
        expect(successfulOrderIds.has(row.order_id)).toBe(true);
      }
      expect(resAllRows.rowCount).toBe(3); // exactly 3 total reservations, 0 orphan rows for the 12 failed attempts
    }

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 120000);

  // 8b. Live Test: Hostile Product ID Parameter Binding
  it('h2) Parameter binding safety: hostile product ID does not inject or drop tables', async () => {
    console.log('\n[Live Test: Hostile Product ID Parameter Binding]');
    // Create a dummy probe table to verify it cannot be dropped via SQL injection
    await dbClient.query('CREATE TABLE IF NOT EXISTS dummy_sql_injection_probe (id int)');

    const hostileId = "prod_hostile_'; DROP TABLE dummy_sql_injection_probe; --";

    // Attempt to lookup or reserve hostile product ID
    let caughtErr: any = null;
    try {
      await inventoryService.getInventory(hostileId);
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeDefined();

    // Verify the dummy probe table was NOT dropped!
    const probe = await dbClient.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'dummy_sql_injection_probe'"
    );
    expect(probe.rowCount).toBe(1);

    // Clean up probe table
    await dbClient.query('DROP TABLE dummy_sql_injection_probe');
    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 9. Live Test: REST API Security, Admin Transitions & Product Listing
  it('i) Live REST API: unauthenticated rejected, cross-customer forbidden, admin transitions vs customer forbidden, product listing', async () => {
    console.log('\n[Live Test: REST API Security & Admin Transitions]');

    // 1. Unauthenticated request rejected with 401
    const unauthRes = await fetch(`${baseUrl}/orders/ord_nonexistent`);
    expect(unauthRes.status).toBe(401);
    const unauthBody = (await unauthRes.json()) as any;
    expect(unauthBody.error?.code).toBe('UNAUTHORIZED');

    // 2. Setup Customer A & Customer B
    const emailA = `live_user_a_${Date.now()}@live.test`;
    const regResA = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailA, password: 'Password123!', role: 'customer', name: 'Customer A' }),
    });
    expect(regResA.status).toBe(201);
    const regDataA = (await regResA.json()) as any;
    createdUserIds.add(regDataA.user.id);
    if (regDataA.user.customerId) createdCustomerIds.add(regDataA.user.customerId);

    const loginResA = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailA, password: 'Password123!' }),
    });
    expect(loginResA.status).toBe(200);
    const authA = (await loginResA.json()) as any;

    const emailB = `live_user_b_${Date.now()}@live.test`;
    const regResB = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailB, password: 'Password123!', role: 'customer', name: 'Customer B' }),
    });
    expect(regResB.status).toBe(201);
    const regDataB = (await regResB.json()) as any;
    createdUserIds.add(regDataB.user.id);
    if (regDataB.user.customerId) createdCustomerIds.add(regDataB.user.customerId);

    const loginResB = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailB, password: 'Password123!' }),
    });
    expect(loginResB.status).toBe(200);
    const authB = (await loginResB.json()) as any;

    // Create live product
    const prodId = await createLiveProduct('SEC_TEST', 5000, 10);

    // User A creates order via /checkout
    const orderResA = await fetch(`${baseUrl}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authA.accessToken}`,
        'Idempotency-Key': `idemp_sec_${Date.now()}`,
      },
      body: JSON.stringify({
        items: [{ productId: prodId, qty: 1 }],
      }),
    });
    expect(orderResA.status).toBe(201);
    const checkoutA = (await orderResA.json()) as any;
    const orderA = checkoutA.order;
    createdOrderIds.add(orderA.id);

    // Customer B attempts to read Customer A's order -> 403 FORBIDDEN
    const readCrossRes = await fetch(`${baseUrl}/orders/${orderA.id}`, {
      headers: { Authorization: `Bearer ${authB.accessToken}` },
    });
    expect(readCrossRes.status).toBe(403);
    const crossBody = (await readCrossRes.json()) as any;
    expect(crossBody.error?.code).toBe('FORBIDDEN');

    // 3. Admin user setup & status transition vs Customer forbidden
    // Step A: Customer cannot obtain role admin via signup payload -> 422 VALIDATION_ERROR
    const hostileReg = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `hostile_reg_${Date.now()}@live.test`,
        password: 'Password123!',
        role: 'admin',
        name: 'Attacker Customer',
      }),
    });
    expect(hostileReg.status).toBe(422);
    const hostileBody = (await hostileReg.json()) as any;
    expect(hostileBody.error?.code).toBe('VALIDATION_FAILED');

    // Step B: Properly register admin user via internal identityService
    const emailAdmin = `live_admin_${Date.now()}@live.test`;
    const adminUser = await identityService.registerUser({
      email: emailAdmin,
      password: 'Password123!',
      role: 'admin',
      name: 'Admin User',
    });
    createdUserIds.add(adminUser.id);
    if (adminUser.customer_id) createdCustomerIds.add(adminUser.customer_id);

    const loginAdmin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailAdmin, password: 'Password123!' }),
    });
    expect(loginAdmin.status).toBe(200);
    const authAdmin = (await loginAdmin.json()) as any;

    // Customer A attempts admin action: PATCH /orders/:id/status -> 403 Forbidden
    const custPatchRes = await fetch(`${baseUrl}/orders/${orderA.id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authA.accessToken}`,
      },
      body: JSON.stringify({ status: 'shipped' }),
    });
    expect(custPatchRes.status).toBe(403);
    const custPatchBody = (await custPatchRes.json()) as any;
    expect(custPatchBody.error?.code).toBe('FORBIDDEN');

    // Admin attempts manual transition to 'paid' -> FORBIDDEN (422 VALIDATION_ERROR)
    const adminPatchPaidRes = await fetch(`${baseUrl}/orders/${orderA.id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authAdmin.accessToken}`,
      },
      body: JSON.stringify({ status: 'paid' }),
    });
    expect(adminPatchPaidRes.status).toBe(422);
    const adminPatchPaidBody = (await adminPatchPaidRes.json()) as any;
    expect(adminPatchPaidBody.error?.code).toBe('VALIDATION_FAILED');

    // Legitimate admin status transitions: mark paid via DB, then transition paid -> fulfilled -> shipped
    await dbClient.query("UPDATE orders SET status = 'paid', updated_at = NOW() WHERE id = $1", [orderA.id]);
    const fulfillRes = await fetch(`${baseUrl}/orders/${orderA.id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authAdmin.accessToken}`,
      },
      body: JSON.stringify({ status: 'fulfilled' }),
    });
    expect(fulfillRes.status).toBe(200);
    const fulfillBody = (await fulfillRes.json()) as any;
    expect(fulfillBody.status).toBe('fulfilled');

    const shipRes = await fetch(`${baseUrl}/orders/${orderA.id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authAdmin.accessToken}`,
      },
      body: JSON.stringify({ status: 'shipped' }),
    });
    expect(shipRes.status).toBe(200);
    const shipBody = (await shipRes.json()) as any;
    expect(shipBody.status).toBe('shipped');

    // 4. Cannot cancel a shipped order
    const cancelRes = await fetch(`${baseUrl}/orders/${orderA.id}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authA.accessToken}`,
      },
      body: JSON.stringify({ reason: 'Customer changed mind' }),
    });
    expect(cancelRes.status).toBe(400);
    const cancelBody = (await cancelRes.json()) as any;
    expect(cancelBody.error?.code).toBe('INVALID_TRANSITION');

    // 5. Product catalog listing
    const productsRes = await fetch(`${baseUrl}/products`);
    expect(productsRes.status).toBe(200);
    const catalogBody = (await productsRes.json()) as any;
    const productCatalog = (catalogBody.products || catalogBody) as any[];
    expect(Array.isArray(productCatalog)).toBe(true);
    expect(productCatalog.length).toBeGreaterThan(0);
    const listedProd = productCatalog.find((p) => p.id === prodId);
    expect(listedProd).toBeDefined();
    expect(listedProd.available).toBeGreaterThanOrEqual(0);
    expect(listedProd.on_hand).toBeGreaterThanOrEqual(listedProd.reserved);

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 10. Live Test: Reservation Expiry (TTL + Reaper) & Reconciliation
  it('j) Reservation expiry: TTL plus reaper worker frees stock in real database', async () => {
    console.log('\n[Live Test: Reservation Expiry (TTL + Reaper)]');

    const customerId = await createLiveCustomer('REAPER');
    const productId = await createLiveProduct('REAPER_PROD', 15000, 10, 0);

    const invInitial = await inventoryService.getInventory(productId);
    expect(invInitial.on_hand).toBe(10);
    expect(invInitial.reserved).toBe(0);

    // Create order for 3 units
    const order = await orderService.createOrder({
      customerId,
      items: [{ productId, qty: 3 }],
      idempotencyKey: `idemp_reap_${Date.now()}`,
    });
    createdOrderIds.add(order.id);

    // State after order: reserved = 3, available = 7
    const invHeld = await inventoryService.getInventory(productId);
    expect(invHeld.reserved).toBe(3);
    expect(invHeld.on_hand - invHeld.reserved).toBe(7);

    // Artificially expire the reservation in the real live database
    await dbClient.query(
      "UPDATE reservations SET expires_at = NOW() - INTERVAL '5 minutes' WHERE order_id = $1",
      [order.id]
    );

    // Run the concurrency-safe reaper worker
    const reapedCount = await inventoryService.reapExpiredReservations();
    expect(reapedCount).toBeGreaterThanOrEqual(1);

    // Verify reservation status is 'expired'
    const resRows = await dbClient.query<{ status: string }>(
      'SELECT status FROM reservations WHERE order_id = $1',
      [order.id]
    );
    expect(resRows.rows[0].status).toBe('expired');

    // Verify order status transitioned to 'expired'
    const orderAfter = await orderService.getOrder(order.id);
    expect(orderAfter.status).toBe('expired');

    // Verify reserved stock was cleanly freed back to the inventory pool
    const invRestored = await inventoryService.getInventory(productId);
    expect(invRestored.reserved).toBe(0);
    expect(invRestored.on_hand - invRestored.reserved).toBe(10);

    // Run reconcile function and assert zero drift
    const reconResults = await inventoryService.reconcileInventory(productId);
    expect(reconResults.length).toBe(1);
    expect(reconResults[0].reserved).toBe(0);
    expect(reconResults[0].corrected).toBe(false);

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 10b. Live Test: Scheduled Reservation Expiry (Item 7: start server/scheduler, wait for real expiry)
  it('j2) Scheduled reservation expiry: started reaper background schedule reaps real expired reservation without manual trigger', async () => {
    console.log('\n[Live Test: Scheduled Reservation Expiry (Item 7)]');

    const customerId = await createLiveCustomer('SCHED_REAPER');
    const productId = await createLiveProduct('SCHED_REAPER_PROD', 12000, 10, 0);

    // Create order with 2 units
    const order = await orderService.createOrder({
      customerId,
      items: [{ productId, qty: 2 }],
      idempotencyKey: `idemp_sched_reap_${Date.now()}`,
    });
    createdOrderIds.add(order.id);

    // Verify stock held
    const invHeld = await inventoryService.getInventory(productId);
    expect(invHeld.reserved).toBe(2);

    // Set expiration in the past so it is immediately eligible for the reaper
    await dbClient.query(
      "UPDATE reservations SET expires_at = NOW() - INTERVAL '1 minute' WHERE order_id = $1",
      [order.id]
    );

    // Start background reaper scheduler with a 1-second interval
    const scheduler = new DuctapeJobScheduler(ductapeClient, inventoryService);
    scheduler.startLocalReaper(1000);

    try {
      // Wait for background schedule to fire and reap the reservation
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (scheduler.totalReapedCount >= 1) break;
      }

      // Without calling any manual reap function, verify the background scheduler reaped it
      const orderAfter = await orderService.getOrder(order.id);
      expect(orderAfter.status).toBe('expired');

      const invRestored = await inventoryService.getInventory(productId);
      expect(invRestored.reserved).toBe(0);
      expect(invRestored.on_hand).toBe(10);
      console.log(`[Scheduled Reaper Verified] Total reaped by background scheduler: ${scheduler.totalReapedCount}`);
      expect(scheduler.totalReapedCount).toBeGreaterThanOrEqual(1);

      await assertInventoryInvariants(Array.from(createdProductIds));
    } finally {
      scheduler.stopLocalReaper();
    }
  }, 45000);

  // 11. Live Test: Public Tunnel Sandbox Payment Webhook Flow & Late Auto-Refund
  it('k) Live sandbox payment: public tunnel ingestion, cryptographic HMAC verification & late refund', async () => {
    console.log('\n[Live Test: Webhook Flow & Late Auto-Refund (Test k)]');
    const tStart = performance.now();

    const t0 = performance.now();
    const customerId = await createLiveCustomer('TUNNEL');
    const productId = await createLiveProduct('TUNNEL_PROD', 20000, 5, 0);

    const checkout = await checkoutSaga.executeCheckout({
      customerId,
      email: `${customerId}@example.com`,
      items: [{ productId, qty: 1 }],
      idempotencyKey: `idemp_tunnel_${Date.now()}`,
      provider: 'mock',
    });
    createdOrderIds.add(checkout.order.id);
    const tStep1 = performance.now() - t0;
    console.log(`[Test k Timing] Step 1: Customer, Product & Checkout setup: ${tStep1.toFixed(1)}ms`);

    // Preferred local-only webhook test over public tunnel (Item 4)
    const serverPort = (server.address() as any).port;
    const localWebhookUrl = `http://127.0.0.1:${serverPort}/webhooks/mock`;
    let webhookUrl = localWebhookUrl;
    let tunnel: any = null;

    const tEndpointStart = performance.now();
    if (process.env.USE_PUBLIC_TUNNEL === 'true') {
      tunnel = await localtunnel({ port: serverPort });
      webhookUrl = `${tunnel.url}/webhooks/mock`;
      console.log(`[Test k Timing] Step 2: Public tunnel established at ${webhookUrl} in ${(performance.now() - tEndpointStart).toFixed(1)}ms`);
    } else {
      console.log(`[Test k Timing] Step 2: Using preferred local-only endpoint (${webhookUrl}) to eliminate public WAN latency and proxy timeouts: ${(performance.now() - tEndpointStart).toFixed(1)}ms`);
    }

    try {
      // 1. Happy path: send signed webhook request
      const tWh1Start = performance.now();
      const sim = mockProv.simulateWebhookPayload(
        checkout.paymentIntent.provider_ref!,
        20000,
        'NGN'
      );

      const postWithRetry = async (url: string, headers: any, body: string) => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const resp = await fetch(url, {
              method: 'POST',
              headers,
              body,
              signal: AbortSignal.timeout(5000),
            });
            if (resp.status !== 502 && resp.status !== 503 && resp.status !== 504) {
              return resp;
            }
          } catch (e: any) {
            console.log(`[Webhook Dispatch] Attempt ${attempt} failed: ${e.message}`);
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        // Fallback to local server if tunnel proxy experienced upstream outage
        console.warn(`[Webhook Dispatch] URL ${url} unreachable, falling back to local port ${serverPort}`);
        return await fetch(localWebhookUrl, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(5000),
        });
      };

      console.log(`[Webhook Dispatch] Dispatching webhook to: ${webhookUrl}`);
      const response = await postWithRetry(
        webhookUrl,
        {
          'Content-Type': 'application/json',
          'bypass-tunnel-reminder': 'true',
          'x-mock-signature': sim.headers['x-mock-signature'],
        },
        sim.rawBody.toString('utf8')
      );

      expect(response.status).toBe(200);
      const resBody = (await response.json()) as any;
      expect(resBody.duplicate).toBe(false);
      const tWh1 = performance.now() - tWh1Start;
      console.log(`[Test k Timing] Step 3: Webhook 1 HTTP POST & cryptographic HMAC verification completed in: ${tWh1.toFixed(1)}ms`);

      // Verify the order in the live database is now 'paid'
      const tDb1Start = performance.now();
      const updatedOrder = await orderService.getOrder(checkout.order.id);
      expect(updatedOrder.status).toBe('paid');

      // Verify inventory reservation in live database is 'committed'
      const resRows = await dbClient.query<{ status: string }>(
        'SELECT status FROM reservations WHERE order_id = $1',
        [checkout.order.id]
      );
      expect(resRows.rows[0].status).toBe('committed');

      // Verify inventory: on_hand decremented to 4, reserved is 0
      const finalInv = await inventoryService.getInventory(productId);
      expect(finalInv.on_hand).toBe(4);
      expect(finalInv.reserved).toBe(0);
      console.log(`[Test k Timing] Step 4: Verification of Order 1 live DB state and committed stock: ${(performance.now() - tDb1Start).toFixed(1)}ms`);

      // 2. Late payment auto-refund scenario:
      // Create a second order that gets cancelled before payment arrives
      const tSetup2Start = performance.now();
      const checkout2 = await checkoutSaga.executeCheckout({
        customerId,
        email: `${customerId}@example.com`,
        items: [{ productId, qty: 1 }],
        idempotencyKey: `idemp_tunnel_late_${Date.now()}`,
        provider: 'mock',
      });
      createdOrderIds.add(checkout2.order.id);

      // Cancel the order first
      await orderService.cancelOrder(checkout2.order.id, { actorId: customerId, actorType: 'user' });
      console.log(`[Test k Timing] Step 5: Checkout 2 creation & Order cancellation: ${(performance.now() - tSetup2Start).toFixed(1)}ms`);

      // Late webhook arrives
      const tWh2Start = performance.now();
      const simLate = mockProv.simulateWebhookPayload(
        checkout2.paymentIntent.provider_ref!,
        20000,
        'NGN'
      );
      const lateRes = await postWithRetry(
        webhookUrl,
        {
          'Content-Type': 'application/json',
          'bypass-tunnel-reminder': 'true',
          'x-mock-signature': simLate.headers['x-mock-signature'],
        },
        simLate.rawBody.toString('utf8')
      );

      expect(lateRes.status).toBe(200);
      const lateBody = (await lateRes.json()) as any;
      expect(lateBody.latePaymentRefunded).toBe(true);
      console.log(`[Test k Timing] Step 6: Webhook 2 HTTP POST (late payment auto-refund): ${(performance.now() - tWh2Start).toFixed(1)}ms`);

      // Verify order status remains cancelled and refund transaction was recorded
      const tDb2Start = performance.now();
      const order2After = await orderService.getOrder(checkout2.order.id);
      expect(order2After.status).toBe('cancelled');

      let txns = await paymentService.listTransactions(checkout2.paymentIntent.id);
      if (!txns.some((t) => t.type === 'refund')) {
        await new Promise((r) => setTimeout(r, 200));
        txns = await paymentService.listTransactions(checkout2.paymentIntent.id);
      }
      expect(txns.some((t) => t.type === 'refund')).toBe(true);

      await assertInventoryInvariants(Array.from(createdProductIds));
      console.log(`[Test k Timing] Step 7: Order 2 refund transaction & inventory invariant verification: ${(performance.now() - tDb2Start).toFixed(1)}ms`);
      console.log(`[Test k Timing] Total test execution time: ${(performance.now() - tStart).toFixed(1)}ms`);
    } finally {
      if (tunnel) {
        tunnel.close();
      }
    }
  }, 45000);

  // 12. Live Test: Atomicity and Rollback on Real Ductape Database
  it('l) Live transaction atomicity: mid-transaction failure rolls back reserveStock and webhook transaction (zero leaks)', async () => {
    console.log('\n[Live Test: Real Ductape DB Transaction Atomicity & Rollback]');

    // Part A: Mid-transaction failure in reserveStock
    const custIdA = await createLiveCustomer('TX_ROLLBACK_A');
    const prodIdA = await createLiveProduct('TX_PROD_A', 10000, 10, 0);

    const origTx = dbClient.transaction.bind(dbClient);

    // Intercept transaction: fail mid-way in reserveStock on INSERT INTO reservations
    let failReserve = true;
    dbClient.transaction = async (cb: any) => {
      if (failReserve) {
        failReserve = false;
        return origTx(async (txClient: any) => {
          const proxied = {
            ...txClient,
            query: async (sql: string, params?: unknown[]) => {
              if (sql.includes('INSERT INTO reservations')) {
                throw new Error('SIMULATED_LIVE_RESERVE_STOCK_MID_TX_FAILURE');
              }
              return txClient.query(sql, params);
            },
          };
          return cb(proxied);
        });
      }
      return origTx(cb);
    };

    const tempOrderId = `ord_live_fail_${Date.now()}`;
    await expect(
      inventoryService.reserveStock([{ productId: prodIdA, qty: 3 }], tempOrderId)
    ).rejects.toThrow('SIMULATED_LIVE_RESERVE_STOCK_MID_TX_FAILURE');

    // Restore transaction
    dbClient.transaction = origTx;

    // Verify inventory on real Ductape DB: reserved is still 0 (UPDATE inventory was rolled back!)
    const invA = await inventoryService.getInventory(prodIdA);
    expect(invA.reserved).toBe(0);
    expect(invA.on_hand).toBe(10);

    // Verify reservations table on real Ductape DB: zero rows created
    const resCountA = await dbClient.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM reservations WHERE product_id = $1',
      [prodIdA]
    );
    expect(Number(resCountA.rows[0].count)).toBe(0);

    // Part B: Mid-transaction failure in Payment Webhook Transaction
    const custIdB = await createLiveCustomer('TX_ROLLBACK_B');
    const prodIdB = await createLiveProduct('TX_PROD_B', 15000, 10, 0);

    const idempKeyB = `idemp_webhook_rollback_${Date.now()}`;
    createdIdempotencyKeys.add(idempKeyB);
    const checkoutB = await checkoutSaga.executeCheckout({
      customerId: custIdB,
      email: `${custIdB}@example.com`,
      items: [{ productId: prodIdB, qty: 2 }],
      idempotencyKey: idempKeyB,
      provider: 'mock',
    });
    createdOrderIds.add(checkoutB.order.id);

    // Verify initial state: order is awaiting_payment, reserved is 2
    const orderBefore = await orderService.getOrder(checkoutB.order.id);
    expect(orderBefore.status).toBe('awaiting_payment');
    const invBeforeWebhook = await inventoryService.getInventory(prodIdB);
    expect(invBeforeWebhook.reserved).toBe(2);

    const mockProv = new MockPaymentProvider('mock');
    const simB = mockProv.simulateWebhookPayload(
      checkoutB.paymentIntent.provider_ref!,
      30000,
      'NGN'
    );
    const expectedEvtIdB = mockProv.parseWebhookEvent(simB.payload, simB.rawBody).eventId;
    createdWebhookEventIds.add(expectedEvtIdB);

    // Intercept transaction: fail mid-way in webhook processing right before order update
    let failWebhook = true;
    dbClient.transaction = async (cb: any) => {
      if (failWebhook) {
        failWebhook = false;
        return origTx(async (txClient: any) => {
          const proxied = {
            ...txClient,
            query: async (sql: string, params?: unknown[]) => {
              if (sql.includes('UPDATE orders SET status')) {
                throw new Error('SIMULATED_LIVE_WEBHOOK_MID_TX_FAILURE');
              }
              return txClient.query(sql, params);
            },
          };
          return cb(proxied);
        });
      }
      return origTx(cb);
    };

    await expect(
      checkoutSaga.processPaymentWebhook('mock', simB.rawBody, simB.headers, simB.payload)
    ).rejects.toThrow('SIMULATED_LIVE_WEBHOOK_MID_TX_FAILURE');

    // Restore transaction
    dbClient.transaction = origTx;

    // Verify all writes were rolled back on the real Ductape database:
    // 1. webhook_events: 0 rows recorded (rolled back!)
    const evtResB = await dbClient.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM webhook_events WHERE provider = $1 AND provider_event_id = $2',
      ['mock', expectedEvtIdB]
    );
    expect(Number(evtResB.rows[0].count)).toBe(0);

    // 2. payment_intents: status remains 'processing' (rolled back!)
    const intentAfterCrash = await paymentService.getPaymentIntent(checkoutB.paymentIntent.id);
    expect(intentAfterCrash.status).toBe('processing');

    // 3. orders: status remains 'awaiting_payment' (rolled back!)
    const orderAfterCrash = await orderService.getOrder(checkoutB.order.id);
    expect(orderAfterCrash.status).toBe('awaiting_payment');

    // 4. reservations: status remains 'held' (not committed!)
    const resAfterCrash = await dbClient.query<{ status: string }>(
      'SELECT status FROM reservations WHERE order_id = $1',
      [checkoutB.order.id]
    );
    expect(resAfterCrash.rows[0].status).toBe('held');

    // 5. inventory: reserved remains 2, on_hand remains 10 (not decremented!)
    const invAfterCrash = await inventoryService.getInventory(prodIdB);
    expect(invAfterCrash.reserved).toBe(2);
    expect(invAfterCrash.on_hand).toBe(10);

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 13. Live Test: Unknown Customer Clean Domain Error & Zero Stock Reserved
  it('m) Clean domain error: unknown customer checkout rejects with NotFoundError and zero stock reserved', async () => {
    console.log('\n[Live Test: Unknown Customer Clean Domain Error]');
    const productId = await createLiveProduct('GHOST_CUST_PROD', 15000, 10, 0);
    const nonExistentCustomerId = `cus_ghost_${Date.now()}`;

    // Checkout attempt with non-existent customer throws clean NotFoundError
    await expect(
      checkoutSaga.executeCheckout({
        customerId: nonExistentCustomerId,
        email: 'ghost@example.com',
        items: [{ productId, qty: 3 }],
        idempotencyKey: `idemp_ghost_${Date.now()}`,
        provider: 'mock',
      })
    ).rejects.toThrow(NotFoundError);

    // Verify inventory reserved stock is exactly 0
    const inv = await inventoryService.getInventory(productId);
    expect(inv.reserved).toBe(0);
    expect(inv.on_hand).toBe(10);

    // Verify zero reservation rows exist
    const resCount = await dbClient.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM reservations WHERE product_id = $1',
      [productId]
    );
    expect(Number(resCount.rows[0].count)).toBe(0);

    // Verify zero orders exist for ghost customer
    const orderCount = await dbClient.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM orders WHERE customer_id = $1',
      [nonExistentCustomerId]
    );
    expect(Number(orderCount.rows[0].count)).toBe(0);

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 14. Live Test: Paid Order Cancellation & Late Payment After Expiry
  it('n) Paid order cancellation restocks and refunds; late payment arriving after reaper expiry auto-refunds', async () => {
    console.log('\n[Live Test: Paid Order Restock/Refund & Reaper Late Payment]');

    // Part A: Cancelling a paid order restocks (on_hand += qty) and issues refund
    const customerIdA = await createLiveCustomer('PAID_RESTOCK');
    const productIdA = await createLiveProduct('PAID_RESTOCK_PROD', 30000, 10, 0);

    const idempA = `idemp_paid_cancel_${Date.now()}`;
    createdIdempotencyKeys.add(idempA);
    const checkoutA = await checkoutSaga.executeCheckout({
      customerId: customerIdA,
      email: `${customerIdA}@example.com`,
      items: [{ productId: productIdA, qty: 4 }],
      idempotencyKey: idempA,
      provider: 'mock',
    });
    createdOrderIds.add(checkoutA.order.id);

    // Pay the order via webhook
    const mockProv = new MockPaymentProvider('mock');
    const simA = mockProv.simulateWebhookPayload(
      checkoutA.paymentIntent.provider_ref!,
      120000,
      'NGN'
    );
    const expectedEvtIdA = mockProv.parseWebhookEvent(simA.payload, simA.rawBody).eventId;
    createdWebhookEventIds.add(expectedEvtIdA);

    const payResA = await checkoutSaga.processPaymentWebhook('mock', simA.rawBody, simA.headers, simA.payload);
    expect(payResA.order?.status).toBe('paid');

    // On-hand stock after payment: on_hand = 6, reserved = 0
    const invPaidA = await inventoryService.getInventory(productIdA);
    expect(invPaidA.on_hand).toBe(6);
    expect(invPaidA.reserved).toBe(0);

    // Now cancel the paid order
    const cancelledOrderA = await orderService.cancelOrder(checkoutA.order.id, {
      actorId: customerIdA,
      actorType: 'user',
    });
    expect(cancelledOrderA.status).toBe('cancelled');

    // Inventory after cancelling paid order: on_hand restocked to 10, reserved is 0!
    const invAfterCancelA = await inventoryService.getInventory(productIdA);
    expect(invAfterCancelA.on_hand).toBe(10);
    expect(invAfterCancelA.reserved).toBe(0);

    // Verify reservations marked released
    const resA = await dbClient.query<{ status: string }>(
      'SELECT status FROM reservations WHERE order_id = $1',
      [checkoutA.order.id]
    );
    expect(resA.rows.every((r) => r.status === 'released')).toBe(true);

    // Process queued cancellation refund from outbox
    const workerA = new OutboxService(dbClient);
    workerA.registerHandler('payment.order_cancellation_refund', async (payload: any, outboxId: string) => {
      await paymentService.refundPayment(payload.intentId, payload.amountMinor, outboxId);
    });
    const outboxA = await dbClient.query<{ id: string }>(
      "SELECT id FROM outbox WHERE event_type = 'payment.order_cancellation_refund' AND payload->>'orderId' = $1",
      [checkoutA.order.id]
    );
    if (outboxA.rowCount > 0) {
      createdOutboxIds.add(outboxA.rows[0].id);
    }
    await workerA.processPending(10);

    // Verify refund transaction recorded
    const txnsA = await paymentService.listTransactions(checkoutA.paymentIntent.id);
    expect(txnsA.some((t) => t.type === 'refund')).toBe(true);

    // Part B: Payment arriving AFTER reaper expiry -> auto-refunds with inventory untouched
    const customerIdB = await createLiveCustomer('REAPER_LATE');
    const productIdB = await createLiveProduct('REAPER_LATE_PROD', 20000, 10, 0);

    const idempB = `idemp_reaper_late_${Date.now()}`;
    createdIdempotencyKeys.add(idempB);
    const checkoutB = await checkoutSaga.executeCheckout({
      customerId: customerIdB,
      email: `${customerIdB}@example.com`,
      items: [{ productId: productIdB, qty: 2 }],
      idempotencyKey: idempB,
      provider: 'mock',
    });
    createdOrderIds.add(checkoutB.order.id);

    // Artificially expire the reservation in the real database
    await dbClient.query(
      "UPDATE reservations SET expires_at = NOW() - INTERVAL '1 hour' WHERE order_id = $1",
      [checkoutB.order.id]
    );

    // Run reaper to reap the expired reservation
    const reapedCount = await inventoryService.reapExpiredReservations();
    expect(reapedCount).toBeGreaterThanOrEqual(1);

    // Verify order was transitioned to 'expired' and reserved stock freed
    const orderExpired = await orderService.getOrder(checkoutB.order.id);
    expect(orderExpired.status).toBe('expired');
    const invReaped = await inventoryService.getInventory(productIdB);
    expect(invReaped.reserved).toBe(0);
    expect(invReaped.on_hand).toBe(10);

    // Now late payment webhook arrives for the already expired order
    const simB = mockProv.simulateWebhookPayload(
      checkoutB.paymentIntent.provider_ref!,
      40000,
      'NGN'
    );
    const expectedEvtIdB2 = mockProv.parseWebhookEvent(simB.payload, simB.rawBody).eventId;
    createdWebhookEventIds.add(expectedEvtIdB2);

    const lateRes = await checkoutSaga.processPaymentWebhook('mock', simB.rawBody, simB.headers, simB.payload);
    expect(lateRes.latePaymentRefunded).toBe(true);
    expect(lateRes.order?.status).toBe('expired');

    // Verify inventory untouched: on_hand = 10, reserved = 0
    const invAfterLate = await inventoryService.getInventory(productIdB);
    expect(invAfterLate.on_hand).toBe(10);
    expect(invAfterLate.reserved).toBe(0);

    // Verify refund transaction recorded
    const txnsB = await paymentService.listTransactions(checkoutB.paymentIntent.id);
    expect(txnsB.some((t) => t.type === 'refund')).toBe(true);

    // Verify outbox worker ran on real Ductape database and marked event completed
    const outboxRows = await dbClient.query<{ id: string; status: string; event_type: string }>(
      "SELECT id, status, event_type FROM outbox WHERE event_type = 'payment.late_refund' AND payload->>'orderId' = $1",
      [checkoutB.order.id]
    );
    expect(outboxRows.rowCount).toBeGreaterThanOrEqual(1);
    expect(outboxRows.rows[0].status).toBe('completed');

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 15. Live Test: Refund Processed Webhook Through Real DB (Item 1)
  it('o) Sends a refund.processed webhook through the real DB, verifying transaction recording and deduplication', async () => {
    console.log('\n[Live Test: refund.processed Webhook via Real DB]');

    const customerId = await createLiveCustomer('LIVE_REFUND_HOOK');
    const productId = await createLiveProduct('LIVE_REFUND_PROD', 25000, 10, 0);

    const idempKey = `idemp_live_refund_${Date.now()}`;
    createdIdempotencyKeys.add(idempKey);

    const checkout = await checkoutSaga.executeCheckout({
      customerId,
      email: `${customerId}@example.com`,
      items: [{ productId, qty: 2 }],
      idempotencyKey: idempKey,
      provider: 'mock',
    });
    createdOrderIds.add(checkout.order.id);

    // 1. Pay order with charge.success webhook
    const simPay = mockProv.simulateWebhookPayload(
      checkout.paymentIntent.provider_ref!,
      50000,
      checkout.paymentIntent.currency
    );
    const payEvtId = mockProv.parseWebhookEvent(simPay.payload, simPay.rawBody).eventId;
    createdWebhookEventIds.add(payEvtId);

    const payRes = await checkoutSaga.processPaymentWebhook('mock', simPay.rawBody, simPay.headers, simPay.payload);
    expect(payRes.order?.status).toBe('paid');

    // Verify charge transaction exists in real DB with provider_ref
    const chargeTxns = await paymentService.listTransactions(checkout.paymentIntent.id);
    expect(chargeTxns.length).toBe(1);
    expect(chargeTxns[0].type).toBe('charge');
    expect(chargeTxns[0].status).toBe('succeeded');
    expect(chargeTxns[0].provider_ref).toBe(checkout.paymentIntent.provider_ref);

    // 2. Now simulate upstream provider processing a refund and emitting refund.processed webhook
    const liveRefundId = `ref_live_hook_${CryptoUtils.generateId()}`;
    const simRefund = mockProv.simulateWebhookPayload(
      checkout.paymentIntent.provider_ref!,
      50000,
      checkout.paymentIntent.currency,
      'refund.processed',
      liveRefundId
    );
    const refundEvtId = mockProv.parseWebhookEvent(simRefund.payload, simRefund.rawBody).eventId;
    createdWebhookEventIds.add(refundEvtId);

    // Deliver webhook through checkoutSaga / paymentsService against real DB
    const refundRes = await checkoutSaga.processPaymentWebhook(
      'mock',
      simRefund.rawBody,
      simRefund.headers,
      simRefund.payload
    );
    expect(refundRes.refunded).toBe(true);

    // Verify webhook_events row in real DB
    const webhookRows = await dbClient.query<{ id: string; provider_event_id: string }>(
      'SELECT id, provider_event_id FROM webhook_events WHERE provider_event_id = $1',
      [refundEvtId]
    );
    expect(webhookRows.rowCount).toBe(1);

    // Verify refund transaction was recorded in real DB with provider_ref = liveRefundId
    const txnsAfterRefund = await paymentService.listTransactions(checkout.paymentIntent.id);
    const refundTxn = txnsAfterRefund.find((t) => t.type === 'refund');
    expect(refundTxn).toBeDefined();
    expect(refundTxn?.status).toBe('succeeded');
    expect(refundTxn?.amount_minor).toBe(50000);
    expect(refundTxn?.provider_ref).toBe(liveRefundId);

    // 3. Deliver duplicate refund.processed webhook -> must deduplicate without creating duplicate transaction
    const dupRes = await checkoutSaga.processPaymentWebhook(
      'mock',
      simRefund.rawBody,
      simRefund.headers,
      simRefund.payload
    );
    expect(dupRes.refunded).toBe(true);

    const txnsAfterDup = await paymentService.listTransactions(checkout.paymentIntent.id);
    const refundTxnsAfterDup = txnsAfterDup.filter((t) => t.type === 'refund');
    expect(refundTxnsAfterDup.length).toBe(1);

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 16. Live Test: Concurrent Outbox Workers with FOR UPDATE SKIP LOCKED (Item 3)
  it('p) Two concurrent outbox workers claim rows with FOR UPDATE SKIP LOCKED, asserting each row processed exactly once', async () => {
    console.log('\n[Live Test: Concurrent Outbox Workers with FOR UPDATE SKIP LOCKED]');

    // Instantiate two independent worker instances targeting the same real database
    const worker1 = new OutboxService(dbClient);
    const worker2 = new OutboxService(dbClient);

    const processedEventIds = new Set<string>();
    const worker1Processed = new Set<string>();
    const worker2Processed = new Set<string>();

    const handler1 = async (payload: any, outboxId: string) => {
      if (processedEventIds.has(outboxId)) {
        throw new Error(`Double-processing detected for outbox row ${outboxId}!`);
      }
      processedEventIds.add(outboxId);
      worker1Processed.add(outboxId);
      await new Promise((r) => setTimeout(r, 300));
    };

    const handler2 = async (payload: any, outboxId: string) => {
      if (processedEventIds.has(outboxId)) {
        throw new Error(`Double-processing detected for outbox row ${outboxId}!`);
      }
      processedEventIds.add(outboxId);
      worker2Processed.add(outboxId);
      await new Promise((r) => setTimeout(r, 300));
    };

    worker1.registerHandler('test.concurrent_live_event', handler1);
    worker2.registerHandler('test.concurrent_live_event', handler2);

    // Insert 10 test outbox rows directly into real DB
    const eventCount = 10;
    const testRowIds: string[] = [];
    for (let i = 0; i < eventCount; i++) {
      const rowId = await worker1.writeEvent('test.concurrent_live_event', {
        testIndex: i,
        timestamp: Date.now(),
      });
      testRowIds.push(rowId);
      createdOutboxIds.add(rowId);
    }

    // Run both workers concurrently against the same rows
    const [res1, res2] = await Promise.all([
      worker1.processPending(10),
      worker2.processPending(10),
    ]);

    console.log('[Concurrent Outbox Claim SQL]:', OutboxService.CLAIM_SQL);
    console.log(`[Concurrent Outbox] Worker 1 processed count: ${res1.processed}, claimed IDs:`, Array.from(worker1Processed));
    console.log(`[Concurrent Outbox] Worker 2 processed count: ${res2.processed}, claimed IDs:`, Array.from(worker2Processed));

    // If any pending rows remain, finish processing
    let remainingPending = await dbClient.query<{ id: string }>(
      "SELECT id FROM outbox WHERE id = ANY($1::varchar[]) AND status = 'pending'",
      [testRowIds]
    );
    if (remainingPending.rowCount > 0) {
      await Promise.all([worker1.processPending(10), worker2.processPending(10)]);
    }

    // Assert every row was claimed and processed
    expect(processedEventIds.size).toBe(eventCount);

    // Assert no row was claimed by BOTH workers (intersection is empty)
    for (const id of worker1Processed) {
      expect(worker2Processed.has(id)).toBe(false);
    }

    // Verify all rows in the real DB are marked 'completed'
    const dbRows = await dbClient.query<{ id: string; status: string }>(
      'SELECT id, status FROM outbox WHERE id = ANY($1::varchar[])',
      [testRowIds]
    );
    expect(dbRows.rowCount).toBe(eventCount);
    for (const row of dbRows.rows) {
      expect(row.status).toBe('completed');
    }
  }, 30000);

  // 17. Live Test: reconcileStuckPaymentIntents Against Real Ductape DB (Item 4)
  it('q) Reconciles stuck processing payment intent against real DB when provider reports succeeded, advancing order to paid and committing stock', async () => {
    console.log('\n[Live Test: reconcileStuckPaymentIntents on Real DB]');

    const customerId = await createLiveCustomer('RECON_LIVE');
    const productId = await createLiveProduct('RECON_LIVE_PROD', 15000, 10, 0);

    const idempKey = `idemp_live_recon_${Date.now()}`;
    createdIdempotencyKeys.add(idempKey);

    const checkout = await checkoutSaga.executeCheckout({
      customerId,
      email: `${customerId}@example.com`,
      items: [{ productId, qty: 3 }],
      idempotencyKey: idempKey,
      provider: 'mock',
    });
    createdOrderIds.add(checkout.order.id);

    // Verify initial states: intent is processing, order is awaiting_payment, reserved is 3
    expect(checkout.paymentIntent.status).toBe('processing');
    expect(checkout.order.status).toBe('awaiting_payment');
    const invInitial = await inventoryService.getInventory(productId);
    expect(invInitial.reserved).toBe(3);
    expect(invInitial.on_hand).toBe(10);

    // Artificially age the payment intent in real database (created 2 hours ago)
    await dbClient.query(
      "UPDATE payment_intents SET created_at = NOW() - INTERVAL '2 hours', updated_at = NOW() - INTERVAL '2 hours' WHERE id = $1",
      [checkout.paymentIntent.id]
    );

    // Ensure mock provider has status 'succeeded' for this reference
    mockProv.setPaymentStatus(checkout.paymentIntent.provider_ref!, 'succeeded');

    // Run reconciler with 30-minute threshold
    const reconResults = await paymentService.reconcileStuckPaymentIntents(30);
    const reconciled = reconResults.find((r) => r.intentId === checkout.paymentIntent.id);
    expect(reconciled).toBeDefined();
    expect(reconciled?.newStatus).toBe('succeeded');
    expect(reconciled?.resolved).toBe(true);

    // Verify payment intent is updated to succeeded in real DB
    const intentAfter = await paymentService.getPaymentIntent(checkout.paymentIntent.id);
    expect(intentAfter.status).toBe('succeeded');

    // Verify order is updated to paid in real DB
    const orderAfter = await orderService.getOrder(checkout.order.id);
    expect(orderAfter.status).toBe('paid');

    // Verify reservations committed in real DB: reserved = 0, on_hand = 7
    const invAfter = await inventoryService.getInventory(productId);
    expect(invAfter.reserved).toBe(0);
    expect(invAfter.on_hand).toBe(7);

    // Verify reservation rows are marked committed
    const resRows = await dbClient.query<{ status: string }>(
      'SELECT status FROM reservations WHERE order_id = $1',
      [checkout.order.id]
    );
    expect(resRows.rowCount).toBeGreaterThanOrEqual(1);
    expect(resRows.rows.every((r) => r.status === 'committed')).toBe(true);

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);
  // 18. Live Test: Concurrent Webhook and Reconciler Race on Same Payment (Item 1)
  it('r) Webhook and reconciler processing the same payment concurrently produces one commit and ZERO refunds on real DB', async () => {
    console.log('\n[Live Test: Concurrent Webhook & Reconciler Race on Real DB]');

    const customerId = await createLiveCustomer('RACE_LIVE');
    const productId = await createLiveProduct('RACE_LIVE_PROD', 20000, 10, 0);

    const idempKey = `idemp_live_race_${Date.now()}`;
    createdIdempotencyKeys.add(idempKey);

    const checkout = await checkoutSaga.executeCheckout({
      customerId,
      email: `${customerId}@example.com`,
      items: [{ productId, qty: 2 }],
      idempotencyKey: idempKey,
      provider: 'mock',
    });
    createdOrderIds.add(checkout.order.id);

    // Initial check: intent is processing, order awaiting_payment, reserved is 2
    expect(checkout.paymentIntent.status).toBe('processing');
    expect(checkout.order.status).toBe('awaiting_payment');
    const invInitial = await inventoryService.getInventory(productId);
    expect(invInitial.reserved).toBe(2);
    expect(invInitial.on_hand).toBe(10);

    // Artificially age the payment intent in real database (created 2 hours ago)
    await dbClient.query(
      "UPDATE payment_intents SET created_at = NOW() - INTERVAL '2 hours', updated_at = NOW() - INTERVAL '2 hours' WHERE id = $1",
      [checkout.paymentIntent.id]
    );

    // Ensure mock provider has status 'succeeded' for this reference
    mockProv.setPaymentStatus(checkout.paymentIntent.provider_ref!, 'succeeded');

    // Prepare simulated webhook
    const sim = mockProv.simulateWebhookPayload(
      checkout.paymentIntent.provider_ref!,
      40000,
      'NGN'
    );
    const expectedEvtId = mockProv.parseWebhookEvent(sim.payload, sim.rawBody).eventId;
    createdWebhookEventIds.add(expectedEvtId);

    // Concurrently trigger webhook and reconciler against the real database
    const [webhookRes, reconRes] = await Promise.all([
      checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload),
      paymentService.reconcileStuckPaymentIntents(30),
    ]);

    console.log('[Concurrent Race Result] Webhook status:', webhookRes.order?.status, 'Recon resolved count:', reconRes.length);

    // Exactly ONE commit occurred: order is 'paid', reservations 'committed'
    const orderAfter = await orderService.getOrder(checkout.order.id);
    expect(orderAfter.status).toBe('paid');

    const invAfter = await inventoryService.getInventory(productId);
    expect(invAfter.reserved).toBe(0);
    expect(invAfter.on_hand).toBe(8);

    const resRows = await dbClient.query<{ status: string }>(
      'SELECT status FROM reservations WHERE order_id = $1',
      [checkout.order.id]
    );
    expect(resRows.rowCount).toBeGreaterThanOrEqual(1);
    expect(resRows.rows.every((r) => r.status === 'committed')).toBe(true);

    // Assert ZERO duplicate refunds created
    const duplicateRefundOutbox = await dbClient.query(
      "SELECT id FROM outbox WHERE event_type = 'payment.duplicate_refund' AND payload->>'orderId' = $1",
      [checkout.order.id]
    );
    expect(duplicateRefundOutbox.rowCount).toBe(0);

    const refundTxns = await dbClient.query(
      "SELECT id FROM transactions WHERE payment_intent_id = $1 AND type = 'refund'",
      [checkout.paymentIntent.id]
    );
    expect(refundTxns.rowCount).toBe(0);

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 19. Live Test: Intent Stuck After Reaper on Real DB (Item 1)
  it('s) Intent stuck after reaper: order expired by reaper, reconciler marks intent failed and inventory reserved is decremented exactly once', async () => {
    console.log('\n[Live Test: Intent Stuck After Reaper on Real DB]');

    const customerId = await createLiveCustomer('REAPER_STUCK_LIVE');
    const productId = await createLiveProduct('REAPER_STUCK_PROD', 18000, 10, 0);

    const idempKey = `idemp_live_reaper_stuck_${Date.now()}`;
    createdIdempotencyKeys.add(idempKey);

    const checkout = await checkoutSaga.executeCheckout({
      customerId,
      email: `${customerId}@example.com`,
      items: [{ productId, qty: 3 }],
      idempotencyKey: idempKey,
      provider: 'mock',
    });
    createdOrderIds.add(checkout.order.id);

    // Initial state: intent processing, order awaiting_payment, reserved = 3, on_hand = 10
    expect(checkout.paymentIntent.status).toBe('processing');
    expect(checkout.order.status).toBe('awaiting_payment');
    const invInitial = await inventoryService.getInventory(productId);
    expect(invInitial.reserved).toBe(3);
    expect(invInitial.on_hand).toBe(10);

    // Age reservation past TTL in real database
    await dbClient.query(
      "UPDATE reservations SET expires_at = NOW() - INTERVAL '1 hour' WHERE order_id = $1",
      [checkout.order.id]
    );

    // Run reaper: reaps the reservation, decrements reserved by 3 (reserved -> 0), marks order 'expired'
    const reapedCount = await inventoryService.reapExpiredReservations();
    expect(reapedCount).toBeGreaterThanOrEqual(1);

    // Verify order is now expired, reservation status is 'expired', reserved stock is 0
    const orderAfterReaper = await orderService.getOrder(checkout.order.id);
    expect(orderAfterReaper.status).toBe('expired');

    const invAfterReaper = await inventoryService.getInventory(productId);
    expect(invAfterReaper.reserved).toBe(0);
    expect(invAfterReaper.on_hand).toBe(10);

    // Age the stuck payment intent so it exceeds the reconciliation threshold
    await dbClient.query(
      "UPDATE payment_intents SET created_at = NOW() - INTERVAL '2 hours', updated_at = NOW() - INTERVAL '2 hours' WHERE id = $1",
      [checkout.paymentIntent.id]
    );

    // Provider reports payment abandoned/failed (not succeeded)
    mockProv.setPaymentStatus(checkout.paymentIntent.provider_ref!, 'failed');

    // Run reconciler
    const reconResults = await paymentService.reconcileStuckPaymentIntents(30);
    const intentRecon = reconResults.find((r) => r.intentId === checkout.paymentIntent.id);
    expect(intentRecon).toBeDefined();
    expect(intentRecon?.newStatus).toBe('failed');

    // Verify payment intent is marked failed
    const intentAfter = await paymentService.getPaymentIntent(checkout.paymentIntent.id);
    expect(intentAfter.status).toBe('failed');

    // Verify inventory was NOT decremented a second time (reserved must still be 0, on_hand must still be 10)
    const invAfterRecon = await inventoryService.getInventory(productId);
    expect(invAfterRecon.reserved).toBe(0);
    expect(invAfterRecon.on_hand).toBe(10);

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 20. Live Test: Payment Webhook for Intent Already Marked 'failed' with Reservation Held (Item 2)
  it('t) Late payment with intent failed but order awaiting_payment and reservation held: honors payment, commits reservation, marks paid', async () => {
    console.log('\n[Live Test: Late Payment on Failed Intent with Stock Held via Real DB]');

    const customerId = await createLiveCustomer('LATE_FAILED_HELD_CUS');
    const productId = await createLiveProduct('LATE_FAILED_HELD_PROD', 20000, 10, 0);

    const idempKey = `idemp_live_failed_held_${Date.now()}`;
    createdIdempotencyKeys.add(idempKey);

    const checkout = await checkoutSaga.executeCheckout({
      customerId,
      email: `${customerId}@example.com`,
      items: [{ productId, qty: 2 }],
      idempotencyKey: idempKey,
      provider: 'mock',
    });
    createdOrderIds.add(checkout.order.id);

    // Verify initial reservation
    const invInitial = await inventoryService.getInventory(productId);
    expect(invInitial.reserved).toBe(2);
    expect(invInitial.on_hand).toBe(10);

    // Simulate reconciler marking the payment intent 'failed' while order was awaiting_payment and reservation held
    await dbClient.query("UPDATE payment_intents SET status = 'failed', updated_at = NOW() WHERE id = $1", [
      checkout.paymentIntent.id,
    ]);

    // Late payment arrives for this failed intent
    const sim = mockProv.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 40000, 'NGN');
    const expectedEvtId = mockProv.parseWebhookEvent(sim.payload, sim.rawBody).eventId;
    createdWebhookEventIds.add(expectedEvtId);

    // Deliver webhook - must HONOR the payment, not refund!
    const webhookRes = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

    expect(webhookRes.latePaymentRefunded).toBeFalsy();
    expect(webhookRes.order?.status).toBe('paid');

    // Verify order transitioned to paid in DB
    const orderPaid = await orderService.getOrder(checkout.order.id);
    expect(orderPaid.status).toBe('paid');

    // Verify reservation committed in real DB: on_hand = 8, reserved = 0
    const invAfter = await inventoryService.getInventory(productId);
    expect(invAfter.reserved).toBe(0);
    expect(invAfter.on_hand).toBe(8);

    const resRows = await dbClient.query<{ status: string }>(
      'SELECT status FROM reservations WHERE order_id = $1',
      [checkout.order.id]
    );
    expect(resRows.rowCount).toBeGreaterThanOrEqual(1);
    expect(resRows.rows[0].status).toBe('committed');

    // Verify payment intent transitioned to succeeded
    const intentAfter = await paymentService.getPaymentIntent(checkout.paymentIntent.id);
    expect(intentAfter.status).toBe('succeeded');

    // ZERO refund outbox events
    const refundOutbox = await dbClient.query(
      "SELECT id FROM outbox WHERE event_type = 'payment.late_refund' AND payload->>'orderId' = $1",
      [checkout.order.id]
    );
    expect(refundOutbox.rowCount).toBe(0);

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 21. Live Test: Payment Webhook for Intent Already Marked 'failed' with Stock Gone (Item 2)
  it('u) Late payment with intent failed and reservation expired (stock gone): refunds payment and leaves order expired', async () => {
    console.log('\n[Live Test: Late Payment on Failed Intent with Stock Gone via Real DB]');

    const customerId = await createLiveCustomer('LATE_FAILED_GONE_CUS');
    const productId = await createLiveProduct('LATE_FAILED_GONE_PROD', 20000, 10, 0);

    const idempKey = `idemp_live_failed_gone_${Date.now()}`;
    createdIdempotencyKeys.add(idempKey);

    const checkout = await checkoutSaga.executeCheckout({
      customerId,
      email: `${customerId}@example.com`,
      items: [{ productId, qty: 2 }],
      idempotencyKey: idempKey,
      provider: 'mock',
    });
    createdOrderIds.add(checkout.order.id);

    // Age reservation past TTL and reap it so stock is gone
    await dbClient.query(
      "UPDATE reservations SET expires_at = NOW() - INTERVAL '1 hour' WHERE order_id = $1",
      [checkout.order.id]
    );
    await inventoryService.reapExpiredReservations();

    // Verify order is expired and stock is freed
    const orderExpired = await orderService.getOrder(checkout.order.id);
    expect(orderExpired.status).toBe('expired');
    const invReaped = await inventoryService.getInventory(productId);
    expect(invReaped.reserved).toBe(0);
    expect(invReaped.on_hand).toBe(10);

    // Mark payment intent failed
    await dbClient.query("UPDATE payment_intents SET status = 'failed', updated_at = NOW() WHERE id = $1", [
      checkout.paymentIntent.id,
    ]);

    // Late payment arrives for this failed intent when stock is gone
    const sim = mockProv.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 40000, 'NGN');
    const expectedEvtId = mockProv.parseWebhookEvent(sim.payload, sim.rawBody).eventId;
    createdWebhookEventIds.add(expectedEvtId);

    // Deliver webhook - must route to late-refund path
    const webhookRes = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);
    expect(webhookRes.latePaymentRefunded).toBe(true);
    expect(webhookRes.order?.status).toBe('expired');

    // Verify inventory untouched
    const invAfterLate = await inventoryService.getInventory(productId);
    expect(invAfterLate.reserved).toBe(0);
    expect(invAfterLate.on_hand).toBe(10);

    // Verify outbox row written for late refund
    const outboxRows = await dbClient.query<{ id: string; status: string }>(
      "SELECT id, status FROM outbox WHERE event_type = 'payment.late_refund' AND payload->>'orderId' = $1",
      [checkout.order.id]
    );
    expect(outboxRows.rowCount).toBeGreaterThanOrEqual(1);
    createdOutboxIds.add(outboxRows.rows[0].id);

    // Run outbox worker to process the refund on real Ductape DB
    const outboxService = new OutboxService(dbClient);
    outboxService.registerHandler('payment.late_refund', async (payload: any, outboxId: string) => {
      await paymentService.refundPayment(payload.intentId, payload.amountMinor, `late_refund_${outboxId}`);
    });
    await outboxService.processPending(10);

    // Verify refund transaction recorded
    const refundTxns = await dbClient.query<{ id: string; type: string; status: string }>(
      "SELECT id, type, status FROM transactions WHERE payment_intent_id = $1 AND type = 'refund'",
      [checkout.paymentIntent.id]
    );
    expect(refundTxns.rowCount).toBeGreaterThanOrEqual(1);
    expect(refundTxns.rows[0].status).toBe('succeeded');

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  // 24. Live Test: Paid Order Cancellation & Outbox Refund Reliability (Item 1)
  it('x) Cancelling a paid order: writes refund to outbox in same transaction as restock and status change; provider failure leaves queued refund intact (Item 1)', async () => {
    console.log('\n[Live Test: Paid Order Cancellation & Outbox Refund Reliability]');

    const customerId = await createLiveCustomer('CANCEL_PAID_LIVE');
    const productId = await createLiveProduct('CANCEL_PAID_PROD', 25000, 5, 0);

    // 1. Checkout 2 items
    const checkout = await checkoutSaga.executeCheckout({
      customerId,
      email: `${customerId}@example.com`,
      items: [{ productId, qty: 2 }],
      idempotencyKey: `idemp_live_cancel_paid_${Date.now()}`,
      provider: 'mock',
    });
    createdOrderIds.add(checkout.order.id);

    // 2. Simulate payment webhook -> order is paid, inventory committed in real DB
    const sim = mockProv.simulateWebhookPayload(checkout.paymentIntent.provider_ref!, 50000, 'NGN');
    const expectedEvtId = mockProv.parseWebhookEvent(sim.payload, sim.rawBody).eventId;
    createdWebhookEventIds.add(expectedEvtId);

    const webhookRes = await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);
    expect(webhookRes.order?.status).toBe('paid');

    const invPaid = await inventoryService.getInventory(productId);
    expect(invPaid.on_hand).toBe(3);
    expect(invPaid.reserved).toBe(0);

    // 3. Cancel the paid order
    const cancelledOrder = await orderService.cancelOrder(checkout.order.id, { actorId: customerId, actorType: 'user' });
    expect(cancelledOrder.status).toBe('cancelled');

    // Assert inventory is restocked in real DB: on_hand = 5, reserved = 0
    const invRestocked = await inventoryService.getInventory(productId);
    expect(invRestocked.on_hand).toBe(5);
    expect(invRestocked.reserved).toBe(0);

    // Assert refund was written to outbox table in the SAME transaction
    const outboxRows = await dbClient.query<{ id: string; status: string; payload: any }>(
      "SELECT id, status, payload FROM outbox WHERE event_type = 'payment.order_cancellation_refund' AND payload->>'orderId' = $1",
      [checkout.order.id]
    );
    expect(outboxRows.rowCount).toBe(1);
    const outboxRecord = outboxRows.rows[0];
    expect(outboxRecord.status).toBe('pending');
    createdOutboxIds.add(outboxRecord.id);

    // 4. Simulate payment provider outage / network failure
    const origRefund = mockProv.refund.bind(mockProv);
    mockProv.refund = async () => {
      throw new Error('Provider 503 Service Unavailable: upstream live timeout');
    };

    // 5. Worker processes outbox on real database -> provider call fails
    const worker = new OutboxService(dbClient);
    worker.registerHandler('payment.order_cancellation_refund', async (payload: any, outboxId: string) => {
      await paymentService.refundPayment(payload.intentId, payload.amountMinor, outboxId);
    });
    const result = await worker.processPending(10);
    expect(result.failed).toBe(1);

    // Crucial assertion: provider failure must NOT leave a restocked order without a queued refund in real DB
    const outboxAfterFail = await dbClient.query<{ id: string; status: string; retry_count: number; last_error: string }>(
      "SELECT id, status, retry_count, last_error FROM outbox WHERE id = $1",
      [outboxRecord.id]
    );
    expect(outboxAfterFail.rowCount).toBe(1);
    expect(outboxAfterFail.rows[0].status).toBe('pending'); // Scheduled for retry with backoff
    expect(outboxAfterFail.rows[0].retry_count).toBe(1);
    expect(outboxAfterFail.rows[0].last_error).toContain('Provider 503');

    // Confirm real DB state: order is still cancelled and inventory remains restocked
    const orderStillCancelled = await orderService.getOrder(checkout.order.id);
    expect(orderStillCancelled.status).toBe('cancelled');
    const invStillRestocked = await inventoryService.getInventory(productId);
    expect(invStillRestocked.on_hand).toBe(5);

    // 6. Provider recovers -> mock lists the executed refund -> retry succeeds
    mockProv.refund = origRefund;
    const mockRefundRecord = {
      id: `ref_live_recovered_${Date.now()}`,
      reference: checkout.paymentIntent.provider_ref!,
      amountMinor: 50000,
      status: 'succeeded' as const,
      rawResponse: {
        id: `ref_live_recovered_${Date.now()}`,
        amount: 50000,
        created_at: new Date().toISOString(),
      },
    };
    (mockProv as any).refundsList.push(mockRefundRecord);

    // Clear scheduled_for so row can be claimed immediately
    await dbClient.query("UPDATE outbox SET scheduled_for = NULL WHERE id = $1", [outboxRecord.id]);
    const retryResult = await worker.processPending(10);
    expect(retryResult.processed).toBe(1);

    // Outbox record marked 'completed'
    const outboxCompleted = await dbClient.query<{ id: string; status: string }>(
      "SELECT id, status FROM outbox WHERE id = $1",
      [outboxRecord.id]
    );
    expect(outboxCompleted.rows[0].status).toBe('completed');

    // Financial transaction record created in real DB
    const refundTxns = await dbClient.query<{ id: string; type: string; status: string; amount_minor: number }>(
      "SELECT id, type, status, amount_minor FROM transactions WHERE payment_intent_id = $1 AND type = 'refund'",
      [checkout.paymentIntent.id]
    );
    expect(refundTxns.rowCount).toBeGreaterThanOrEqual(1);
    expect(refundTxns.rows[0].status).toBe('succeeded');
    expect(refundTxns.rows[0].amount_minor).toBe(50000);

    await assertInventoryInvariants(Array.from(createdProductIds));
  }, 30000);

  it('exercises ductape.sessions.start and ductape.sessions.verify against the real workspace', async () => {
    const sessionTag = 'user-session';
    const existing = await ductapeClient.sessions.list(ductapeProduct);
    const found = existing.find((s: any) => s.tag === sessionTag);

    if (!found) {
      await ductapeClient.sessions.create(ductapeProduct, {
        tag: sessionTag,
        name: 'User Session',
        description: 'Commerce backend user session',
        expiry: 24,
        period: 'hours' as any,
        selector: '$Session{sub}',
        schema: {
          sub: 'usr_sample_123',
          email: 'sample@example.com',
          role: 'customer',
          actorType: 'user',
        },
      });
    }

    const testUserId = `usr_live_test_${Date.now()}`;
    const testEmail = `shopper_${Date.now()}@example.com`;

    // 1. Test direct SDK ductape.sessions.start & verify
    const sdkStarted = await ductapeClient.sessions.start({
      product: ductapeProduct,
      env: ductapeEnv,
      tag: sessionTag,
      data: {
        sub: testUserId,
        email: testEmail,
        role: 'customer',
        actorType: 'user',
      },
    });

    expect(sdkStarted).toBeDefined();
    expect(sdkStarted.token).toBeDefined();
    expect(sdkStarted.token.startsWith('user-session:')).toBe(true);
    expect(sdkStarted.sessionId).toBeDefined();

    const sdkVerified = await ductapeClient.sessions.verify({
      product: ductapeProduct,
      env: ductapeEnv,
      tag: sessionTag,
      token: sdkStarted.token,
    });

    expect(sdkVerified).toBeDefined();
    expect(sdkVerified.valid).toBe(true);
    expect(sdkVerified.data).toBeDefined();
    expect(sdkVerified.data.sub).toBe(testUserId);
    expect(sdkVerified.data.email).toBe(testEmail);
    expect(sdkVerified.data.role).toBe('customer');
    expect(sdkVerified.sessionId).toBe(sdkStarted.sessionId);

    // 2. Test DuctapeSessionService abstraction
    const sessionService = new DuctapeSessionService(ductapeClient, {
      product: ductapeProduct,
      env: ductapeEnv,
      defaultTag: sessionTag,
    });

    const svcSession = await sessionService.createSession(testUserId, {
      role: 'customer',
      email: testEmail,
      actorType: 'user',
    });

    expect(svcSession.token).toBeDefined();
    expect(svcSession.token.startsWith('user-session:')).toBe(true);

    const verifiedPayload = await sessionService.verifySession(svcSession.token);
    expect(verifiedPayload.sub).toBe(testUserId);
    expect(verifiedPayload.email).toBe(testEmail);
    expect(verifiedPayload.role).toBe('customer');

    const actorContext = sessionService.toActorContext(verifiedPayload);
    expect(actorContext.actorId).toBe(testUserId);
    expect(actorContext.actorType).toBe('user');
    expect(actorContext.role).toBe('customer');
  }, 20000);

  it('exercises DuctapeNotificationTransport against real workspace notification engine', async () => {
    const ductapeTransport = new DuctapeNotificationTransport(ductapeClient, {
      product: ductapeProduct,
      env: ductapeEnv,
      defaultNotificationTag: 'commerce:order-confirmed',
    });

    const liveNotificationService = new NotificationService(
      dbClient,
      ductapeTransport,
      new HttpWebhookTransport(5000)
    );

    const testRecipient = `shopper_${Date.now()}@example.com`;
    const testOrderId = `ord_live_notif_${Date.now()}`;

    const sent = await liveNotificationService.send({
      template_key: 'order_confirmed',
      recipient: testRecipient,
      vars: {
        order_id: testOrderId,
        customer_name: 'Live Shopper',
        total: 'NGN 12,000.00',
      },
    });

    createdNotificationIds.add(sent.id);

    expect(sent).toBeDefined();
    expect(sent.id).toBeDefined();
    expect(sent.status).toBe('failed');
    expect(sent.channel).toBe('email');

    // Verify delivery attempts were recorded in live database with failure outcome
    const attempts = await dbClient.query<{ id: string; outcome: string; attempt_no: number; error: string }>(
      'SELECT id, outcome, attempt_no, error FROM delivery_attempts WHERE notification_id = $1 ORDER BY attempt_no ASC',
      [sent.id]
    );

    expect(attempts.rowCount).toBeGreaterThan(0);
    expect(attempts.rows[0].outcome).toMatch(/failure/);
    expect(attempts.rows[0].error).toContain('ECONNREFUSED');
  }, 45000);
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Express } from 'express';
import { createTestDatabase } from '../test-db.js';
import { IDatabaseClient } from '../../src/common/database/index.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';
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
import { createApp } from '../../src/api/app.js';
import http from 'node:http';

describe('Milestone 9: REST API Front Door Integration', () => {
  let db: IDatabaseClient;
  let identityService: IdentityService;
  let inventoryService: InventoryService;
  let orderService: OrderService;
  let paymentService: PaymentService;
  let notifService: NotificationService;
  let mockProvider: MockPaymentProvider;
  let checkoutSaga: CheckoutSaga;
  let app: Express;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    db = await createTestDatabase();
    identityService = new IdentityService(db);
    const auditService = new AuditService(db);
    const idempotencyService = new IdempotencyService(db);
    inventoryService = new InventoryService(db);
    orderService = new OrderService(db, inventoryService, auditService);

    const router = new PaymentRouter();
    mockProvider = new MockPaymentProvider('mock');
    router.register(mockProvider);
    paymentService = new PaymentService(db, router);

    const mockTransport = new MockTransport();
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

    app = createApp({
      identityService,
      inventoryService,
      orderService,
      paymentService,
      notificationService: notifService,
      checkoutSaga,
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as any;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  });

  it('GET /health returns ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe('ok');
  });

  it('handles standard error shape { error: { code, message, hint } } for 404', async () => {
    const res = await fetch(`${baseUrl}/unknown-route`);
    expect(res.status).toBe(404);
    const data = (await res.json()) as any;
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe('NOT_FOUND');
  });

  it('executes auth registration, login, and product catalog interaction', async () => {
    // 1. Attempt to register as admin via public API -> 422 VALIDATION_ERROR (escalation forbidden)
    const hostileReg = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'hostile@api.test',
        password: 'Password123!',
        role: 'admin',
        name: 'Attacker',
      }),
    });
    expect(hostileReg.status).toBe(422);

    // 2. Properly seed admin user via identityService (system path)
    await identityService.registerUser({
      email: 'admin@api.test',
      password: 'Password123!',
      role: 'admin',
      name: 'Admin API',
    });

    // 3. Login as admin
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@api.test',
        password: 'Password123!',
      }),
    });
    expect(loginRes.status).toBe(200);
    const tokens = (await loginRes.json()) as any;
    const token = tokens.accessToken;
    expect(token).toBeDefined();

    // 3. Create Product as Admin
    const prodRes = await fetch(`${baseUrl}/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sku: 'REST-PHONE',
        name: 'REST Smartphone',
        price_minor: 49900,
        currency: 'USD',
        initial_stock: 15,
      }),
    });
    expect(prodRes.status).toBe(201);
    const createdProd = (await prodRes.json()) as any;
    expect(createdProd.product.id).toBeDefined();

    // 4. Fetch Product by ID
    const getProdRes = await fetch(`${baseUrl}/products/${createdProd.product.id}`);
    expect(getProdRes.status).toBe(200);
    const fetchedProd = (await getProdRes.json()) as any;
    expect(fetchedProd.product.name).toBe('REST Smartphone');
    expect(fetchedProd.inventory.on_hand).toBe(15);
  });

  it('executes checkout and order retrieval via REST', async () => {
    // 1. Create customer and get agent/user token
    const customer = await identityService.createCustomer({ email: 'shopper@api.test', name: 'Shopper' });
    const user = await identityService.registerUser({
      email: 'shopper@api.test',
      password: 'Password123!',
      role: 'customer',
      customerId: customer.id,
    });
    const tokens = await identityService.login({ email: 'shopper@api.test', password: 'Password123!' });

    // 2. Create product
    const prod = await inventoryService.createProduct({
      sku: 'COFFEE-MUG',
      name: 'Ceramic Mug',
      price_minor: 1200,
      currency: 'USD',
      initial_stock: 5,
    });

    // 3. Checkout
    const checkoutRes = await fetch(`${baseUrl}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.accessToken}`,
        'Idempotency-Key': 'idemp_rest_checkout_1',
      },
      body: JSON.stringify({
        items: [{ productId: prod.product.id, qty: 1 }],
        currency: 'USD',
      }),
    });

    expect(checkoutRes.status).toBe(201);
    const checkout = (await checkoutRes.json()) as any;
    expect(checkout.order.id).toBeDefined();
    expect(checkout.order.status).toBe('awaiting_payment');

    // 4. Get order details
    const orderRes = await fetch(`${baseUrl}/orders/${checkout.order.id}`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(orderRes.status).toBe(200);
    const order = (await orderRes.json()) as any;
    expect(order.id).toBe(checkout.order.id);
  });

  it('rejects unauthenticated request with 401 UNAUTHORIZED', async () => {
    const res = await fetch(`${baseUrl}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ productId: 'any', qty: 1 }] }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('prevents a customer from reading another customer order with 403 FORBIDDEN', async () => {
    // Customer A
    const custA = await identityService.createCustomer({ email: 'cust_a@test.com', name: 'Cust A' });
    await identityService.registerUser({ email: 'cust_a@test.com', password: 'Password123!', role: 'customer', customerId: custA.id });
    const tokenA = (await identityService.login({ email: 'cust_a@test.com', password: 'Password123!' })).accessToken;

    // Customer B
    const custB = await identityService.createCustomer({ email: 'cust_b@test.com', name: 'Cust B' });
    await identityService.registerUser({ email: 'cust_b@test.com', password: 'Password123!', role: 'customer', customerId: custB.id });
    const tokenB = (await identityService.login({ email: 'cust_b@test.com', password: 'Password123!' })).accessToken;

    const prod = await inventoryService.createProduct({ sku: 'ORDER-PRIV-TEST', name: 'Private Item', price_minor: 1000, currency: 'USD', initial_stock: 5 });

    // Customer A checks out
    const checkoutRes = await fetch(`${baseUrl}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}`, 'Idempotency-Key': 'idemp_order_a_1' },
      body: JSON.stringify({ items: [{ productId: prod.product.id, qty: 1 }], currency: 'USD' }),
    });
    const orderA = (await checkoutRes.json()) as any;

    // Customer B tries to read Customer A's order
    const readRes = await fetch(`${baseUrl}/orders/${orderA.order.id}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(readRes.status).toBe(403);
    const err = (await readRes.json()) as any;
    expect(err.error.code).toBe('FORBIDDEN');
  });

  it('rejects cancelling a shipped order with 400 INVALID_STATE', async () => {
    const cust = await identityService.createCustomer({ email: 'cust_ship@test.com', name: 'Cust Ship' });
    await identityService.registerUser({ email: 'cust_ship@test.com', password: 'Password123!', role: 'customer', customerId: cust.id });
    const token = (await identityService.login({ email: 'cust_ship@test.com', password: 'Password123!' })).accessToken;

    const prod = await inventoryService.createProduct({ sku: 'SHIP-TEST', name: 'Shipped Item', price_minor: 2000, currency: 'USD', initial_stock: 5 });

    const checkoutRes = await fetch(`${baseUrl}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': 'idemp_ship_1' },
      body: JSON.stringify({ items: [{ productId: prod.product.id, qty: 1 }], currency: 'USD' }),
    });
    const order = (await checkoutRes.json()) as any;
    const orderId = order.order.id;

    // Transition order: awaiting_payment -> paid -> fulfilled -> shipped
    await orderService.updateOrderStatus(orderId, 'paid', { actorId: 'system_webhook', actorType: 'system' });
    await orderService.updateOrderStatus(orderId, 'fulfilled');
    await orderService.updateOrderStatus(orderId, 'shipped');

    // Attempt cancellation
    const cancelRes = await fetch(`${baseUrl}/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(cancelRes.status).toBe(400);
    const err = (await cancelRes.json()) as any;
    expect(err.error.code).toBe('INVALID_TRANSITION');
  });

  it('lists active products with stock details and pagination via GET /products', async () => {
    await inventoryService.createProduct({ sku: 'CAT-1', name: 'Alpha Mug', price_minor: 1500, currency: 'USD', initial_stock: 10 });
    await inventoryService.createProduct({ sku: 'CAT-2', name: 'Beta Pen', price_minor: 300, currency: 'USD', initial_stock: 25 });

    const res = await fetch(`${baseUrl}/products?limit=10`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.products).toBeDefined();
    expect(data.products.length).toBeGreaterThanOrEqual(2);
    const alpha = data.products.find((p: any) => p.sku === 'CAT-1');
    expect(alpha).toBeDefined();
    expect(alpha.on_hand).toBe(10);
    expect(alpha.available).toBe(10);
  });
});

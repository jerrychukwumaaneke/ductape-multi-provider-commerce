import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
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
import { logIncomingWebhook } from '../../src/api/routes/webhooks.routes.js';
import { logOutboundProviderCall } from '../../src/modules/payments/outbound-logger.js';

describe('Admin Logs API Integration', () => {
  let db: IDatabaseClient;
  let identityService: IdentityService;
  let app: Express;
  let server: http.Server;
  let baseUrl: string;
  let adminToken: string;
  let customerToken: string;

  beforeEach(async () => {
    db = await createTestDatabase();
    identityService = new IdentityService(db);
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

    app = createApp({
      identityService,
      inventoryService,
      orderService,
      paymentService,
      notificationService: notifService,
      checkoutSaga,
      db,
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as any;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    // Seed customer and admin
    await identityService.registerUser({
      email: 'customer_admin_test@test.com',
      password: 'Password123!',
      role: 'customer',
      name: 'Customer Test',
    });
    const custLogin = await identityService.login({
      email: 'customer_admin_test@test.com',
      password: 'Password123!',
    });
    customerToken = custLogin.accessToken;

    await identityService.registerUser({
      email: 'admin_test@test.com',
      password: 'AdminPassword123!',
      role: 'admin',
      name: 'Admin Test',
    });
    const adminLogin = await identityService.login({
      email: 'admin_test@test.com',
      password: 'AdminPassword123!',
    });
    adminToken = adminLogin.accessToken;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await fetch(`${baseUrl}/admin/logs/webhooks`);
    expect(res.status).toBe(401);
  });

  it('rejects customer role requests with 403 FORBIDDEN', async () => {
    const res = await fetch(`${baseUrl}/admin/logs/webhooks`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    expect(res.status).toBe(403);
  });

  it('returns webhook and outbound logs for admin role', async () => {
    // Write sample logs
    logIncomingWebhook('paystack', { authorization: 'Bearer secret', host: 'example.com' }, '{"event":"charge.success"}');
    logOutboundProviderCall({
      timestamp: new Date().toISOString(),
      provider: 'paystack',
      method: 'POST',
      url: 'https://api.paystack.co/transaction/initialize',
      durationMs: 15,
      status: 200,
    });

    // 1. Webhooks log
    const whRes = await fetch(`${baseUrl}/admin/logs/webhooks?limit=10`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(whRes.status).toBe(200);
    const whData = await whRes.json();
    expect(whData.count).toBeGreaterThan(0);
    expect(whData.logs[0].provider).toBe('paystack');

    // 2. Outbound log
    const obRes = await fetch(`${baseUrl}/admin/logs/outbound?limit=10`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(obRes.status).toBe(200);
    const obData = await obRes.json();
    expect(obData.count).toBeGreaterThan(0);
    expect(obData.logs[0].provider).toBe('paystack');

    // 3. Stats
    const statsRes = await fetch(`${baseUrl}/admin/logs/stats`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(statsRes.status).toBe(200);
    const statsData = await statsRes.json();
    expect(statsData.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(statsData.log_files['incoming-webhooks.log'].exists).toBe(true);
  });

  it('returns database webhook events from postgres', async () => {
    // Insert dummy webhook_event
    await db.query(
      `INSERT INTO webhook_events (id, provider, provider_event_id, type, payload, processed_at)
       VALUES ('evt_test_1', 'flutterwave', 'flw_evt_101', 'charge.completed', '{"status":"successful"}', NOW())
       ON CONFLICT DO NOTHING`
    );

    const res = await fetch(`${baseUrl}/admin/logs/db-webhooks?limit=10`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBeGreaterThan(0);
    expect(data.events[0].provider).toBe('flutterwave');
    expect(data.events[0].provider_event_id).toBe('flw_evt_101');
  });

  it('authenticates via valid X-Admin-Key header (>=32 chars) and rejects query param', async () => {
    const validKey = 'sec_admin_key_testing_production_grade_secret_32chars';
    process.env.ADMIN_SECRET_KEY = validKey;

    try {
      // 1. Valid header -> 200
      const okRes = await fetch(`${baseUrl}/admin/logs/stats`, {
        headers: { 'X-Admin-Key': validKey },
      });
      expect(okRes.status).toBe(200);

      // 2. Invalid header -> 401
      const badRes = await fetch(`${baseUrl}/admin/logs/stats`, {
        headers: { 'X-Admin-Key': 'wrong_key_that_fails_comparison' },
      });
      expect(badRes.status).toBe(401);

      // 3. Query param alone is NOT accepted -> 401
      const queryRes = await fetch(`${baseUrl}/admin/logs/stats?admin_key=${validKey}`);
      expect(queryRes.status).toBe(401);
    } finally {
      delete process.env.ADMIN_SECRET_KEY;
    }
  });

  it('seedDefaultUsers synchronizes admin password from ADMIN_PASSWORD env var', async () => {
    const { seedDefaultUsers } = await import('../../src/db/seed-users.js');
    process.env.ADMIN_PASSWORD = 'SuperSecureCustomAdminPassword2026!';

    try {
      await seedDefaultUsers(db);
      const loginResult = await identityService.login({
        email: 'admin@commerce.io',
        password: 'SuperSecureCustomAdminPassword2026!',
      });
      expect(loginResult.accessToken).toBeDefined();
    } finally {
      delete process.env.ADMIN_PASSWORD;
    }
  });

  it('seedDefaultUsers in production revokes leaked default AdminPassword123!', async () => {
    const { seedDefaultUsers } = await import('../../src/db/seed-users.js');
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      // First seed with default in dev
      process.env.NODE_ENV = 'development';
      await seedDefaultUsers(db);

      // Now run seed in production without ADMIN_PASSWORD
      process.env.NODE_ENV = 'production';
      delete process.env.ADMIN_PASSWORD;
      await seedDefaultUsers(db);

      // Leaked password AdminPassword123! should now be rejected!
      await expect(
        identityService.login({
          email: 'admin@commerce.io',
          password: 'AdminPassword123!',
        })
      ).rejects.toThrow();
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });
});


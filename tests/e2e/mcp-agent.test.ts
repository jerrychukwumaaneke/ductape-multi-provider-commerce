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
import { IdentityService } from '../../src/modules/identity/identity.service.js';
import { CheckoutSaga } from '../../src/modules/orders/checkout-saga.js';
import { McpCommerceServer } from '../../src/mcp/server.js';
import { Order, Product } from '../../src/common/types/index.js';

describe('Milestone 7: MCP Agent Interface E2E Test Suite', () => {
  let db: IDatabaseClient;
  let identityService: IdentityService;
  let inventoryService: InventoryService;
  let orderService: OrderService;
  let paymentService: PaymentService;
  let notifService: NotificationService;
  let mockTransport: MockTransport;
  let mockProvider: MockPaymentProvider;
  let idempotencyService: IdempotencyService;
  let auditService: AuditService;
  let checkoutSaga: CheckoutSaga;
  let mcpServer: McpCommerceServer;

  // Agent tokens
  let agentRwToken: string;
  let agentRoToken: string;
  let agentAdminToken: string;
  let customerAId: string;
  let customerBId: string;
  let testProduct1: Product;
  let testProduct2: Product;

  beforeEach(async () => {
    db = await createTestDatabase();
    identityService = new IdentityService(db);
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

    mcpServer = new McpCommerceServer(
      db,
      identityService,
      orderService,
      inventoryService,
      paymentService,
      notifService,
      checkoutSaga,
      auditService
    );

    // Setup customers
    const cusA = await identityService.createCustomer({ email: 'alice@agent.test', name: 'Alice Customer' });
    const cusB = await identityService.createCustomer({ email: 'bob@agent.test', name: 'Bob Customer' });
    customerAId = cusA.id;
    customerBId = cusB.id;

    // Agent tokens: scoped to customerA
    agentRwToken = identityService.createAgentToken('agent_001', 'agent', ['read_write'], customerAId);
    agentRoToken = identityService.createAgentToken('agent_002', 'agent', ['read_only'], customerAId);
    agentAdminToken = identityService.createAgentToken('agent_admin', 'admin', ['*']);

    // Setup Notification Template
    await notifService.createTemplate({
      key: 'order_confirmed',
      channel: 'email',
      category: 'transactional',
      subject: 'Order {{order_id}} Confirmed',
      body: 'Hello {{customer_name}}, total is {{total}}',
      required_vars: ['order_id', 'customer_name', 'total'],
    });

    // Populate catalog
    const p1 = await inventoryService.createProduct({
      sku: 'SKU-SMARTPHONE',
      name: 'Flagship Smartphone',
      price_minor: 99900,
      currency: 'USD',
      initial_stock: 10,
    });
    testProduct1 = p1.product;

    const p2 = await inventoryService.createProduct({
      sku: 'SKU-CASE',
      name: 'Protective Smartphone Case',
      price_minor: 2500,
      currency: 'USD',
      initial_stock: 20,
    });
    testProduct2 = p2.product;
  });

  afterEach(async () => {
    await db.close();
  });

  describe('1. Product Search & Catalog Discovery via MCP', () => {
    it('searches products with real-time stock and pagination', async () => {
      const res = await mcpServer.executeTool<Array<Product & { available_stock: number }>>(
        'search_products',
        { query: 'Smartphone', limit: 10 },
        agentRoToken
      );

      expect(res.success).toBe(true);
      expect(res.data).toBeDefined();
      expect(res.data?.length).toBe(2);
      expect(res.data?.[0].sku).toContain('SKU-');
      expect(res.data?.[0].available_stock).toBeGreaterThan(0);
      expect(res.has_more).toBe(false);
    });

    it('respects pagination limit and has_more flag', async () => {
      const res = await mcpServer.executeTool<Array<Product>>(
        'search_products',
        { limit: 1 },
        agentRwToken
      );

      expect(res.success).toBe(true);
      expect(res.data?.length).toBe(1);
      expect(res.has_more).toBe(true);
    });
  });

  describe('2. Full Scripted Agent E2E Scenario (Search -> Checkout -> Check Payment -> Cancel -> Resend)', () => {
    it('executes the full end-to-end agent workflow purely through MCP tools', async () => {
      // Step A: Search catalog
      const searchRes = await mcpServer.executeTool<Array<Product & { available_stock: number }>>(
        'search_products',
        { query: 'Flagship' },
        agentRwToken
      );
      expect(searchRes.success).toBe(true);
      const product = searchRes.data![0];
      expect(product.id).toBe(testProduct1.id);
      expect(product.available_stock).toBe(10);

      // Step B: Create Checkout
      const checkoutRes = await mcpServer.executeTool<{
        order: Order;
        payment_intent_id: string;
        amount_minor: number;
        currency: string;
      }>(
        'create_checkout',
        {
          items: [{ productId: product.id, qty: 2 }],
          idempotency_key: 'agent_idemp_001',
          currency: 'USD',
          provider: 'mock',
        },
        agentRwToken
      );

      expect(checkoutRes.success).toBe(true);
      expect(checkoutRes.data?.order.status).toBe('awaiting_payment');
      expect(checkoutRes.data?.amount_minor).toBe(199800);
      const orderId = checkoutRes.data!.order.id;
      const paymentIntentId = checkoutRes.data!.payment_intent_id;

      // Verify stock reservation: on_hand 10, reserved 2 -> available 8
      const invAfterCheckout = await inventoryService.getInventory(product.id);
      expect(invAfterCheckout.on_hand).toBe(10);
      expect(invAfterCheckout.reserved).toBe(2);

      // Step C: Check Payment Status
      const payStatusRes = await mcpServer.executeTool<{
        payment_intent_id: string;
        status: string;
        amount_minor: number;
      }>(
        'get_payment_status',
        { payment_intent_id: paymentIntentId },
        agentRwToken
      );
      expect(payStatusRes.success).toBe(true);
      expect(payStatusRes.data?.status).toBe('processing');
      expect(payStatusRes.data?.amount_minor).toBe(199800);

      // Step D: Get Order Details
      const getOrderRes = await mcpServer.executeTool<Order>(
        'get_order',
        { order_id: orderId },
        agentRwToken
      );
      expect(getOrderRes.success).toBe(true);
      expect(getOrderRes.data?.id).toBe(orderId);
      expect(getOrderRes.data?.items?.length).toBe(1);

      // Step E: List Orders for Agent's customer
      const listOrdersRes = await mcpServer.executeTool<Order[]>(
        'list_orders',
        { limit: 5 },
        agentRwToken
      );
      expect(listOrdersRes.success).toBe(true);
      expect(listOrdersRes.data?.length).toBe(1);
      expect(listOrdersRes.data?.[0].id).toBe(orderId);

      // Step F: Cancel Order
      const cancelRes = await mcpServer.executeTool<{
        order_id: string;
        status: string;
        message: string;
      }>(
        'cancel_order',
        { order_id: orderId, reason: 'Customer changed mind' },
        agentRwToken
      );
      expect(cancelRes.success).toBe(true);
      expect(cancelRes.data?.status).toBe('cancelled');

      // Verify stock immediately released
      const invAfterCancel = await inventoryService.getInventory(product.id);
      expect(invAfterCancel.reserved).toBe(0);

      // Step G: Cancel again is safe and quiet (Idempotency)
      const repeatCancelRes = await mcpServer.executeTool<{
        order_id: string;
        status: string;
      }>(
        'cancel_order',
        { order_id: orderId },
        agentRwToken
      );
      expect(repeatCancelRes.success).toBe(true);
      expect(repeatCancelRes.data?.status).toBe('cancelled');

      // Step H: Resend / Trigger notification
      const notifRes = await mcpServer.executeTool<{
        notification_id: string;
        status: string;
      }>(
        'resend_notification',
        {
          template_key: 'order_confirmed',
          recipient: 'alice@agent.test',
          vars: {
            order_id: orderId,
            customer_name: 'Alice',
            total: '$1,998.00',
          },
        },
        agentRwToken
      );
      expect(notifRes.success).toBe(true);
      expect(notifRes.data?.notification_id).toBeDefined();

      // Step I: Get Delivery Status
      const deliveryRes = await mcpServer.executeTool<{
        status: string;
        attempt_count: number;
      }>(
        'get_delivery_status',
        { notification_id: notifRes.data!.notification_id },
        agentRwToken
      );
      expect(deliveryRes.success).toBe(true);
      expect(deliveryRes.data?.status).toBe('delivered');
      expect(deliveryRes.data?.attempt_count).toBe(1);
    });
  });

  describe('3. Scope Enforcement & Destructive Actions', () => {
    it('prevents read-only agents from executing write operations', async () => {
      const res = await mcpServer.executeTool(
        'create_checkout',
        {
          items: [{ productId: testProduct1.id, qty: 1 }],
          idempotency_key: 'ro_attempt',
        },
        agentRoToken
      );

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('FORBIDDEN');
      expect(res.error?.message).toContain('read_only');
    });

    it('prevents cancel_order for read-only agents', async () => {
      const res = await mcpServer.executeTool(
        'cancel_order',
        { order_id: 'ord_dummy' },
        agentRoToken
      );

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('FORBIDDEN');
    });

    it('requires confirm: true for destructive refund_payment', async () => {
      const res = await mcpServer.executeTool(
        'refund_payment',
        {
          payment_intent_id: 'pi_test',
          confirm: false,
        },
        agentAdminToken
      );

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('CONFIRMATION_REQUIRED');
      expect(res.error?.hint).toContain('confirm: true');
    });

    it('rejects refund_payment when agent lacks elevated refund scope', async () => {
      const res = await mcpServer.executeTool(
        'refund_payment',
        {
          payment_intent_id: 'pi_test',
          confirm: true,
        },
        agentRwToken // read_write but not elevated refund/admin
      );

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('FORBIDDEN');
      expect(res.error?.hint).toContain('payments:refund');
    });

    it('allows successful refund when confirmed by elevated agent', async () => {
      // 1. Create and pay for an order
      const checkoutRes = await mcpServer.executeTool<{
        order: Order;
        payment_intent_id: string;
      }>(
        'create_checkout',
        {
          items: [{ productId: testProduct1.id, qty: 1 }],
          idempotency_key: 'refund_test_checkout',
        },
        agentRwToken
      );

      const piId = checkoutRes.data!.payment_intent_id;
      // Mark as succeeded via simulation
      const pi = await paymentService.getPaymentIntent(piId);
      const sim = mockProvider.simulateWebhookPayload(pi.provider_ref!, pi.amount_minor, pi.currency);
      await checkoutSaga.processPaymentWebhook('mock', sim.rawBody, sim.headers, sim.payload);

      // 2. Refund with elevated token and confirm: true
      const refundRes = await mcpServer.executeTool<{
        payment_intent_id: string;
        refunded_amount_minor: number;
        provider_status: string;
      }>(
        'refund_payment',
        {
          payment_intent_id: piId,
          confirm: true,
          reason: 'Defective item',
        },
        agentAdminToken
      );

      expect(refundRes.success).toBe(true);
      expect(refundRes.data?.payment_intent_id).toBe(piId);
      expect(refundRes.data?.provider_status).toBe('succeeded');
    });
  });

  describe('4. Customer Isolation & Security', () => {
    it('prevents agent scoped to Customer A from viewing Customer B orders', async () => {
      // Create order for Customer B directly
      await db.query(
        "INSERT INTO orders (id, customer_id, status, total_minor, currency, idempotency_key) VALUES ('ord_bob_secret', $1, 'awaiting_payment', 5000, 'USD', 'bob_idemp')",
        [customerBId]
      );

      // Customer A's agent tries to get Bob's order
      const getRes = await mcpServer.executeTool(
        'get_order',
        { order_id: 'ord_bob_secret' },
        agentRwToken
      );

      expect(getRes.success).toBe(false);
      expect(getRes.error?.code).toBe('FORBIDDEN');
    });

    it('records agent actions in audit log with actor_type = agent', async () => {
      await mcpServer.executeTool(
        'create_checkout',
        {
          items: [{ productId: testProduct2.id, qty: 1 }],
          idempotency_key: 'audit_test_idemp',
        },
        agentRwToken
      );

      const logs = await auditService.listLogs({ actorId: 'agent_001' });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].actor_type).toBe('agent');
      expect(logs[0].actor_id).toBe('agent_001');
    });
  });
});

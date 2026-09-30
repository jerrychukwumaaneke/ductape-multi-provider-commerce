import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '../test-db.js';
import { IDatabaseClient } from '../../src/common/database/index.js';
import { InventoryService } from '../../src/modules/inventory/inventory.service.js';
import { OrderService } from '../../src/modules/orders/orders.service.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { InsufficientInventoryError, InvalidTransitionError } from '../../src/common/errors/app-error.js';

describe('Milestone 4: Orders & Inventory Concurrency Test Suite', () => {
  let db: IDatabaseClient;
  let inventoryService: InventoryService;
  let orderService: OrderService;
  let auditService: AuditService;

  beforeEach(async () => {
    db = await createTestDatabase();
    inventoryService = new InventoryService(db);
    auditService = new AuditService(db);
    orderService = new OrderService(db, inventoryService, auditService);

    // Create a customer
    await db.query("INSERT INTO customers (id, email, name) VALUES ('cus_1', 'buyer@test.com', 'Buyer One')");
    await db.query("INSERT INTO customers (id, email, name) VALUES ('cus_2', 'buyer2@test.com', 'Buyer Two')");
  });

  afterEach(async () => {
    await db.close();
  });

  describe('1. Happy Path Checkout & Stock Reservation', () => {
    it('creates order, snapshots prices, and reserves stock accurately', async () => {
      const { product } = await inventoryService.createProduct({
        sku: 'SHIRT-BLUE',
        name: 'Blue T-Shirt',
        price_minor: 2500, // 25.00
        currency: 'USD',
        initial_stock: 10,
      });

      const order = await orderService.createOrder({
        customerId: 'cus_1',
        idempotencyKey: 'idemp_order_1',
        currency: 'USD',
        items: [{ productId: product.id, qty: 3 }],
      });

      expect(order.status).toBe('awaiting_payment');
      expect(order.total_minor).toBe(7500); // 2500 * 3
      expect(order.items?.length).toBe(1);
      expect(order.items?.[0].name_snapshot).toBe('Blue T-Shirt');
      expect(order.items?.[0].unit_price_minor).toBe(2500);

      // Verify inventory reservation
      const inv = await inventoryService.getInventory(product.id);
      expect(inv.on_hand).toBe(10);
      expect(inv.reserved).toBe(3);
    });
  });

  describe('2. Partial Reservation Rollback on Insufficient Stock', () => {
    it('rejects multi-item cart if ANY item is out of stock and leaves zero partial reservations', async () => {
      const item1 = await inventoryService.createProduct({
        sku: 'ITEM-IN-STOCK',
        name: 'Item In Stock',
        price_minor: 1000,
        currency: 'USD',
        initial_stock: 5,
      });

      const item2 = await inventoryService.createProduct({
        sku: 'ITEM-OUT-STOCK',
        name: 'Item Out Of Stock',
        price_minor: 2000,
        currency: 'USD',
        initial_stock: 1, // only 1 available, we will request 2
      });

      await expect(
        orderService.createOrder({
          customerId: 'cus_1',
          idempotencyKey: 'idemp_order_insufficient',
          items: [
            { productId: item1.product.id, qty: 3 }, // item1 has enough stock
            { productId: item2.product.id, qty: 2 }, // item2 does NOT have enough stock
          ],
        })
      ).rejects.toThrow(InsufficientInventoryError);

      // Verify item1 was completely rolled back!
      const inv1 = await inventoryService.getInventory(item1.product.id);
      expect(inv1.reserved).toBe(0);

      // Verify item2 has no reservation
      const inv2 = await inventoryService.getInventory(item2.product.id);
      expect(inv2.reserved).toBe(0);

      // Verify no order was created
      const orders = await orderService.listOrders({ customerId: 'cus_1' });
      expect(orders.length).toBe(0);
    });
  });

  describe('3. Concurrency Race Condition: 2 checkouts for the last 1 unit', () => {
    it('guarantees that under concurrent requests, exactly one succeeds and one fails with zero overselling', async () => {
      const { product } = await inventoryService.createProduct({
        sku: 'LIMITED-EDITION',
        name: 'Rare Item',
        price_minor: 50000,
        currency: 'USD',
        initial_stock: 1, // Only 1 unit in stock!
      });

      // Fire two concurrent checkout requests simultaneously
      const [res1, res2] = await Promise.allSettled([
        orderService.createOrder({
          customerId: 'cus_1',
          idempotencyKey: 'race_buyer_1',
          items: [{ productId: product.id, qty: 1 }],
        }),
        orderService.createOrder({
          customerId: 'cus_2',
          idempotencyKey: 'race_buyer_2',
          items: [{ productId: product.id, qty: 1 }],
        }),
      ]);

      const successCount = [res1, res2].filter((r) => r.status === 'fulfilled').length;
      const rejectedCount = [res1, res2].filter((r) => r.status === 'rejected').length;

      // Exactly ONE succeeds, exactly ONE fails!
      expect(successCount).toBe(1);
      expect(rejectedCount).toBe(1);

      const rejectedResult = (res1.status === 'rejected' ? res1 : res2) as PromiseRejectedResult;
      expect(rejectedResult.reason).toBeInstanceOf(InsufficientInventoryError);

      // Verify inventory state: on_hand = 1, reserved = 1. Never oversold!
      const finalInv = await inventoryService.getInventory(product.id);
      expect(finalInv.on_hand).toBe(1);
      expect(finalInv.reserved).toBe(1);
    });
  });

  describe('4. Reservation Expiry Worker', () => {
    it('releases held stock when reservations expire', async () => {
      const { product } = await inventoryService.createProduct({
        sku: 'EXPIRING-PROD',
        name: 'Expiring Product',
        price_minor: 3000,
        currency: 'USD',
        initial_stock: 5,
      });

      // Create an order
      const order = await orderService.createOrder({
        customerId: 'cus_1',
        idempotencyKey: 'idemp_expiring',
        items: [{ productId: product.id, qty: 2 }],
      });

      expect((await inventoryService.getInventory(product.id)).reserved).toBe(2);

      // Force reservation to be expired in the past
      await db.query(
        "UPDATE reservations SET expires_at = NOW() - INTERVAL '1 minute' WHERE order_id = $1",
        [order.id]
      );

      // Run expiry worker
      const expiredCount = await inventoryService.expireOldReservations();
      expect(expiredCount).toBe(1);

      // Stock must be restored to 0 reserved
      const invAfter = await inventoryService.getInventory(product.id);
      expect(invAfter.reserved).toBe(0);

      // Order should be marked expired
      const expiredOrder = await orderService.getOrder(order.id);
      expect(expiredOrder.status).toBe('expired');
    });
  });

  describe('5. Order Cancellation & Stock Release', () => {
    it('releases reserved stock on cancellation and allows safe repeated cancel', async () => {
      const { product } = await inventoryService.createProduct({
        sku: 'CANCEL-TEST',
        name: 'Cancel Test Product',
        price_minor: 1500,
        currency: 'USD',
        initial_stock: 10,
      });

      const order = await orderService.createOrder({
        customerId: 'cus_1',
        idempotencyKey: 'idemp_cancel_test',
        items: [{ productId: product.id, qty: 4 }],
      });

      expect((await inventoryService.getInventory(product.id)).reserved).toBe(4);

      // Cancel order
      const cancelled = await orderService.cancelOrder(order.id, {
        actorId: 'usr_buyer',
        actorType: 'user',
      });
      expect(cancelled.status).toBe('cancelled');

      // Reserved stock released
      const invAfter = await inventoryService.getInventory(product.id);
      expect(invAfter.reserved).toBe(0);

      // Idempotent cancel: cancelling again succeeds quietly
      const secondCancel = await orderService.cancelOrder(order.id);
      expect(secondCancel.status).toBe('cancelled');
    });

    it('rejects cancellation on shipped orders', async () => {
      const { product } = await inventoryService.createProduct({
        sku: 'SHIPPED-PROD',
        name: 'Shipped Product',
        price_minor: 1200,
        currency: 'USD',
        initial_stock: 5,
      });

      const order = await orderService.createOrder({
        customerId: 'cus_1',
        idempotencyKey: 'idemp_ship_test',
        items: [{ productId: product.id, qty: 1 }],
      });

      // Advance order: awaiting_payment -> paid -> fulfilled -> shipped
      await orderService.updateOrderStatus(order.id, 'paid', { actorId: 'system_webhook', actorType: 'system' });
      await orderService.updateOrderStatus(order.id, 'fulfilled');
      await orderService.updateOrderStatus(order.id, 'shipped');

      // Attempt to cancel shipped order
      await expect(orderService.cancelOrder(order.id)).rejects.toThrow(InvalidTransitionError);
    });
  });
});

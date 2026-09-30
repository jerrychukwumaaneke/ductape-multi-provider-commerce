import { IDatabaseClient } from '../../common/database/index.js';
import { CryptoUtils } from '../../common/utils/crypto.js';
import { NotFoundError, ValidationError } from '../../common/errors/app-error.js';
import { StateMachine } from '../../common/state-machine/index.js';
import { Order, OrderItem, OrderStatus, ActorContext, PaymentIntent } from '../../common/types/index.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';

export interface OrderItemInput {
  productId: string;
  qty: number;
}

export interface CreateOrderInput {
  customerId: string;
  items: OrderItemInput[];
  idempotencyKey: string;
  currency?: string;
  ttlMinutes?: number;
}

export class OrderService {
  private readonly outboxService: OutboxService;

  constructor(
    private readonly db: IDatabaseClient,
    private readonly inventoryService: InventoryService,
    private readonly auditService?: AuditService,
    public paymentService?: { refundPayment: (id: string, amount?: number) => Promise<any> },
    outboxService?: OutboxService
  ) {
    this.outboxService = outboxService ?? new OutboxService(db);
  }

  public async createOrder(input: CreateOrderInput, actor?: ActorContext): Promise<Order> {
    if (!input.items || input.items.length === 0) {
      throw new ValidationError('An order must contain at least one item');
    }

    for (const item of input.items) {
      if (item.qty <= 0) {
        throw new ValidationError(`Quantity for product ${item.productId} must be greater than zero`);
      }
    }

    // Validate customer exists before reserving stock
    const custRes = await this.db.query('SELECT id FROM customers WHERE id = $1', [input.customerId]);
    if (custRes.rowCount === 0) {
      throw new NotFoundError('Customer', input.customerId);
    }

    // 1. Check idempotency: UNIQUE(customer_id, idempotency_key)
    const existingOrder = await this.db.query<Order>(
      'SELECT id, customer_id, status, total_minor, currency, idempotency_key, created_at, updated_at FROM orders WHERE customer_id = $1 AND idempotency_key = $2',
      [input.customerId, input.idempotencyKey]
    );
    if (existingOrder.rowCount > 0) {
      const order = existingOrder.rows[0];
      order.items = await this.getOrderItems(order.id);
      return order;
    }

    // 2. Fetch product price and name snapshots
    const orderItemsToCreate: Array<{
      productId: string;
      nameSnapshot: string;
      unitPriceMinor: number;
      qty: number;
    }> = [];

    let totalMinor = 0;
    const currency = input.currency?.toUpperCase() || 'NGN';

    for (const item of input.items) {
      const product = await this.inventoryService.getProduct(item.productId);
      if (!product.active) {
        throw new ValidationError(`Product ${product.name} (${product.sku}) is currently inactive`);
      }
      orderItemsToCreate.push({
        productId: product.id,
        nameSnapshot: product.name,
        unitPriceMinor: product.price_minor,
        qty: item.qty,
      });
      totalMinor += product.price_minor * item.qty;
    }

    const orderId = CryptoUtils.generateId('ord');

    // 3. Atomically reserve inventory
    // If any item fails, reserveStock rolls back all held reservations and throws InsufficientInventoryError
    await this.inventoryService.reserveStock(
      input.items.map((i) => ({ productId: i.productId, qty: i.qty })),
      orderId,
      input.ttlMinutes ?? 15
    );

    // 4. Create Order & Order Items
    const order = await this.db.transaction(async (tx) => {
      const orderRes = await tx.query<Order>(
        `INSERT INTO orders (id, customer_id, status, total_minor, currency, idempotency_key, created_at, updated_at)
         VALUES ($1, $2, 'awaiting_payment', $3, $4, $5, NOW(), NOW())
         RETURNING id, customer_id, status, total_minor, currency, idempotency_key, created_at, updated_at`,
        [orderId, input.customerId, totalMinor, currency, input.idempotencyKey]
      );

      const createdItems: OrderItem[] = [];
      for (const item of orderItemsToCreate) {
        const itemId = CryptoUtils.generateId('itm');
        const itemRes = await tx.query<OrderItem>(
          `INSERT INTO order_items (id, order_id, product_id, name_snapshot, unit_price_minor, qty)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, order_id, product_id, name_snapshot, unit_price_minor, qty`,
          [itemId, orderId, item.productId, item.nameSnapshot, item.unitPriceMinor, item.qty]
        );
        createdItems.push(itemRes.rows[0]);
      }

      const createdOrder = orderRes.rows[0];
      createdOrder.items = createdItems;
      return createdOrder;
    });

    if (this.auditService && actor) {
      await this.auditService.record({
        actorId: actor.actorId,
        actorType: actor.actorType,
        action: 'order.created',
        entity: 'order',
        entityId: order.id,
        after: { status: order.status, total: order.total_minor },
      });
    }

    return order;
  }

  public async getOrder(orderId: string): Promise<Order> {
    const res = await this.db.query<Order>(
      'SELECT id, customer_id, status, total_minor, currency, idempotency_key, created_at, updated_at FROM orders WHERE id = $1',
      [orderId]
    );
    if (res.rowCount === 0) {
      throw new NotFoundError('Order', orderId);
    }
    const order = res.rows[0];
    order.items = await this.getOrderItems(orderId);
    return order;
  }

  public async getOrderItems(orderId: string): Promise<OrderItem[]> {
    const res = await this.db.query<OrderItem>(
      'SELECT id, order_id, product_id, name_snapshot, unit_price_minor, qty FROM order_items WHERE order_id = $1',
      [orderId]
    );
    return res.rows;
  }

  public async listOrders(options: { customerId?: string; status?: OrderStatus; limit?: number; offset?: number } = {}): Promise<Order[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (options.customerId) {
      conditions.push(`customer_id = $${idx++}`);
      params.push(options.customerId);
    }
    if (options.status) {
      conditions.push(`status = $${idx++}`);
      params.push(options.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    params.push(limit, offset);

    const res = await this.db.query<Order>(
      `SELECT id, customer_id, status, total_minor, currency, idempotency_key, created_at, updated_at 
       FROM orders ${where} 
       ORDER BY created_at DESC 
       LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );

    return res.rows;
  }

  public async cancelOrder(orderId: string, actor?: ActorContext): Promise<Order> {
    const order = await this.getOrder(orderId);

    // Idempotent: repeating cancel on an already canceled order succeeds quietly
    if (order.status === 'cancelled') {
      return order;
    }

    StateMachine.validateOrderTransition(order.status, 'cancelled');

    let cancelledOrder: Order;

    await this.db.transaction(async (tx) => {
      if (order.status === 'paid') {
        // 1. Restock committed inventory: on_hand += qty, status = 'released' inside transaction
        await this.inventoryService.restockCommittedOrder(orderId, tx);

        // 2. Fetch the succeeded payment intent
        const intentRes = await tx.query<PaymentIntent>(
          "SELECT id, order_id, provider, provider_ref, amount_minor, currency, status FROM payment_intents WHERE order_id = $1 AND status = 'succeeded' FOR UPDATE",
          [orderId]
        );

        // 3. Write refund to the outbox inside the EXACT SAME transaction as the restock and status change
        if (intentRes.rowCount > 0) {
          const intent = intentRes.rows[0];
          await this.outboxService.writeEvent(
            'payment.order_cancellation_refund',
            {
              orderId: order.id,
              intentId: intent.id,
              amountMinor: intent.amount_minor,
              customerId: order.customer_id,
              provider: intent.provider,
              reference: intent.provider_ref,
            },
            tx
          );
        }
      } else {
        // Release held reservations inside transaction
        await this.inventoryService.releaseReservations(orderId, tx);
      }

      const res = await tx.query<Order>(
        "UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING id, customer_id, status, total_minor, currency, idempotency_key, created_at, updated_at",
        [orderId]
      );
      cancelledOrder = res.rows[0];
    });

    cancelledOrder!.items = await this.getOrderItems(orderId);

    if (this.auditService && actor && typeof actor === 'object' && actor.actorId && actor.actorType) {
      await this.auditService.record({
        actorId: actor.actorId,
        actorType: actor.actorType,
        action: 'order.cancelled',
        entity: 'order',
        entityId: orderId,
        before: { status: order.status },
        after: { status: 'cancelled' },
      });
    }

    return cancelledOrder;
  }

  public async updateOrderStatus(
    orderId: string,
    nextStatus: OrderStatus,
    actor?: ActorContext,
    externalTx?: IDatabaseClient
  ): Promise<Order> {
    if (nextStatus === 'paid') {
      const isExplicitSystemWebhook =
        (actor?.actorType === 'system' || actor?.actorType === 'webhook') && Boolean(actor?.actorId);
      if (!isExplicitSystemWebhook) {
        throw new ValidationError(
          "Manual transition to 'paid' status is forbidden. Orders can only be marked paid via an explicit system/webhook context."
        );
      }
    }

    const dbClient = externalTx || this.db;
    const order = await this.getOrder(orderId);
    if (order.status === nextStatus) {
      return order;
    }

    StateMachine.validateOrderTransition(order.status, nextStatus);

    const res = await dbClient.query<Order>(
      'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, customer_id, status, total_minor, currency, idempotency_key, created_at, updated_at',
      [nextStatus, orderId]
    );

    const updated = res.rows[0];
    updated.items = await this.getOrderItems(orderId);

    if (this.auditService && actor) {
      await this.auditService.record({
        actorId: actor.actorId,
        actorType: actor.actorType,
        action: 'order.status_updated',
        entity: 'order',
        entityId: orderId,
        before: { status: order.status },
        after: { status: nextStatus },
      });
    }

    return updated;
  }
}

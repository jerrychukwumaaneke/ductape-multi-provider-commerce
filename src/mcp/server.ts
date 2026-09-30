import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { IDatabaseClient } from '../common/database/index.js';
import { AppError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../common/errors/app-error.js';
import { Currency, Order, OrderStatus, Product, TransactionRecord } from '../common/types/index.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { IdentityService } from '../modules/identity/identity.service.js';
import { InventoryService } from '../modules/inventory/inventory.service.js';
import { NotificationService } from '../modules/notifications/notifications.service.js';
import { CheckoutSaga } from '../modules/orders/checkout-saga.js';
import { OrderService } from '../modules/orders/orders.service.js';
import { PaymentService } from '../modules/payments/payments.service.js';
import { ToolSchemas, ToolName } from './tools.js';
import {
  AgentAuthContext,
  CancelOrderParams,
  CreateCheckoutParams,
  GetDeliveryStatusParams,
  GetOrderParams,
  GetPaymentStatusParams,
  ListOrdersParams,
  ListTransactionsParams,
  McpResponseEnvelope,
  RefundPaymentParams,
  ResendNotificationParams,
  SearchProductsParams,
} from './types.js';

export interface McpCommerceServerOptions {
  name?: string;
  version?: string;
}

export class McpCommerceServer {
  public readonly mcpServer: Server;

  constructor(
    private readonly db: IDatabaseClient,
    private readonly identityService: IdentityService,
    private readonly orderService: OrderService,
    private readonly inventoryService: InventoryService,
    private readonly paymentService: PaymentService,
    private readonly notificationService: NotificationService,
    private readonly checkoutSaga: CheckoutSaga,
    private readonly auditService: AuditService,
    options: McpCommerceServerOptions = {}
  ) {
    this.mcpServer = new Server(
      {
        name: options.name || 'commerce-backend-mcp',
        version: options.version || '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.registerMcpHandlers();
  }

  // =================== AUTH & PERMISSIONS ===================

  public verifyAgentToken(token: string): AgentAuthContext {
    const payload = this.identityService.verifyToken(token);
    if (payload.actorType !== 'agent' && payload.role !== 'admin') {
      throw new ForbiddenError('Only agent or admin tokens are authorized for the MCP interface.');
    }

    return {
      agentId: payload.sub,
      role: payload.role,
      customerId: payload.customerId ?? undefined,
      scope: payload.scope ?? ['*'],
    };
  }

  private hasWriteAccess(ctx: AgentAuthContext): boolean {
    if (ctx.role === 'admin') return true;
    if (ctx.scope.includes('*') || ctx.scope.includes('read_write')) return true;
    return false;
  }

  private hasElevatedAccess(ctx: AgentAuthContext): boolean {
    if (ctx.role === 'admin') return true;
    if (ctx.scope.includes('*') || ctx.scope.includes('admin') || ctx.scope.includes('payments:refund')) return true;
    return false;
  }

  // =================== DIRECT EXECUTION API ===================

  public async executeTool<T = unknown>(
    toolName: ToolName | string,
    params: Record<string, unknown>,
    auth: AgentAuthContext | string
  ): Promise<McpResponseEnvelope<T>> {
    const ctx = typeof auth === 'string' ? this.verifyAgentToken(auth) : auth;

    try {
      let data: unknown;
      let hasMore: boolean | undefined;

      switch (toolName) {
        case 'search_products': {
          const parsed = ToolSchemas.search_products.parameters.parse(params);
          const result = await this.searchProducts(parsed, ctx);
          data = result.products;
          hasMore = result.has_more;
          break;
        }

        case 'get_order': {
          const parsed = ToolSchemas.get_order.parameters.parse(params);
          data = await this.getOrder(parsed, ctx);
          break;
        }

        case 'list_orders': {
          const parsed = ToolSchemas.list_orders.parameters.parse(params);
          const result = await this.listOrders(parsed, ctx);
          data = result.orders;
          hasMore = result.has_more;
          break;
        }

        case 'create_checkout': {
          if (!this.hasWriteAccess(ctx)) {
            return {
              success: false,
              error: {
                code: 'FORBIDDEN',
                message: "Agent scope 'read_only' is not authorized to create checkouts.",
                hint: "Use an agent token with 'read_write' or '*' scope.",
              },
            };
          }
          const parsed = ToolSchemas.create_checkout.parameters.parse(params);
          data = await this.createCheckout(parsed, ctx);
          break;
        }

        case 'cancel_order': {
          if (!this.hasWriteAccess(ctx)) {
            return {
              success: false,
              error: {
                code: 'FORBIDDEN',
                message: "Agent scope 'read_only' is not authorized to cancel orders.",
                hint: "Use an agent token with 'read_write' or '*' scope.",
              },
            };
          }
          const parsed = ToolSchemas.cancel_order.parameters.parse(params);
          data = await this.cancelOrder(parsed, ctx);
          break;
        }

        case 'get_payment_status': {
          const parsed = ToolSchemas.get_payment_status.parameters.parse(params);
          data = await this.getPaymentStatus(parsed, ctx);
          break;
        }

        case 'list_transactions': {
          const parsed = ToolSchemas.list_transactions.parameters.parse(params);
          const result = await this.listTransactions(parsed, ctx);
          data = result.transactions;
          hasMore = result.has_more;
          break;
        }

        case 'refund_payment': {
          const parsed = ToolSchemas.refund_payment.parameters.parse(params);
          if (!parsed.confirm) {
            return {
              success: false,
              error: {
                code: 'CONFIRMATION_REQUIRED',
                message: 'Refund is a destructive action requiring explicit confirmation.',
                hint: 'Pass confirm: true in tool arguments to proceed.',
              },
            };
          }
          if (!this.hasElevatedAccess(ctx)) {
            return {
              success: false,
              error: {
                code: 'FORBIDDEN',
                message: 'Agent lacks elevated refund privileges.',
                hint: "Requires 'admin' or 'payments:refund' scope.",
              },
            };
          }
          data = await this.refundPayment(parsed, ctx);
          break;
        }

        case 'resend_notification': {
          if (!this.hasWriteAccess(ctx)) {
            return {
              success: false,
              error: {
                code: 'FORBIDDEN',
                message: "Agent scope 'read_only' is not authorized to resend notifications.",
                hint: "Use an agent token with 'read_write' or '*' scope.",
              },
            };
          }
          const parsed = ToolSchemas.resend_notification.parameters.parse(params);
          data = await this.resendNotification(parsed, ctx);
          break;
        }

        case 'get_delivery_status': {
          const parsed = ToolSchemas.get_delivery_status.parameters.parse(params);
          data = await this.getDeliveryStatus(parsed, ctx);
          break;
        }

        default:
          return {
            success: false,
            error: {
              code: 'UNKNOWN_TOOL',
              message: `Unknown tool name: '${toolName}'`,
              hint: `Available tools: ${Object.keys(ToolSchemas).join(', ')}`,
            },
          };
      }

      return {
        success: true,
        data: data as T,
        ...(hasMore !== undefined ? { has_more: hasMore } : {}),
      };
    } catch (err: unknown) {
      if (err instanceof AppError) {
        return {
          success: false,
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
            hint: err.hint,
          },
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: {
          code: 'EXECUTION_FAILED',
          message,
          hint: 'Verify tool input arguments against schema.',
        },
      };
    }
  }

  // =================== TOOL IMPLEMENTATIONS ===================

  private async searchProducts(
    params: SearchProductsParams,
    _ctx: AgentAuthContext
  ): Promise<{ products: Array<Product & { available_stock: number }>; has_more: boolean }> {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const offset = Math.max(params.offset ?? 0, 0);

    const conditions: string[] = ['p.active = TRUE'];
    const queryParams: unknown[] = [];
    let pIdx = 1;

    if (params.query && params.query.trim().length > 0) {
      conditions.push(`(p.name ILIKE $${pIdx} OR p.sku ILIKE $${pIdx})`);
      queryParams.push(`%${params.query.trim()}%`);
      pIdx++;
    }

    queryParams.push(limit + 1);
    const limitParam = pIdx++;
    queryParams.push(offset);
    const offsetParam = pIdx++;

    const sql = `
      SELECT p.id, p.sku, p.name, p.price_minor, p.currency, p.active, p.created_at,
             COALESCE(i.on_hand, 0) as on_hand,
             COALESCE(i.reserved, 0) as reserved
      FROM products p
      LEFT JOIN inventory i ON p.id = i.product_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;

    const res = await this.db.query<{
      id: string;
      sku: string;
      name: string;
      price_minor: number;
      currency: Currency;
      active: boolean;
      created_at: Date;
      on_hand: number;
      reserved: number;
    }>(sql, queryParams);

    const hasMore = res.rows.length > limit;
    const items = hasMore ? res.rows.slice(0, limit) : res.rows;

    const products = items.map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      price_minor: r.price_minor,
      currency: r.currency,
      active: r.active,
      created_at: r.created_at,
      available_stock: Math.max(0, Number(r.on_hand) - Number(r.reserved)),
    }));

    return { products, has_more: hasMore };
  }

  private async getOrder(params: GetOrderParams, ctx: AgentAuthContext): Promise<Order> {
    const order = await this.orderService.getOrder(params.order_id);

    // Isolation check: customer-scoped agents cannot access other customers' orders
    if (ctx.customerId && order.customer_id !== ctx.customerId && ctx.role !== 'admin') {
      throw new ForbiddenError(`Agent customer scope '${ctx.customerId}' cannot access order for customer '${order.customer_id}'`);
    }

    return order;
  }

  private async listOrders(
    params: ListOrdersParams,
    ctx: AgentAuthContext
  ): Promise<{ orders: Order[]; has_more: boolean }> {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const offset = Math.max(params.offset ?? 0, 0);

    let customerId = params.customer_id;
    if (ctx.customerId) {
      if (customerId && customerId !== ctx.customerId && ctx.role !== 'admin') {
        throw new ForbiddenError(`Agent scoped to customer '${ctx.customerId}' cannot query other customers' orders.`);
      }
      customerId = ctx.customerId;
    }

    const conditions: string[] = [];
    const queryParams: unknown[] = [];
    let pIdx = 1;

    if (customerId) {
      conditions.push(`customer_id = $${pIdx++}`);
      queryParams.push(customerId);
    }
    if (params.status) {
      conditions.push(`status = $${pIdx++}`);
      queryParams.push(params.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    queryParams.push(limit + 1);
    const limitParam = pIdx++;
    queryParams.push(offset);
    const offsetParam = pIdx++;

    const res = await this.db.query<Order>(
      `SELECT id, customer_id, status, total_minor, currency, idempotency_key, created_at, updated_at
       FROM orders ${where}
       ORDER BY created_at DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      queryParams
    );

    const hasMore = res.rows.length > limit;
    const orders = hasMore ? res.rows.slice(0, limit) : res.rows;

    return { orders, has_more: hasMore };
  }

  private async createCheckout(
    params: CreateCheckoutParams,
    ctx: AgentAuthContext
  ): Promise<{
    order: Order;
    payment_intent_id: string;
    amount_minor: number;
    currency: string;
    checkout_url?: string;
  }> {
    const customerId = ctx.customerId || 'cus_agent_default';
    const email = params.email || `${customerId}@customer.internal`;

    const result = await this.checkoutSaga.executeCheckout(
      {
        customerId,
        email,
        items: params.items,
        idempotencyKey: params.idempotency_key,
        currency: params.currency || 'USD',
        provider: params.provider,
      },
      {
        actorId: ctx.agentId,
        actorType: 'agent',
        customerId: ctx.customerId,
        role: ctx.role,
        scope: ctx.scope,
      }
    );

    await this.auditService.record({
      actorId: ctx.agentId,
      actorType: 'agent',
      action: 'agent.create_checkout',
      entity: 'order',
      entityId: result.order.id,
      after: {
        total_minor: result.order.total_minor,
        acting_customer_id: ctx.customerId,
        payment_intent_id: result.paymentIntent.id,
      },
    });

    return {
      order: result.order,
      payment_intent_id: result.paymentIntent.id,
      amount_minor: result.paymentIntent.amount_minor,
      currency: result.paymentIntent.currency,
      checkout_url: result.checkoutUrl,
    };
  }

  private async cancelOrder(
    params: CancelOrderParams,
    ctx: AgentAuthContext
  ): Promise<{ order_id: string; status: OrderStatus; message: string }> {
    const order = await this.orderService.getOrder(params.order_id);

    if (ctx.customerId && order.customer_id !== ctx.customerId && ctx.role !== 'admin') {
      throw new ForbiddenError(`Agent customer scope '${ctx.customerId}' cannot cancel order belonging to '${order.customer_id}'`);
    }

    const cancelledOrder = await this.orderService.cancelOrder(params.order_id, {
      actorId: ctx.agentId,
      actorType: 'agent',
      customerId: ctx.customerId,
      role: ctx.role,
      scope: ctx.scope,
    });

    await this.auditService.record({
      actorId: ctx.agentId,
      actorType: 'agent',
      action: 'agent.cancel_order',
      entity: 'order',
      entityId: order.id,
      before: { status: order.status },
      after: { status: cancelledOrder.status, reason: params.reason },
    });

    return {
      order_id: cancelledOrder.id,
      status: cancelledOrder.status,
      message: 'Order cancelled successfully and held inventory released.',
    };
  }

  private async getPaymentStatus(
    params: GetPaymentStatusParams,
    ctx: AgentAuthContext
  ): Promise<{
    payment_intent_id: string;
    order_id: string;
    status: string;
    amount_minor: number;
    currency: string;
    provider: string;
    provider_ref?: string | null;
  }> {
    let intent;
    if (params.payment_intent_id) {
      intent = await this.paymentService.getPaymentIntent(params.payment_intent_id);
    } else if (params.order_id) {
      const res = await this.db.query(
        'SELECT id, order_id, provider, provider_ref, amount_minor, currency, status, idempotency_key, created_at, updated_at FROM payment_intents WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
        [params.order_id]
      );
      if (res.rowCount === 0) {
        throw new NotFoundError('PaymentIntent for Order', params.order_id);
      }
      intent = res.rows[0] as any;
    } else {
      throw new ValidationError('Either payment_intent_id or order_id must be provided');
    }

    // Customer isolation check
    const order = await this.orderService.getOrder(intent.order_id);
    if (ctx.customerId && order.customer_id !== ctx.customerId && ctx.role !== 'admin') {
      throw new ForbiddenError(`Agent scoped to customer '${ctx.customerId}' cannot access payment for order '${order.id}'`);
    }

    return {
      payment_intent_id: intent.id,
      order_id: intent.order_id,
      status: intent.status,
      amount_minor: intent.amount_minor,
      currency: intent.currency,
      provider: intent.provider,
      provider_ref: intent.provider_ref,
    };
  }

  private async listTransactions(
    params: ListTransactionsParams,
    ctx: AgentAuthContext
  ): Promise<{ transactions: TransactionRecord[]; has_more: boolean }> {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);

    let paymentIntentId = params.payment_intent_id;
    if (!paymentIntentId && params.order_id) {
      const res = await this.db.query<{ id: string }>(
        'SELECT id FROM payment_intents WHERE order_id = $1 LIMIT 1',
        [params.order_id]
      );
      if (res.rowCount > 0) {
        paymentIntentId = res.rows[0].id;
      }
    }

    if (paymentIntentId) {
      const intent = await this.paymentService.getPaymentIntent(paymentIntentId);
      const order = await this.orderService.getOrder(intent.order_id);
      if (ctx.customerId && order.customer_id !== ctx.customerId && ctx.role !== 'admin') {
        throw new ForbiddenError('Unauthorized to view transactions for this order');
      }
    }

    const allTxns = await this.paymentService.listTransactions(paymentIntentId);
    const hasMore = allTxns.length > limit;
    const transactions = hasMore ? allTxns.slice(0, limit) : allTxns;

    return { transactions, has_more: hasMore };
  }

  private async refundPayment(
    params: RefundPaymentParams,
    ctx: AgentAuthContext
  ): Promise<{
    payment_intent_id: string;
    refunded_amount_minor: number;
    provider_status: string;
    provider_ref: string;
  }> {
    const intent = await this.paymentService.getPaymentIntent(params.payment_intent_id);
    const refundRes = await this.paymentService.refundPayment(params.payment_intent_id, params.amount_minor);

    await this.auditService.record({
      actorId: ctx.agentId,
      actorType: 'agent',
      action: 'payment.refund',
      entity: 'payment_intent',
      entityId: intent.id,
      after: {
        refunded_amount_minor: params.amount_minor ?? intent.amount_minor,
        acting_customer_id: ctx.customerId,
        reason: params.reason,
      },
    });

    return {
      payment_intent_id: intent.id,
      refunded_amount_minor: params.amount_minor ?? intent.amount_minor,
      provider_status: refundRes.status,
      provider_ref: refundRes.reference,
    };
  }

  private async resendNotification(
    params: ResendNotificationParams,
    ctx: AgentAuthContext
  ): Promise<{ notification_id: string; status: string; recipient: string }> {
    let resultRecord;

    if (params.notification_id) {
      const { notification } = await this.notificationService.getNotification(params.notification_id);
      resultRecord = await this.notificationService.send({
        template_key: notification.template_key,
        recipient: notification.recipient,
        vars: (notification.vars || {}) as Record<string, string>,
        idempotency_key: params.idempotency_key || `resend_${params.notification_id}_${Date.now()}`,
      });
    } else if (params.template_key && params.recipient) {
      resultRecord = await this.notificationService.send({
        template_key: params.template_key,
        recipient: params.recipient,
        vars: params.vars || {},
        idempotency_key: params.idempotency_key,
      });
    } else {
      throw new ValidationError('Either notification_id or both template_key and recipient must be provided.');
    }

    await this.auditService.record({
      actorId: ctx.agentId,
      actorType: 'agent',
      action: 'notification.resend',
      entity: 'notification',
      entityId: resultRecord.id,
      after: { recipient: resultRecord.recipient, status: resultRecord.status },
    });

    return {
      notification_id: resultRecord.id,
      status: resultRecord.status,
      recipient: resultRecord.recipient,
    };
  }

  private async getDeliveryStatus(
    params: GetDeliveryStatusParams,
    _ctx: AgentAuthContext
  ): Promise<{
    notification_id: string;
    channel: string;
    recipient: string;
    status: string;
    attempt_count: number;
    attempts: unknown[];
  }> {
    const { notification, attempts } = await this.notificationService.getNotification(params.notification_id);

    return {
      notification_id: notification.id,
      channel: notification.channel,
      recipient: notification.recipient,
      status: notification.status,
      attempt_count: attempts.length,
      attempts: attempts.map((a) => ({
        attempt_no: a.attempt_no,
        outcome: a.outcome,
        error: a.error,
        at: a.at,
      })),
    };
  }

  // =================== MCP PROTOCOL HANDLERS ===================

  private registerMcpHandlers(): void {
    // List Tools
    this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = Object.entries(ToolSchemas).map(([name, schema]) => ({
        name,
        description: schema.description,
        inputSchema: {
          type: 'object',
          // JSON Schema representation
        },
      }));

      return { tools };
    });

    // Call Tool
    this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Default internal agent context for standard MCP channel calls
      const defaultAgentCtx: AgentAuthContext = {
        agentId: 'mcp-agent-session',
        role: 'agent',
        scope: ['*'],
      };

      const envelope = await this.executeTool(name, args || {}, defaultAgentCtx);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(envelope, null, 2),
          },
        ],
        isError: !envelope.success,
      };
    });
  }
}

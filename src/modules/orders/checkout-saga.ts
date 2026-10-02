import { IDatabaseClient } from '../../common/database/index.js';
import { ActorContext, Order, PaymentIntent } from '../../common/types/index.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { NotificationService } from '../notifications/notifications.service.js';
import { PaymentService, WebhookResult } from '../payments/payments.service.js';
import { OrderService, OrderItemInput } from './orders.service.js';
import { AuditService } from '../audit/audit.service.js';

export interface CheckoutInput {
  customerId: string;
  email: string;
  items: OrderItemInput[];
  idempotencyKey: string;
  currency?: string;
  provider?: string;
  callbackUrl?: string;
  ttlMinutes?: number;
}

export interface CheckoutResult {
  order: Order;
  paymentIntent: PaymentIntent;
  checkoutUrl?: string;
}

export class CheckoutSaga {
  constructor(
    private readonly db: IDatabaseClient,
    private readonly orderService: OrderService,
    private readonly inventoryService: InventoryService,
    private readonly paymentService: PaymentService,
    private readonly notificationService: NotificationService,
    private readonly idempotencyService: IdempotencyService,
    private readonly auditService?: AuditService
  ) {
    // Register transactional outbox handlers
    const outbox = this.paymentService.getOutboxService();
    outbox.registerHandler('inventory.release', async (payload) => {
      await this.inventoryService.releaseReservations(payload.orderId);
    });
    outbox.registerHandler('payment.duplicate_refund', async (payload, outboxId) => {
      await this.paymentService.refundPayment(payload.intentId, payload.amountMinor, outboxId);
    });
    outbox.registerHandler('payment.late_refund', async (payload, outboxId) => {
      await this.paymentService.refundPayment(payload.intentId, payload.amountMinor, outboxId);
    });
    outbox.registerHandler('payment.order_cancellation_refund', async (payload, outboxId) => {
      await this.paymentService.refundPayment(payload.intentId, payload.amountMinor, outboxId);
    });
    outbox.registerHandler('notification.send', async (payload) => {
      const record = await this.notificationService.send(payload);
      if (record.status === 'failed') {
        throw new Error(`Notification delivery failed for notification ${record.id} (template: ${record.template_key})`);
      }
    });
    outbox.registerHandler('notification.dead_letter', async (payload) => {
      await this.notificationService.recordDeadLetter(payload);
    });
  }

  public async executeCheckout(input: CheckoutInput, actor?: ActorContext): Promise<CheckoutResult> {
    const idempResult = await this.idempotencyService.runIdempotent(
      input.idempotencyKey,
      'checkout',
      { customerId: input.customerId, items: input.items, currency: input.currency },
      async () => {
        // 1. Create order & reserve stock atomically
        const order = await this.orderService.createOrder(
          {
            customerId: input.customerId,
            items: input.items,
            idempotencyKey: input.idempotencyKey,
            currency: input.currency,
            ttlMinutes: input.ttlMinutes ?? 15,
          },
          actor
        );

        // 2. Create Payment Intent (with Step 2->3 safety: release stock and fail order if createPayment throws)
        try {
          const paymentRes = await this.paymentService.createPaymentIntent({
            orderId: order.id,
            amountMinor: order.total_minor,
            currency: order.currency,
            email: input.email,
            idempotencyKey: `pi_${input.idempotencyKey}`,
            provider: input.provider,
            callbackUrl: input.callbackUrl,
          });

          return {
            order,
            paymentIntent: paymentRes.paymentIntent,
            checkoutUrl: paymentRes.checkoutUrl,
          };
        } catch (err) {
          // Requirement 4: Release stock and fail the order if createPayment throws
          await this.inventoryService.releaseReservations(order.id).catch((relErr) => {
            console.error(`[CheckoutSaga] Failed to release reservations for order ${order.id}:`, relErr);
          });
          await this.orderService
            .updateOrderStatus(order.id, 'payment_failed', { actorId: 'system', actorType: 'system' })
            .catch((ordErr) => {
              console.error(`[CheckoutSaga] Failed to update order status to payment_failed for order ${order.id}:`, ordErr);
            });
          throw err;
        }
      }
    );

    return idempResult.data;
  }

  public async processPaymentWebhook(
    providerName: string,
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
    payload: unknown
  ): Promise<WebhookResult> {
    // 1. Ingest & verify webhook inside ONE atomic database transaction
    const webhookRes: WebhookResult = await this.paymentService.handleWebhook(
      providerName,
      rawBody,
      headers,
      payload,
      async (tx, intent) => {
        // Normal success path: commit reservations in the SAME database transaction!
        await this.inventoryService.commitReservations(intent.order_id, tx);
      }
    );

    // Promptly execute outbox worker for pending tasks (refund, release, notification)
    const outbox = this.paymentService.getOutboxService();
    await outbox.processPending().catch((err) => {
      console.error('[CheckoutSaga] Error processing outbox events:', err);
    });

    // Record audit log if audit service is available
    if (this.auditService && webhookRes.order) {
      const action =
        webhookRes.order.status === 'paid'
          ? 'order.paid'
          : webhookRes.latePaymentRefunded
          ? 'payment.late_auto_refund'
          : webhookRes.secondPaymentRefunded
          ? 'payment.duplicate_auto_refund'
          : `order.${webhookRes.order.status}`;

      await this.auditService.record({
        actorId: 'webhook',
        actorType: 'system',
        action,
        entity: 'order',
        entityId: webhookRes.order.id,
        after: { status: webhookRes.order.status },
      }).catch((audErr) => {
        console.error('[CheckoutSaga] Audit record error:', audErr);
      });
    }

    return webhookRes;
  }

  public async handlePaymentReturn(
    reference: string,
    providerName?: string
  ): Promise<{
    success: boolean;
    status: string;
    orderId?: string;
    reference: string;
    order?: Order;
    paymentIntent?: PaymentIntent;
    message: string;
  }> {
    const result = await this.paymentService.verifyAndReconcilePayment(
      reference,
      providerName,
      async (tx, intent) => {
        await this.inventoryService.commitReservations(intent.order_id, tx);
      }
    );

    const outbox = this.paymentService.getOutboxService();
    await outbox.processPending().catch((err) => {
      console.error('[CheckoutSaga] Error processing outbox events after payment return:', err);
    });

    if (this.auditService && result.order) {
      const action = result.order.status === 'paid' ? 'order.paid' : `order.${result.order.status}`;
      await this.auditService.record({
        actorId: 'customer_return',
        actorType: 'system',
        action,
        entity: 'order',
        entityId: result.order.id,
        after: { status: result.order.status },
      }).catch((audErr) => {
        console.error('[CheckoutSaga] Audit record error on return:', audErr);
      });
    }

    const orderStatus = result.order?.status || result.paymentIntent?.status || 'processing';
    const isPaid = orderStatus === 'paid' || result.paymentIntent?.status === 'succeeded';

    return {
      success: isPaid,
      status: isPaid ? 'succeeded' : orderStatus,
      orderId: result.order?.id || result.paymentIntent?.order_id,
      reference,
      order: result.order,
      paymentIntent: result.paymentIntent,
      message: isPaid
        ? 'Payment successful and verified. Order confirmed!'
        : `Payment status is ${orderStatus}.`,
    };
  }
}

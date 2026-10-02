import { IDatabaseClient } from '../../common/database/index.js';
import { CryptoUtils } from '../../common/utils/crypto.js';
import { NotFoundError, UnauthorizedError, ValidationError, PaymentFailedError, AppError, ProviderApiError } from '../../common/errors/app-error.js';
import { StateMachine } from '../../common/state-machine/index.js';
import { PaymentIntent, TransactionRecord, PaymentIntentStatus, Order } from '../../common/types/index.js';
import { PaymentRouter } from './router.js';
import { NormalizedEvent, PaymentProvider, ProviderPayment, ProviderRefund } from './types.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { sanitizeTransactionRawResponse } from './sanitize-response.js';

export interface CreatePaymentIntentInput {
  orderId: string;
  amountMinor: number;
  currency: string;
  email: string;
  idempotencyKey: string;
  provider?: string;
  callbackUrl?: string;
}

export interface WebhookResult {
  duplicate: boolean;
  event: NormalizedEvent;
  verifiedPayment?: ProviderPayment;
  paymentIntent?: PaymentIntent;
  order?: Order;
  ignored?: boolean;
  refunded?: boolean;
  latePaymentRefunded?: boolean;
  secondPaymentRefunded?: boolean;
}

export class PaymentService {
  private readonly outboxService: OutboxService;
  private readonly inventoryService: InventoryService;
  private isReconciling = false;

  constructor(
    private readonly db: IDatabaseClient,
    private readonly router: PaymentRouter,
    outboxService?: OutboxService,
    inventoryService?: InventoryService
  ) {
    this.outboxService = outboxService ?? new OutboxService(db);
    this.inventoryService = inventoryService ?? new InventoryService(db);
    this.registerDefaultHandlers();
  }

  private registerDefaultHandlers(): void {
    this.outboxService.registerHandler('payment.duplicate_refund', async (payload, outboxId) => {
      await this.refundPayment(payload.intentId, payload.amountMinor, outboxId);
    });
    this.outboxService.registerHandler('payment.late_refund', async (payload, outboxId) => {
      await this.refundPayment(payload.intentId, payload.amountMinor, outboxId);
    });
    this.outboxService.registerHandler('payment.order_cancellation_refund', async (payload, outboxId) => {
      await this.refundPayment(payload.intentId, payload.amountMinor, outboxId);
    });
  }

  public getOutboxService(): OutboxService {
    return this.outboxService;
  }

  public getInventoryService(): InventoryService {
    return this.inventoryService;
  }

  public getPaymentRouter(): PaymentRouter {
    return this.router;
  }

  public async createPaymentIntent(input: CreatePaymentIntentInput): Promise<{
    paymentIntent: PaymentIntent;
    checkoutUrl?: string;
  }> {
    // 1. Idempotency check on payment_intents
    const existing = await this.db.query<PaymentIntent>(
      'SELECT id, order_id, provider, provider_ref, amount_minor, currency, status, idempotency_key, created_at, updated_at FROM payment_intents WHERE idempotency_key = $1',
      [input.idempotencyKey]
    );
    if (existing.rowCount > 0) {
      return { paymentIntent: existing.rows[0] };
    }

    // 2. Resolve Candidate Providers
    const candidates = this.router.resolveCandidates({
      preferredProvider: input.provider,
      currency: input.currency,
    });

    if (candidates.length === 0) {
      throw new PaymentFailedError('No suitable payment providers available');
    }

    const intentId = CryptoUtils.generateId('pi');
    const reference = `ref_${intentId}`;

    // Step 2->3 Safety: Persist the intent in DB with status 'processing' BEFORE calling candidate provider.
    // This prevents webhook-before-intent race conditions.
    const initialProvider = candidates[0];
    await this.db.query<PaymentIntent>(
      `INSERT INTO payment_intents (id, order_id, provider, provider_ref, amount_minor, currency, status, idempotency_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7, NOW(), NOW())`,
      [
        intentId,
        input.orderId,
        initialProvider.name,
        reference,
        input.amountMinor,
        input.currency.toUpperCase(),
        input.idempotencyKey,
      ]
    );

    let lastError: Error | null = null;
    let chosenProvider: PaymentProvider | null = null;
    let providerPayment: ProviderPayment | null = null;

    try {
      for (const provider of candidates) {
        try {
          if (provider.name !== initialProvider.name) {
            await this.db.query(
              'UPDATE payment_intents SET provider = $1, updated_at = NOW() WHERE id = $2',
              [provider.name, intentId]
            );
          }

          const payment = await provider.createPayment({
            orderId: input.orderId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            email: input.email,
            reference,
            callbackUrl: input.callbackUrl,
          });

          chosenProvider = provider;
          providerPayment = payment;
          break; // Successfully initialized
        } catch (err: any) {
          lastError = err;
          // Verify payment was confirmed NOT created to avoid double charging
          let paymentCreated = false;
          try {
            const verified = await provider.verifyPayment(reference);
            if (verified && (verified.status === 'succeeded' || verified.status === 'pending')) {
              paymentCreated = true;
            }
          } catch {
            paymentCreated = false;
          }

          if (paymentCreated) {
            throw new PaymentFailedError(`Payment initialization ambiguous on ${provider.name}. Failover aborted to prevent double charge.`);
          }

          // Safe to attempt next candidate
          continue;
        }
      }

      if (!chosenProvider || !providerPayment) {
        throw new PaymentFailedError(`All payment providers failed. Last error: ${lastError?.message}`);
      }
    } catch (err) {
      // Requirement 4: If createPayment throws, mark the pre-inserted intent failed
      await this.db.query(
        "UPDATE payment_intents SET status = 'failed', updated_at = NOW() WHERE id = $1",
        [intentId]
      ).catch((failErr) => {
        console.error('[PaymentService] Failed to mark payment intent failed:', failErr);
      });
      throw err;
    }

    // Sync provider reference if provider returned a custom reference
    if (providerPayment.reference && providerPayment.reference !== reference) {
      await this.db.query(
        'UPDATE payment_intents SET provider_ref = $1, updated_at = NOW() WHERE id = $2',
        [providerPayment.reference, intentId]
      );
    }

    const finalIntent = await this.getPaymentIntent(intentId);

    return {
      paymentIntent: finalIntent,
      checkoutUrl: providerPayment.checkoutUrl,
    };
  }

  public async getPaymentIntent(id: string): Promise<PaymentIntent> {
    const res = await this.db.query<PaymentIntent>(
      'SELECT id, order_id, provider, provider_ref, amount_minor, currency, status, idempotency_key, created_at, updated_at FROM payment_intents WHERE id = $1',
      [id]
    );
    if (res.rowCount === 0) {
      throw new NotFoundError('PaymentIntent', id);
    }
    return res.rows[0];
  }

  public async getPaymentIntentByReference(provider: string, reference: string): Promise<PaymentIntent | null> {
    const res = await this.db.query<PaymentIntent>(
      'SELECT id, order_id, provider, provider_ref, amount_minor, currency, status, idempotency_key, created_at, updated_at FROM payment_intents WHERE provider = $1 AND provider_ref = $2',
      [provider, reference]
    );
    return res.rowCount > 0 ? res.rows[0] : null;
  }

  public async handleWebhook(
    providerName: string,
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
    payload: unknown,
    onSuccessTx?: (tx: IDatabaseClient, intent: PaymentIntent, verifiedPayment: ProviderPayment) => Promise<void>
  ): Promise<WebhookResult> {
    const provider = this.router.getProvider(providerName);
    if (!provider) {
      throw new NotFoundError('PaymentProvider', providerName);
    }

    // 1. Signature Check
    const validSignature = provider.verifyWebhookSignature(rawBody, headers);
    if (!validSignature) {
      throw new UnauthorizedError('Invalid webhook signature');
    }

    // 2. Parse Event (using rawBody for fallback deterministic dedupe key)
    const event = provider.parseWebhookEvent(payload, rawBody);

    // 3. Fast-path: Ignore unknown events with 200 without attempting verification or DB writes
    if (event.type === 'unknown') {
      return { duplicate: false, event, ignored: true };
    }

    // 4. Fast-path: Handle refund callback (e.g. Paystack refund.processed)
    if (event.type === 'refund.success') {
      const evtId = CryptoUtils.generateId('evt');
      await this.db.query(
        `INSERT INTO webhook_events (id, provider, provider_event_id, type, payload, processed_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (provider, provider_event_id) DO NOTHING`,
        [evtId, provider.name, event.eventId, event.type, JSON.stringify(event.rawPayload)]
      );

      const intent = await this.getPaymentIntentByReference(provider.name, event.reference);
      if (intent) {
        // Extract the provider's refund ID from the event payload
        const providerRefundId = String(
          (event.rawPayload as any)?.data?.id ??
          (event.rawPayload as any)?.id ??
          event.eventId
        );

        const existingTxns = await this.listTransactions(intent.id);
        const refundTxns = existingTxns.filter((t) => t.type === 'refund');

        // Match on the provider's refund id, not amount (Item 2)
        const alreadyRecorded = refundTxns.some(
          (t) => t.provider_ref === providerRefundId || t.provider_ref === event.eventId
        );

        // Use the refund's own amount from the event or payload (Item 3)
        const refundAmount = Number((event.rawPayload as any)?.data?.amount ?? event.amountMinor ?? intent.amount_minor);
        const refundPayload = {
          ...((typeof event.rawPayload === 'object' && event.rawPayload !== null ? event.rawPayload : {}) as object),
          currency: intent.currency,
        };

        if (!alreadyRecorded) {
          const sanitizedRefund = sanitizeTransactionRawResponse(refundPayload, {
            id: providerRefundId,
            amount: refundAmount,
            currency: intent.currency,
            reference: intent.provider_ref ?? undefined,
            status: 'succeeded',
          });

          // Check if there is an in-flight 'pending' refund row for this intent
          const pendingRow = refundTxns.find((t) => t.status === 'pending');
          if (pendingRow) {
            await this.db.query(
              `UPDATE transactions SET status = 'succeeded', provider_ref = $1, amount_minor = $2, raw_response = $3 WHERE id = $4`,
              [providerRefundId, refundAmount, JSON.stringify(sanitizedRefund), pendingRow.id]
            );
          } else {
            // Allow multiple partial refunds while the sum stays <= the charge (Item 2)
            const totalSucceeded = refundTxns
              .filter((t) => t.status === 'succeeded')
              .reduce((sum, t) => sum + t.amount_minor, 0);

            if (totalSucceeded + refundAmount <= intent.amount_minor) {
              const txnId = CryptoUtils.generateId('txn');
              await this.db.query(
                `INSERT INTO transactions (id, payment_intent_id, type, amount_minor, status, provider_ref, raw_response, created_at)
                 VALUES ($1, $2, 'refund', $3, 'succeeded', $4, $5, NOW())`,
                [
                  txnId,
                  intent.id,
                  refundAmount,
                  providerRefundId,
                  JSON.stringify(sanitizedRefund),
                ]
              );
            }
          }
        }
      }

      return { duplicate: false, event, refunded: true };
    }

    // 5. Fast-path deduplicate check: if already processed and recorded, return duplicate
    const existingEvt = await this.db.query(
      'SELECT id FROM webhook_events WHERE provider = $1 AND provider_event_id = $2',
      [provider.name, event.eventId]
    );
    if (existingEvt.rowCount > 0) {
      return { duplicate: true, event };
    }

    // 6. Re-verify with provider API so webhook is not the sole source of truth
    const verifiedPayment = await provider.verifyPayment(event.reference);

    // Requirement 3: pending/abandoned/ongoing returns non-2xx (retry) WITHOUT recording the event in webhook_events
    if (
      verifiedPayment.status === 'pending' ||
      verifiedPayment.status === 'ongoing' ||
      verifiedPayment.status === 'abandoned'
    ) {
      throw new AppError(
        503,
        'PAYMENT_PENDING',
        `Payment status is '${verifiedPayment.status}' at provider. Webhook should be retried.`
      );
    }

    return this.processWebhookTransaction(provider, event, verifiedPayment, onSuccessTx);
  }

  public async processWebhookTransaction(
    provider: PaymentProvider,
    event: NormalizedEvent,
    verifiedPayment: ProviderPayment,
    onSuccessTx?: (tx: IDatabaseClient, intent: PaymentIntent, verifiedPayment: ProviderPayment) => Promise<void>
  ): Promise<WebhookResult> {
    // Requirement 4: No matching intent -> return 404 and do NOT record the event in webhook_events
    const intent = await this.getPaymentIntentByReference(provider.name, event.reference);
    if (!intent) {
      throw new NotFoundError('PaymentIntent', event.reference);
    }

    // 7. Atomic transaction: lock payment_intent FOR UPDATE first, dedupe, lock order, update intent, write outbox rows
    return this.db.transaction(async (tx) => {
      // 1. SELECT the payment_intent FOR UPDATE first (Item 1)
      const lockedIntentRes = await tx.query<PaymentIntent>(
        `SELECT id, order_id, provider, provider_ref, amount_minor, currency, status, idempotency_key, created_at, updated_at
         FROM payment_intents
         WHERE id = $1
         FOR UPDATE`,
        [intent.id]
      );
      if (lockedIntentRes.rowCount === 0) {
        throw new NotFoundError('PaymentIntent', intent.id);
      }
      const lockedIntent = lockedIntentRes.rows[0];

      // If it is already 'succeeded', return a no-op (Item 1)
      if (lockedIntent.status === 'succeeded') {
        const ordRes = await tx.query<Order>('SELECT * FROM orders WHERE id = $1', [lockedIntent.order_id]);
        return {
          duplicate: false,
          event,
          verifiedPayment,
          paymentIntent: lockedIntent,
          order: ordRes.rows[0],
          ignored: true,
        };
      }

      // 7a. Dedupe insert
      const evtId = CryptoUtils.generateId('evt');
      const insertRes = await tx.query(
        `INSERT INTO webhook_events (id, provider, provider_event_id, type, payload, processed_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING id`,
        [evtId, provider.name, event.eventId, event.type, JSON.stringify(event.rawPayload)]
      ).catch((err: any) => {
        if (err.message?.includes('unique') || err.message?.includes('duplicate key') || err.code === '23505') {
          return { rowCount: 0, rows: [] };
        }
        throw err;
      });

      if (insertRes.rowCount === 0) {
        return { duplicate: true, event };
      }

      // 7b. Lock order row FOR UPDATE inside webhook transaction (Requirement 11)
      const orderRes = await tx.query<Order>(
        'SELECT id, customer_id, status, total_minor, currency, idempotency_key, created_at, updated_at FROM orders WHERE id = $1 FOR UPDATE',
        [lockedIntent.order_id]
      );
      if (orderRes.rowCount === 0) {
        throw new NotFoundError('Order', lockedIntent.order_id);
      }
      const order = orderRes.rows[0];

      // 7c. Fetch customer info for notification recipient & name (Requirement 8 & Item 3)
      const custRes = await tx.query<{ id: string; email: string; name: string }>(
        'SELECT id, email, name FROM customers WHERE id = $1',
        [order.customer_id]
      );
      const customer = custRes.rows[0];

      // Helper to enqueue notification or dead-letter if customer row is missing (Item 3)
      const enqueueNotification = async (templateKey: string, vars: Record<string, unknown>, idempotencyKey?: string) => {
        if (!customer || !customer.email) {
          // Dead-letter the notification with an error (Item 3)
          await this.outboxService.writeEvent(
            'notification.dead_letter',
            {
              orderId: order.id,
              customerId: order.customer_id,
              error: `Customer record missing for customer ID: '${order.customer_id}'. Notification could not be delivered.`,
              templateKey,
              vars,
            },
            tx
          );
        } else {
          await this.outboxService.writeEvent(
            'notification.send',
            {
              template_key: templateKey,
              recipient: customer.email,
              idempotency_key: idempotencyKey,
              vars: {
                ...vars,
                customer_name: customer.name,
              },
            },
            tx
          );
        }
      };

      // Case A: Order is ALREADY paid -> check if a DIFFERENT provider transaction id paid the same order (Item 1)
      if (order.status === 'paid') {
        const existingCharges = await tx.query<{ provider_ref: string; payment_intent_id: string }>(
          `SELECT t.provider_ref, t.payment_intent_id
           FROM transactions t
           JOIN payment_intents pi ON t.payment_intent_id = pi.id
           WHERE pi.order_id = $1 AND t.type = 'charge' AND t.status = 'succeeded'`,
          [order.id]
        );

        // Only trigger a duplicate-payment refund when a DIFFERENT provider transaction id paid the same order
        const isDifferentPayment = existingCharges.rows.some(
          (c) => c.provider_ref !== verifiedPayment.reference || c.payment_intent_id !== lockedIntent.id
        );

        if (isDifferentPayment) {
          const sanitizedCharge = sanitizeTransactionRawResponse(verifiedPayment.rawResponse, {
            id: verifiedPayment.id,
            reference: verifiedPayment.reference,
            amount: verifiedPayment.amountMinor,
            currency: verifiedPayment.currency,
            status: verifiedPayment.status,
          });
          const txnId = CryptoUtils.generateId('txn');
          await tx.query(
            `INSERT INTO transactions (id, payment_intent_id, type, amount_minor, status, provider_ref, raw_response, created_at)
             VALUES ($1, $2, 'charge', $3, $4, $5, $6, NOW())`,
            [
              txnId,
              lockedIntent.id,
              verifiedPayment.amountMinor,
              verifiedPayment.status,
              verifiedPayment.reference,
              JSON.stringify(sanitizedCharge),
            ]
          );

          // Write outbox event to refund the duplicate payment (Requirement 6 & 11)
          await this.outboxService.writeEvent(
            'payment.duplicate_refund',
            {
              intentId: lockedIntent.id,
              orderId: order.id,
              amountMinor: verifiedPayment.amountMinor,
              provider: provider.name,
              reference: verifiedPayment.reference,
              customerId: order.customer_id,
              customerEmail: customer?.email,
            },
            tx
          );

          // Enqueue alert notification (Item 3: dead-letters if missing customer)
          await enqueueNotification('payment_refunded_alert', {
            order_id: order.id,
            reason: 'Duplicate payment received on an already-paid order. Automatically refunding.',
          });

          return {
            duplicate: false,
            event,
            verifiedPayment,
            paymentIntent: lockedIntent,
            order,
            secondPaymentRefunded: true,
          };
        }

        // Same payment already paid -> no-op, zero refunds! (Item 1)
        return {
          duplicate: false,
          event,
          verifiedPayment,
          paymentIntent: lockedIntent,
          order,
          ignored: true,
        };
      }

      // Query held reservations for this order to check if stock is still reserved
      const heldRes = await tx.query<{ id: string; product_id: string; qty: number }>(
        "SELECT id, product_id, qty FROM reservations WHERE order_id = $1 AND status = 'held' FOR UPDATE",
        [order.id]
      );
      const hasHeldStock = heldRes.rowCount > 0;

      // Case B: Late payment refund path:
      // Refund if:
      // 1. Order was already cancelled or expired
      // 2. OR Intent was marked 'failed', and stock is gone / no held reservation exists (Item 2)
      const isLateRefund =
        order.status === 'cancelled' ||
        order.status === 'expired' ||
        (lockedIntent.status === 'failed' && !hasHeldStock && verifiedPayment.status === 'succeeded');

      if (isLateRefund) {
        const sanitizedCharge = sanitizeTransactionRawResponse(verifiedPayment.rawResponse, {
          id: verifiedPayment.id,
          reference: verifiedPayment.reference,
          amount: verifiedPayment.amountMinor,
          currency: verifiedPayment.currency,
          status: verifiedPayment.status,
        });
        const txnId = CryptoUtils.generateId('txn');
        await tx.query(
          `INSERT INTO transactions (id, payment_intent_id, type, amount_minor, status, provider_ref, raw_response, created_at)
           VALUES ($1, $2, 'charge', $3, $4, $5, $6, NOW())`,
          [
            txnId,
            lockedIntent.id,
            verifiedPayment.amountMinor,
            verifiedPayment.status,
            verifiedPayment.reference,
            JSON.stringify(sanitizedCharge),
          ]
        );

        // If order was still awaiting_payment but stock is gone, advance it to expired and release any leftover reservations
        if (order.status === 'awaiting_payment') {
          await tx.query("UPDATE orders SET status = 'expired', updated_at = NOW() WHERE id = $1", [order.id]);
          order.status = 'expired';
          await this.inventoryService.releaseReservations(order.id, tx);
        }

        // Write outbox event for late refund (Requirement 6 & Item 3)
        await this.outboxService.writeEvent(
          'payment.late_refund',
          {
            intentId: lockedIntent.id,
            orderId: order.id,
            amountMinor: verifiedPayment.amountMinor,
            provider: provider.name,
            reference: verifiedPayment.reference,
            customerId: order.customer_id,
            customerEmail: customer?.email,
            reason: !hasHeldStock
              ? 'Stock reservation expired or unavailable'
              : `Order was ${order.status}`,
          },
          tx
        );

        // Enqueue alert notification (Item 3: dead-letters if missing customer)
        await enqueueNotification('payment_refunded_alert', {
          order_id: order.id,
          reason: !hasHeldStock
            ? 'Payment arrived after reservation expired and stock is gone. Automatically refunded.'
            : `Payment succeeded after order was ${order.status}. Automatically refunded.`,
        });

        return {
          duplicate: false,
          event,
          verifiedPayment,
          paymentIntent: lockedIntent,
          order,
          latePaymentRefunded: true,
        };
      }

      // Case C: Order is awaiting_payment
      // Even if payment intent was marked 'failed' (e.g. by reconciler), honor the payment since stock is held! (Item 2)
      if (order.status === 'awaiting_payment') {
        if (verifiedPayment.status === 'succeeded') {
          // Amount/currency verification
          if (
            verifiedPayment.amountMinor !== intent.amount_minor ||
            verifiedPayment.currency.toUpperCase() !== intent.currency.toUpperCase() ||
            verifiedPayment.reference !== intent.provider_ref
          ) {
            throw new ValidationError(
              `Payment verification mismatch: expected amount ${intent.amount_minor} ${intent.currency} (ref: ${intent.provider_ref}), but provider reported ${verifiedPayment.amountMinor} ${verifiedPayment.currency} (ref: ${verifiedPayment.reference})`
            );
          }

          // Advance intent to succeeded (even if it was previously marked failed)
          await tx.query(
            "UPDATE payment_intents SET status = 'succeeded', updated_at = NOW() WHERE id = $1",
            [intent.id]
          );

          // Record transaction
          const sanitizedCharge = sanitizeTransactionRawResponse(verifiedPayment.rawResponse, {
            id: verifiedPayment.id,
            reference: verifiedPayment.reference,
            amount: verifiedPayment.amountMinor,
            currency: verifiedPayment.currency,
            status: 'succeeded',
          });
          const txnId = CryptoUtils.generateId('txn');
          await tx.query(
            `INSERT INTO transactions (id, payment_intent_id, type, amount_minor, status, provider_ref, raw_response, created_at)
             VALUES ($1, $2, 'charge', $3, 'succeeded', $4, $5, NOW())`,
            [
              txnId,
              intent.id,
              verifiedPayment.amountMinor,
              verifiedPayment.reference,
              JSON.stringify(sanitizedCharge),
            ]
          );

          // Advance order to paid
          await tx.query(
            "UPDATE orders SET status = 'paid', updated_at = NOW() WHERE id = $1",
            [order.id]
          );

          // Commit reservations in this SAME transaction!
          if (onSuccessTx) {
            await onSuccessTx(tx, intent, verifiedPayment);
          } else {
            for (const r of heldRes.rows) {
              const qty = Number(r.qty);
              await tx.query(
                'UPDATE inventory SET reserved = reserved - CAST($1 AS INTEGER), on_hand = on_hand - CAST($1 AS INTEGER) WHERE product_id = $2',
                [qty, r.product_id]
              );
              await tx.query(
                "UPDATE reservations SET status = 'committed' WHERE id = $1",
                [r.id]
              );
            }
          }

          // Write outbox event for order confirmation notification (Item 3 & 8)
          await enqueueNotification(
            'order_confirmed',
            {
              order_id: order.id,
              total: `${(order.total_minor / 100).toFixed(2)} ${order.currency}`,
            },
            `notif_order_paid_${order.id}`
          );

          return {
            duplicate: false,
            event,
            verifiedPayment,
            paymentIntent: { ...intent, status: 'succeeded' as const },
            order: { ...order, status: 'paid' as const },
          };
        } else {
          // Failure path (failed / canceled)
          await tx.query(
            "UPDATE payment_intents SET status = 'failed', updated_at = NOW() WHERE id = $1",
            [intent.id]
          );

          const sanitizedCharge = sanitizeTransactionRawResponse(verifiedPayment.rawResponse, {
            id: verifiedPayment.id,
            reference: verifiedPayment.reference,
            amount: verifiedPayment.amountMinor,
            currency: verifiedPayment.currency,
            status: 'failed',
          });
          const txnId = CryptoUtils.generateId('txn');
          await tx.query(
            `INSERT INTO transactions (id, payment_intent_id, type, amount_minor, status, provider_ref, raw_response, created_at)
             VALUES ($1, $2, 'charge', $3, 'failed', $4, $5, NOW())`,
            [
              txnId,
              intent.id,
              verifiedPayment.amountMinor,
              verifiedPayment.reference,
              JSON.stringify(sanitizedCharge),
            ]
          );

          await tx.query(
            "UPDATE orders SET status = 'payment_failed', updated_at = NOW() WHERE id = $1",
            [order.id]
          );

          // Write outbox row for failure release (Requirement 6)
          await this.outboxService.writeEvent(
            'inventory.release',
            { orderId: order.id },
            tx
          );

          // Write outbox row for failure notification (Item 3)
          await enqueueNotification('payment_failed', {
            order_id: order.id,
          });

          return {
            duplicate: false,
            event,
            verifiedPayment,
            paymentIntent: { ...intent, status: 'failed' as const },
            order: { ...order, status: 'payment_failed' as const },
          };
        }
      }

      return {
        duplicate: false,
        event,
        verifiedPayment,
        paymentIntent: intent,
        order,
      };
    });
  }

  public async verifyAndReconcilePayment(
    reference: string,
    providerName?: string,
    onSuccessTx?: (tx: IDatabaseClient, intent: PaymentIntent, verifiedPayment: ProviderPayment) => Promise<void>
  ): Promise<WebhookResult> {
    // 1. Locate intent by provider_ref
    let intent: PaymentIntent | null = null;
    if (providerName) {
      intent = await this.getPaymentIntentByReference(providerName, reference);
    }
    if (!intent) {
      const res = await this.db.query<PaymentIntent>(
        'SELECT * FROM payment_intents WHERE provider_ref = $1 LIMIT 1',
        [reference]
      );
      if (res.rowCount > 0) {
        intent = res.rows[0];
      }
    }

    const resolvedProviderName = providerName || intent?.provider;
    if (!resolvedProviderName) {
      throw new NotFoundError('PaymentIntent', reference);
    }

    const provider = this.router.getProvider(resolvedProviderName);
    if (!provider) {
      throw new NotFoundError('PaymentProvider', resolvedProviderName);
    }

    // 2. If intent already succeeded, return immediately with current order state
    if (intent && intent.status === 'succeeded') {
      const ordRes = await this.db.query<Order>('SELECT * FROM orders WHERE id = $1', [intent.order_id]);
      return {
        duplicate: false,
        event: {
          provider: provider.name,
          eventId: `return_${provider.name}_${reference}`,
          type: 'charge.success',
          reference,
          amountMinor: intent.amount_minor,
          currency: intent.currency,
          rawPayload: {},
        },
        paymentIntent: intent,
        order: ordRes.rows[0],
        ignored: true,
      };
    }

    // 3. Verify with provider API
    const verified = await provider.verifyPayment(reference);

    // If intent was not found by original reference, try with verified.reference
    if (!intent && verified.reference) {
      intent = await this.getPaymentIntentByReference(provider.name, verified.reference);
      if (!intent) {
        const res = await this.db.query<PaymentIntent>(
          'SELECT * FROM payment_intents WHERE provider_ref = $1 LIMIT 1',
          [verified.reference]
        );
        if (res.rowCount > 0) {
          intent = res.rows[0];
        }
      }
    }

    if (!intent) {
      throw new NotFoundError('PaymentIntent', reference);
    }

    // 4. Process transaction according to verified status
    if (verified.status === 'succeeded') {
      const returnEvent: NormalizedEvent = {
        provider: provider.name,
        eventId: `return_${provider.name}_${reference}`,
        type: 'charge.success',
        reference: verified.reference,
        amountMinor: verified.amountMinor,
        currency: verified.currency,
        rawPayload: verified.rawResponse,
      };
      return await this.processWebhookTransaction(provider, returnEvent, verified, onSuccessTx);
    } else if (verified.status === 'failed' || verified.status === 'canceled') {
      const returnEvent: NormalizedEvent = {
        provider: provider.name,
        eventId: `return_${provider.name}_${reference}`,
        type: 'charge.failed',
        reference: verified.reference,
        amountMinor: verified.amountMinor,
        currency: verified.currency,
        rawPayload: verified.rawResponse,
      };
      return await this.processWebhookTransaction(provider, returnEvent, verified, onSuccessTx);
    } else {
      // Pending
      const ordRes = await this.db.query<Order>('SELECT * FROM orders WHERE id = $1', [intent.order_id]);
      return {
        duplicate: false,
        event: {
          provider: provider.name,
          eventId: `return_${provider.name}_${reference}`,
          type: 'unknown',
          reference: verified.reference,
          amountMinor: verified.amountMinor,
          currency: verified.currency,
          rawPayload: verified.rawResponse,
        },
        verifiedPayment: verified,
        paymentIntent: intent,
        order: ordRes.rows[0],
        ignored: true,
      };
    }
  }

  public async refundPayment(
    paymentIntentId: string,
    amountMinor?: number,
    idempotencyKey?: string
  ): Promise<ProviderRefund> {
    // Lock the payment intent FOR UPDATE first (Item 3)
    const intentRes = await this.db.query<PaymentIntent>(
      'SELECT id, order_id, provider, provider_ref, amount_minor, currency, status, idempotency_key, created_at, updated_at FROM payment_intents WHERE id = $1 FOR UPDATE',
      [paymentIntentId]
    );
    if (intentRes.rowCount === 0) {
      throw new NotFoundError('PaymentIntent', paymentIntentId);
    }
    const intent = intentRes.rows[0];

    // 1. Query existing transactions to check partial refund limit and idempotency
    const existingTxns = await this.listTransactions(intent.id);
    const hasSuccessfulCharge = existingTxns.some((t) => t.type === 'charge' && t.status === 'succeeded');

    if (intent.status !== 'succeeded' && intent.status !== 'processing' && !hasSuccessfulCharge) {
      throw new ValidationError(`Cannot refund payment intent with status '${intent.status}'`);
    }

    const currency = intent.currency; // Take currency from intent (Item 1)
    const refundAmount = amountMinor ?? intent.amount_minor;

    if (refundAmount <= 0) {
      throw new ValidationError('Refund amount must be greater than zero');
    }

    const provider = this.router.getProvider(intent.provider);
    if (!provider) {
      throw new NotFoundError('PaymentProvider', intent.provider);
    }

    const refundTxns = existingTxns.filter((t) => t.type === 'refund');

    // Count BOTH 'succeeded' AND 'pending' refunds in the over-refund total! (Item 3)
    const totalCommittedOrPending = refundTxns
      .filter((t) => t.status === 'succeeded' || t.status === 'pending')
      .reduce((sum, t) => sum + t.amount_minor, 0);

    const txnId = idempotencyKey ? `txn_ref_${idempotencyKey}` : CryptoUtils.generateId('txn');
    const existingTxnForIdemp = refundTxns.find(
      (t) => t.id === txnId || (idempotencyKey && (t.raw_response as any)?.idempotencyKey === idempotencyKey)
    );

    if (existingTxnForIdemp) {
      if (existingTxnForIdemp.status === 'succeeded') {
        return {
          id: existingTxnForIdemp.provider_ref || existingTxnForIdemp.id,
          reference: intent.provider_ref!,
          amountMinor: existingTxnForIdemp.amount_minor,
          status: 'succeeded',
          rawResponse: existingTxnForIdemp.raw_response,
        };
      }

      if (existingTxnForIdemp.status === 'pending') {
        // On retry of a pending refund: query the provider for that refund's status instead of re-issuing (Item 2 & 4)
        let providerRefund: ProviderRefund | null = null;
        if (existingTxnForIdemp.provider_ref && typeof (provider as any).getRefund === 'function') {
          providerRefund = await (provider as any).getRefund(existingTxnForIdemp.provider_ref);
        } else if (!existingTxnForIdemp.provider_ref && typeof (provider as any).listRefunds === 'function') {
          // Provider ref is missing: query listRefunds(reference) and match by amount + time window (Item 4)
          // Do NOT catch listRefunds errors: if list call fails, rethrow to prevent duplicate refund re-issuance!
          const refundsList: ProviderRefund[] = await (provider as any).listRefunds(intent.provider_ref!);

          // Match by amount and time window (created within 30 minutes of our local pending record)
          const txnCreatedAtMs = new Date(existingTxnForIdemp.created_at).getTime();
          const matched = refundsList.find((r) => {
            const amountMatches = r.amountMinor === existingTxnForIdemp.amount_minor;
            const raw = r.rawResponse as any;
            const refundTimeStr = raw?.createdAt || raw?.created_at || raw?.data?.created_at || raw?.refunded_at;
            if (!refundTimeStr) {
              return false; // If provider gives no refund timestamp, treat as no match rather than falling back to local time (Item 3)
            }
            const refundTimeMs = new Date(refundTimeStr).getTime();
            if (isNaN(refundTimeMs)) {
              return false;
            }
            const inTimeWindow = Math.abs(refundTimeMs - txnCreatedAtMs) <= 30 * 60 * 1000;
            return amountMatches && inTimeWindow;
          });

          if (matched) {
            providerRefund = matched;
          }
        }

        if (providerRefund && (providerRefund.status === 'succeeded' || providerRefund.status === 'pending')) {
          const sanitizedRefund = sanitizeTransactionRawResponse(providerRefund.rawResponse, {
            id: providerRefund.id,
            reference: providerRefund.reference,
            amount: providerRefund.amountMinor,
            currency: currency,
            status: providerRefund.status,
          });
          await this.db.query(
            `UPDATE transactions
             SET status = $1, provider_ref = $2, raw_response = $3
             WHERE id = $4`,
            [
              providerRefund.status,
              providerRefund.id, // provider's refund id
              JSON.stringify(sanitizedRefund),
              existingTxnForIdemp.id,
            ]
          );
          return {
            id: providerRefund.id,
            reference: providerRefund.reference,
            amountMinor: providerRefund.amountMinor,
            status: providerRefund.status,
            rawResponse: providerRefund.rawResponse,
          };
        }

        if (providerRefund && providerRefund.status === 'failed') {
          const sanitizedRefund = sanitizeTransactionRawResponse(providerRefund.rawResponse, {
            id: providerRefund.id,
            reference: providerRefund.reference,
            amount: providerRefund.amountMinor,
            currency: currency,
            status: 'failed',
          });
          await this.db.query(
            `UPDATE transactions
             SET status = 'failed', provider_ref = $1, raw_response = $2
             WHERE id = $3`,
            [
              providerRefund.id,
              JSON.stringify(sanitizedRefund),
              existingTxnForIdemp.id,
            ]
          );
          throw new PaymentFailedError(`Provider refund failed: ${providerRefund.id}`);
        }

        // If a pending refund has no provider id and listRefunds finds no match (or provider lacks getRefund/listRefunds,
        // or matched refund is 'failed'), do NOT issue a new refund. Leave row pending, log alert, and require review (Item 1)
        const reason = !providerRefund
          ? 'Provider refund could not be located via getRefund/listRefunds (list returned no match or provider lacks inquiry)'
          : `Provider refund reported non-viable status '${providerRefund.status}'`;

        console.error(
          `[RefundAlert] Pending refund txn ${existingTxnForIdemp.id} for intent ${intent.id} cannot be safely re-issued. ${reason}. Leaving transaction row in 'pending' status for manual review.`
        );

        await this.db.query(
          `UPDATE transactions
           SET raw_response = $1
           WHERE id = $2`,
          [
            JSON.stringify({
              ...(typeof existingTxnForIdemp.raw_response === 'object' && existingTxnForIdemp.raw_response !== null
                ? existingTxnForIdemp.raw_response
                : {}),
              manual_review_required: true,
              review_reason: reason,
              reviewed_at: new Date().toISOString(),
            }),
            existingTxnForIdemp.id,
          ]
        );

        throw new AppError(
          409,
          'CONFLICT',
          `Pending refund txn ${existingTxnForIdemp.id} requires manual review: ${reason}. Duplicate refund was NOT issued.`
        );
      }
    }

    // Allow multiple partial refunds while the sum stays <= the charge (Item 2 & 3)
    // Counting pending refunds in the over-refund total, excluding the current idempotency transaction if retrying
    const otherCommittedOrPending = refundTxns
      .filter((t) => t.id !== existingTxnForIdemp?.id && (t.status === 'succeeded' || t.status === 'pending'))
      .reduce((sum, t) => sum + t.amount_minor, 0);

    if (otherCommittedOrPending + refundAmount > intent.amount_minor) {
      throw new ValidationError(
        `Refund amount of ${refundAmount} ${currency} exceeds remaining chargeable balance of ${intent.amount_minor - otherCommittedOrPending} ${currency} on intent ${intent.id}`
      );
    }

    // 2. Write a 'pending' refund row BEFORE calling the provider (Item 2)
    if (!existingTxnForIdemp) {
      await this.db.query(
        `INSERT INTO transactions (id, payment_intent_id, type, amount_minor, status, provider_ref, raw_response, created_at)
         VALUES ($1, $2, 'refund', $3, 'pending', NULL, $4, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [
          txnId,
          intent.id,
          refundAmount,
          JSON.stringify({ stage: 'initiated', idempotencyKey, currency }),
        ]
      );
    } else if (existingTxnForIdemp.status === 'failed') {
      await this.db.query(
        `UPDATE transactions
         SET status = 'pending', provider_ref = NULL, raw_response = $1, created_at = NOW()
         WHERE id = $2`,
        [
          JSON.stringify({ stage: 're-initiated', idempotencyKey, currency }),
          existingTxnForIdemp.id,
        ]
      );
    }

    // 3. Call the provider to execute the refund (currency from intent)
    let refundResult: ProviderRefund;
    try {
      refundResult = await provider.refund(intent.provider_ref!, refundAmount, currency);
    } catch (err: any) {
      // Clean 4xx rejections from provider should mark transaction row 'failed' with real error immediately (Item 4)
      const isClientError =
        (err instanceof ProviderApiError && err.isClientError) ||
        (typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500);

      if (isClientError) {
        const targetTxnId = existingTxnForIdemp?.id || txnId;
        const errorMsg = err.message || 'Provider 4xx client rejection';
        await this.db.query(
          `UPDATE transactions
           SET status = 'failed', raw_response = $1
           WHERE id = $2`,
          [
            JSON.stringify({
              error: errorMsg,
              statusCode: err.statusCode,
              providerResponse: err.rawResponse || null,
              failedAt: new Date().toISOString(),
              idempotencyKey,
            }),
            targetTxnId,
          ]
        );
      }
      throw err;
    }

    // 4. Update the local 'pending' transaction to succeeded (storing provider's refund id in provider_ref)
    const sanitizedRefund = sanitizeTransactionRawResponse(refundResult.rawResponse, {
      id: refundResult.id,
      reference: refundResult.reference,
      amount: refundResult.amountMinor,
      currency: currency,
      status: refundResult.status,
    });

    await this.db.query(
      `UPDATE transactions
       SET status = $1, provider_ref = $2, raw_response = $3
       WHERE id = $4`,
      [
        refundResult.status,
        refundResult.id, // Match and store on the provider's refund id! (Item 1 & 2)
        JSON.stringify(sanitizedRefund),
        existingTxnForIdemp?.id || txnId,
      ]
    );

    return refundResult;
  }

  public async listTransactions(paymentIntentId?: string): Promise<TransactionRecord[]> {
    let sql = 'SELECT id, payment_intent_id, type, amount_minor, status, provider_ref, raw_response, created_at FROM transactions';
    const params: unknown[] = [];
    if (paymentIntentId) {
      sql += ' WHERE payment_intent_id = $1';
      params.push(paymentIntentId);
    }
    sql += ' ORDER BY created_at DESC';

    const res = await this.db.query<TransactionRecord>(sql, params);
    return res.rows;
  }

  /**
   * Item 4: Reconciliation job that polls providers for payment intents stuck in 'processing' beyond thresholdMinutes.
   * Routes through the exact same transactional handler as webhooks (dedupe, outbox, late-payment path).
   * 'pending' stays processing until past the TTL, then fails the intent and releases held stock.
   */
  public async reconcileStuckPaymentIntents(
    thresholdMinutes = 15,
    maxBatch = 50,
    onSuccessTx?: (tx: IDatabaseClient, intent: PaymentIntent, verifiedPayment: ProviderPayment) => Promise<void>
  ): Promise<Array<{
    intentId: string;
    orderId: string;
    reference: string;
    previousStatus: string;
    newStatus: string;
    resolved: boolean;
  }>> {
    // Overlap guard (Item 4)
    if (this.isReconciling) {
      return [];
    }
    this.isReconciling = true;

    try {
      const results: Array<{
        intentId: string;
        orderId: string;
        reference: string;
        previousStatus: string;
        newStatus: string;
        resolved: boolean;
      }> = [];

      const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);
      // Batching via LIMIT $2 and backoff via updated_at (Item 4)
      const stuckRes = await this.db.query<PaymentIntent>(
        `SELECT id, order_id, provider, provider_ref, amount_minor, currency, status, idempotency_key, created_at, updated_at
         FROM payment_intents
         WHERE status = 'processing'
           AND created_at < $1
           AND (updated_at IS NULL OR updated_at <= created_at OR updated_at < NOW() - INTERVAL '5 minutes')
         ORDER BY created_at ASC
         LIMIT $2`,
        [cutoff, maxBatch]
      );

      for (const intent of stuckRes.rows) {
        if (!intent.provider_ref) continue;
        const provider = this.router.getProvider(intent.provider);
        if (!provider) continue;

        let verified: ProviderPayment;
        try {
          verified = await provider.verifyPayment(intent.provider_ref);
        } catch (err) {
          console.error(`[Reconciler] Verification error for intent ${intent.id}:`, err);
          await this.db.query('UPDATE payment_intents SET updated_at = NOW() WHERE id = $1', [intent.id]);
          continue;
        }

        // Check if the order is expired or cancelled and provider is not 'succeeded' (Item 4)
        const orderRes = await this.db.query<Order>('SELECT id, status FROM orders WHERE id = $1', [intent.order_id]);
        const order = orderRes.rows[0];

        if (order && (order.status === 'expired' || order.status === 'cancelled') && verified.status !== 'succeeded') {
          // Mark intent failed via shared release code (Item 1 & 4)
          await this.db.transaction(async (tx) => {
            await tx.query("UPDATE payment_intents SET status = 'failed', updated_at = NOW() WHERE id = $1", [intent.id]);
            await this.inventoryService.releaseReservations(intent.order_id, tx);
          });

          results.push({
            intentId: intent.id,
            orderId: intent.order_id,
            reference: intent.provider_ref,
            previousStatus: 'processing',
            newStatus: 'failed',
            resolved: true,
          });
          continue;
        }

        if (verified.status === 'succeeded') {
          // Route through the same transactional handler as the webhook (dedupe, outbox, late-payment path)
          const reconEvent: NormalizedEvent = {
            provider: provider.name,
            eventId: `recon_${intent.provider}_${intent.provider_ref}`,
            type: 'charge.success',
            reference: verified.reference,
            amountMinor: verified.amountMinor,
            currency: verified.currency,
            rawPayload: verified.rawResponse,
          };

          await this.processWebhookTransaction(provider, reconEvent, verified, onSuccessTx);

          results.push({
            intentId: intent.id,
            orderId: intent.order_id,
            reference: intent.provider_ref,
            previousStatus: 'processing',
            newStatus: 'succeeded',
            resolved: true,
          });
        } else if (verified.status === 'failed' || verified.status === 'canceled') {
          const reconEvent: NormalizedEvent = {
            provider: provider.name,
            eventId: `recon_${intent.provider}_${intent.provider_ref}`,
            type: 'charge.failed',
            reference: verified.reference,
            amountMinor: verified.amountMinor,
            currency: verified.currency,
            rawPayload: verified.rawResponse,
          };

          await this.processWebhookTransaction(provider, reconEvent, verified, onSuccessTx);

          results.push({
            intentId: intent.id,
            orderId: intent.order_id,
            reference: intent.provider_ref,
            previousStatus: 'processing',
            newStatus: 'failed',
            resolved: true,
          });
        } else {
          // 'pending', 'ongoing', 'abandoned':
          // Stays processing until past the TTL, then fail the intent and release stock (Item 1 & 4)
          const resRows = await this.db.query<{ expires_at: Date }>(
            "SELECT expires_at FROM reservations WHERE order_id = $1 ORDER BY expires_at DESC LIMIT 1",
            [intent.order_id]
          );

          const isPastTtl = resRows.rowCount > 0 && new Date(resRows.rows[0].expires_at) <= new Date();

          if (isPastTtl) {
            await this.db.transaction(async (tx) => {
              await tx.query("UPDATE payment_intents SET status = 'failed', updated_at = NOW() WHERE id = $1", [intent.id]);
              await tx.query("UPDATE orders SET status = 'expired', updated_at = NOW() WHERE id = $1 AND status = 'awaiting_payment'", [intent.order_id]);
              await this.inventoryService.releaseReservations(intent.order_id, tx);
            });

            results.push({
              intentId: intent.id,
              orderId: intent.order_id,
              reference: intent.provider_ref,
              previousStatus: 'processing',
              newStatus: 'failed',
              resolved: true,
            });
          } else {
            // Backoff: touch updated_at so it is not immediately re-polled
            await this.db.query('UPDATE payment_intents SET updated_at = NOW() WHERE id = $1', [intent.id]);
          }
        }
      }

      return results;
    } finally {
      this.isReconciling = false;
    }
  }
}


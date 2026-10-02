import crypto from 'node:crypto';
import { CryptoUtils } from '../../../common/utils/crypto.js';
import { ProviderApiError } from '../../../common/errors/app-error.js';
import { loggedFetch } from '../outbound-logger.js';
import { CreatePaymentInput, NormalizedEvent, PaymentProvider, ProviderPayment, ProviderRefund } from '../types.js';

export interface FlutterwaveConfig {
  secretKey: string;
  secretHash: string; // configured webhook verification secret in Flutterwave dashboard
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class FlutterwavePaymentProvider implements PaymentProvider {
  public readonly name = 'flutterwave';
  private readonly secretKey: string;
  private readonly secretHash: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: FlutterwaveConfig) {
    this.secretKey = config.secretKey;
    this.secretHash = config.secretHash;
    this.baseUrl = config.baseUrl || 'https://api.flutterwave.com/v3';
    this.fetchImpl = config.fetchFn || fetch;
  }

  public async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
    const { res, body } = await loggedFetch(
      this.name,
      `${this.baseUrl}/payments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tx_ref: input.reference,
          amount: input.amountMinor / 100, // Flutterwave takes major units in API
          currency: input.currency.toUpperCase(),
          redirect_url: input.callbackUrl || 'https://example.com/checkout/callback',
          customer: {
            email: input.email,
          },
          meta: {
            order_id: input.orderId,
            ...input.metadata,
          },
        }),
      },
      this.fetchImpl
    );

    if (!res.ok || body?.status !== 'success') {
      const errMsg = body?.message || res.statusText || 'Flutterwave initialization failed';
      throw new ProviderApiError(this.name, res.status, errMsg, body);
    }

    return {
      id: input.reference,
      reference: input.reference,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'pending',
      checkoutUrl: body.data?.link,
      rawResponse: body,
    };
  }

  public async verifyPayment(reference: string): Promise<ProviderPayment> {
    const isNumericId = /^\d+$/.test(reference);
    const endpoint = isNumericId
      ? `${this.baseUrl}/transactions/${reference}/verify`
      : `${this.baseUrl}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`;

    const { res, body } = await loggedFetch(
      this.name,
      endpoint,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
      },
      this.fetchImpl
    );

    if (!res.ok || body?.status !== 'success') {
      const errMsg = body?.message || res.statusText || 'Flutterwave verification failed';
      throw new ProviderApiError(this.name, res.status, errMsg, body);
    }

    const data = body.data;
    const status = data.status === 'successful' ? 'succeeded' : data.status === 'failed' ? 'failed' : 'pending';
    const amountMinor = Math.round(data.amount * 100);

    return {
      id: String(data.id),
      reference: data.tx_ref,
      amountMinor,
      currency: data.currency,
      status,
      rawResponse: body,
    };
  }

  public async cancelPayment(reference: string): Promise<void> {
    // Flutterwave sessions expire automatically if unpaid; client-side void is recorded
  }

  public async refund(reference: string, amountMinor?: number): Promise<ProviderRefund> {
    // Confirm identifier requirement: Flutterwave's refund endpoint strictly requires the numeric transaction ID (/v3/transactions/{id}/refund)
    let numericTxId: string;
    let resolvedReference = reference;
    let resolvedAmountMinor = amountMinor;

    if (/^\d+$/.test(reference)) {
      numericTxId = reference;
    } else {
      // Look up transaction by reference first to obtain the required numeric ID
      const tx = await this.verifyPayment(reference);
      numericTxId = tx.id;
      resolvedReference = tx.reference;
      if (resolvedAmountMinor === undefined) {
        resolvedAmountMinor = tx.amountMinor;
      }
    }

    if (!numericTxId || !/^\d+$/.test(numericTxId)) {
      throw new Error(`Flutterwave refund requires a numeric transaction ID, but could not resolve one for reference: '${reference}'`);
    }

    const refundPayload: Record<string, unknown> = {};
    if (resolvedAmountMinor !== undefined) {
      refundPayload.amount = resolvedAmountMinor / 100;
    }

    const { res, body } = await loggedFetch(
      this.name,
      `${this.baseUrl}/transactions/${numericTxId}/refund`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(refundPayload),
      },
      this.fetchImpl
    );

    if (!res.ok || body?.status !== 'success') {
      const errMsg = body?.message || res.statusText || 'Flutterwave refund failed';
      throw new ProviderApiError(this.name, res.status, errMsg, body);
    }

    const data = body.data;
    const amountRefundedMinor = data?.amount_refunded
      ? Math.round(Number(data.amount_refunded) * 100)
      : (resolvedAmountMinor ?? 0);

    return {
      id: String(data?.id || `flw_ref_${Date.now()}`),
      reference: resolvedReference,
      amountMinor: amountRefundedMinor,
      status: data?.status === 'completed' || data?.status === 'successful' ? 'succeeded' : 'pending',
      rawResponse: body,
    };
  }

  /**
   * Fetch a single refund by refund ID.
   * Official Flutterwave API reference: https://developer.flutterwave.com/reference/endpoints/refunds/#get-a-refund
   * [Unverified until a real refund is captured] Parsing is based on official Flutterwave documentation specifications.
   */
  public async getRefund(refundId: string): Promise<ProviderRefund | null> {
    const { res, body } = await loggedFetch(
      this.name,
      `${this.baseUrl}/refunds/${encodeURIComponent(refundId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
      },
      this.fetchImpl
    );

    if (res.status === 404) {
      return null;
    }

    if (!res.ok || body?.status !== 'success') {
      const errMsg = body?.message || res.statusText || 'Flutterwave getRefund failed';
      throw new ProviderApiError(this.name, res.status, errMsg, body);
    }

    const data = body.data;
    if (!data) return null;
    const amountMinor = Math.round(Number(data.amount_refunded || data.amount || 0) * 100);
    return {
      id: String(data.id),
      reference: String(data.tx_ref || data.flw_ref || refundId),
      amountMinor,
      status:
        data.status === 'completed' || data.status === 'successful'
          ? 'succeeded'
          : data.status === 'failed'
            ? 'failed'
            : 'pending',
      rawResponse: body,
    };
  }

  /**
   * List all refunds, optionally querying by transaction reference or ID.
   * Official Flutterwave API reference: https://developer.flutterwave.com/reference/endpoints/refunds/#get-all-refunds
   * [Unverified until a real refund is captured] Parsing is based on official Flutterwave documentation specifications.
   */
  public async listRefunds(referenceOrTxId?: string): Promise<ProviderRefund[]> {
    let endpoint = `${this.baseUrl}/refunds`;
    if (referenceOrTxId) {
      endpoint += `?tx_ref=${encodeURIComponent(referenceOrTxId)}`;
    }

    const { res, body } = await loggedFetch(
      this.name,
      endpoint,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
      },
      this.fetchImpl
    );

    if (!res.ok || body?.status !== 'success') {
      const errMsg = body?.message || res.statusText || 'Flutterwave listRefunds failed';
      throw new ProviderApiError(this.name, res.status, errMsg, body);
    }

    let list = Array.isArray(body.data) ? body.data : [];
    if (referenceOrTxId) {
      list = list.filter(
        (item: any) =>
          String(item.tx_id) === referenceOrTxId ||
          String(item.flw_ref) === referenceOrTxId ||
          String(item.tx_ref) === referenceOrTxId ||
          String(item.id) === referenceOrTxId
      );
    }

    return list.map((item: any) => ({
      id: String(item.id),
      reference: String(item.tx_ref || item.flw_ref || item.tx_id || referenceOrTxId || ''),
      amountMinor: Math.round(Number(item.amount_refunded || item.amount || 0) * 100),
      status:
        item.status === 'completed' || item.status === 'successful'
          ? 'succeeded'
          : item.status === 'failed'
            ? 'failed'
            : 'pending',
      rawResponse: item,
    }));
  }

  public verifyWebhookSignature(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>
  ): boolean {
    const hash = headers['verif-hash'];
    if (!hash || typeof hash !== 'string') return false;

    const bufHash = Buffer.from(hash, 'utf8');
    const bufSecret = Buffer.from(this.secretHash, 'utf8');

    // 1. Direct secret hash match (standard Flutterwave dashboard configured secret hash)
    if (bufHash.length > 0 && bufHash.length === bufSecret.length) {
      if (CryptoUtils.timingSafeEqual(hash, this.secretHash)) {
        return true;
      }
    }

    // 2. Optional HMAC-SHA256 signature match (computed over raw body with secret hash)
    const rawBodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expectedHmac = crypto
      .createHmac('sha256', this.secretHash)
      .update(rawBodyStr)
      .digest('hex');

    const bufHmac = Buffer.from(expectedHmac, 'utf8');
    if (bufHash.length > 0 && bufHash.length === bufHmac.length) {
      return CryptoUtils.timingSafeEqual(hash, expectedHmac);
    }

    return false;
  }

  public parseWebhookEvent(payload: any, rawBody?: Buffer | string): NormalizedEvent {
    const data = payload.data || payload;
    let eventType: 'charge.success' | 'charge.failed' | 'refund.success' | 'unknown';
    if (payload.event === 'charge.completed' || payload.event === 'charge.success') {
      eventType = data.status === 'successful' ? 'charge.success' : 'charge.failed';
    } else if (payload.event === 'refund.completed' || payload.event === 'refund.successful') {
      eventType = 'refund.success';
    } else if (payload.event === 'charge.failed') {
      eventType = 'charge.failed';
    } else {
      eventType = 'unknown';
    }
    const txnId = data.id ?? payload.id;
    let eventId: string;
    if (txnId !== undefined && txnId !== null && String(txnId).trim().length > 0) {
      eventId = `${this.name}_${eventType}_${txnId}`;
    } else {
      const bodyStr = rawBody ? (typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')) : JSON.stringify(payload);
      eventId = `${this.name}_${eventType}_${CryptoUtils.sha256(bodyStr)}`;
    }

    return {
      provider: 'flutterwave',
      eventId,
      type: eventType,
      reference: data.tx_ref,
      amountMinor: Math.round((data.amount || 0) * 100),
      currency: data.currency || 'NGN',
      rawPayload: payload,
    };
  }
}

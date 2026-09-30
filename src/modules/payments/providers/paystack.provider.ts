import { CryptoUtils } from '../../../common/utils/crypto.js';
import { CreatePaymentInput, NormalizedEvent, PaymentProvider, ProviderPayment, ProviderRefund } from '../types.js';

export interface PaystackConfig {
  secretKey: string;
  baseUrl?: string;
}

export class PaystackPaymentProvider implements PaymentProvider {
  public readonly name = 'paystack';
  private readonly secretKey: string;
  private readonly baseUrl: string;

  constructor(config: PaystackConfig) {
    this.secretKey = config.secretKey;
    this.baseUrl = config.baseUrl || 'https://api.paystack.co';
  }

  public async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
    const res = await fetch(`${this.baseUrl}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: input.email,
        amount: input.amountMinor, // Paystack expects integer minor units (kobo, cents)
        currency: input.currency.toUpperCase(),
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: input.metadata,
      }),
    });

    const body = (await res.json()) as any;
    if (!res.ok || !body.status) {
      throw new Error(`Paystack initialization failed: ${body.message || res.statusText}`);
    }

    return {
      id: String(body.data.reference),
      reference: body.data.reference,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'pending',
      checkoutUrl: body.data.authorization_url,
      rawResponse: body,
    };
  }

  public async verifyPayment(reference: string): Promise<ProviderPayment> {
    const res = await fetch(`${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
      },
    });

    const body = (await res.json()) as any;
    if (!res.ok || !body.status) {
      throw new Error(`Paystack verification failed: ${body.message || res.statusText}`);
    }

    const data = body.data;
    const status = data.status === 'success' ? 'succeeded' : data.status === 'failed' ? 'failed' : 'pending';

    return {
      id: String(data.id),
      reference: data.reference,
      amountMinor: data.amount,
      currency: data.currency,
      status,
      rawResponse: body,
    };
  }

  public async cancelPayment(reference: string): Promise<void> {
    // Paystack does not have a cancel endpoint for initialized sessions;
    // recording cancellation locally is standard practice.
  }

  public async refund(reference: string, amountMinor?: number): Promise<ProviderRefund> {
    const res = await fetch(`${this.baseUrl}/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        transaction: reference,
        amount: amountMinor, // in minor units
      }),
    });

    const body = (await res.json()) as any;
    if (!res.ok || !body.status) {
      throw new Error(`Paystack refund failed: ${body.message || res.statusText}`);
    }

    return {
      id: String(body.data.id),
      reference,
      amountMinor: body.data.amount,
      status: body.data.status === 'processed' ? 'succeeded' : 'pending',
      rawResponse: body,
    };
  }

  /**
   * Fetch a single refund by refund ID.
   * Official Paystack API reference: https://paystack.com/docs/api/refund/#fetch
   * [Unverified until a real refund is captured] Parsing is based on official Paystack documentation specifications.
   */
  public async getRefund(refundId: string): Promise<ProviderRefund> {
    const res = await fetch(`${this.baseUrl}/refund/${encodeURIComponent(refundId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
      },
    });

    const body = (await res.json()) as any;
    if (!res.ok || !body.status) {
      throw new Error(`Paystack getRefund failed: ${body.message || res.statusText}`);
    }

    const data = body.data;
    return {
      id: String(data.id),
      reference: data.transaction?.reference || String(data.transaction || ''),
      amountMinor: Number(data.amount),
      status: data.status === 'processed' ? 'succeeded' : data.status === 'failed' ? 'failed' : 'pending',
      rawResponse: body,
    };
  }

  /**
   * List refunds, optionally filtered by transaction reference.
   * Official Paystack API reference: https://paystack.com/docs/api/refund/#list
   * [Unverified until a real refund is captured] Parsing is based on official Paystack documentation specifications.
   */
  public async listRefunds(reference?: string): Promise<ProviderRefund[]> {
    const url = new URL(`${this.baseUrl}/refund`);
    if (reference) {
      url.searchParams.set('reference', reference);
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
      },
    });

    const body = (await res.json()) as any;
    if (!res.ok || !body.status) {
      throw new Error(`Paystack listRefunds failed: ${body.message || res.statusText}`);
    }

    const list = Array.isArray(body.data) ? body.data : [];
    return list.map((item: any) => ({
      id: String(item.id),
      reference: item.transaction?.reference || String(item.transaction || reference || ''),
      amountMinor: Number(item.amount),
      status: item.status === 'processed' ? 'succeeded' : item.status === 'failed' ? 'failed' : 'pending',
      rawResponse: item,
    }));
  }

  public verifyWebhookSignature(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>
  ): boolean {
    const signature = headers['x-paystack-signature'];
    if (!signature || typeof signature !== 'string') return false;

    const expected = CryptoUtils.createHmacSha512(rawBody, this.secretKey);
    const bufExpected = Buffer.from(expected, 'utf8');
    const bufSignature = Buffer.from(signature, 'utf8');
    if (bufExpected.length === 0 || bufSignature.length === 0 || bufExpected.length !== bufSignature.length) {
      return false;
    }

    return CryptoUtils.timingSafeEqual(expected, signature);
  }

  public parseWebhookEvent(payload: any, rawBody?: Buffer | string): NormalizedEvent {
    let eventType: 'charge.success' | 'charge.failed' | 'refund.success' | 'unknown';
    if (payload.event === 'charge.success') {
      eventType = 'charge.success';
    } else if (payload.event === 'refund.processed' || payload.event === 'refund.success') {
      eventType = 'refund.success';
    } else if (payload.event === 'charge.failed' || payload.event === 'paymentrequest.failed') {
      eventType = 'charge.failed';
    } else {
      eventType = 'unknown';
    }

    const txnId = payload.data?.id ?? payload.id;
    let eventId: string;
    if (txnId !== undefined && txnId !== null && String(txnId).trim().length > 0) {
      eventId = `${this.name}_${eventType}_${txnId}`;
    } else {
      const bodyStr = rawBody ? (typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')) : JSON.stringify(payload);
      eventId = `${this.name}_${eventType}_${CryptoUtils.sha256(bodyStr)}`;
    }

    return {
      provider: 'paystack',
      eventId,
      type: eventType,
      reference: payload.data?.reference,
      amountMinor: payload.data?.amount,
      currency: payload.data?.currency || 'NGN',
      rawPayload: payload,
    };
  }
}

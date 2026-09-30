import crypto from 'node:crypto';
import { CreatePaymentInput, NormalizedEvent, PaymentProvider, ProviderPayment, ProviderRefund } from '../types.js';

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class StripePaymentProvider implements PaymentProvider {
  public readonly name = 'stripe';
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: StripeConfig) {
    this.secretKey = config.secretKey;
    this.webhookSecret = config.webhookSecret;
    this.baseUrl = config.baseUrl || 'https://api.stripe.com/v1';
    this.fetchImpl = config.fetchFn || fetch;
  }

  public async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
    const params = new URLSearchParams();
    params.append('amount', String(input.amountMinor)); // Stripe uses minor units (cents)
    params.append('currency', input.currency.toLowerCase());
    params.append('description', `Order ${input.orderId}`);
    params.append('receipt_email', input.email);
    params.append('metadata[order_id]', input.orderId);
    params.append('metadata[reference]', input.reference);

    const res = await this.fetchImpl(`${this.baseUrl}/payment_intents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const body = (await res.json()) as any;
    if (!res.ok || body.error) {
      throw new Error(`Stripe PaymentIntent creation failed: ${body.error?.message || res.statusText}`);
    }

    return {
      id: body.id,
      reference: input.reference,
      amountMinor: body.amount,
      currency: body.currency.toUpperCase(),
      status: body.status === 'succeeded' ? 'succeeded' : 'pending',
      checkoutUrl: body.client_secret ? `https://checkout.stripe.com/pay/${body.id}` : undefined,
      rawResponse: body,
    };
  }

  public async verifyPayment(reference: string): Promise<ProviderPayment> {
    // If reference is a Stripe ID (pi_...) query directly, otherwise search by metadata
    let endpoint = `${this.baseUrl}/payment_intents/${encodeURIComponent(reference)}`;
    if (!reference.startsWith('pi_')) {
      endpoint = `${this.baseUrl}/payment_intents/search?query=metadata['reference']:'${encodeURIComponent(reference)}'`;
    }

    const res = await this.fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
      },
    });

    const body = (await res.json()) as any;
    if (!res.ok || body.error) {
      throw new Error(`Stripe verification failed: ${body.error?.message || res.statusText}`);
    }

    const intent = body.data ? body.data[0] : body;
    if (!intent) {
      throw new Error(`Stripe payment not found for reference: ${reference}`);
    }

    const status = intent.status === 'succeeded' ? 'succeeded' : intent.status === 'canceled' ? 'failed' : 'pending';

    return {
      id: intent.id,
      reference: intent.metadata?.reference || intent.id,
      amountMinor: intent.amount,
      currency: intent.currency.toUpperCase(),
      status,
      rawResponse: intent,
    };
  }

  public async cancelPayment(reference: string): Promise<void> {
    const payment = await this.verifyPayment(reference);
    const res = await this.fetchImpl(`${this.baseUrl}/payment_intents/${payment.id}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
      },
    });

    const body = (await res.json()) as any;
    if (!res.ok && body.error?.code !== 'payment_intent_unexpected_state') {
      throw new Error(`Stripe cancel failed: ${body.error?.message || res.statusText}`);
    }
  }

  public async refund(reference: string, amountMinor?: number): Promise<ProviderRefund> {
    const payment = await this.verifyPayment(reference);

    const params = new URLSearchParams();
    params.append('payment_intent', payment.id);
    if (amountMinor !== undefined) {
      params.append('amount', String(amountMinor));
    }

    const res = await this.fetchImpl(`${this.baseUrl}/refunds`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const body = (await res.json()) as any;
    if (!res.ok || body.error) {
      throw new Error(`Stripe refund failed: ${body.error?.message || res.statusText}`);
    }

    return {
      id: body.id,
      reference,
      amountMinor: body.amount,
      status: body.status === 'succeeded' ? 'succeeded' : 'pending',
      rawResponse: body,
    };
  }

  public verifyWebhookSignature(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>
  ): boolean {
    const sigHeader = headers['stripe-signature'];
    if (!sigHeader || typeof sigHeader !== 'string') return false;

    const items = sigHeader.split(',').reduce<Record<string, string>>((acc, part) => {
      const [k, v] = part.trim().split('=');
      if (k && v) acc[k] = v;
      return acc;
    }, {});

    const timestamp = items['t'];
    const signature = items['v1'];
    if (!timestamp || !signature) return false;

    const payload = `${timestamp}.${typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')}`;
    const expectedSig = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(payload)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'));
    } catch {
      return false;
    }
  }

  public parseWebhookEvent(payload: any): NormalizedEvent {
    const eventType = payload.type;
    const obj = payload.data?.object || {};

    let type: 'charge.success' | 'charge.failed' | 'refund.success' = 'charge.failed';
    if (eventType === 'payment_intent.succeeded' || eventType === 'charge.succeeded') {
      type = 'charge.success';
    } else if (eventType === 'charge.refunded') {
      type = 'refund.success';
    }

    const reference = obj.metadata?.reference || obj.id || `ref_${Date.now()}`;
    const amountMinor = obj.amount || obj.amount_received || 0;
    const currency = (obj.currency || 'USD').toUpperCase();

    return {
      provider: 'stripe',
      eventId: payload.id || `evt_${Date.now()}`,
      type,
      reference,
      amountMinor,
      currency,
      rawPayload: payload,
    };
  }
}

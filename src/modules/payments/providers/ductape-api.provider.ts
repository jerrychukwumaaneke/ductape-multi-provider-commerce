import Ductape from '@ductape/sdk';
import { CreatePaymentInput, NormalizedEvent, PaymentProvider, ProviderPayment, ProviderRefund } from '../types.js';
import { CryptoUtils } from '../../../common/utils/crypto.js';

export interface DuctapeApiProviderOptions {
  appTag?: string;
  name?: string;
  webhookSecret?: string;
  product?: string;
  env?: string;
}

export class DuctapeApiPaymentProvider implements PaymentProvider {
  public readonly name: string;
  private readonly appTag: string;
  private readonly webhookSecret?: string;
  private readonly product: string;
  private readonly env: string;

  constructor(
    private readonly ductape: Ductape,
    options: DuctapeApiProviderOptions = {}
  ) {
    this.name = options.name || 'ductape-api';
    this.appTag = options.appTag || 'paystack';
    this.webhookSecret = options.webhookSecret || process.env.PAYSTACK_SECRET_KEY;
    this.product = options.product || process.env.DUCTAPE_PRODUCT || 'commerce-backend';
    this.env = options.env || process.env.DUCTAPE_ENV || 'dev';
  }

  public async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
    const res = await this.ductape.api.run({
      product: this.product,
      env: this.env,
      app: this.appTag,
      action: 'initialize',
      input: {
        email: input.email,
        amount: input.amountMinor,
        currency: input.currency.toUpperCase(),
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: input.metadata,
      },
    });

    const body = res?.data || res;
    return {
      id: body?.reference || input.reference,
      reference: input.reference,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'pending',
      checkoutUrl: body?.authorization_url || body?.checkout_url,
      rawResponse: body,
    };
  }

  public async verifyPayment(reference: string): Promise<ProviderPayment> {
    const res = await this.ductape.api.run({
      product: this.product,
      env: this.env,
      app: this.appTag,
      action: 'verify',
      input: { reference },
    });

    const data = res?.data || res;
    const status = data?.status === 'success' || data?.status === 'succeeded' ? 'succeeded' : 'pending';

    return {
      id: String(data?.id || reference),
      reference,
      amountMinor: data?.amount || 0,
      currency: data?.currency || 'NGN',
      status,
      rawResponse: data,
    };
  }

  public async cancelPayment(_reference: string): Promise<void> {
    // Void payment locally
  }

  public async refund(reference: string, amountMinor?: number): Promise<ProviderRefund> {
    const res = await this.ductape.api.run({
      product: this.product,
      env: this.env,
      app: this.appTag,
      action: 'refund',
      input: { reference, amount: amountMinor },
    });

    const data = res?.data || res;
    return {
      id: String(data?.id || `dt_ref_${Date.now()}`),
      reference,
      amountMinor: data?.amount || amountMinor || 0,
      status: 'succeeded',
      rawResponse: data,
    };
  }

  public verifyWebhookSignature(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>
  ): boolean {
    if (!this.webhookSecret) {
      return false;
    }
    const signature = headers['x-paystack-signature'] || headers['x-ductape-signature'];
    if (!signature || typeof signature !== 'string') {
      return false;
    }
    return CryptoUtils.verifyHmacSha512(rawBody, signature, this.webhookSecret);
  }

  public parseWebhookEvent(payload: unknown): NormalizedEvent {
    const dataObj = payload && typeof payload === 'object' ? (payload as Record<string, any>) : {};
    const eventType = dataObj.event === 'charge.success'
      ? 'charge.success'
      : dataObj.event === 'refund.processed'
        ? 'refund.success'
        : 'charge.failed';

    const innerData = dataObj.data && typeof dataObj.data === 'object' ? dataObj.data : {};

    return {
      provider: this.name,
      eventId: String(innerData.id || dataObj.id || Date.now()),
      type: eventType,
      reference: String(innerData.reference || dataObj.reference || ''),
      amountMinor: Number(innerData.amount || dataObj.amount || 0),
      currency: String(innerData.currency || dataObj.currency || 'NGN'),
      rawPayload: payload,
    };
  }
}

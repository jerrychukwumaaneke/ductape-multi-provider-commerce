import { CryptoUtils } from '../../../common/utils/crypto.js';
import { CreatePaymentInput, NormalizedEvent, PaymentProvider, ProviderPayment, ProviderRefund } from '../types.js';

export class MockPaymentProvider implements PaymentProvider {
  public webhookSecret = 'mock_webhook_secret_key_123';

  // Configurable testing flags
  public shouldFailCreate = false;
  public shouldDeclineVerify = false;
  public shouldFailSignature = false;
  public shouldThrowAfterRefund = false;
  public refundCallCount = 0;
  public simulatedVerifyStatus: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'ongoing' | 'abandoned' = 'succeeded';

  private payments = new Map<string, ProviderPayment>();
  private refunds = new Map<string, ProviderRefund>();
  private refundsList: ProviderRefund[] = [];

  constructor(public readonly name: string = 'mock') {}

  public setMockPayment(reference: string, payment: ProviderPayment): void {
    this.payments.set(reference, payment);
  }

  public async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
    if (this.shouldFailCreate) {
      throw new Error('Mock provider creation failed: network error');
    }

    const payment: ProviderPayment = {
      id: `mock_pay_${input.reference}`,
      reference: input.reference,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'pending',
      checkoutUrl: `https://mock.checkout.example.com/pay/${input.reference}`,
      rawResponse: { mock: true, orderId: input.orderId },
    };

    this.payments.set(input.reference, payment);
    return payment;
  }

  public async verifyPayment(reference: string): Promise<ProviderPayment> {
    const existing = this.payments.get(reference);

    if (this.shouldDeclineVerify) {
      const failedPayment: ProviderPayment = {
        id: existing?.id ?? `mock_pay_${reference}`,
        reference,
        amountMinor: existing?.amountMinor ?? 0,
        currency: existing?.currency ?? 'NGN',
        status: 'failed',
        rawResponse: { gateway_response: 'Insufficient funds' },
      };
      this.payments.set(reference, failedPayment);
      return failedPayment;
    }

    const status = this.simulatedVerifyStatus !== 'succeeded'
      ? this.simulatedVerifyStatus
      : (existing?.status === 'failed' ? 'failed' : 'succeeded');

    const verifiedPayment: ProviderPayment = {
      id: existing?.id ?? `mock_pay_${reference}`,
      reference,
      amountMinor: existing?.amountMinor ?? 1000,
      currency: existing?.currency ?? 'NGN',
      status,
      rawResponse: { gateway_response: status },
    };
    this.payments.set(reference, verifiedPayment);
    return verifiedPayment;
  }

  public setPaymentStatus(reference: string, status: 'pending' | 'succeeded' | 'failed' | 'canceled'): void {
    const existing = this.payments.get(reference);
    if (existing) {
      existing.status = status;
      this.payments.set(reference, existing);
    }
  }

  public async cancelPayment(reference: string): Promise<void> {
    const existing = this.payments.get(reference);
    if (existing) {
      existing.status = 'canceled';
      this.payments.set(reference, existing);
    }
  }

  public async refund(reference: string, amountMinor?: number, currency?: string): Promise<ProviderRefund> {
    this.refundCallCount++;
    const existing = this.payments.get(reference);
    const refundAmount = amountMinor ?? existing?.amountMinor ?? 0;

    const refundId = `mock_ref_${CryptoUtils.generateId()}`;
    const refundRecord: ProviderRefund = {
      id: refundId,
      reference,
      amountMinor: refundAmount,
      status: 'succeeded',
      rawResponse: {
        refunded: true,
        refundId,
        currency: currency || existing?.currency || 'NGN',
        created_at: new Date().toISOString(),
      },
    };

    this.refunds.set(reference, refundRecord);
    this.refunds.set(refundId, refundRecord);
    this.refundsList.push(refundRecord);

    if (this.shouldThrowAfterRefund) {
      // Simulate real crash immediately after provider created refund but before caller finishes local update
      throw new Error('SIMULATED_CRASH_POST_PROVIDER_REFUND: Server process crashed after upstream provider refund');
    }

    return refundRecord;
  }

  public async getRefund(referenceOrId: string): Promise<ProviderRefund | null> {
    return this.refunds.get(referenceOrId) || this.refundsList.find((r) => r.id === referenceOrId || r.reference === referenceOrId) || null;
  }

  public async listRefunds(reference: string): Promise<ProviderRefund[]> {
    return this.refundsList.filter((r) => r.reference === reference);
  }

  public verifyWebhookSignature(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>
  ): boolean {
    if (this.shouldFailSignature) return false;

    const signature = headers['x-mock-signature'] || headers['x-signature'];
    if (!signature || typeof signature !== 'string') return false;

    return CryptoUtils.verifyHmacSha256(rawBody, signature, this.webhookSecret);
  }

  public parseWebhookEvent(payload: any, rawBody?: Buffer | string): NormalizedEvent {
    let eventType: 'charge.success' | 'charge.failed' | 'refund.success' | 'unknown';
    if (payload.event === 'charge.failed') {
      eventType = 'charge.failed';
    } else if (payload.event === 'refund.success' || payload.event === 'refund.processed') {
      eventType = 'refund.success';
    } else if (payload.event === 'charge.success') {
      eventType = 'charge.success';
    } else {
      eventType = 'unknown';
    }
    const txnId = payload.id ?? payload.data?.id ?? payload.data?.reference ?? payload.reference;
    let eventId: string;
    if (txnId !== undefined && txnId !== null && String(txnId).trim().length > 0) {
      eventId = `${this.name}_${eventType}_${txnId}`;
    } else {
      const bodyStr = rawBody ? (typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')) : JSON.stringify(payload);
      eventId = `${this.name}_${eventType}_${CryptoUtils.sha256(bodyStr)}`;
    }

    return {
      provider: 'mock',
      eventId,
      type: eventType,
      reference: payload.data?.reference || payload.reference || 'unknown_ref',
      amountMinor: payload.data?.amount || payload.amount || 0,
      currency: payload.data?.currency || payload.currency || 'NGN',
      rawPayload: payload,
    };
  }

  public simulateWebhookPayload(
    reference: string,
    amountMinor: number,
    currency: string,
    eventType = 'charge.success',
    refundId?: string
  ) {
    const payload: any = {
      event: eventType,
      id: refundId ? `mock_evt_${refundId}` : `mock_evt_${reference}`,
      data: {
        id: refundId || (eventType.includes('refund') ? `mock_ref_${reference}` : undefined),
        reference,
        amount: amountMinor,
        currency,
        status: 'success',
      },
    };
    const bodyStr = JSON.stringify(payload);
    const signature = CryptoUtils.createHmacSha256(bodyStr, this.webhookSecret);

    return {
      rawBody: Buffer.from(bodyStr),
      headers: { 'x-mock-signature': signature },
      payload,
    };
  }
}

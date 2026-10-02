export interface CreatePaymentInput {
  orderId: string;
  amountMinor: number;
  currency: string;
  email: string;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderPayment {
  id: string;
  reference: string;
  amountMinor: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'ongoing' | 'abandoned';
  checkoutUrl?: string;
  rawResponse?: unknown;
}

export interface ProviderRefund {
  id: string;
  reference: string;
  amountMinor: number;
  status: 'succeeded' | 'failed' | 'pending';
  rawResponse?: unknown;
}

export interface NormalizedEvent {
  provider: string;
  eventId: string;
  type: 'charge.success' | 'charge.failed' | 'refund.success' | 'unknown';
  reference: string;
  amountMinor: number;
  currency: string;
  rawPayload: unknown;
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<ProviderPayment>;
  verifyPayment(reference: string): Promise<ProviderPayment>;
  cancelPayment(reference: string): Promise<void>;
  refund(reference: string, amountMinor?: number, currency?: string): Promise<ProviderRefund>;
  getRefund?(refundId: string): Promise<ProviderRefund | null>;
  listRefunds?(referenceOrTransactionId?: string): Promise<ProviderRefund[]>;
  verifyWebhookSignature(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhookEvent(payload: unknown, rawBody?: Buffer | string): NormalizedEvent;
}

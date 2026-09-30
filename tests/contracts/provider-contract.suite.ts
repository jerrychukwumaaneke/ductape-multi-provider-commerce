import { describe, it, expect } from 'vitest';
import { PaymentProvider } from '../../src/modules/payments/types.js';

export function runPaymentProviderContractSuite(
  name: string,
  createProvider: () => {
    provider: PaymentProvider;
    generateValidWebhook: (ref: string, amount: number) => { rawBody: Buffer; headers: Record<string, string>; payload: unknown };
  }
) {
  describe(`Contract Test Suite: ${name} PaymentProvider`, () => {
    it('satisfies contract: createPayment', async () => {
      const { provider } = createProvider();
      const res = await provider.createPayment({
        orderId: 'ord_contract_1',
        amountMinor: 5000,
        currency: 'NGN',
        email: 'buyer@contract.test',
        reference: `ref_${Date.now()}_1`,
      });

      expect(res.reference).toBeDefined();
      expect(res.amountMinor).toBe(5000);
      expect(res.currency).toBe('NGN');
      expect(['pending', 'succeeded']).toContain(res.status);
    });

    it('satisfies contract: verifyPayment', async () => {
      const { provider } = createProvider();
      const ref = `ref_${Date.now()}_2`;
      await provider.createPayment({
        orderId: 'ord_contract_2',
        amountMinor: 7500,
        currency: 'NGN',
        email: 'buyer@contract.test',
        reference: ref,
      });

      const verified = await provider.verifyPayment(ref);
      expect(verified.reference).toBe(ref);
      expect(verified.amountMinor).toBe(7500);
      expect(['succeeded', 'failed', 'pending']).toContain(verified.status);
    });

    it('satisfies contract: cancelPayment', async () => {
      const { provider } = createProvider();
      const ref = `ref_${Date.now()}_3`;
      await provider.createPayment({
        orderId: 'ord_contract_3',
        amountMinor: 2000,
        currency: 'NGN',
        email: 'buyer@contract.test',
        reference: ref,
      });

      await expect(provider.cancelPayment(ref)).resolves.not.toThrow();
    });

    it('satisfies contract: refund', async () => {
      const { provider } = createProvider();
      const ref = `ref_${Date.now()}_4`;
      await provider.createPayment({
        orderId: 'ord_contract_4',
        amountMinor: 3000,
        currency: 'NGN',
        email: 'buyer@contract.test',
        reference: ref,
      });

      const refund = await provider.refund(ref, 3000);
      expect(refund.reference).toBe(ref);
      expect(refund.amountMinor).toBe(3000);
      expect(['succeeded', 'pending']).toContain(refund.status);
    });

    it('satisfies contract: webhook signature validation and event parsing', async () => {
      const { provider, generateValidWebhook } = createProvider();
      const ref = `ref_${Date.now()}_5`;
      const webhook = generateValidWebhook(ref, 4000);

      // 1. Valid signature
      const isValid = provider.verifyWebhookSignature(webhook.rawBody, webhook.headers);
      expect(isValid).toBe(true);

      // 2. Invalid signature (tampered body)
      const tamperedBody = Buffer.from(JSON.stringify({ tampered: true }));
      const isInvalid = provider.verifyWebhookSignature(tamperedBody, webhook.headers);
      expect(isInvalid).toBe(false);

      // 3. Event parsing
      const parsed = provider.parseWebhookEvent(webhook.payload);
      expect(parsed.provider).toBe(provider.name);
      expect(parsed.reference).toBe(ref);
      expect(parsed.amountMinor).toBe(4000);
      expect(parsed.type).toBe('charge.success');
    });
  });
}

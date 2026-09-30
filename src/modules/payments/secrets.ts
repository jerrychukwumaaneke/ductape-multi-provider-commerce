import Ductape from '@ductape/sdk';

export interface ProviderSecrets {
  paystackSecretKey?: string;
  flutterwaveSecretKey?: string;
  flutterwaveSecretHash?: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
}

export class DuctapeSecretResolver {
  constructor(private readonly ductape?: Ductape) {}

  public async getSecret(name: string): Promise<string | undefined> {
    if (this.ductape?.secrets && typeof this.ductape.secrets.fetch === 'function') {
      try {
        const secret = await this.ductape.secrets.fetch(name);
        if (secret?.value) return secret.value;
      } catch {
        // Fallback to process.env
      }
    }

    return process.env[name];
  }

  public async resolveProviderSecrets(): Promise<ProviderSecrets> {
    return {
      paystackSecretKey:
        (await this.getSecret('PAYSTACK_SECRET_KEY')) ||
        (await this.getSecret('PAYSTACK_SK')),
      flutterwaveSecretKey:
        (await this.getSecret('FLUTTERWAVE_SECRET_KEY')) ||
        (await this.getSecret('FLW_SECRET_KEY')) ||
        (await this.getSecret('FLW_SECK')),
      flutterwaveSecretHash:
        (await this.getSecret('FLUTTERWAVE_WEBHOOK_HASH')) ||
        (await this.getSecret('FLUTTERWAVE_SECRET_HASH')),
      stripeSecretKey: await this.getSecret('STRIPE_SECRET_KEY'),
      stripeWebhookSecret: await this.getSecret('STRIPE_WEBHOOK_SECRET'),
    };
  }
}

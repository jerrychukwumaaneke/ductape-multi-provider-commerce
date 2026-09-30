import { PaymentProvider } from './types.js';

export interface RouteResolutionCriteria {
  preferredProvider?: string;
  currency?: string;
  country?: string;
}

export class PaymentRouter {
  private providers = new Map<string, PaymentProvider>();

  public register(provider: PaymentProvider): void {
    this.providers.set(provider.name.toLowerCase(), provider);
  }

  public getProvider(name: string): PaymentProvider | undefined {
    return this.providers.get(name.toLowerCase());
  }

  public resolveCandidates(criteria: RouteResolutionCriteria = {}): PaymentProvider[] {
    const candidates: PaymentProvider[] = [];
    const added = new Set<string>();

    const add = (name: string) => {
      const p = this.providers.get(name.toLowerCase());
      if (p && !added.has(p.name.toLowerCase())) {
        candidates.push(p);
        added.add(p.name.toLowerCase());
      }
    };

    // 1. Explicit preferred provider
    if (criteria.preferredProvider) {
      add(criteria.preferredProvider);
    }

    // 2. Rules by currency / country
    const currency = criteria.currency?.toUpperCase();
    if (currency === 'NGN') {
      add('paystack');
      add('flutterwave');
    } else if (currency === 'USD') {
      add('stripe');
      add('flutterwave');
    } else if (currency === 'EUR' || currency === 'GBP') {
      add('stripe');
    } else if (currency === 'KES' || currency === 'GHS' || currency === 'ZAR') {
      add('flutterwave');
      add('paystack');
    }

    // 3. Fallback to mock (for automated testing)
    if (this.providers.has('mock')) {
      add('mock');
    }

    // 4. Any other registered providers
    for (const [name] of this.providers) {
      add(name);
    }

    return candidates;
  }

  public resolve(criteria: RouteResolutionCriteria = {}): PaymentProvider {
    const candidates = this.resolveCandidates(criteria);
    if (candidates.length === 0) {
      throw new Error('No payment providers registered in PaymentRouter');
    }
    return candidates[0];
  }
}

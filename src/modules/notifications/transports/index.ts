import { SsrfGuard } from '../ssrf-guard.js';
import { CryptoUtils } from '../../../common/utils/crypto.js';

export interface TransportResult {
  success: boolean;
  error?: string;
  isTransient?: boolean;
}

export interface SendMessagePayload {
  to: string;
  subject?: string;
  body: string;
  secret?: string;
  recipientId?: string;
}

export interface INotificationTransport {
  send(message: SendMessagePayload): Promise<TransportResult>;
}

export class MockTransport implements INotificationTransport {
  public sentMessages: SendMessagePayload[] = [];
  public failNextCount = 0;
  public failPermanently = false;

  public async send(message: SendMessagePayload): Promise<TransportResult> {
    if (this.failPermanently) {
      return { success: false, error: 'Recipient address rejected', isTransient: false };
    }

    if (this.failNextCount > 0) {
      this.failNextCount--;
      return { success: false, error: 'Simulated connection timeout (504)', isTransient: true };
    }

    this.sentMessages.push(message);
    return { success: true };
  }

  public reset(): void {
    this.sentMessages = [];
    this.failNextCount = 0;
    this.failPermanently = false;
  }
}

export class HttpWebhookTransport implements INotificationTransport {
  private readonly timeoutMs: number;

  constructor(timeoutMs = 5000) {
    this.timeoutMs = timeoutMs;
  }

  public async send(message: SendMessagePayload): Promise<TransportResult> {
    // 1. SSRF check
    const check = SsrfGuard.isSafeUrl(message.to);
    if (!check.safe) {
      return { success: false, error: `SSRF Guard blocked URL: ${check.reason}`, isTransient: false };
    }

    // 2. Signature
    const secret = message.secret || 'default_webhook_secret';
    const signature = CryptoUtils.createHmacSha256(message.body, secret);

    // 3. Dispatch with timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(message.to, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-SHA256': signature,
          'User-Agent': 'DuctapeCommerce-Webhook/1.0',
        },
        body: message.body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const isTransient = response.status >= 500 || response.status === 429;
        return {
          success: false,
          error: `HTTP ${response.status} ${response.statusText}`,
          isTransient,
        };
      }

      return { success: true };
    } catch (err: any) {
      const isTransient = err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      return {
        success: false,
        error: err.message || 'Unknown network error',
        isTransient,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export * from './ductape.transport.js';

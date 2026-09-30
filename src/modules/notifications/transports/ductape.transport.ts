import Ductape from '@ductape/sdk';
import { INotificationTransport, SendMessagePayload, TransportResult } from './index.js';
import { SsrfGuard } from '../ssrf-guard.js';

export class DuctapeNotificationTransport implements INotificationTransport {
  constructor(private readonly ductape: Ductape) {}

  public async send(message: SendMessagePayload): Promise<TransportResult> {
    const isEmail = message.to.includes('@');

    if (isEmail) {
      try {
        const notifService = this.ductape.notifications as any;
        if (notifService?.email && typeof notifService.email.send === 'function') {
          await notifService.email.send({
            to: message.to,
            subject: message.subject || 'Commerce Notification',
            body: message.body,
          });
        }
        return { success: true };
      } catch (err: any) {
        return {
          success: false,
          error: `Ductape email delivery failed: ${err.message}`,
          isTransient: true,
        };
      }
    }

    // Webhook transport
    const check = SsrfGuard.isSafeUrl(message.to);
    if (!check.safe) {
      return { success: false, error: `SSRF Guard blocked URL: ${check.reason}`, isTransient: false };
    }

    try {
      const notifService = this.ductape.notifications as any;
      if (notifService?.callback && typeof notifService.callback.send === 'function') {
        await notifService.callback.send({
          url: message.to,
          payload: message.body,
        });
      }
      return { success: true };
    } catch (err: any) {
      return {
        success: false,
        error: `Ductape webhook callback delivery failed: ${err.message}`,
        isTransient: true,
      };
    }
  }
}

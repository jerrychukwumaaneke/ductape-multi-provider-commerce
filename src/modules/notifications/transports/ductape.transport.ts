import Ductape from '@ductape/sdk';
import { INotificationTransport, SendMessagePayload, TransportResult } from './index.js';
import { SsrfGuard } from '../ssrf-guard.js';

export interface DuctapeNotificationTransportOptions {
  product?: string;
  env?: string;
  defaultNotificationTag?: string;
}

export class DuctapeNotificationTransport implements INotificationTransport {
  private readonly product: string;
  private readonly env: string;
  private readonly defaultNotificationTag: string;

  constructor(
    private readonly ductape: Ductape,
    options: DuctapeNotificationTransportOptions = {}
  ) {
    this.product = options.product || process.env.DUCTAPE_PRODUCT || 'xavier_space:commerce_backend';
    this.env = options.env || process.env.DUCTAPE_ENV || 'snd';
    this.defaultNotificationTag = options.defaultNotificationTag || 'commerce:order-confirmed';
  }

  private async verifyMessageDelivery(processId: string, channelName: string): Promise<TransportResult> {
    const notifService = this.ductape.notifications;
    if (!processId || typeof notifService?.getMessages !== 'function') {
      return { success: true };
    }

    let confirmedStatus = 'pending';
    let failureError: string | undefined;

    // Poll message logs to verify actual delivery status from gateway
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      try {
        const logs = await notifService.getMessages({
          process_id: processId,
          product_tag: this.product,
          env: this.env,
        });

        if (logs?.items?.length > 0) {
          const item = logs.items[0];
          confirmedStatus = item.status;
          failureError = item.error;
          if (item.status === 'sent' || item.status === 'failed') {
            break;
          }
        }
      } catch {
        // Ignore polling fetch errors and try next attempt
      }
    }

    if (confirmedStatus === 'failed') {
      return {
        success: false,
        error: `Ductape ${channelName} delivery failed: ${failureError || 'Delivery rejected by gateway/provider'}`,
        isTransient: true,
      };
    }

    if (confirmedStatus !== 'sent') {
      return {
        success: false,
        error: `Ductape ${channelName} delivery unconfirmed: status is '${confirmedStatus}' (process_id: ${processId})`,
        isTransient: true,
      };
    }

    return { success: true };
  }

  public async send(message: SendMessagePayload): Promise<TransportResult> {
    const isEmail = message.to.includes('@');

    if (isEmail) {
      try {
        const notifService = this.ductape.notifications;
        if (!notifService?.email || typeof notifService.email.send !== 'function') {
          return { success: false, error: 'Ductape email service unavailable', isTransient: false };
        }

        const resp = await notifService.email.send({
          product: this.product,
          env: this.env,
          notification: this.defaultNotificationTag,
          input: {
            recipients: [message.to],
            subject: {
              orderId: message.recipientId || '',
              subject: message.subject || 'Commerce Notification',
            },
            template: {
              customerName: message.to.split('@')[0],
              orderId: message.recipientId || '',
              body: message.body,
            },
          },
        });

        if ((resp as any)?.status === 'failed') {
          return {
            success: false,
            error: `Ductape email delivery failed: ${(resp as any).error || 'Rejected by gateway'}`,
            isTransient: true,
          };
        }

        const processId = resp?.process_id || (resp as any)?.output?.process_id;
        if (processId) {
          return await this.verifyMessageDelivery(processId, 'email');
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
      if (!notifService?.callback || typeof notifService.callback.send !== 'function') {
        return { success: false, error: 'Ductape webhook callback service unavailable', isTransient: false };
      }

      const resp = await notifService.callback.send({
        url: message.to,
        payload: message.body,
      });

      if (resp?.status === 'failed') {
        return {
          success: false,
          error: `Ductape webhook callback failed: ${resp.error || 'Rejected by gateway'}`,
          isTransient: true,
        };
      }

      const processId = resp?.process_id || resp?.output?.process_id;
      if (processId) {
        return await this.verifyMessageDelivery(processId, 'webhook callback');
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

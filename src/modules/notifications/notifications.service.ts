import { IDatabaseClient } from '../../common/database/index.js';
import { CryptoUtils } from '../../common/utils/crypto.js';
import { NotFoundError, ValidationError, RateLimitedError } from '../../common/errors/app-error.js';
import { TemplateEngine } from './template-engine.js';
import { INotificationTransport, MockTransport } from './transports/index.js';
import {
  NotificationTemplate,
  CreateTemplateInput,
  NotificationPreference,
  SendNotificationInput,
  NotificationRecord,
  DeliveryAttemptRecord,
  WebhookEndpoint,
} from './types.js';

export class NotificationService {
  private readonly defaultTransport: INotificationTransport;
  private readonly webhookTransport: INotificationTransport;
  private readonly maxRetries = 5;
  private recipientRateLimitMap = new Map<string, number[]>(); // timestamp array

  constructor(
    private readonly db: IDatabaseClient,
    emailTransport?: INotificationTransport,
    webhookTransport?: INotificationTransport
  ) {
    this.defaultTransport = emailTransport ?? new MockTransport();
    this.webhookTransport = webhookTransport ?? new MockTransport();
  }

  // =================== TEMPLATES ===================

  public async createTemplate(input: CreateTemplateInput): Promise<NotificationTemplate> {
    const existing = await this.db.query<NotificationTemplate>(
      'SELECT version FROM notification_templates WHERE key = $1 ORDER BY version DESC LIMIT 1',
      [input.key]
    );

    const version = existing.rowCount > 0 ? existing.rows[0].version + 1 : 1;
    const id = CryptoUtils.generateId('tmpl');

    const res = await this.db.query<NotificationTemplate>(
      `INSERT INTO notification_templates (id, key, version, channel, category, subject, body, required_vars, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING id, key, version, channel, category, subject, body, required_vars, created_at`,
      [
        id,
        input.key,
        version,
        input.channel,
        input.category,
        input.subject ?? null,
        input.body,
        JSON.stringify(input.required_vars ?? []),
      ]
    );

    return res.rows[0];
  }

  public async getTemplate(key: string, version?: number): Promise<NotificationTemplate> {
    let query: string;
    let params: unknown[];

    if (version) {
      query = 'SELECT id, key, version, channel, category, subject, body, required_vars, created_at FROM notification_templates WHERE key = $1 AND version = $2';
      params = [key, version];
    } else {
      query = 'SELECT id, key, version, channel, category, subject, body, required_vars, created_at FROM notification_templates WHERE key = $1 ORDER BY version DESC LIMIT 1';
      params = [key];
    }

    const res = await this.db.query<NotificationTemplate>(query, params);
    if (res.rowCount === 0) {
      throw new NotFoundError('NotificationTemplate', key);
    }

    const row = res.rows[0];
    if (typeof row.required_vars === 'string') {
      row.required_vars = JSON.parse(row.required_vars);
    }
    return row;
  }

  // =================== PREFERENCES ===================

  public async setPreference(pref: NotificationPreference): Promise<void> {
    await this.db.query(
      `INSERT INTO notification_preferences (user_id, category, channel, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, category, channel) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [pref.user_id, pref.category, pref.channel, pref.enabled]
    );
  }

  public async getPreferences(userId: string): Promise<NotificationPreference[]> {
    const res = await this.db.query<NotificationPreference>(
      'SELECT user_id, category, channel, enabled FROM notification_preferences WHERE user_id = $1',
      [userId]
    );
    return res.rows;
  }

  // =================== RATE LIMITING ===================

  private checkRateLimit(recipient: string, limit = 10, windowMs = 60000): void {
    const now = Date.now();
    const timestamps = this.recipientRateLimitMap.get(recipient) || [];
    const valid = timestamps.filter((t) => now - t < windowMs);

    if (valid.length >= limit) {
      throw new RateLimitedError(Math.ceil((windowMs - (now - valid[0])) / 1000));
    }

    valid.push(now);
    this.recipientRateLimitMap.set(recipient, valid);
  }

  // =================== SEND NOTIFICATION ===================

  public async send(input: SendNotificationInput): Promise<NotificationRecord> {
    // 1. Idempotency Check
    if (input.idempotency_key) {
      const existing = await this.db.query<NotificationRecord>(
        'SELECT id, template_key, recipient, channel, status, dedupe_key, idempotency_key, vars, created_at FROM notifications WHERE idempotency_key = $1',
        [input.idempotency_key]
      );
      if (existing.rowCount > 0) {
        return existing.rows[0];
      }
    }

    // 2. Dedupe Check
    if (input.dedupe_key) {
      const existing = await this.db.query<NotificationRecord>(
        'SELECT id, template_key, recipient, channel, status, dedupe_key, idempotency_key, vars, created_at FROM notifications WHERE dedupe_key = $1',
        [input.dedupe_key]
      );
      if (existing.rowCount > 0) {
        return existing.rows[0];
      }
    }

    // 3. Load Template & Validate Required Variables
    const template = await this.getTemplate(input.template_key);
    TemplateEngine.validateVariables(template.required_vars, input.vars);

    // 4. Rate Limiting Check
    try {
      this.checkRateLimit(input.recipient);
    } catch {
      const notifId = CryptoUtils.generateId('notif');
      const res = await this.db.query<NotificationRecord>(
        `INSERT INTO notifications (id, template_key, recipient, channel, status, dedupe_key, idempotency_key, vars, created_at)
         VALUES ($1, $2, $3, $4, 'rate_limited', $5, $6, $7, NOW())
         RETURNING id, template_key, recipient, channel, status, dedupe_key, idempotency_key, vars, created_at`,
        [
          notifId,
          template.key,
          input.recipient,
          template.channel,
          input.dedupe_key ?? null,
          input.idempotency_key ?? null,
          JSON.stringify(input.vars),
        ]
      );
      throw new RateLimitedError(60);
    }

    // 5. User Preferences Check
    // Transactional category ALWAYS sends; optional categories can be opted out
    let isSuppressed = false;
    if (template.category === 'optional' && input.user_id) {
      const prefRes = await this.db.query<{ enabled: boolean }>(
        'SELECT enabled FROM notification_preferences WHERE user_id = $1 AND category = $2 AND channel = $3',
        [input.user_id, template.category, template.channel]
      );
      if (prefRes.rowCount > 0 && prefRes.rows[0].enabled === false) {
        isSuppressed = true;
      }
    }

    const notifId = CryptoUtils.generateId('notif');
    const initialStatus = isSuppressed ? 'suppressed' : 'queued';

    const insertRes = await this.db.query<NotificationRecord>(
      `INSERT INTO notifications (id, template_key, recipient, channel, status, dedupe_key, idempotency_key, vars, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING id, template_key, recipient, channel, status, dedupe_key, idempotency_key, vars, created_at`,
      [
        notifId,
        template.key,
        input.recipient,
        template.channel,
        initialStatus,
        input.dedupe_key ?? null,
        input.idempotency_key ?? null,
        JSON.stringify(input.vars),
      ]
    );

    let notification = insertRes.rows[0];
    if (isSuppressed) {
      return notification;
    }

    // 6. Deliver Notification with Retries
    notification = await this.executeDelivery(notification, template);
    return notification;
  }

  private async executeDelivery(
    notification: NotificationRecord,
    template: NotificationTemplate
  ): Promise<NotificationRecord> {
    const rendered = TemplateEngine.render(template, notification.vars);
    const transport = template.channel === 'webhook' ? this.webhookTransport : this.defaultTransport;

    let attemptNo = 0;
    let delivered = false;

    // Update status to 'sending'
    await this.db.query("UPDATE notifications SET status = 'sending' WHERE id = $1", [notification.id]);

    while (attemptNo < this.maxRetries && !delivered) {
      attemptNo++;

      const res = await transport.send({
        to: notification.recipient,
        subject: rendered.subject,
        body: rendered.body,
      });

      if (res.success) {
        delivered = true;
        await this.recordAttempt(notification.id, attemptNo, 'success');
      } else {
        const isTransient = res.isTransient !== false;
        const outcome = isTransient ? 'transient_failure' : 'permanent_failure';
        await this.recordAttempt(notification.id, attemptNo, outcome, res.error);

        if (!isTransient) {
          // Permanent failure; stop retrying immediately
          break;
        }

        // On transient failure, update status to 'retrying'
        if (attemptNo < this.maxRetries) {
          await this.db.query("UPDATE notifications SET status = 'retrying' WHERE id = $1", [notification.id]);
        }
      }
    }

    const finalStatus = delivered ? 'delivered' : 'failed';
    const finalRes = await this.db.query<NotificationRecord>(
      'UPDATE notifications SET status = $1 WHERE id = $2 RETURNING id, template_key, recipient, channel, status, dedupe_key, idempotency_key, vars, created_at',
      [finalStatus, notification.id]
    );

    return finalRes.rows[0];
  }

  private async recordAttempt(
    notificationId: string,
    attemptNo: number,
    outcome: 'success' | 'transient_failure' | 'permanent_failure',
    error?: string
  ): Promise<void> {
    const id = CryptoUtils.generateId('atmpt');
    await this.db.query(
      `INSERT INTO delivery_attempts (id, notification_id, attempt_no, outcome, error, at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [id, notificationId, attemptNo, outcome, error ?? null]
    );
  }

  // =================== DELIVERY STATUS & REPLAY ===================

  public async getNotification(id: string): Promise<{
    notification: NotificationRecord;
    attempts: DeliveryAttemptRecord[];
  }> {
    const notifRes = await this.db.query<NotificationRecord>(
      'SELECT id, template_key, recipient, channel, status, dedupe_key, idempotency_key, vars, created_at FROM notifications WHERE id = $1',
      [id]
    );
    if (notifRes.rowCount === 0) {
      throw new NotFoundError('Notification', id);
    }

    const attemptsRes = await this.db.query<DeliveryAttemptRecord>(
      'SELECT id, notification_id, attempt_no, outcome, error, at FROM delivery_attempts WHERE notification_id = $1 ORDER BY attempt_no ASC',
      [id]
    );

    return {
      notification: notifRes.rows[0],
      attempts: attemptsRes.rows,
    };
  }

  public async replayFailed(notificationId: string): Promise<NotificationRecord> {
    const { notification } = await this.getNotification(notificationId);
    if (notification.status !== 'failed') {
      throw new ValidationError(`Cannot replay notification with status '${notification.status}' (must be 'failed').`);
    }

    const template = await this.getTemplate(notification.template_key);
    return this.executeDelivery(notification, template);
  }

  // =================== OUTGOING WEBHOOK ENDPOINTS ===================

  public async registerWebhookEndpoint(data: { ownerId: string; url: string; secret: string }): Promise<WebhookEndpoint> {
    const id = CryptoUtils.generateId('whk');
    const res = await this.db.query<WebhookEndpoint>(
      `INSERT INTO webhook_endpoints (id, owner_id, url, secret, active, consecutive_failures, created_at)
       VALUES ($1, $2, $3, $4, TRUE, 0, NOW())
       RETURNING id, owner_id, url, secret, active, consecutive_failures, created_at`,
      [id, data.ownerId, data.url, data.secret]
    );
    return res.rows[0];
  }

  public async recordEndpointFailure(endpointId: string): Promise<void> {
    const res = await this.db.query<{ consecutive_failures: number }>(
      'UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1 WHERE id = $1 RETURNING consecutive_failures',
      [endpointId]
    );
    if (res.rowCount > 0 && res.rows[0].consecutive_failures >= 5) {
      await this.db.query('UPDATE webhook_endpoints SET active = FALSE WHERE id = $1', [endpointId]);
    }
  }

  public async recordDeadLetter(input: {
    customerId?: string;
    orderId?: string;
    error: string;
  }): Promise<string> {
    const id = CryptoUtils.generateId('notif');
    await this.db.query(
      `INSERT INTO notifications (id, recipient, template_key, channel, status, vars, created_at)
       VALUES ($1, $2, 'dead_letter', 'email', 'failed', $3, NOW())`,
      [
        id,
        `missing_customer_${input.customerId || 'unknown'}`,
        JSON.stringify({ error: input.error, orderId: input.orderId, customerId: input.customerId }),
      ]
    );

    const attemptId = CryptoUtils.generateId('att');
    await this.db.query(
      `INSERT INTO delivery_attempts (id, notification_id, attempt_no, outcome, error, at)
       VALUES ($1, $2, 1, 'permanent_failure', $3, NOW())`,
      [attemptId, id, input.error]
    );

    return id;
  }
}

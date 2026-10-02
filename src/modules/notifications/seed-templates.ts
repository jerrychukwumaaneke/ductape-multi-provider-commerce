import { IDatabaseClient } from '../../common/database/index.js';

export interface DefaultTemplateDef {
  key: string;
  channel: 'email' | 'webhook' | 'sms' | 'push';
  category: 'transactional' | 'optional';
  subject: string;
  body: string;
  required_vars: string[];
}

export const DEFAULT_NOTIFICATION_TEMPLATES: DefaultTemplateDef[] = [
  {
    key: 'order_confirmed',
    channel: 'email',
    category: 'transactional',
    subject: 'Order Confirmed: {{order_id}}',
    body: 'Hello {{customer_name}}, your order {{order_id}} for {{total}} has been confirmed.',
    required_vars: [],
  },
  {
    key: 'order_cancelled',
    channel: 'email',
    category: 'transactional',
    subject: 'Order Cancelled: {{order_id}}',
    body: 'Hello {{customer_name}}, your order {{order_id}} has been cancelled.',
    required_vars: [],
  },
  {
    key: 'payment_refunded_alert',
    channel: 'email',
    category: 'transactional',
    subject: 'Payment Refunded: {{order_id}}',
    body: 'Hello {{customer_name}}, your payment for order {{order_id}} has been refunded. Reason: {{reason}}',
    required_vars: [],
  },
  {
    key: 'payment_failed',
    channel: 'email',
    category: 'transactional',
    subject: 'Payment Failed: {{order_id}}',
    body: 'Hello {{customer_name}}, payment for your order {{order_id}} could not be processed.',
    required_vars: [],
  },
  {
    key: 'order_paid',
    channel: 'email',
    category: 'transactional',
    subject: 'Payment Received: {{order_id}}',
    body: 'Hello {{customer_name}}, your payment for order {{order_id}} has been received.',
    required_vars: [],
  },
  {
    key: 'order_shipped',
    channel: 'email',
    category: 'transactional',
    subject: 'Order Shipped: {{order_id}}',
    body: 'Hello {{customer_name}}, your order {{order_id}} has shipped.',
    required_vars: [],
  },
  {
    key: 'order_delivered',
    channel: 'email',
    category: 'transactional',
    subject: 'Order Delivered: {{order_id}}',
    body: 'Hello {{customer_name}}, your order {{order_id}} has been delivered.',
    required_vars: [],
  },
  {
    key: 'order_refunded',
    channel: 'email',
    category: 'transactional',
    subject: 'Order Refunded: {{order_id}}',
    body: 'Hello {{customer_name}}, your order {{order_id}} has been refunded.',
    required_vars: [],
  },
];

export async function seedNotificationTemplates(db: IDatabaseClient): Promise<void> {
  for (const t of DEFAULT_NOTIFICATION_TEMPLATES) {
    const id = `tmpl_${t.key}_v1`;
    await db.query(
      `INSERT INTO notification_templates (id, key, version, channel, category, subject, body, required_vars, created_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (key, version) DO UPDATE
       SET subject = EXCLUDED.subject,
           body = EXCLUDED.body,
           required_vars = EXCLUDED.required_vars,
           channel = EXCLUDED.channel,
           category = EXCLUDED.category`,
      [
        id,
        t.key,
        t.channel,
        t.category,
        t.subject,
        t.body,
        JSON.stringify(t.required_vars),
      ]
    );
  }
}

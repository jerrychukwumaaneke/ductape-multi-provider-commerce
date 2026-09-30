import { NotificationChannel, NotificationCategory, NotificationStatus, DeliveryOutcome } from '../../common/types/index.js';

export interface NotificationTemplate {
  id: string;
  key: string;
  version: number;
  channel: NotificationChannel;
  category: NotificationCategory;
  subject?: string | null;
  body: string;
  required_vars: string[];
  created_at: Date;
}

export interface CreateTemplateInput {
  key: string;
  channel: NotificationChannel;
  category: NotificationCategory;
  subject?: string;
  body: string;
  required_vars?: string[];
}

export interface NotificationPreference {
  user_id: string;
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
}

export interface SendNotificationInput {
  template_key: string;
  recipient: string;
  vars: Record<string, unknown>;
  idempotency_key?: string;
  dedupe_key?: string;
  user_id?: string;
}

export interface NotificationRecord {
  id: string;
  template_key: string;
  recipient: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  dedupe_key?: string | null;
  idempotency_key?: string | null;
  vars: Record<string, unknown>;
  created_at: Date;
}

export interface DeliveryAttemptRecord {
  id: string;
  notification_id: string;
  attempt_no: number;
  outcome: DeliveryOutcome;
  error?: string | null;
  at: Date;
}

export interface WebhookEndpoint {
  id: string;
  owner_id: string;
  url: string;
  secret: string;
  active: boolean;
  consecutive_failures: number;
  created_at: Date;
}

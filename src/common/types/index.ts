export type Currency = 'NGN' | 'USD' | 'EUR' | 'GBP' | string;

export type UserRole = 'customer' | 'admin' | 'agent';

export type ActorType = 'user' | 'agent' | 'system' | 'webhook';

export interface ActorContext {
  actorId: string;
  actorType: ActorType;
  customerId?: string;
  role?: UserRole;
  scope?: string[];
}

export type OrderStatus =
  | 'pending'
  | 'awaiting_payment'
  | 'paid'
  | 'fulfilled'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'payment_failed'
  | 'expired';

export type PaymentIntentStatus =
  | 'created'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export type ReservationStatus =
  | 'held'
  | 'committed'
  | 'released'
  | 'expired';

export type NotificationChannel = 'email' | 'webhook' | 'sms' | 'push';

export type NotificationCategory = 'transactional' | 'optional';

export type NotificationStatus =
  | 'queued'
  | 'sending'
  | 'delivered'
  | 'retrying'
  | 'failed'
  | 'suppressed'
  | 'rate_limited';

export type DeliveryOutcome = 'success' | 'transient_failure' | 'permanent_failure';

export interface Customer {
  id: string;
  email: string;
  name: string;
  created_at: Date;
}

export interface User {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  customer_id?: string | null;
  created_at: Date;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  price_minor: number;
  currency: Currency;
  active: boolean;
  created_at: Date;
}

export interface Inventory {
  product_id: string;
  on_hand: number;
  reserved: number;
}

export interface Reservation {
  id: string;
  order_id: string;
  product_id: string;
  qty: number;
  status: ReservationStatus;
  expires_at: Date;
  created_at: Date;
}

export interface Order {
  id: string;
  customer_id: string;
  status: OrderStatus;
  total_minor: number;
  currency: Currency;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
  items?: OrderItem[];
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  name_snapshot: string;
  unit_price_minor: number;
  qty: number;
}

export interface PaymentIntent {
  id: string;
  order_id: string;
  provider: string;
  provider_ref?: string | null;
  amount_minor: number;
  currency: Currency;
  status: PaymentIntentStatus;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
}

export interface TransactionRecord {
  id: string;
  payment_intent_id: string;
  type: 'charge' | 'refund';
  amount_minor: number;
  status: string;
  provider_ref?: string | null;
  raw_response?: unknown;
  created_at: Date;
}

export interface AuditLogEntry {
  id: string;
  actor_id: string;
  actor_type: ActorType;
  action: string;
  entity: string;
  entity_id: string;
  before?: unknown;
  after?: unknown;
  at: Date;
}

export interface IdempotencyRecord {
  key: string;
  scope: string;
  request_hash: string;
  response: unknown;
  created_at: Date;
}

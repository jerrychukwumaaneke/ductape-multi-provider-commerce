import { Currency, OrderStatus, UserRole } from '../common/types/index.js';

export interface McpResponseEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    hint?: string;
  };
  has_more?: boolean;
}

export interface AgentAuthContext {
  agentId: string;
  role: UserRole;
  scope: string[];
  customerId?: string;
}

export interface SearchProductsParams {
  query?: string;
  limit?: number;
  offset?: number;
}

export interface GetOrderParams {
  order_id: string;
}

export interface ListOrdersParams {
  customer_id?: string;
  status?: OrderStatus;
  limit?: number;
  offset?: number;
}

export interface CreateCheckoutParams {
  items: Array<{ productId: string; qty: number }>;
  idempotency_key: string;
  currency?: Currency;
  provider?: string;
  email?: string;
}

export interface CancelOrderParams {
  order_id: string;
  reason?: string;
}

export interface GetPaymentStatusParams {
  payment_intent_id?: string;
  order_id?: string;
}

export interface ListTransactionsParams {
  payment_intent_id?: string;
  order_id?: string;
  limit?: number;
}

export interface RefundPaymentParams {
  payment_intent_id: string;
  amount_minor?: number;
  confirm: boolean;
  reason?: string;
}

export interface ResendNotificationParams {
  notification_id?: string;
  template_key?: string;
  recipient?: string;
  vars?: Record<string, string>;
  idempotency_key?: string;
}

export interface GetDeliveryStatusParams {
  notification_id: string;
}

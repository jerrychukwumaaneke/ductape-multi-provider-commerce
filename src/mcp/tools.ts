import { z } from 'zod';

export const ToolSchemas = {
  search_products: {
    description: 'Search available active products in the commerce catalog with real-time stock levels.',
    parameters: z.object({
      query: z.string().optional().describe('Search query matching product name or SKU'),
      limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of items to return (1-100)'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset number (>= 0)'),
    }),
  },

  get_order: {
    description: 'Fetch complete details and line items of a specific order by ID.',
    parameters: z.object({
      order_id: z.string().min(1).describe('The unique order identifier (e.g., ord_...)'),
    }),
  },

  list_orders: {
    description: 'List orders scoped to the authenticated customer or filtered by status with bounded pagination.',
    parameters: z.object({
      customer_id: z.string().optional().describe('Optional customer ID filter (only admins can query arbitrary customers)'),
      status: z.enum([
        'pending',
        'awaiting_payment',
        'paid',
        'fulfilled',
        'shipped',
        'delivered',
        'cancelled',
        'payment_failed',
        'expired',
      ]).optional().describe('Filter by order status enum'),
      limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of orders to return (1-100)'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset (>= 0)'),
    }),
  },

  create_checkout: {
    description: 'Create an order and initiate a checkout session. Atomically reserves stock and creates a payment intent.',
    parameters: z.object({
      items: z.array(
        z.object({
          productId: z.string().min(1).describe('Unique product ID'),
          qty: z.number().int().min(1).describe('Quantity to purchase (> 0)'),
        })
      ).min(1).describe('Array of items to purchase'),
      idempotency_key: z.string().min(1).describe('Unique idempotency key to prevent double checkout'),
      currency: z.string().default('USD').describe('3-letter ISO currency code (e.g. USD, NGN)'),
      provider: z.string().optional().describe('Payment provider name (mock, paystack, stripe, flutterwave)'),
      email: z.string().email().optional().describe('Customer email for notifications'),
    }),
  },

  cancel_order: {
    description: 'Idempotently cancel an unfulfilled order and immediately release reserved inventory.',
    parameters: z.object({
      order_id: z.string().min(1).describe('Order ID to cancel'),
      reason: z.string().optional().describe('Optional cancellation reason'),
    }),
  },

  get_payment_status: {
    description: 'Check the real-time status and provider reference of a payment intent or order.',
    parameters: z.object({
      payment_intent_id: z.string().optional().describe('Payment intent ID (e.g., pi_...)'),
      order_id: z.string().optional().describe('Order ID to look up payment for'),
    }).refine(data => data.payment_intent_id || data.order_id, {
      message: 'Either payment_intent_id or order_id must be provided',
    }),
  },

  list_transactions: {
    description: 'Retrieve financial transaction ledger entries (charges, refunds) for an intent or order.',
    parameters: z.object({
      payment_intent_id: z.string().optional().describe('Payment intent ID'),
      order_id: z.string().optional().describe('Order ID'),
      limit: z.number().int().min(1).max(100).default(20).describe('Maximum transactions to return (1-100)'),
    }),
  },

  refund_payment: {
    description: 'DESTRUCTIVE: Issue a full or partial refund for a succeeded payment intent. Requires explicit confirmation and elevated permissions.',
    parameters: z.object({
      payment_intent_id: z.string().min(1).describe('Payment intent ID to refund'),
      amount_minor: z.number().int().min(1).optional().describe('Optional minor unit amount to refund (defaults to full remaining amount)'),
      confirm: z.boolean().describe('Must be set to true to acknowledge destructive financial action'),
      reason: z.string().optional().describe('Reason for refund'),
    }),
  },

  resend_notification: {
    description: 'Resend an order confirmation or notification, or replay a dead-lettered failed delivery.',
    parameters: z.object({
      notification_id: z.string().optional().describe('Existing notification ID to replay'),
      template_key: z.string().optional().describe('Template key to send'),
      recipient: z.string().optional().describe('Recipient email address or webhook URL'),
      vars: z.record(z.string(), z.string()).optional().describe('Template interpolation variables'),
      idempotency_key: z.string().optional().describe('Idempotency key for resend'),
    }),
  },

  get_delivery_status: {
    description: 'Inspect the delivery status, attempt logs, and final outcome of a sent notification.',
    parameters: z.object({
      notification_id: z.string().min(1).describe('Notification ID to inspect'),
    }),
  },
};

export type ToolName = keyof typeof ToolSchemas;

export const TOOL_NAMES = Object.keys(ToolSchemas) as ToolName[];

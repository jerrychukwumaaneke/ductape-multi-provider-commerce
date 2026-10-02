import fs from 'fs';
import path from 'path';
import { IDatabaseClient } from '../common/database/index.js';

export const INITIAL_SCHEMA_SQL = `
-- 1. Customers
CREATE TABLE IF NOT EXISTS customers (
    id VARCHAR(64) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Users (authentication and roles)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL CHECK (role IN ('customer', 'admin', 'agent')),
    customer_id VARCHAR(64) REFERENCES customers(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Products
CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(64) PRIMARY KEY,
    sku VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
    currency VARCHAR(3) NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Inventory
CREATE TABLE IF NOT EXISTS inventory (
    product_id VARCHAR(64) PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    on_hand INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT check_inventory_on_hand CHECK (on_hand >= 0),
    CONSTRAINT check_inventory_reserved CHECK (reserved >= 0),
    CONSTRAINT check_inventory_bound CHECK (reserved <= on_hand)
);

-- 5. Reservations
CREATE TABLE IF NOT EXISTS reservations (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    product_id VARCHAR(64) NOT NULL REFERENCES products(id),
    qty INTEGER NOT NULL CHECK (qty > 0),
    status VARCHAR(32) NOT NULL CHECK (status IN ('held', 'committed', 'released', 'expired')),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reservations_status_expires ON reservations(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_reservations_order ON reservations(order_id);

-- 6. Orders
CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL REFERENCES customers(id),
    status VARCHAR(32) NOT NULL CHECK (status IN ('pending', 'awaiting_payment', 'paid', 'fulfilled', 'shipped', 'delivered', 'cancelled', 'payment_failed', 'expired')),
    total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
    currency VARCHAR(3) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT unique_customer_order_idempotency UNIQUE (customer_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- 7. Order Items
CREATE TABLE IF NOT EXISTS order_items (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id VARCHAR(64) NOT NULL REFERENCES products(id),
    name_snapshot VARCHAR(255) NOT NULL,
    unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
    qty INTEGER NOT NULL CHECK (qty > 0)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- 8. Payment Intents
CREATE TABLE IF NOT EXISTS payment_intents (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL REFERENCES orders(id),
    provider VARCHAR(64) NOT NULL,
    provider_ref VARCHAR(255),
    amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
    currency VARCHAR(3) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('created', 'processing', 'succeeded', 'failed', 'canceled')),
    idempotency_key VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_intents_order ON payment_intents(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_ref ON payment_intents(provider, provider_ref);

-- 9. Transactions
CREATE TABLE IF NOT EXISTS transactions (
    id VARCHAR(64) PRIMARY KEY,
    payment_intent_id VARCHAR(64) NOT NULL REFERENCES payment_intents(id),
    type VARCHAR(32) NOT NULL CHECK (type IN ('charge', 'refund')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
    status VARCHAR(32) NOT NULL,
    provider_ref VARCHAR(255),
    raw_response JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transactions_intent ON transactions(payment_intent_id);

-- 10. Webhook Events
CREATE TABLE IF NOT EXISTS webhook_events (
    id VARCHAR(64) PRIMARY KEY,
    provider VARCHAR(64) NOT NULL,
    provider_event_id VARCHAR(255) NOT NULL,
    type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT unique_provider_event UNIQUE (provider, provider_event_id)
);

-- 11. Notification Templates
CREATE TABLE IF NOT EXISTS notification_templates (
    id VARCHAR(64) PRIMARY KEY,
    key VARCHAR(100) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    channel VARCHAR(32) NOT NULL CHECK (channel IN ('email', 'webhook', 'sms', 'push')),
    category VARCHAR(32) NOT NULL CHECK (category IN ('transactional', 'optional')),
    subject VARCHAR(255),
    body TEXT NOT NULL,
    required_vars JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT unique_template_key_version UNIQUE (key, version)
);

-- 12. Notification Preferences
CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id VARCHAR(64) NOT NULL,
    category VARCHAR(32) NOT NULL,
    channel VARCHAR(32) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (user_id, category, channel)
);

-- 13. Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id VARCHAR(64) PRIMARY KEY,
    template_key VARCHAR(100) NOT NULL,
    recipient VARCHAR(255) NOT NULL,
    channel VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('queued', 'sending', 'delivered', 'retrying', 'failed', 'suppressed', 'rate_limited')),
    dedupe_key VARCHAR(255) UNIQUE,
    idempotency_key VARCHAR(255),
    vars JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);

-- 14. Delivery Attempts
CREATE TABLE IF NOT EXISTS delivery_attempts (
    id VARCHAR(64) PRIMARY KEY,
    notification_id VARCHAR(64) NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    attempt_no INTEGER NOT NULL,
    outcome VARCHAR(32) NOT NULL CHECK (outcome IN ('success', 'transient_failure', 'permanent_failure')),
    error TEXT,
    at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_notif ON delivery_attempts(notification_id);

-- 15. Webhook Endpoints (Outgoing)
CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id VARCHAR(64) PRIMARY KEY,
    owner_id VARCHAR(64) NOT NULL,
    url TEXT NOT NULL,
    secret VARCHAR(255) NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    consecutive_failures INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 16. Audit Log (Append-only)
CREATE TABLE IF NOT EXISTS audit_log (
    id VARCHAR(64) PRIMARY KEY,
    actor_id VARCHAR(64) NOT NULL,
    actor_type VARCHAR(32) NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
    action VARCHAR(100) NOT NULL,
    entity VARCHAR(64) NOT NULL,
    entity_id VARCHAR(64) NOT NULL,
    before JSONB,
    after JSONB,
    at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_type, actor_id);

-- 17. Idempotency Records
CREATE TABLE IF NOT EXISTS idempotency_records (
    key VARCHAR(255) NOT NULL,
    scope VARCHAR(64) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    response JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (key, scope)
);

-- 18. Transactional Outbox
CREATE TABLE IF NOT EXISTS outbox (
    id VARCHAR(64) PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    claimed_at TIMESTAMP WITH TIME ZONE,
    scheduled_for TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
CREATE INDEX IF NOT EXISTS idx_outbox_scheduled ON outbox(status, scheduled_for);
`;

export async function runMigrations(db: IDatabaseClient): Promise<void> {
  console.log('[DatabaseMigrations] Ensuring schema tables exist...');
  let sqlToRun = INITIAL_SCHEMA_SQL;

  const candidatePaths = [
    path.resolve(process.cwd(), 'src/db/migrations/001_initial_schema.sql'),
    path.resolve(process.cwd(), 'dist/db/migrations/001_initial_schema.sql'),
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const fileContent = fs.readFileSync(p, 'utf8');
        if (fileContent.trim().length > 0) {
          sqlToRun = fileContent;
          break;
        }
      } catch {
        // Fall back to embedded schema
      }
    }
  }

  await db.query(sqlToRun);
  console.log('[DatabaseMigrations] Schema migrations verified and applied successfully.');
}

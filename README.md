# Agent-Operable Commerce Backend

[![Tests](https://img.shields.io/badge/tests-72%20passed-brightgreen.svg)](#testing)
[![Architecture](https://img.shields.io/badge/architecture-Modular%20Monolith-blue.svg)](#architecture)
[![Interface](https://img.shields.io/badge/MCP-10%20Tools%20Supported-purple.svg)](#mcp-agent-interface)

An enterprise-grade, agent-operable commerce backend built with TypeScript, Node.js, and PostgreSQL. Designed as a strict **Modular Monolith**, this backend exposes both a front-door REST API and a Model Context Protocol (MCP) server for autonomous AI coding agents and human shoppers.

---

## Architecture Overview

The system strictly follows the **Modular Monolith** architectural pattern. High-level API and MCP transports act as thin adapters delegating all business logic to decoupled, cohesive domain service modules:

```
                          ┌─────────────────────────────┐
                          │   AI Agents / MCP Clients   │
                          └──────────────┬──────────────┘
                                         │ JSON-RPC / MCP Protocol
                                         ▼
┌───────────────────────────┐   ┌────────────────────────────────┐
│   HTTP Shoppers / Admin   │   │  MCP Server (src/mcp)          │
└─────────────┬─────────────┘   │  - 10 Scoped Agent Tools       │
              │ REST            │  - Prompt-Injection Defense    │
              ▼                 │  - Consistent Envelope         │
┌───────────────────────────┐   └────────────────┬───────────────┘
│  REST API (src/api)       │                    │
│  - /auth, /products       │                    │
│  - /checkout, /orders     │                    │
│  - /payments, /webhooks   │                    │
│  - /notifications         │                    │
└─────────────┬─────────────┘                    │
              └──────────────────┬───────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        DOMAIN SERVICES (src/modules)                   │
├─────────────────┬─────────────────┬──────────────────┬─────────────────┤
│    Identity     │    Inventory    │      Orders      │    Payments     │
│  - JWT Auth     │  - Atomic stock │  - Order items   │  - Router/rules │
│  - Agent tokens │  - Expiry worker│  - State Machine │  - Failover     │
│  - BCrypt       │  - Zero oversell│  - Checkout Saga │  - Webhook dedup│
├─────────────────┴─────────────────┴──────────────────┴─────────────────┤
│     Notifications      │     Idempotency      │       Audit Log        │
│  - Email / Webhook     │  - SHA-256 Hashing   │  - Append-only ledger  │
│  - SSRF Guard / Retry  │  - Concurrent lock   │  - Actor attribution   │
└────────────────────────────────┬───────────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    DATABASE ABSTRACTION (src/common)                   │
│  PostgreSQL 14+ / pg-mem (In-Memory Isolation Harness for Tests)       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Core Guarantees & Design Rules

1. **Zero Overselling Under Concurrency:** Stock reservations execute via an atomic conditional SQL operation:
   $$\text{reserved} = \text{reserved} + \text{qty} \quad \text{WHERE} \quad (\text{on\_hand} - \text{reserved}) \ge \text{qty}$$
   Verified by high-concurrency race condition tests (e.g. 2 simultaneous checkouts for 1 final unit; exactly 1 succeeds).
2. **Integer Minor Units:** All monetary values are strictly stored and computed as integer minor units (kobo, cents). No floating-point math is ever used for balances or transactions.
3. **Idempotent Mutating Operations:** Writes use SHA-256 idempotency hashing. Repeated operations return stored responses without side effects. Repeated order cancellations succeed quietly.
4. **Resilient Checkout Saga:** Coordinates inventory reservations, payment intents, webhook confirmation, and transactional notifications. If a webhook arrives after order expiration, an automatic refund is triggered with an audit alert.
5. **Prompt-Injection Defense:** Free-text customer or order fields are returned strictly as passive data attributes inside structured JSON envelopes.

---

## Directory Structure

```
├── commerce-backend-prd.md     # Product Requirement Document
├── docs/
│   └── ductape-findings.md     # Milestone 1: Ductape verification spike & architectural decisions
├── src/
│   ├── api/                    # Milestone 9: REST API Front Door
│   │   ├── middleware/         # Auth and AppError formatting middleware
│   │   ├── routes/             # Thin Express routes (/auth, /products, /orders, /payments, etc.)
│   │   └── app.ts              # Express application factory
│   ├── common/                 # Shared foundations
│   │   ├── database/           # IDatabaseClient and Postgres client
│   │   ├── errors/             # Standard AppError hierarchy
│   │   ├── state-machine/      # Order and Payment transition validators
│   │   ├── types/              # Common domain interfaces
│   │   └── utils/              # Cryptographic helpers
│   ├── db/
│   │   └── migrations/         # 001_initial_schema.sql (17 relational tables)
│   ├── mcp/                    # Milestone 7: Model Context Protocol Server
│   │   ├── server.ts           # MCP Commerce Server implementation
│   │   ├── tools.ts            # Strict Zod schemas for the 10 agent tools
│   │   └── types.ts            # MCP envelopes & agent context
│   ├── modules/
│   │   ├── audit/              # Append-only audit trail
│   │   ├── idempotency/        # Deterministic SHA-256 idempotency service
│   │   ├── identity/           # Password hashing, JWT tokens, scoped agent tokens
│   │   ├── inventory/          # Conditional atomic stock reservation and expiry worker
│   │   ├── notifications/      # Template engine, SSRF guard, delivery attempts, retries
│   │   ├── orders/             # Order lifecycle, price snapshots, Checkout Saga
│   │   └── payments/           # Router, failover, webhooks, Paystack, Flutterwave, Stripe, Mock
│   └── index.ts                # Application bootstrapper
└── tests/
    ├── contracts/              # Provider contract test suite (run across Mock, Flutterwave, Stripe)
    ├── e2e/                    # Scripted MCP Agent E2E scenario
    ├── integration/            # Inventory concurrency, payment, saga, and REST API tests
    ├── unit/                   # Foundation and Notification unit tests
    └── test-db.ts              # In-memory PostgreSQL harness using pg-mem
```

---

## Getting Started

### Prerequisites

- Node.js 18+ (tested on Node.js v24)
- PostgreSQL 14+ (optional for local dev; automated tests use self-contained in-memory PostgreSQL)

### 1. Installation

```bash
git clone <repository-url>
cd ductape-project
npm install
```

### 2. Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Key environment variables:

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:postgres@localhost:5432/commerce_db` |
| `JWT_SECRET` | Secret key for JWT session tokens | `super-secret-jwt-key` |
| `PORT` | HTTP server port | `3000` |
| `PAYSTACK_SECRET_KEY` | Paystack API Secret Key | Optional in test |
| `FLUTTERWAVE_SECRET_KEY` | Flutterwave API Secret Key | Optional in test |
| `FLUTTERWAVE_SECRET_HASH`| Flutterwave Webhook Secret Hash | Optional in test |
| `STRIPE_SECRET_KEY` | Stripe Secret API Key | Optional in test |
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook Signing Secret | Optional in test |

---

## Testing

The test suite runs with **Vitest** and requires **zero external databases or credentials**, executing against an in-memory PostgreSQL instance with complete relational constraints:

```bash
# Run all 72 automated test suites
npm test

# Run tests in watch mode
npm run test:watch
```

### Test Coverage Highlights:

- **Inventory Concurrency (`tests/integration/inventory-concurrency.test.ts`):** Verifies that two simultaneous checkout requests competing for the last unit of stock result in exactly one purchase and zero overselling.
- **Provider Contracts (`tests/contracts/multi-provider.test.ts`):** Ensures `Mock`, `Flutterwave`, and `Stripe` pass identical verification, cancellation, refund, and webhook signature contracts.
- **Checkout Saga (`tests/integration/checkout-saga.test.ts`):** Tests happy path, stock release on payment failure, and auto-refund on late webhooks after expiry.
- **MCP Agent Interface (`tests/e2e/mcp-agent.test.ts`):** Full end-to-end scripted agent workflow using only MCP tools.
- **REST API (`tests/integration/api.test.ts`):** Validates authentication, order lifecycle, and standard error shape `{ error: { code, message, details, hint } }`.

---

## MCP Agent Interface

The Model Context Protocol (MCP) server provides 10 tools tailored for AI agents:

| Tool Name | Parameters | Description | Permissions |
|---|---|---|---|
| `search_products` | `query?`, `limit?`, `offset?` | Search active catalog with real-time stock levels | Read-only |
| `get_order` | `order_id` | Retrieve order details and items | Read-only (customer scoped) |
| `list_orders` | `customer_id?`, `status?`, `limit?`, `offset?` | Bounded pagination of orders (`has_more`) | Read-only (customer scoped) |
| `create_checkout` | `items`, `idempotency_key`, `currency?`, `provider?` | Reserve stock & initialize payment intent | Read-Write |
| `cancel_order` | `order_id`, `reason?` | Idempotently cancel order & release held stock | Read-Write |
| `get_payment_status` | `payment_intent_id?`, `order_id?` | Inspect payment status & gateway ref | Read-only |
| `list_transactions` | `payment_intent_id?`, `order_id?`, `limit?` | Ledger of charges & refunds | Read-only |
| `refund_payment` | `payment_intent_id`, `amount_minor?`, `confirm` | **Destructive**: Requires `confirm: true` | Elevated (`admin` / `payments:refund`) |
| `resend_notification` | `notification_id?`, `template_key?`, `recipient?`, `vars?` | Resend or replay notification | Read-Write |
| `get_delivery_status` | `notification_id` | View delivery attempts & timestamps | Read-only |

### Standard Response Envelope

Every MCP tool responds with a uniform JSON envelope:

```json
{
  "success": true,
  "data": { ... },
  "has_more": false
}
```

In case of error:

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_INVENTORY",
    "message": "One or more requested items do not have sufficient available inventory.",
    "hint": "Reduce the requested quantities or remove out-of-stock items and try again."
  }
}
```

---

## REST API Reference

All requests accept and return JSON. Mutating requests should pass an `Idempotency-Key` header.

### Authentication
- `POST /auth/register` — Register a customer or admin (`{ email, password, role?, name? }`)
- `POST /auth/login` — Authenticate and receive JWT access/refresh tokens
- `POST /auth/refresh` — Refresh access token

### Catalog & Inventory
- `GET /products` — List catalog products
- `GET /products/:id` — Get product & stock details
- `POST /products` — *Admin*: Create new product
- `PUT /inventory/:productId` — *Admin*: Update on-hand inventory

### Orders & Checkout
- `POST /checkout` — Initiate checkout session with stock reservation
- `GET /orders/:id` — Get order status & items
- `GET /orders` — List orders (scoped to authenticated user)
- `POST /orders/:id/cancel` — Idempotently cancel an unfulfilled order
- `PATCH /orders/:id/status` — *Admin*: Advance order status

### Payments & Webhooks
- `POST /payments` — Initialize a payment intent
- `GET /payments/:id` — Inspect payment intent status
- `POST /payments/:id/cancel` — Cancel payment intent
- `POST /payments/:id/refund` — *Admin*: Process refund
- `GET /transactions` — View financial transaction log
- `POST /webhooks/:provider` — Ingest signed inbound provider webhooks (`paystack`, `stripe`, `flutterwave`)

### Notifications
- `POST /notifications` — Send a transactional or optional notification
- `GET /notifications/:id` — Inspect delivery state & attempts
- `POST /notifications/:id/replay` — Replay failed dead-lettered message
- `GET /notifications/templates/:key` — View template
- `POST /notifications/templates` — *Admin*: Create template
- `GET /notifications/preferences/:userId` — Fetch user communication preferences
- `PUT /notifications/preferences/:userId` — Update user channel/category opt-out

---

## Step-by-Step Demo Script

Here is an end-to-end walkthrough demonstrating the core flows:

```bash
# 1. Build project
npm run build

# 2. Run test suite to verify all 72 tests pass
npm test
```

### Scripted Programmatic Demo

You can run the full agent workflow via the programmatic MCP interface:

```typescript
import { bootstrap } from './dist/index.js';

async function demo() {
  const { mcpServer, identityService } = await bootstrap();

  // Create scoped agent token
  const token = identityService.createAgentToken('agent_demo', 'agent', ['read_write']);

  // 1. Agent searches catalog
  const products = await mcpServer.executeTool('search_products', { query: 'Laptop' }, token);
  console.log('Found products:', products.data);

  // 2. Agent creates checkout
  const checkout = await mcpServer.executeTool('create_checkout', {
    items: [{ productId: products.data[0].id, qty: 1 }],
    idempotency_key: 'demo_checkout_key_001',
    currency: 'USD',
  }, token);
  console.log('Checkout created:', checkout.data);

  // 3. Check payment status
  const payment = await mcpServer.executeTool('get_payment_status', {
    order_id: checkout.data.order.id,
  }, token);
  console.log('Payment intent status:', payment.data.status);
}
```

---

## License

ISC

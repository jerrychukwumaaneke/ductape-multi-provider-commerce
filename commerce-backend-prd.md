# PRD: Agent-Operable Commerce Backend on Ductape

**Stack:** TypeScript (Node 18+), Ductape SDK + MCP + CLI, PostgreSQL
**Modules:** Orders, Payments (multi-provider), Notifications, MCP agent interface

Items marked **[VERIFY]** are assumptions about Ductape that were not confirmable from public docs. Milestone 0 resolves them.

---

## 1. Goals and non-goals

**Goals**
1. Checkout that can never oversell inventory, even under concurrent requests.
2. A provider-agnostic payment layer (Paystack first, then Flutterwave and Stripe) behind one interface.
3. A reusable notification service (email + webhook) with templates, preferences, dedupe, rate limits, retries.
4. An MCP server so an AI agent can operate the system safely.
5. Every important action idempotent, audited, and tested.

**Non-goals (v1):** storefront UI, shipping/tax engines, multi-warehouse, subscriptions, marketplace payouts.

---

## 2. Architecture

```
Agent (MCP) ─┐
REST clients ─┴─► API layer (auth, validation, errors)
                     │
        ┌────────────┼──────────────┐
     Orders      Payments      Notifications
        │            │  Provider Router → Paystack | Flutterwave | Stripe | Mock
        └────────────┴──────► PostgreSQL (via ductape.databases)
                 Ductape: sessions, jobs, events, notifications, secrets, api
```

Business logic lives in a **service layer**. REST and MCP are thin front doors over the same services.

---

## 3. Milestone 0: Setup (you do this)

| Step | Done when |
|---|---|
| Create Ductape workspace and product; add `dev` and `prd` environments | Product visible in Workbench |
| Provision PostgreSQL and link to both environments | `ductape resources databases list` shows it |
| Copy Access Key, Publishable Key, Workspace ID (Workbench → Tokens) | Stored in `.env`, not in git |
| `npm i -g @ductape/mcp @ductape/cli`, then `ductape login`, then `ductape init --link` | `ductape whoami` works |
| Add MCP config to your coding agent | Agent lists Ductape tools |
| Paystack account, test mode; copy test secret and public keys | Keys in `.env` |
| ngrok (or similar) tunnel for webhooks | Public HTTPS URL reaches localhost |
| Flutterwave / Stripe test accounts (later phase; Stripe access from Nigeria may be restricted) | Keys in `.env` |

Ductape resources needed: PostgreSQL database, secrets for each provider key, a notification (email) configuration, and job scheduling.

---

## 4. Milestone 1: Ductape verification spike (agent does this)

The agent must test and report on each item before writing domain code:

1. **[VERIFY] Atomic conditional update.** Can `ductape.databases` run `UPDATE ... WHERE on_hand - reserved >= qty` and report affected rows? Or run multi-statement transactions? If neither: fall back to a per-product serialized queue via `ductape.events`, or a single database function called through Ductape. Document the choice.
2. **[VERIFY] Third-party providers via `ductape.api.run`.** How to register Paystack as an app with actions (`initialize`, `verify`, `refund`). Whether it exists already.
3. **[VERIFY] Inbound webhooks.** How a Ductape backend receives and reads the **raw body** and headers (needed for signature checks). If not native, run a small HTTP server (Express/Fastify) in the app.
4. **[VERIFY] Jobs.** Delayed and recurring jobs (reservation expiry, retries), and built-in retry/backoff behavior.
5. **[VERIFY] Notifications.** Email provider setup, templates, and delivery status callbacks.
6. **[VERIFY] Sessions.** Custom claims (role, org) in tokens; refresh and revoke.
7. **[VERIFY] Caches.** Atomic increment with TTL (for rate limiting and idempotency), or use PostgreSQL instead.

**Deliverable:** `docs/ductape-findings.md` with what works, what doesn't, and the fallback chosen for each.

---

## 5. Domain model (PostgreSQL)

All money is stored as **integer minor units** (kobo, cents) plus a currency code.

| Table | Key fields |
|---|---|
| `customers` | id, email (unique), name, created_at |
| `users` | id, email, password_hash, role (`customer`/`admin`/`agent`), customer_id? |
| `products` | id, sku (unique), name, price_minor, currency, active |
| `inventory` | product_id (PK), on_hand, reserved; CHECK on_hand >= 0, reserved >= 0, reserved <= on_hand |
| `reservations` | id, order_id, product_id, qty, status (`held`/`committed`/`released`/`expired`), expires_at |
| `orders` | id, customer_id, status, total_minor, currency, idempotency_key (unique per customer) |
| `order_items` | id, order_id, product_id, name_snapshot, unit_price_minor, qty |
| `payment_intents` | id, order_id, provider, provider_ref, amount_minor, currency, status, idempotency_key |
| `transactions` | id, payment_intent_id, type (`charge`/`refund`), amount_minor, status, provider_ref, raw_response |
| `webhook_events` | id, provider, provider_event_id, type, payload, processed_at; UNIQUE(provider, provider_event_id) |
| `notification_templates` | id, key, version, channel, category (`transactional`/`optional`), subject, body, required_vars |
| `notification_preferences` | user_id, category, channel, enabled |
| `notifications` | id, template_key, recipient, channel, status, dedupe_key (unique), idempotency_key |
| `delivery_attempts` | id, notification_id, attempt_no, outcome, error, at |
| `webhook_endpoints` | id, owner_id, url, secret, active, consecutive_failures |
| `audit_log` | id, actor_id, actor_type (`user`/`agent`/`system`), action, entity, entity_id, before, after, at (append-only) |
| `idempotency_records` | key, scope, request_hash, response, created_at |

---

## 6. State machines

**Order:** `pending` → `awaiting_payment` → `paid` → `fulfilled` → `shipped` → `delivered`
Cancel allowed from `pending`, `awaiting_payment`, `paid` (paid triggers refund). Not from `shipped`/`delivered`. `payment_failed` and `expired` are terminal.

**Payment intent:** `created` → `processing` → `succeeded` | `failed` | `canceled`. Transitions are validated in one shared helper; illegal transitions throw a typed error.

---

## 7. Checkout flow

1. Authenticate, validate, check `Idempotency-Key` (replay returns the stored response).
2. In one atomic step per item, reserve stock. If **any** item fails, release everything reserved so far and return `INSUFFICIENT_INVENTORY` listing the products. No order is created.
3. Create the order (`awaiting_payment`) with price and name snapshots. Reservations expire in 15 minutes (configurable).
4. Create a payment intent through the provider router. Return the provider checkout URL or client secret.
5. Provider webhook arrives: verify signature, dedupe on (provider, event id), update intent, then order to `paid`, commit reservations (`on_hand -= qty`, `reserved -= qty`), send notification.
6. On failure, cancel, or expiry: release reservations, update the order, notify.
7. Always re-verify with the provider API before marking paid, so the webhook is a trigger and not the sole source of truth.

Late or duplicate webhooks must leave the state correct. A success webhook after expiry triggers an automatic refund and alert.

---

## 8. Payment layer

```ts
interface PaymentProvider {
  name: string;
  createPayment(i: CreatePaymentInput): Promise<ProviderPayment>;
  verifyPayment(ref: string): Promise<ProviderPayment>;
  cancelPayment(ref: string): Promise<void>;
  refund(ref: string, amountMinor?: number): Promise<ProviderRefund>;
  verifyWebhookSignature(rawBody: Buffer, headers: Headers): boolean;
  parseWebhookEvent(payload: unknown): NormalizedEvent;
}
```

- Adapters translate provider statuses and event names into internal ones and convert amounts at the boundary.
- **Router modes:** explicit provider, then rules by currency/country (NGN to Paystack, USD to Stripe), then failover (only when the first payment is confirmed not created, to avoid double charging).
- **Adapter contract tests:** one shared suite every adapter must pass (create, verify, cancel, refund, valid/invalid signature, duplicate event). The Mock provider passes it too and is used in automated tests.
- Provider keys come from Ductape secrets, separate for `dev` and `prd`. Confirm exact signature schemes from each provider's docs during build; do not assume they match.

---

## 9. Notification service

- **API:** send, template CRUD (versioned), preferences get/set, delivery status, attempts list, replay failed.
- **Send request:** `template_key`, `recipient`, `vars`, `idempotency_key`, optional `dedupe_key`.
- **Duplicates:** idempotency key stops caller retries; dedupe key (template + recipient + event id, within a window) stops logical duplicates.
- **Preferences:** optional categories respect opt-out; `transactional` always sends. Suppressed messages get status `suppressed`.
- **Rate limits:** per recipient and per caller.
- **Delivery states:** `queued` → `sending` → `delivered` | `retrying` → `failed` (dead-letter, replayable). Also `suppressed`, `rate_limited`.
- **Retries:** transient failures only (timeouts, 5xx, 429), exponential backoff with jitter, max 5 attempts, every attempt recorded.
- **Outgoing webhooks:** HMAC-signed payloads, short timeout, block private/internal IP ranges (SSRF guard), disable endpoint after repeated failures.
- **Templates:** required variables validated at send time; missing variable is a 422, never a broken message.

---

## 10. API surface (REST)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh` |
| Catalog | `GET /products`, `GET /products/:id`; admin: `POST/PATCH /products`, `PUT /inventory/:productId` |
| Orders | `POST /checkout`, `GET /orders/:id`, `GET /orders`, `POST /orders/:id/cancel`; admin: `PATCH /orders/:id/status` |
| Payments | `POST /payments`, `GET /payments/:id`, `POST /payments/:id/cancel`, `POST /payments/:id/refund`, `GET /transactions` |
| Webhooks in | `POST /webhooks/:provider` |
| Notifications | `POST /notifications`, `GET /notifications/:id`, templates and preferences routes |

**Standard error shape:** `{ error: { code, message, details, hint } }`. Codes are stable strings (`INSUFFICIENT_INVENTORY`, `INVALID_TRANSITION`, `VALIDATION_FAILED`, `FORBIDDEN`, ...).

---

## 11. MCP interface (for agents)

Expose about 10 tools with model-oriented descriptions and strict schemas (enums, ISO dates):

`search_products`, `get_order`, `list_orders`, `create_checkout`, `cancel_order`, `get_payment_status`, `list_transactions`, `refund_payment`, `resend_notification`, `get_delivery_status`

Rules:
- Consistent response envelope and bounded pagination with a `has_more` flag.
- Error messages say what was wrong and what values are allowed.
- Writes are idempotent; repeating `cancel_order` on a canceled order succeeds quietly.
- `refund_payment` and other destructive tools require a `confirm: true` parameter and elevated scope.
- Agents carry a **scoped token** acting on behalf of a user (read-only or read-write). Audit log records `actor_type = agent` and the acting user.
- Free text from orders or customers is returned as data. Nothing in it can trigger privileged actions (prompt-injection defense).

---

## 12. Security

- Password hashing (argon2/bcrypt), short-lived access tokens, refresh and revoke via `ductape.sessions`.
- Role checks on every route; customers see only their own data.
- Webhook signature verification on raw body; reject on failure.
- Secrets only in Ductape secrets or env vars; never logged. Redact PII and card-related fields in logs.
- Input validation with a schema library (e.g., Zod) at every boundary.

---

## 13. Tests

Use the Mock provider for automation; run a small suite against real Paystack sandbox separately.

| Area | Cases |
|---|---|
| Checkout | happy path, totals, stock reserved |
| Inventory | insufficient stock rejected with no partial reservation; **two concurrent checkouts for the last unit, exactly one succeeds**; reservation expiry releases stock |
| Payments | success, failure, decline, cancel, refund, duplicate create (idempotency) |
| Webhooks | valid, invalid signature, duplicate event, out-of-order, late success after expiry |
| Orders | cancel releases stock, cannot cancel shipped, cancel twice is safe, illegal transition |
| Notifications | delivered, permanent failure, transient failure then success, retries exhausted, duplicate request, preference suppression, rate limit, missing template var |
| Auth | unauthenticated, wrong user, wrong role, expired token |
| Validation | missing fields, negative/zero qty, unknown product |
| Adapters | shared contract suite for every provider |
| Agent E2E | scripted client: search, checkout, check payment, cancel, resend notification, using only MCP tools |

---

## 14. Build order

| # | Milestone | Acceptance |
|---|---|---|
| 0 | Setup (section 3) | Checklist complete |
| 1 | Ductape verification spike | Findings doc written |
| 2 | Foundations: schema, auth, validation, errors, idempotency, audit, state-machine helper, test harness | Migrations run; foundation tests pass |
| 3 | Notification service with email + webhook | Notification tests pass |
| 4 | Orders + inventory | Concurrency test passes |
| 5 | Payments: interface, Mock, Paystack, webhooks | Contract suite + webhook tests pass; sandbox demo works |
| 6 | Checkout saga tying 3 to 5 together | Full failure-path tests pass |
| 7 | MCP server + agent E2E | E2E scenario passes |
| 8 | Flutterwave, Stripe adapters; routing rules; failover | Same contract suite passes |
| 9 | README, architecture and decision notes, demo script | A new developer can run everything from the README |

---

## 15. Prompt for your coding agent

> You are building this backend using Ductape. Before writing code, inspect Ductape's documentation and your available MCP tools. Use the Ductape SDK in this codebase for backend resources, integrations, jobs, notifications, sessions and configuration. Build in TypeScript. Follow `commerce-backend-prd.md` milestone by milestone.
>
> Start with Milestone 1 (the verification spike) and write `docs/ductape-findings.md` before any domain code. If an assumption marked [VERIFY] is false, choose the fallback, document it, and continue. Do not just explain what I should do. Make the changes in the codebase, configure Ductape, run the application and tests, and fix errors until everything passes.
>
> Rules: money in integer minor units; every write idempotent; all provider access behind the `PaymentProvider` interface; automated tests use the Mock provider; never commit secrets; report progress at the end of each milestone with test results.

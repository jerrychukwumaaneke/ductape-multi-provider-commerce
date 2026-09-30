# Evidence-Based Ductape Platform & SDK Verification Findings

**Date:** 2026-09-29  
**SDK Inspected:** `@ductape/sdk@0.3.7`  
**Execution Environment:** Node.js 18+ / TypeScript / Windows  
**Verification Method:** Exact TypeScript `.d.ts` definitions, compiler diagnostics (`tsc --noEmit`), and live terminal executions.

---

## 1. Executive Summary & Verification Spike Context

This document replaces all previous speculative claims with concrete evidence extracted directly from:
- `@ductape/sdk/dist/index.d.ts`
- `@ductape/sdk/dist/database/databases.service.d.ts`
- `@ductape/sdk/dist/database/types/*.d.ts`
- `@ductape/sdk/dist/sessions/types/index.d.ts`
- `@ductape/sdk/dist/types/processor.types.d.ts`
- Terminal compiler outputs (`npx tsc --noEmit`)
- Live execution outputs (`npx tsx scripts/test-ductape-db.ts` and `npx tsx scripts/test-paystack.ts`)

---

## 2. Database Integration (`ductape.databases`)

### 2.1 Actual Type Signatures from `@ductape/sdk`

From `node_modules/@ductape/sdk/dist/index.d.ts` (lines 1853–1921):

```typescript
// Connection & Context
connect: (config: IConnectionConfig) => Promise<DatabaseConnection>;
closeAll: () => Promise<void>;
getCurrentContext: () => Promise<IConnectionContext>;
getAdapter: (options?: { env?: string; product?: string; database?: string }) => Promise<BaseAdapter>;
getService: () => Promise<DatabaseService>;

// ORM CRUD
query: <T = any>(options: IQueryOptions) => Promise<IQueryResult<T>>;
insert: <T = any>(options: IInsertOptions) => Promise<IInsertResult<T>>;
update: <T = any>(options: IUpdateOptions) => Promise<IUpdateResult<T>>;
delete: (options: IDeleteOptions) => Promise<IDeleteResult>;
upsert: <T = any>(options: IUpsertOptions) => Promise<IUpsertResult<T>>;
beginTransaction: (options: ITransactionOptions) => Promise<ITransaction>;
```

### 2.2 `ITransaction` Definition

From `node_modules/@ductape/sdk/dist/database/types/transaction.interface.d.ts` (lines 27–42):

```typescript
export interface ITransaction {
    /** Unique transaction ID */
    id: string;
    /** Transaction status */
    status: TransactionStatus;
    /** Commit the transaction */
    commit(): Promise<void>;
    /** Rollback the transaction */
    rollback(): Promise<void>;
    /** Check if transaction is still active */
    isActive(): boolean;
    /** Create a savepoint */
    savepoint(name: string): Promise<ISavepoint>;
    /** Native client/session (database-specific) */
    client?: any;
}
```

Notice:
- `commit()` and `rollback()` are instance methods on the returned `ITransaction` object.
- They are **not** methods on `ductape.databases` or on a synchronous adapter.

### 2.3 Evidence: Inability to Express Atomic Conditional Update in Typed `where`

From `node_modules/@ductape/sdk/dist/database/types/write.interface.d.ts` (lines 69–75):

```typescript
export interface IUpdateOptions {
    table: string;
    data: Record<string, any | IUpdateOperator>;
    where: IWhereClause;
    returning?: boolean;
    returningColumns?: string[];
    env?: string;
    product?: string;
    database?: string;
    transaction?: ITransaction;
    // ...
}
```

From `node_modules/@ductape/sdk/dist/database/types/query.interface.d.ts` (lines 41–85):

```typescript
export interface IWhereClause {
    [key: string]: any | IComparisonOperator | ILogicalOperator;
}

export interface IComparisonOperator {
    $eq?: any;
    $ne?: any;
    $gt?: any;
    $gte?: any;
    $lt?: any;
    $lte?: any;
    $in?: any[];
    $nin?: any[];
    $like?: string;
    $ilike?: string;
    $between?: [any, any];
    $isNull?: boolean;
    $isNotNull?: boolean;
    $contains?: any;
    $containedBy?: any;
    $overlaps?: any[];
    $regex?: string | RegExp;
    $exists?: boolean;
}
```

**Technical Analysis & Limitations:**
1. **Key Identifier Escaping:** Every property key in `IWhereClause` is treated as a column name identifier and escaped by the query builder. Supplying `"on_hand - reserved": { $gte: qty }` generates SQL targeting a non-existent column named `"\"on_hand - reserved\""`.
2. **No Expression or Computed-Column Operator:** The `$gte`, `$gt`, etc. comparison operators only take literal values (`any`). There is no `$expr` operator (as in MongoDB) or cross-column arithmetic comparison.
3. **No Row-Locking in `IQueryOptions`:** `IQueryOptions` contains no `forUpdate` or locking parameter. Doing a read-then-update inside `beginTransaction()` without row locking (`FOR UPDATE`) cannot prevent race conditions under concurrent execution, leading to overselling.

### 2.4 Live Execution Error (Attempting Ductape Database Connection)

Running `scripts/test-ductape-db.ts` with `USE_DUCTAPE_DB=true`:

```text
[Ductape DB Test] Initializing Ductape with workspace: "", env: "dev", product: "commerce-backend"
Error: No accessKey provided
    at Ductape.fetchSession (C:\Users\jerry.intern\Desktop\ductape-project\node_modules\@ductape\sdk\src\index.ts:8004:54)
    at Ductape.performUserAuth (C:\Users\jerry.intern\Desktop\ductape-project\node_modules\@ductape\sdk\src\index.ts:7136:18)
    at new Ductape (C:\Users\jerry.intern\Desktop\ductape-project\node_modules\@ductape\sdk\src\index.ts:1098:32)
No Existing session, should try to create a new one
[Ductape DB Test] Attempting to connect to Ductape database...
[Ductape DB Test] Error encountered:
Error: "accessKey" is not allowed to be empty
    at Ductape.refreshUserAccessToken (C:\Users\jerry.intern\Desktop\ductape-project\node_modules\@ductape\sdk\src\index.ts:8078:13)
```

*(When providing a test key without valid platform provisioning, the SDK contacts Ductape auth servers and exits with `Error: user not authorized`.)*

### 2.5 Architecture Decision & Honest Fallback

1. **Direct PostgreSQL Connection (`PostgresDatabaseClient` via `pg.Pool`):**
   - The primary, guaranteed mechanism for atomic inventory reservations in standalone and test environments.
   - Executes the single atomic statement:
     ```sql
     UPDATE inventory 
     SET reserved = reserved + $1 
     WHERE product_id = $2 
       AND (on_hand - reserved) >= $1 
     RETURNING on_hand, reserved;
     ```
   - Checks `rowCount === 1`. If `0`, fails immediately without partial reservation.
2. **Ductape Database Client (`DuctapeDatabaseClient`):**
   - Implemented against the real `DatabaseService.raw(...)` and `BaseAdapter.beginTransaction()` APIs.
   - Used when authenticated against Ductape platform with linked database resources.

---

## 3. Sessions & Authentication (`ductape.sessions`)

### 3.1 Actual Type Signatures from `@ductape/sdk`

From `node_modules/@ductape/sdk/dist/index.d.ts` (lines 562–620):

```typescript
// Product schema definition (NOT user session start):
create: (product: string, data: IProductSession) => Promise<void>;

// Real runtime session management:
start: (data: {
    product: string;
    env: string;
    tag: string;
    data: Record<string, unknown>;
}) => Promise<ISessionResult>;

verify: (data: {
    product: string;
    env: string;
    tag: string;
    token: string;
}) => Promise<IVerifyResult>;

refresh: (data: {
    product: string;
    env: string;
    tag: string;
    refreshToken: string;
}) => Promise<ISessionResult>;

revoke: (data: {
    product: string;
    env: string;
    tag: string;
    sessionId?: string;
    identifier?: string;
}) => Promise<void>;
```

From `node_modules/@ductape/sdk/dist/sessions/types/index.d.ts` (lines 80–94):

```typescript
export interface ISessionResult {
    token: string;
    refreshToken: string;
    expiresAt?: Date;
    sessionId?: string;
}

export interface IVerifyResult {
    valid: boolean;
    data?: Record<string, unknown>;
    sessionId?: string;
    expiresAt?: Date;
}
```

### 3.2 Inaccuracies Corrected from Previous Claims

1. **`create` vs `start`:** `ductape.sessions.create` is an internal product builder method for configuring session schemas on the platform (`(product: string, data: IProductSession) => Promise<void>`). The real runtime method to generate a user session token is `ductape.sessions.start(...)`.
2. **Scoping Requirements:** `verify`, `refresh`, and `revoke` all require `{ product: string, env: string, tag: string }`. Calling `verify({ token })` is a TypeScript compiler error.
3. **`IVerifyResult` Structure:** The returned object contains `valid`, `data`, `sessionId`, and `expiresAt`. There is **no** top-level `user_id` property. Custom user identifiers reside inside `data.sub` or `data.userId`.
4. **`revoke` Parameters:** `revoke` takes `{ product, env, tag, sessionId?, identifier? }`, not `{ token: string }`.

### 3.3 Architecture Decision & Fallback

- **Connected Ductape Mode:** `DuctapeSessionService` uses the real `start`, `verify`, and `revoke` signatures with explicit `product`, `env`, and `defaultTag`.
- **Standalone / Offline Fallback:** Local cryptographic JWTs via `jsonwebtoken` and `bcryptjs` password hashing, strictly matching the session payload structure (`sub`, `email`, `role`, `customerId`, `actorType`, `scope`).

---

## 4. Payment Integrations & Third-Party Actions (`ductape.api`)

### 4.1 Actual Type Signatures from `@ductape/sdk`

From `node_modules/@ductape/sdk/dist/types/processor.types.d.ts` (lines 360–381):

```typescript
export interface IActionProcessorInput {
    env: string;
    product?: string;
    product_id?: string;
    app: string;
    cache?: string;
    /**
     * Input can be either:
     * - Structured: { body: {...}, params: {...}, query: {...}, headers: {...} }
     * - Flat: { key: value, 'prefix:key': value }
     */
    input: IActionInputType;
    action: string;
    retries?: number;
    session?: string;
    preloadedBootstrap?: unknown;
}
```

### 4.2 Inaccuracies Corrected from Previous Claims

1. **Request Body Field:** The parameter is `input`, **not** `payload`.
2. **Mandatory Scope:** `env: string` and `product: string` are required parameters.
3. **Action Execution:** Calling `ductape.api.run` proxies requests through Ductape's processor API. External apps (like `paystack`) must be pre-configured in Ductape Workbench.

### 4.3 Live Execution Errors (Attempting Live Payment Calls)

Running `scripts/test-paystack.ts` against Paystack sandbox:

```text
[Paystack Test] Using PAYSTACK_SECRET_KEY: sk_test...
[Paystack Test] Using DUCTAPE_ACCESS_KEY: (none)

--- 1. Testing DuctapeApiPaymentProvider ---
No Existing session, should try to create a new one
DuctapeApiPaymentProvider Error:
"accessKey" is not allowed to be empty
Error: "accessKey" is not allowed to be empty
    at Ductape.refreshUserAccessToken (C:\Users\jerry.intern\Desktop\ductape-project\node_modules\@ductape\sdk\src\index.ts:8078:13)
    at async Ductape.performUserAuth (C:\Users\jerry.intern\Desktop\ductape-project\node_modules\@ductape\sdk\src\index.ts:7138:9)

--- 2. Testing Direct PaystackPaymentProvider (HTTPS Adapter) ---
Direct PaystackPaymentProvider Error:
Paystack initialization failed: Invalid key
Error: Paystack initialization failed: Invalid key
    at PaystackPaymentProvider.createPayment (C:\Users\jerry.intern\Desktop\ductape-project\src\modules\payments\providers\paystack.provider.ts:38:13)
    at async main (C:\Users\jerry.intern\Desktop\ductape-project\scripts\test-paystack.ts:41:20)
```

**Findings:**
- `DuctapeApiPaymentProvider` cannot run in offline/local environments without active Ductape platform credentials and an authenticated session.
- `PaystackPaymentProvider` (direct HTTPS client) successfully contacts `https://api.paystack.co/transaction/initialize` and receives a real HTTP 401 `Invalid key` error response from Paystack sandbox when using an unprovisioned test key.

### 4.4 Architecture Decision & Fallback

All payment interactions are abstracted behind the `PaymentProvider` interface:
1. **Direct HTTPS Providers (`PaystackPaymentProvider`, `FlutterwavePaymentProvider`, `StripePaymentProvider`):** Contact provider endpoints directly over HTTPS with standard API key headers and HMAC signature verification.
2. **Ductape API Provider (`DuctapeApiPaymentProvider`):** Uses `ductape.api.run` with the real `{ product, env, app, action, input }` signature when running in a connected Ductape Workbench.
3. **Mock Provider (`MockPaymentProvider`):** Deterministic provider for unit and automated integration test suites.

---

## 5. Inbound Webhooks

### 5.1 Verification
- Inspecting `@ductape/sdk` confirms there is no embedded HTTP server for listening to incoming webhooks on localhost.
- Webhook signature validation (e.g. Paystack HMAC-SHA512 via `x-paystack-signature`, Stripe HMAC-SHA256 via `stripe-signature`) requires the raw byte-for-byte request body buffer (`rawBody`). Parsing JSON beforehand breaks hash validation.

### 5.2 Implementation
- A lightweight Express server captures the unparsed body via:
  ```typescript
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    }
  });
  ```
- All webhooks route to `POST /webhooks/:provider` and pass `req.rawBody` directly to `provider.verifyWebhookSignature(rawBody, headers)`.

---

## 6. Jobs & Deferred Schedulers (`ductape.jobs`)

### 6.1 Verification
- From `node_modules/@ductape/sdk/dist/jobs/index.d.ts`, the jobs engine is backed by BullMQ and Redis, requiring `ductape.monitor()` and a connected Redis instance (`REDIS_URL`).

### 6.2 Fallback
- For zero-dependency environments where Redis is not provisioned, a PostgreSQL-backed polling mechanism periodically releases expired held stock reservations:
  ```sql
  SELECT * FROM reservations WHERE status = 'held' AND expires_at < NOW();
  ```

---

## 7. Notifications (`ductape.notifications`)

### 7.1 Verification
- `ductape.notifications` supports raw multi-channel message dispatch (`email`, `sms`, `push`, `callback`).
- Domain-level commerce concerns (user opt-in preferences, transactional bypass, variable templating, message deduplication, and dead-letter audit logs) are application-level responsibilities.

### 7.2 Implementation
- The application implements a dedicated PostgreSQL-backed Notification Engine with tables:
  - `notification_templates`: Key, channel, transactional status, subject, template body.
  - `notification_preferences`: Per-customer opt-outs (transactional emails bypass suppression).
  - `notifications`: Queued message records with unique deduplication keys.
  - `delivery_attempts`: Audit log recording delivery latency, status, and error details.

---

## 8. Verified Status & Fallback Matrix

| Primitive | Verified SDK Shape / Capability | Concrete Fallback Implemented |
|---|---|---|
| **Inventory Atomicity** | `IUpdateOptions.where` cannot express computed column comparisons (`on_hand - reserved >= qty`); `IQueryOptions` lacks `FOR UPDATE`. | Direct SQL conditional update via `PostgresDatabaseClient` (`pg.Pool`), checking `rowCount === 1`. |
| **Ductape DB Client** | Facade lacks `.raw()`; `DatabaseService.raw(...)` and `BaseAdapter.beginTransaction()` require explicit connection context. | `DuctapeDatabaseClient` written against real `DatabaseService.raw` and `BaseAdapter` types without `as any`. |
| **Sessions** | Runtime user session method is `ductape.sessions.start(...)` (not `create`); requires `product`, `env`, and `tag`. | `DuctapeSessionService` typed to real signatures; standalone local cryptographic JWT fallback. |
| **External API** | `ductape.api.run` requires `{ product, env, app, action, input }` (not `payload`); requires remote processor. | Direct HTTPS adapter (`PaystackPaymentProvider`) contacting Paystack sandbox; `MockPaymentProvider` for tests. |
| **Webhooks** | No native local HTTP listener in SDK; HMAC verification requires raw payload buffer. | Express server with `verify` hook extracting `req.rawBody` for byte-accurate HMAC validation. |
| **Jobs** | BullMQ/Redis backed; requires active Redis broker. | Standalone DB reservation poller for expiration release. |
| **Idempotency** | Financial state requires strict consistency across mutations. | PostgreSQL `idempotency_records` table with unique constraint on `(key, scope)`. |

---

## 9. Live Network Verification Spike Results (Real Credentials, No Mocks)

Executed via `npm run test:live` against live external endpoints:

### 9.1 Paystack Sandbox (Live HTTPS)
- **Key Prefix:** `sk_test_` (len: 48)
- **Endpoint:** `POST https://api.paystack.co/transaction/initialize`
- **Result:** Succeeded in 766ms. Received valid checkout authorization URL:
  `https://checkout.paystack.com/...` with `access_code`.

### 9.2 Flutterwave Sandbox (Live HTTPS)
- **Key Prefix:** `FLWSECK_TEST-` (len: 47)
- **Endpoint:** `POST https://api.flutterwave.com/v3/payments`
- **Result:** Succeeded in 647ms. Received valid hosted payment link:
  `https://checkout-v2.dev-flutterwave.com/v3/hosted/pay/...`.

### 9.3 Ductape Cloud Workspace & Database (`@ductape/sdk`)
- **Workspace ID:** `6abac3bdb1b2cea1a28d2e1e` (len: 24)
- **Access Key:** `748c79...` (len: 225)
- **Authentication & Metadata Flow:**
  1. `Ductape.initUserAuth()` exchanges the access key for a platform JWT and fetches workspace metadata.
  2. Products in Ductape possess two default environments: `snd` (sandbox) and `prd` (production).
  3. Product tag in workspace: `xavier_space:commerce_backend`.
  4. Database configuration is registered via `ductape.databases.create({ product, name, tag, type, envs })`, which securely encrypts the database connection string into workspace secrets as `$Secret{DB_COMMERCE_BACKEND_COMMERCE_DB_SND_URL}`.
  5. `ductape.databases.connect({ env: 'snd', product: 'xavier_space:commerce_backend', database: 'commerce_db' })` bootstraps the database configuration, decrypts the secret using the workspace private key, and opens a connection pool.
  6. Real insert (`ductape.databases.insert`) and query (`ductape.databases.query`) round-trip succeeded in 2413ms:
     ```json
     Insert result: {"data":[],"count":1,"insertedIds":["cus_live_1790694437496"]}
     Query result: {"data":[{"id":"cus_live_1790694437496","email":"cus_live_1790694437496@example.com","name":"Live Ductape Customer","created_at":"2026-09-29T14:07:17.502Z"}],"count":1,"fields":["id","email","name","created_at"]}
     ```

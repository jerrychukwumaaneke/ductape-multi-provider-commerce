import 'dotenv/config';
import { getDuctapeClient } from '../src/common/ductape/index.js';
import { DuctapeDatabaseClient } from '../src/common/database/ductape.database.js';
import { PostgresDatabaseClient, IDatabaseClient } from '../src/common/database/index.js';

async function main() {
  const orderId = process.argv[2];
  if (!orderId) {
    console.error('Usage: npx tsx scripts/inspect-order.ts <orderId>');
    process.exit(1);
  }

  let db: IDatabaseClient;
  const isDuctape = process.env.USE_DUCTAPE_DB === 'true' || Boolean(process.env.DUCTAPE_ACCESS_KEY);
  if (isDuctape) {
    const ductape = getDuctapeClient();
    const ductapeEnv = process.env.DUCTAPE_ENV || 'snd';
    const ductapeProduct = process.env.DUCTAPE_PRODUCT || 'xavier_space:commerce_backend';
    await ductape.databases.connect({
      env: ductapeEnv,
      product: ductapeProduct,
      database: 'commerce_db',
    });
    db = new DuctapeDatabaseClient(ductape);
  } else {
    const connStr = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/commerce_db';
    db = new PostgresDatabaseClient(connStr);
  }

  console.log(`\n======================================================`);
  console.log(`         INSPECTING ORDER: ${orderId}`);
  console.log(`======================================================\n`);

  // 1. Orders
  const orderRes = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  console.log(`--- [1/8] ORDERS (${orderRes.rowCount} row) ---`);
  console.log(JSON.stringify(orderRes.rows, null, 2));

  // 2. Order Items
  const itemsRes = await db.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
  console.log(`\n--- [2/8] ORDER_ITEMS (${itemsRes.rowCount} rows) ---`);
  console.log(JSON.stringify(itemsRes.rows, null, 2));

  // 3. Reservations
  const resRes = await db.query('SELECT * FROM reservations WHERE order_id = $1', [orderId]);
  console.log(`\n--- [3/8] RESERVATIONS (${resRes.rowCount} rows) ---`);
  console.log(JSON.stringify(resRes.rows, null, 2));

  // 4. Inventory
  const invRes = await db.query(
    `SELECT i.*, p.sku, p.name 
     FROM inventory i 
     JOIN products p ON i.product_id = p.id 
     WHERE i.product_id IN (SELECT product_id FROM order_items WHERE order_id = $1)`,
    [orderId]
  );
  console.log(`\n--- [4/8] INVENTORY (${invRes.rowCount} rows) ---`);
  console.log(JSON.stringify(invRes.rows, null, 2));

  // 5. Payment Intents
  const piRes = await db.query('SELECT * FROM payment_intents WHERE order_id = $1', [orderId]);
  console.log(`\n--- [5/8] PAYMENT_INTENTS (${piRes.rowCount} rows) ---`);
  console.log(JSON.stringify(piRes.rows, null, 2));

  // 6. Transactions
  const txnRes = await db.query(
    `SELECT * FROM transactions 
     WHERE payment_intent_id IN (SELECT id FROM payment_intents WHERE order_id = $1)`,
    [orderId]
  );
  console.log(`\n--- [6/8] TRANSACTIONS (${txnRes.rowCount} rows) ---`);
  console.log(JSON.stringify(txnRes.rows, null, 2));

  // 7. Webhook Events
  const piRefs = piRes.rows.map((r: any) => r.provider_ref).filter(Boolean);
  let whRes;
  if (piRefs.length > 0) {
    whRes = await db.query(
      `SELECT * FROM webhook_events 
       WHERE provider_event_id = ANY($1::varchar[]) 
          OR payload::text LIKE '%' || $2 || '%'`,
      [piRefs, orderId]
    );
  } else {
    whRes = await db.query(
      `SELECT * FROM webhook_events WHERE payload::text LIKE '%' || $1 || '%'`,
      [orderId]
    );
  }
  console.log(`\n--- [7/8] WEBHOOK_EVENTS (${whRes.rowCount} rows) ---`);
  console.log(JSON.stringify(whRes.rows, null, 2));

  // 8. Outbox
  const outboxRes = await db.query(
    `SELECT * FROM outbox WHERE payload->>'orderId' = $1 OR payload::text LIKE '%' || $1 || '%'`,
    [orderId]
  );
  console.log(`\n--- [8/8] OUTBOX (${outboxRes.rowCount} rows) ---`);
  console.log(JSON.stringify(outboxRes.rows, null, 2));

  console.log(`\n================ Inspection Complete =================\n`);
  await db.close();
}

main().catch((err) => {
  console.error('[inspect-order] Fatal error:', err);
  process.exit(1);
});

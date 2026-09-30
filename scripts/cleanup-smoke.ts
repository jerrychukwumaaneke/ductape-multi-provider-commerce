import 'dotenv/config';
import { getDuctapeClient } from '../src/common/ductape/index.js';
import { DuctapeDatabaseClient } from '../src/common/database/ductape.database.js';

async function main() {
  const ductape = getDuctapeClient();
  const ductapeEnv = process.env.DUCTAPE_ENV || 'snd';
  const ductapeProduct = process.env.DUCTAPE_PRODUCT || 'xavier_space:commerce_backend';

  await ductape.databases.connect({
    env: ductapeEnv,
    product: ductapeProduct,
    database: 'commerce_db',
  });

  const db = new DuctapeDatabaseClient(ductape);

  console.log('Cleaning up smoke test artifacts on real database...');

  // 1. Order and relations
  const orderId = 'ord_23e37975704e4b0b85ad134f4a44ad6b';
  const r1 = await db.query('DELETE FROM delivery_attempts WHERE notification_id IN (SELECT id FROM notifications WHERE idempotency_key LIKE $1)', ['%smoke%']).catch(() => ({ rowCount: 0 }));
  const r2 = await db.query('DELETE FROM notifications WHERE idempotency_key LIKE $1', ['%smoke%']).catch(() => ({ rowCount: 0 }));
  const r3 = await db.query("DELETE FROM outbox WHERE payload->>'orderId' = $1 OR payload::text LIKE '%smoke%'", [orderId]).catch(() => ({ rowCount: 0 }));
  const r4 = await db.query('DELETE FROM transactions WHERE payment_intent_id IN (SELECT id FROM payment_intents WHERE order_id = $1)', [orderId]).catch(() => ({ rowCount: 0 }));
  const r5 = await db.query('DELETE FROM payment_intents WHERE order_id = $1', [orderId]).catch(() => ({ rowCount: 0 }));
  const r6 = await db.query('DELETE FROM reservations WHERE order_id = $1', [orderId]).catch(() => ({ rowCount: 0 }));
  const r7 = await db.query('DELETE FROM order_items WHERE order_id = $1', [orderId]).catch(() => ({ rowCount: 0 }));
  const r8 = await db.query('DELETE FROM orders WHERE id = $1', [orderId]).catch(() => ({ rowCount: 0 }));

  // 2. Product
  const r9 = await db.query('DELETE FROM inventory WHERE product_id IN (SELECT id FROM products WHERE sku = $1)', ['SKU_SMOKE_1']).catch(() => ({ rowCount: 0 }));
  const r10 = await db.query('DELETE FROM products WHERE sku = $1', ['SKU_SMOKE_1']).catch(() => ({ rowCount: 0 }));

  // 3. User & Customer
  const r11 = await db.query('DELETE FROM users WHERE email = $1', ['smoke_user_live@example.com']).catch(() => ({ rowCount: 0 }));
  const r12 = await db.query('DELETE FROM customers WHERE email = $1', ['smoke_user_live@example.com']).catch(() => ({ rowCount: 0 }));

  console.log('\n--- Smoke Cleanup Row Counts ---');
  console.log(`delivery_attempts: ${r1.rowCount}`);
  console.log(`notifications:     ${r2.rowCount}`);
  console.log(`outbox:            ${r3.rowCount}`);
  console.log(`transactions:      ${r4.rowCount}`);
  console.log(`payment_intents:   ${r5.rowCount}`);
  console.log(`reservations:      ${r6.rowCount}`);
  console.log(`order_items:       ${r7.rowCount}`);
  console.log(`orders:            ${r8.rowCount}`);
  console.log(`inventory:         ${r9.rowCount}`);
  console.log(`products:          ${r10.rowCount}`);
  console.log(`users:             ${r11.rowCount}`);
  console.log(`customers:         ${r12.rowCount}`);
  console.log('Smoke test data cleanup complete!\n');
}

main().catch(console.error);

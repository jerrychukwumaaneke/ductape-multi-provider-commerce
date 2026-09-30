import 'dotenv/config';
import { getDuctapeClient } from '../src/common/ductape/index.js';
import { DuctapeDatabaseClient } from '../src/common/database/ductape.database.js';
import { PostgresDatabaseClient, IDatabaseClient } from '../src/common/database/index.js';
import { OutboxService, OutboxRecord } from '../src/modules/outbox/outbox.service.js';

async function main() {
  const eventTypeFilter = process.argv[2];

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
  console.log(`         REPLAY FAILED OUTBOX EVENTS`);
  if (eventTypeFilter) {
    console.log(`         Filter: event_type = ${eventTypeFilter}`);
  }
  console.log(`======================================================\n`);

  // Query failed rows
  let failedQuery = "SELECT id, event_type, retry_count, last_error, created_at FROM outbox WHERE status = 'failed'";
  const queryParams: unknown[] = [];
  if (eventTypeFilter) {
    failedQuery += " AND event_type = $1";
    queryParams.push(eventTypeFilter);
  }
  failedQuery += " ORDER BY created_at ASC";

  const failedRows = await db.query<OutboxRecord>(failedQuery, queryParams);
  console.log(`Found ${failedRows.rowCount} failed outbox event(s).\n`);

  if (failedRows.rowCount === 0) {
    console.log('No failed rows to replay.');
    await db.close();
    return;
  }

  for (const row of failedRows.rows) {
    console.log(`- [${row.id}] ${row.event_type} (retries: ${row.retry_count}) - Last error: ${row.last_error}`);
  }

  // Re-queue rows back to pending
  const ids = failedRows.rows.map((r) => r.id);
  const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(', ');
  const updateRes = await db.query(
    `UPDATE outbox
     SET status = 'pending', retry_count = 0, scheduled_for = NOW(), claimed_at = NULL, last_error = NULL
     WHERE id IN (${placeholders})`,
    ids
  );

  console.log(`\nRe-queued ${updateRes.rowCount} event(s) to 'pending' with retry_count = 0 and scheduled_for = NOW().`);

  // Process pending events
  const outboxService = new OutboxService(db);
  const runResult = await outboxService.processPending();
  console.log(`Replay processing result: ${runResult.processed} processed, ${runResult.failed} failed.\n`);

  await db.close();
}

main().catch((err) => {
  console.error('[replay-failed-outbox] Fatal error:', err);
  process.exit(1);
});

import { IDatabaseClient } from '../../common/database/index.js';
import { CryptoUtils } from '../../common/utils/crypto.js';

export interface OutboxRecord {
  id: string;
  event_type: string;
  payload: any;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  retry_count: number;
  last_error?: string;
  claimed_at?: Date | null;
  scheduled_for?: Date | null;
  created_at: Date;
  processed_at?: Date | null;
}

export type OutboxHandler = (payload: any, outboxId: string) => Promise<void>;

export class OutboxService {
  private handlers = new Map<string, OutboxHandler>();
  private timer: NodeJS.Timeout | null = null;
  public isProcessing = false;
  public totalProcessed = 0;

  constructor(private readonly db: IDatabaseClient) {}

  public registerHandler(eventType: string, handler: OutboxHandler): void {
    this.handlers.set(eventType, handler);
  }

  public async writeEvent(
    eventType: string,
    payload: unknown,
    txClient?: IDatabaseClient,
    scheduledFor?: Date
  ): Promise<string> {
    const id = CryptoUtils.generateId('obx');
    const client = txClient || this.db;
    await client.query(
      `INSERT INTO outbox (id, event_type, payload, status, retry_count, scheduled_for, created_at)
       VALUES ($1, $2, $3, 'pending', 0, $4, NOW())`,
      [id, eventType, JSON.stringify(payload), scheduledFor ?? null]
    );
    return id;
  }

  /**
   * Re-queues outbox rows stuck in 'processing' beyond stuckThresholdMinutes.
   * Clears claimed_at and sets status back to 'pending'.
   * Strictly touches only rows with claimed_at set and older than the threshold.
   */
  public async requeueStuckProcessing(stuckThresholdMinutes = 5): Promise<number> {
    const cutoff = new Date(Date.now() - stuckThresholdMinutes * 60 * 1000);
    const res = await this.db.query(
      `UPDATE outbox
       SET status = 'pending', claimed_at = NULL
       WHERE status = 'processing'
         AND claimed_at IS NOT NULL
         AND claimed_at < $1`,
      [cutoff]
    );
    return res.rowCount ?? 0;
  }

  public static readonly CLAIM_SQL = `SELECT id, event_type, payload, status, retry_count, claimed_at, scheduled_for, created_at
             FROM outbox
             WHERE status = 'pending'
               AND (scheduled_for IS NULL OR scheduled_for <= NOW())
             ORDER BY created_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED`;

  public async processPending(maxBatch = 20, maxRetries = 3): Promise<{ processed: number; failed: number }> {
    if (this.isProcessing) return { processed: 0, failed: 0 };
    this.isProcessing = true;

    let processed = 0;
    let failed = 0;

    try {
      // Step 1: Claim rows with FOR UPDATE SKIP LOCKED inside an atomic transaction that transitions them to 'processing' and records claimed_at
      let claimedRecords: OutboxRecord[] = [];
      await this.db.transaction(async (tx) => {
        let res;
        try {
          res = await tx.query<OutboxRecord>(OutboxService.CLAIM_SQL, [maxBatch]);
        } catch (err: any) {
          // Strictly restrict no-SKIP-LOCKED fallback to test environments only
          const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
          if (
            isTestEnv &&
            (err.message?.includes('skip locked') ||
              err.message?.includes('AST') ||
              err.message?.includes('syntax'))
          ) {
            res = await tx.query<OutboxRecord>(
              `SELECT id, event_type, payload, status, retry_count, claimed_at, scheduled_for, created_at
               FROM outbox
               WHERE status = 'pending'
                 AND (scheduled_for IS NULL OR scheduled_for <= NOW())
               ORDER BY created_at ASC
               LIMIT $1`,
              [maxBatch]
            );
          } else {
            throw err;
          }
        }

        if (res.rows.length > 0) {
          const ids = res.rows.map((r) => r.id);
          const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(', ');
          await tx.query(
            `UPDATE outbox SET status = 'processing', claimed_at = NOW() WHERE id IN (${placeholders})`,
            ids
          );
          claimedRecords = res.rows;
        }
      });

      // Step 2: Process claimed records through registered handlers
      for (const record of claimedRecords) {
        const payload = typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload;
        const handler = this.handlers.get(record.event_type);

        if (!handler) {
          await this.db.query(
            "UPDATE outbox SET status = 'failed', last_error = $1, processed_at = NOW(), claimed_at = NULL WHERE id = $2",
            [`No handler registered for event type '${record.event_type}'`, record.id]
          );
          failed++;
          continue;
        }

        try {
          // Pass payload and outbox record id as idempotency key
          await handler(payload, record.id);
          await this.db.query(
            "UPDATE outbox SET status = 'completed', processed_at = NOW(), claimed_at = NULL WHERE id = $1",
            [record.id]
          );
          processed++;
          this.totalProcessed++;
        } catch (err: any) {
          const retries = Number(record.retry_count) + 1;
          // Higher retry cap for refunds (10 retries) vs standard events (default 3)
          const isRefund = record.event_type.includes('refund');
          const effectiveMaxRetries = isRefund ? Math.max(maxRetries, 10) : maxRetries;

          if (retries >= effectiveMaxRetries) {
            // Alert and mark permanently failed
            console.error(
              `[OutboxAlert] Permanent failure for outbox row ${record.id} (event: ${record.event_type}, retries: ${retries}/${effectiveMaxRetries}): ${err.message || String(err)}`
            );
            await this.db.query(
              `UPDATE outbox SET status = 'failed', retry_count = $1, last_error = $2, processed_at = NOW(), claimed_at = NULL WHERE id = $3`,
              [retries, err.message || String(err), record.id]
            );
          } else {
            // Exponential backoff: min(2^retries, 900) seconds
            const delaySeconds = Math.min(Math.pow(2, retries), 900);
            const nextScheduled = new Date(Date.now() + delaySeconds * 1000);
            await this.db.query(
              `UPDATE outbox SET status = 'pending', retry_count = $1, last_error = $2, scheduled_for = $3, claimed_at = NULL WHERE id = $4`,
              [retries, err.message || String(err), nextScheduled, record.id]
            );
          }
          failed++;
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return { processed, failed };
  }

  public startWorker(intervalMs = 1000, stuckCheckEveryCycles = 10): void {
    if (this.timer) return;
    let cycles = 0;
    this.timer = setInterval(async () => {
      try {
        cycles++;
        if (cycles % stuckCheckEveryCycles === 0) {
          await this.requeueStuckProcessing(5);
        }
        await this.processPending();
      } catch (err) {
        console.error('[OutboxWorker] Error during outbox poll:', err);
      }
    }, intervalMs);
    this.timer.unref();
  }

  public stopWorker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

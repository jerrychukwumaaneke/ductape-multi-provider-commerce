import { IDatabaseClient } from '../../common/database/index.js';
import { CryptoUtils } from '../../common/utils/crypto.js';
import { IdempotencyConflictError } from '../../common/errors/app-error.js';
import { IdempotencyRecord } from '../../common/types/index.js';

export interface IdempotencyExecutionResult<T> {
  cached: boolean;
  data: T;
}

export class IdempotencyService {
  constructor(private readonly db: IDatabaseClient) {}

  public async runIdempotent<T>(
    key: string,
    scope: string,
    requestPayload: unknown,
    execute: () => Promise<T>
  ): Promise<IdempotencyExecutionResult<T>> {
    const requestHash = CryptoUtils.hashRequest(requestPayload);

    // 1. Check existing record
    const existing = await this.db.query<IdempotencyRecord>(
      'SELECT key, scope, request_hash, response, created_at FROM idempotency_records WHERE key = $1 AND scope = $2',
      [key, scope]
    );

    if (existing.rowCount > 0) {
      const record = existing.rows[0];
      if (record.request_hash !== requestHash) {
        throw new IdempotencyConflictError(key);
      }
      return {
        cached: true,
        data: record.response as T,
      };
    }

    // 2. Execute operation
    const result = await execute();

    // 3. Store response
    await this.db.query(
      `INSERT INTO idempotency_records (key, scope, request_hash, response, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (key, scope) DO UPDATE SET response = EXCLUDED.response`,
      [key, scope, requestHash, JSON.stringify(result)]
    );

    return {
      cached: false,
      data: result,
    };
  }
}

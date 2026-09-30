import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { IDatabaseClient, QueryResult } from '../src/common/database/index.js';

export async function createTestDatabase(): Promise<IDatabaseClient> {
  const db = newDb();

  // Register common pg functions if needed
  db.public.registerFunction({
    name: 'now',
    returns: db.public.getType('timestamp with time zone'),
    implementation: () => new Date(),
  });

  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();

  const migrationPath = path.resolve(__dirname, '../src/db/migrations/001_initial_schema.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  // Execute schema
  await pool.query(sql);

  let currentTx = Promise.resolve();

  const client: IDatabaseClient = {
    query: async <T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>> => {
      const res = await pool.query(text, params);
      return {
        rows: res.rows as T[],
        rowCount: res.rowCount ?? res.rows.length,
      };
    },
    transaction: async <T>(callback: (txClient: IDatabaseClient) => Promise<T>): Promise<T> => {
      let releaseLock: () => void = () => {};
      const nextLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const prevLock = currentTx;
      currentTx = nextLock;
      await prevLock;

      const backup = db.backup();
      try {
        const txClient: IDatabaseClient = {
          query: async <R = unknown>(text: string, params?: unknown[]) => {
            const res = await pool.query(text, params);
            return { rows: res.rows as R[], rowCount: res.rowCount ?? res.rows.length };
          },
          transaction: async () => {
            throw new Error('Nested transaction not supported');
          },
          close: async () => {},
        };
        const result = await callback(txClient);
        return result;
      } catch (err) {
        backup.restore();
        throw err;
      } finally {
        releaseLock();
      }
    },
    close: async () => {
      await pool.end();
    },
  };

  return client;
}

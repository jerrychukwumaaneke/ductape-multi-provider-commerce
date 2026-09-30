import pg from 'pg';

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

export interface IDatabaseClient {
  query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  transaction<T>(callback: (client: IDatabaseClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PostgresDatabaseClient implements IDatabaseClient {
  private pool: pg.Pool;

  constructor(connectionStringOrPool: string | pg.Pool) {
    if (typeof connectionStringOrPool === 'string') {
      this.pool = new pg.Pool({ connectionString: connectionStringOrPool });
    } else {
      this.pool = connectionStringOrPool;
    }
  }

  public async query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    const res = await this.pool.query(text, params);
    return {
      rows: res.rows as T[],
      rowCount: res.rowCount ?? res.rows.length,
    };
  }

  public async transaction<T>(callback: (client: IDatabaseClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const transactionalClient: IDatabaseClient = {
        query: async <R = unknown>(text: string, params?: unknown[]) => {
          const res = await client.query(text, params);
          return { rows: res.rows as R[], rowCount: res.rowCount ?? res.rows.length };
        },
        transaction: async () => {
          throw new Error('Nested transactions not directly supported, use savepoints');
        },
        close: async () => {},
      };
      const result = await callback(transactionalClient);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

export * from './ductape.database.js';

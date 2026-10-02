import Ductape from '@ductape/sdk';
import { IDatabaseClient, QueryResult } from './index.js';

export class DuctapeDatabaseClient implements IDatabaseClient {
  private connectPromise?: Promise<void>;

  constructor(
    private readonly ductape: Ductape,
    private readonly config: { env?: string; product?: string; database?: string } = {}
  ) {}

  public async connect(maxRetries = 3, baseDelayMs = 1000): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const env = this.config.env || process.env.DUCTAPE_ENV || 'snd';
    const product = this.config.product || process.env.DUCTAPE_PRODUCT || 'xavier_space:commerce_backend';
    const database = this.config.database || 'commerce_db';

    const executeConnect = async () => {
      let lastErr: any;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await this.ductape.databases.connect({
            env,
            product,
            database,
          });
          return;
        } catch (err: any) {
          lastErr = err;
          const isConnError =
            err.message?.includes('ECONNREFUSED') ||
            err.message?.includes('connect') ||
            err.message?.includes('timeout') ||
            err.code === 'ECONNREFUSED';
          if (attempt < maxRetries && isConnError) {
            const delay = baseDelayMs * attempt;
            await new Promise((r) => setTimeout(r, delay));
          } else {
            throw err;
          }
        }
      }
      throw lastErr;
    };

    this.connectPromise = executeConnect().catch((err) => {
      this.connectPromise = undefined;
      throw err;
    });

    return this.connectPromise;
  }

  public async query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    await this.connect();
    // DatabaseService provides the raw parameterized query execution interface
    const service = await this.ductape.databases.getService();
    const env = this.config.env || process.env.DUCTAPE_ENV || 'snd';
    const product = this.config.product || process.env.DUCTAPE_PRODUCT || 'xavier_space:commerce_backend';
    const database = this.config.database || 'commerce_db';

    const res = await service.raw<T>({
      table: 'direct_sql',
      query: text,
      params,
      env,
      product,
      database,
    });

    return {
      rows: res.data || [],
      rowCount: res.count ?? res.data?.length ?? 0,
    };
  }

  public async transaction<T>(callback: (client: IDatabaseClient) => Promise<T>): Promise<T> {
    await this.connect();
    const service = await this.ductape.databases.getService();
    const env = this.config.env || process.env.DUCTAPE_ENV || 'snd';
    const product = this.config.product || process.env.DUCTAPE_PRODUCT || 'xavier_space:commerce_backend';
    const database = this.config.database || 'commerce_db';

    const tx = await this.ductape.databases.beginTransaction({
      env,
      product,
      database,
    });

    const txClient: IDatabaseClient = {
      query: async <R = unknown>(text: string, params?: unknown[]) => {
        const res = await service.raw<R>({
          table: 'direct_sql',
          query: text,
          params,
          transaction: tx,
          env,
          product,
          database,
        });
        return {
          rows: res.data || [],
          rowCount: res.count ?? res.data?.length ?? 0,
        };
      },
      transaction: async () => {
        throw new Error('Nested transactions not supported');
      },
      close: async () => {},
    };

    try {
      const result = await callback(txClient);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  public async close(): Promise<void> {
    this.connectPromise = undefined;
    await this.ductape.databases.closeAll();
  }
}

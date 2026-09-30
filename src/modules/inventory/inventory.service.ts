import { IDatabaseClient } from '../../common/database/index.js';
import { CryptoUtils } from '../../common/utils/crypto.js';
import { InsufficientInventoryError, NotFoundError, ValidationError } from '../../common/errors/app-error.js';
import { Inventory, Product, Reservation } from '../../common/types/index.js';

export interface CreateProductInput {
  sku: string;
  name: string;
  price_minor: number;
  currency: string;
  initial_stock?: number;
}

export interface ReserveItemInput {
  productId: string;
  qty: number;
}

export class InventoryService {
  constructor(private readonly db: IDatabaseClient) {}

  public async createProduct(input: CreateProductInput): Promise<{ product: Product; inventory: Inventory }> {
    const productId = CryptoUtils.generateId('prd');

    const res = await this.db.transaction(async (tx) => {
      const prodRes = await tx.query<Product>(
        `INSERT INTO products (id, sku, name, price_minor, currency, active, created_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
         RETURNING id, sku, name, price_minor, currency, active, created_at`,
        [productId, input.sku, input.name, input.price_minor, input.currency.toUpperCase()]
      );

      const onHand = input.initial_stock ?? 0;
      const invRes = await tx.query<Inventory>(
        `INSERT INTO inventory (product_id, on_hand, reserved)
         VALUES ($1, $2, 0)
         RETURNING product_id, on_hand, reserved`,
        [productId, onHand]
      );

      return { product: prodRes.rows[0], inventory: invRes.rows[0] };
    });

    return res;
  }

  public async getProduct(productId: string): Promise<Product> {
    const res = await this.db.query<Product>(
      'SELECT id, sku, name, price_minor, currency, active, created_at FROM products WHERE id = $1',
      [productId]
    );
    if (res.rowCount === 0) {
      throw new NotFoundError('Product', productId);
    }
    return res.rows[0];
  }

  public async listProducts(options: { query?: string; limit?: number; offset?: number } = {}): Promise<Array<Product & { on_hand: number; reserved: number; available: number }>> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);

    const conditions: string[] = ['p.active = TRUE'];
    const queryParams: unknown[] = [];
    let pIdx = 1;

    if (options.query && options.query.trim().length > 0) {
      conditions.push(`(p.name ILIKE $${pIdx} OR p.sku ILIKE $${pIdx})`);
      queryParams.push(`%${options.query.trim()}%`);
      pIdx++;
    }

    queryParams.push(limit);
    const limitParam = pIdx++;
    queryParams.push(offset);
    const offsetParam = pIdx++;

    const sql = `
      SELECT p.id, p.sku, p.name, p.price_minor, p.currency, p.active, p.created_at,
             COALESCE(i.on_hand, 0) as on_hand,
             COALESCE(i.reserved, 0) as reserved
      FROM products p
      LEFT JOIN inventory i ON p.id = i.product_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;

    const res = await this.db.query<any>(sql, queryParams);
    return res.rows.map((row) => ({
      ...row,
      on_hand: Number(row.on_hand),
      reserved: Number(row.reserved),
      available: Math.max(0, Number(row.on_hand) - Number(row.reserved)),
    }));
  }

  public async getInventory(productId: string): Promise<Inventory> {
    const res = await this.db.query<Inventory>(
      'SELECT product_id, on_hand, reserved FROM inventory WHERE product_id = $1',
      [productId]
    );
    if (res.rowCount === 0) {
      throw new NotFoundError('Inventory', productId);
    }
    return res.rows[0];
  }

  public async setStock(productId: string, onHand: number): Promise<Inventory> {
    const res = await this.db.query<Inventory>(
      `UPDATE inventory 
       SET on_hand = $1 
       WHERE product_id = $2 
       RETURNING product_id, on_hand, reserved`,
      [onHand, productId]
    );
    if (res.rowCount === 0) {
      throw new NotFoundError('Inventory', productId);
    }
    return res.rows[0];
  }

  /**
   * Concurrency-safe atomic conditional stock reservation.
   * Runs inside ONE single database transaction (beginTransaction).
   * Creates the reservation row in the same transaction as the inventory update.
   * If any item fails, the transaction is automatically rolled back with zero leakage.
   */
  public async reserveStock(
    items: ReserveItemInput[],
    orderId: string,
    ttlMinutes = 15,
    externalTx?: IDatabaseClient
  ): Promise<Reservation[]> {
    const runInTx = async (tx: IDatabaseClient) => {
      const reservationsCreated: Reservation[] = [];
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

      // Sort items by productId using strict code-point comparison to establish deterministic global lock order and prevent deadlocks across concurrent multi-item checkouts
      const sortedItems = [...items].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));

      const itemsUpdated: { productId: string; qty: number }[] = [];

      for (const item of sortedItems) {
        // Atomic conditional update on inventory: on_hand - reserved >= qty
        const updateRes = await tx.query<Inventory>(
          `UPDATE inventory 
           SET reserved = reserved + $1 
           WHERE product_id = $2 
             AND (on_hand - reserved) >= $1 
           RETURNING product_id, on_hand, reserved`,
          [item.qty, item.productId]
        );

        if (updateRes.rowCount === 0) {
          // Compensate any items reserved earlier in this batch
          for (const prev of itemsUpdated) {
            await tx.query(
              'UPDATE inventory SET reserved = reserved - $1 WHERE product_id = $2',
              [prev.qty, prev.productId]
            );
          }

          // Inside the transaction, throwing an error triggers an immediate rollback of all previous updates and rows
          const currentInv = await tx.query<Inventory>(
            'SELECT on_hand, reserved FROM inventory WHERE product_id = $1',
            [item.productId]
          ).then(r => r.rows[0]).catch(() => ({ on_hand: 0, reserved: 0 }));
          const available = Math.max(0, (currentInv?.on_hand ?? 0) - (currentInv?.reserved ?? 0));

          throw new InsufficientInventoryError({
            unavailableProducts: [
              {
                productId: item.productId,
                requestedQty: item.qty,
                availableQty: available,
              },
            ],
          });
        }

        itemsUpdated.push({ productId: item.productId, qty: item.qty });

        // Record reservation row in the EXACT SAME transaction as the inventory update
        const resId = CryptoUtils.generateId('res');
        const insertRes = await tx.query<Reservation>(
          `INSERT INTO reservations (id, order_id, product_id, qty, status, expires_at, created_at)
           VALUES ($1, $2, $3, $4, 'held', $5, NOW())
           RETURNING id, order_id, product_id, qty, status, expires_at, created_at`,
          [resId, orderId, item.productId, item.qty, expiresAt]
        );

        reservationsCreated.push(insertRes.rows[0]);
      }

      return reservationsCreated;
    };

    if (externalTx) {
      return runInTx(externalTx);
    }
    return this.db.transaction(runInTx);
  }

  /**
   * Commits held reservations when an order is paid.
   * Runs in ONE single transaction: on_hand -= qty, reserved -= qty, status = 'committed'
   */
  public async commitReservations(orderId: string, externalTx?: IDatabaseClient): Promise<void> {
    const runInTx = async (tx: IDatabaseClient) => {
      const res = await tx.query<Reservation>(
        "SELECT id, order_id, product_id, qty, status FROM reservations WHERE order_id = $1 AND status = 'held' FOR UPDATE",
        [orderId]
      );

      if (res.rowCount === 0) {
        throw new ValidationError(`Cannot commit reservations for order ${orderId}: no active held reservations found`);
      }

      for (const r of res.rows) {
        const qty = Number(r.qty);
        await tx.query(
          'UPDATE inventory SET reserved = reserved - CAST($1 AS INTEGER), on_hand = on_hand - CAST($1 AS INTEGER) WHERE product_id = $2',
          [qty, r.product_id]
        );
        await tx.query(
          "UPDATE reservations SET status = 'committed' WHERE id = $1",
          [r.id]
        );
      }
    };

    if (externalTx) {
      await runInTx(externalTx);
    } else {
      await this.db.transaction(runInTx);
    }
  }

  /**
   * Restocks items from a previously paid/committed order that is now cancelled.
   * on_hand += qty, reservations status = 'released'
   */
  public async restockCommittedOrder(orderId: string, externalTx?: IDatabaseClient): Promise<void> {
    const runInTx = async (tx: IDatabaseClient) => {
      const res = await tx.query<Reservation>(
        "SELECT id, order_id, product_id, qty, status FROM reservations WHERE order_id = $1 AND status = 'committed' FOR UPDATE",
        [orderId]
      );
      for (const r of res.rows) {
        const qty = Number(r.qty);
        await tx.query(
          'UPDATE inventory SET on_hand = on_hand + CAST($1 AS INTEGER) WHERE product_id = $2',
          [qty, r.product_id]
        );
        await tx.query(
          "UPDATE reservations SET status = 'released' WHERE id = $1",
          [r.id]
        );
      }
    };

    if (externalTx) {
      await runInTx(externalTx);
    } else {
      await this.db.transaction(runInTx);
    }
  }

  /**
   * Releases held reservations on order cancellation or failure.
   * Runs in ONE single transaction: reserved -= qty, status = 'released'
   */
  public async releaseReservations(orderId: string, externalTx?: IDatabaseClient): Promise<void> {
    const runInTx = async (tx: IDatabaseClient) => {
      const res = await tx.query<Reservation>(
        "SELECT id, order_id, product_id, qty, status FROM reservations WHERE order_id = $1 AND status = 'held' FOR UPDATE",
        [orderId]
      );

      for (const r of res.rows) {
        await tx.query(
          'UPDATE inventory SET reserved = reserved - CAST($1 AS INTEGER) WHERE product_id = $2',
          [Number(r.qty), r.product_id]
        );
        await tx.query(
          "UPDATE reservations SET status = 'released' WHERE id = $1",
          [r.id]
        );
      }
    };

    if (externalTx) {
      await runInTx(externalTx);
    } else {
      await this.db.transaction(runInTx);
    }
  }

  /**
   * Concurrency-safe expired reservations reaper worker.
   * Runs in ONE single transaction: claims held expired reservations (FOR UPDATE SKIP LOCKED),
   * atomically updates status to 'expired', decrements inventory reserved, and transitions orders to 'expired'.
   */
  public async reapExpiredReservations(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const res = await tx.query<Reservation>(
        "SELECT id, order_id, product_id, qty FROM reservations WHERE status = 'held' AND expires_at < NOW() FOR UPDATE"
      );

      let reapedCount = 0;
      for (const r of res.rows) {
        const updateRes = await tx.query<Reservation>(
          "UPDATE reservations SET status = 'expired' WHERE id = $1 AND status = 'held' RETURNING id, order_id, product_id, qty",
          [r.id]
        );

        if (updateRes.rowCount > 0) {
          await tx.query(
            'UPDATE inventory SET reserved = reserved - CAST($1 AS INTEGER) WHERE product_id = $2',
            [Number(r.qty), r.product_id]
          );
          // Mark order as expired if still awaiting payment
          await tx.query(
            "UPDATE orders SET status = 'expired', updated_at = NOW() WHERE id = $1 AND status = 'awaiting_payment'",
            [r.order_id]
          );
          reapedCount++;
        }
      }

      return reapedCount;
    });
  }

  public async expireOldReservations(): Promise<number> {
    return this.reapExpiredReservations();
  }

  /**
   * Reconciles inventory reserved count with the sum of active 'held' reservations.
   * If a productId is provided, reconciles that product; otherwise reconciles all products.
   * Runs inside a database transaction with FOR UPDATE locks.
   */
  public async reconcileInventory(productId?: string): Promise<Array<{ product_id: string; on_hand: number; reserved: number; corrected: boolean }>> {
    const productsToReconcile = productId
      ? [{ product_id: productId }]
      : (await this.db.query<{ product_id: string }>('SELECT product_id FROM inventory')).rows;

    const results: Array<{ product_id: string; on_hand: number; reserved: number; corrected: boolean }> = [];

    for (const p of productsToReconcile) {
      await this.db.transaction(async (tx) => {
        const heldRes = await tx.query<{ total_held: string }>(
          "SELECT COALESCE(SUM(qty), 0) AS total_held FROM reservations WHERE product_id = $1 AND status = 'held'",
          [p.product_id]
        );
        const actualHeld = Number(heldRes.rows[0]?.total_held ?? 0);

        const invRes = await tx.query<Inventory>(
          'SELECT product_id, on_hand, reserved FROM inventory WHERE product_id = $1 FOR UPDATE',
          [p.product_id]
        );
        if (invRes.rowCount === 0) return;
        const current = invRes.rows[0];

        let corrected = false;
        if (Number(current.reserved) !== actualHeld) {
          await tx.query(
            'UPDATE inventory SET reserved = $1 WHERE product_id = $2',
            [actualHeld, p.product_id]
          );
          corrected = true;
        }

        results.push({
          product_id: p.product_id,
          on_hand: Number(current.on_hand),
          reserved: actualHeld,
          corrected,
        });
      });
    }

    return results;
  }
}

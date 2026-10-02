import bcrypt from 'bcryptjs';
import { IDatabaseClient } from '../common/database/index.js';

export async function seedDefaultUsers(db: IDatabaseClient): Promise<void> {
  const customerEmail = 'customer@commerce.io';
  const customerId = 'cus_default_customer';
  const userId = 'usr_default_customer';

  try {
    // 1. Ensure customer record exists
    const custRes = await db.query<{ id: string }>('SELECT id FROM customers WHERE email = $1', [customerEmail]);
    let resolvedCustomerId = customerId;
    if (custRes.rowCount === 0) {
      const insCust = await db.query<{ id: string }>(
        `INSERT INTO customers (id, email, name, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [customerId, customerEmail, 'Default Customer']
      );
      if (insCust.rowCount > 0) {
        resolvedCustomerId = insCust.rows[0].id;
      }
    } else {
      resolvedCustomerId = custRes.rows[0].id;
    }

    // 2. Ensure customer user exists
    const existingUser = await db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [customerEmail]);
    if (existingUser.rowCount === 0) {
      const hash = await bcrypt.hash('Password123!', 10);
      await db.query(
        `INSERT INTO users (id, email, password_hash, role, customer_id, created_at)
         VALUES ($1, $2, $3, 'customer', $4, NOW())
         ON CONFLICT (email) DO NOTHING`,
        [userId, customerEmail, hash, resolvedCustomerId]
      );
      console.log(`[SeedUsers] Seeded default customer: ${customerEmail} / Password123!`);
    }

    // 3. Ensure admin user exists
    const adminEmail = 'admin@commerce.io';
    const adminUserId = 'usr_default_admin';
    const existingAdmin = await db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [adminEmail]);
    if (existingAdmin.rowCount === 0) {
      const adminHash = await bcrypt.hash('AdminPassword123!', 10);
      await db.query(
        `INSERT INTO users (id, email, password_hash, role, customer_id, created_at)
         VALUES ($1, $2, $3, 'admin', NULL, NOW())
         ON CONFLICT (email) DO NOTHING`,
        [adminUserId, adminEmail, adminHash]
      );
      console.log(`[SeedUsers] Seeded default admin: ${adminEmail} / AdminPassword123!`);
    }
  } catch (err: any) {
    console.error('[SeedUsers] Error seeding default users:', err.message);
  }
}

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { IDatabaseClient } from '../common/database/index.js';

export async function seedDefaultUsers(db: IDatabaseClient): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';
  const customerEmail = process.env.DEFAULT_CUSTOMER_EMAIL || 'customer@commerce.io';
  const customerPassword = process.env.DEFAULT_CUSTOMER_PASSWORD || 'Password123!';
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
      const hash = await bcrypt.hash(customerPassword, 10);
      await db.query(
        `INSERT INTO users (id, email, password_hash, role, customer_id, created_at)
         VALUES ($1, $2, $3, 'customer', $4, NOW())
         ON CONFLICT (email) DO NOTHING`,
        [userId, customerEmail, hash, resolvedCustomerId]
      );
      console.log(`[SeedUsers] Seeded default customer user: ${customerEmail}`);
    }

    // 3. Admin user management & security enforcement
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@commerce.io';
    const adminPassword = process.env.ADMIN_PASSWORD;
    const adminUserId = 'usr_default_admin';
    const existingAdmin = await db.query<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [adminEmail]
    );

    if (adminPassword) {
      // Production or configured environment: Synchronize admin credentials from secure environment variable
      const adminHash = await bcrypt.hash(adminPassword, 10);
      if (existingAdmin.rowCount > 0) {
        await db.query('UPDATE users SET password_hash = $1 WHERE email = $2', [adminHash, adminEmail]);
        console.log(`[SeedUsers] Admin password successfully updated from ADMIN_PASSWORD environment variable for: ${adminEmail}`);
      } else {
        await db.query(
          `INSERT INTO users (id, email, password_hash, role, customer_id, created_at)
           VALUES ($1, $2, $3, 'admin', NULL, NOW())
           ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
          [adminUserId, adminEmail, adminHash]
        );
        console.log(`[SeedUsers] Admin user successfully created with ADMIN_PASSWORD environment variable for: ${adminEmail}`);
      }
    } else if (isProduction) {
      // In production, NEVER leave a known or default password active.
      if (existingAdmin.rowCount > 0) {
        const isLeakedDefault = await bcrypt.compare('AdminPassword123!', existingAdmin.rows[0].password_hash);
        if (isLeakedDefault) {
          // Invalidate the leaked default password immediately by scrambling the hash
          const unguessableHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
          await db.query('UPDATE users SET password_hash = $1 WHERE email = $2', [unguessableHash, adminEmail]);
          console.warn(`[SeedUsers] SECURITY ALERT: Known default password detected for ${adminEmail} in production! Leaked password has been revoked and scrambled. Please configure the ADMIN_PASSWORD environment variable in Render.`);
        }
      } else {
        console.warn(`[SeedUsers] NOTICE: In production environment and ADMIN_PASSWORD is not set. Admin user was NOT created with a default password.`);
      }
    } else {
      // Non-production (development / test): Allow convenient default seed for integration testing
      if (existingAdmin.rowCount === 0) {
        const adminHash = await bcrypt.hash('AdminPassword123!', 10);
        await db.query(
          `INSERT INTO users (id, email, password_hash, role, customer_id, created_at)
           VALUES ($1, $2, $3, 'admin', NULL, NOW())
           ON CONFLICT (email) DO NOTHING`,
          [adminUserId, adminEmail, adminHash]
        );
        console.log(`[SeedUsers] Seeded dev admin: ${adminEmail} / AdminPassword123!`);
      }
    }
  } catch (err: any) {
    console.error('[SeedUsers] Error seeding default users:', err.message);
  }
}

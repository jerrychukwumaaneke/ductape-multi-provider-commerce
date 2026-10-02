import { IDatabaseClient } from '../common/database/index.js';

export interface SeedProduct {
  id: string;
  sku: string;
  name: string;
  price_minor: number;
  currency: string;
  active: boolean;
  on_hand: number;
}

export const SEED_PRODUCTS: SeedProduct[] = [
  {
    id: 'prod_live_1790713231955_kidx',
    sku: 'ITEM_SUCC_1790713231955',
    name: 'Product ITEM_SUCC',
    price_minor: 150000,
    currency: 'NGN',
    active: true,
    on_hand: 10,
  },
  {
    id: 'prod_live_1790713232090_vci3',
    sku: 'AVAIL_1790713232090',
    name: 'Product AVAIL',
    price_minor: 50000,
    currency: 'NGN',
    active: true,
    on_hand: 5,
  },
  {
    id: 'prod_live_1790713232104_h2d6',
    sku: 'EMPTY_1790713232104',
    name: 'Product EMPTY',
    price_minor: 75000,
    currency: 'NGN',
    active: true,
    on_hand: 0,
  },
  {
    id: 'prod_live_1790713232340_28k8',
    sku: 'CANCEL_ITEM_1790713232340',
    name: 'Product CANCEL_ITEM',
    price_minor: 80000,
    currency: 'NGN',
    active: true,
    on_hand: 10,
  },
  {
    id: 'prod_live_1790713232656_j9bf',
    sku: 'VAL_UNKNOWN_CUST_1790713232656',
    name: 'Product VAL_UNKNOWN_CUST',
    price_minor: 5000,
    currency: 'NGN',
    active: true,
    on_hand: 10,
  },
  {
    id: 'prod_live_1790713232798_pc9z',
    sku: 'RACE_R1_1790713232798',
    name: 'Product RACE_R1',
    price_minor: 100000,
    currency: 'NGN',
    active: true,
    on_hand: 3,
  },
  {
    id: 'prod_live_1790713233822_sspn',
    sku: 'RACE_R2_1790713233822',
    name: 'Product RACE_R2',
    price_minor: 100000,
    currency: 'NGN',
    active: true,
    on_hand: 3,
  },
  {
    id: 'prod_live_1790713234667_43e7',
    sku: 'RACE_R3_1790713234667',
    name: 'Product RACE_R3',
    price_minor: 100000,
    currency: 'NGN',
    active: true,
    on_hand: 3,
  },
  {
    id: 'prod_live_1790713235447_8onf',
    sku: 'RACE_R4_1790713235447',
    name: 'Product RACE_R4',
    price_minor: 100000,
    currency: 'NGN',
    active: true,
    on_hand: 3,
  },
  {
    id: 'prod_live_1790713236375_pce9',
    sku: 'RACE_R5_1790713236375',
    name: 'Product RACE_R5',
    price_minor: 100000,
    currency: 'NGN',
    active: true,
    on_hand: 3,
  },
  {
    id: 'prod_live_1790713238182_p7os',
    sku: 'SEC_TEST_1790713238182',
    name: 'Product SEC_TEST',
    price_minor: 5000,
    currency: 'NGN',
    active: true,
    on_hand: 10,
  },
  {
    id: 'prod_live_1790713239517_1mqr',
    sku: 'REAPER_PROD_1790713239517',
    name: 'Product REAPER_PROD',
    price_minor: 15000,
    currency: 'NGN',
    active: true,
    on_hand: 10,
  },
  {
    id: 'prod_live_1790713239789_sq9r',
    sku: 'TUNNEL_PROD_1790713239789',
    name: 'Product TUNNEL_PROD',
    price_minor: 20000,
    currency: 'NGN',
    active: true,
    on_hand: 4,
  },
  {
    id: 'prd_934bbcea1e5d47f9ace9d30e95626510',
    sku: 'SKU_WT_1790755636081',
    name: 'Walkthrough Item (SKU_WT_1790755636081)',
    price_minor: 50000,
    currency: 'NGN',
    active: true,
    on_hand: 10,
  },
  {
    id: 'prd_69b95e668b2e4381a68fdede546d5f49',
    sku: 'SKU_WT_1790780750161',
    name: 'Walkthrough Item (SKU_WT_1790780750161)',
    price_minor: 50000,
    currency: 'NGN',
    active: true,
    on_hand: 10,
  },
  {
    id: 'prd_6722e1dae5724e6aa3f6486dd302c8d3',
    sku: 'SKU_WT_1790781868667',
    name: 'Walkthrough Item (SKU_WT_1790781868667)',
    price_minor: 50000,
    currency: 'NGN',
    active: true,
    on_hand: 10,
  },
  {
    id: 'prd_0e1ca3831f064449a4f4557cace14c5d',
    sku: 'SKU_WT_1790782097227',
    name: 'Walkthrough Item (SKU_WT_1790782097227)',
    price_minor: 50000,
    currency: 'NGN',
    active: true,
    on_hand: 10,
  },
  {
    id: 'prd_41e9a6fe912a4d8b8229488c2694f6f2',
    sku: 'SKU_WT_1790786363295',
    name: 'Walkthrough Item (SKU_WT_1790786363295)',
    price_minor: 50000,
    currency: 'NGN',
    active: true,
    on_hand: 10,
  },
  {
    id: 'prd_8a0374ac783249d39d114d0086df8b1d',
    sku: 'SKU_WT_1790787753182',
    name: 'Walkthrough Item (SKU_WT_1790787753182)',
    price_minor: 50000,
    currency: 'NGN',
    active: true,
    on_hand: 8,
  },
];

export async function seedProducts(db: IDatabaseClient): Promise<void> {
  for (const p of SEED_PRODUCTS) {
    await db.query(
      `INSERT INTO products (id, sku, name, price_minor, currency, active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           price_minor = EXCLUDED.price_minor,
           currency = EXCLUDED.currency,
           active = EXCLUDED.active`,
      [p.id, p.sku, p.name, p.price_minor, p.currency, p.active]
    );

    await db.query(
      `INSERT INTO inventory (product_id, on_hand, reserved)
       VALUES ($1, $2, 0)
       ON CONFLICT (product_id) DO UPDATE
       SET on_hand = EXCLUDED.on_hand`,
      [p.id, p.on_hand]
    );
  }
}

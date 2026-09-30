import 'dotenv/config';
import Ductape from '@ductape/sdk';
import { DuctapeDatabaseClient } from '../src/common/database/ductape.database.js';
import { InventoryService } from '../src/modules/inventory/inventory.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { OrderService } from '../src/modules/orders/orders.service.js';
import { PaymentRouter } from '../src/modules/payments/router.js';
import { PaymentService } from '../src/modules/payments/payments.service.js';
import { PaystackPaymentProvider } from '../src/modules/payments/providers/paystack.provider.js';
import { FlutterwavePaymentProvider } from '../src/modules/payments/providers/flutterwave.provider.js';
import { NotificationService } from '../src/modules/notifications/notifications.service.js';
import { MockTransport, HttpWebhookTransport } from '../src/modules/notifications/transports/index.js';
import { IdempotencyService } from '../src/modules/idempotency/idempotency.service.js';
import { CheckoutSaga } from '../src/modules/orders/checkout-saga.js';
import { CryptoUtils } from '../src/common/utils/crypto.js';

async function setupContext() {
  const ductapeAccessKey =
    process.env.DUCTAPE_ACCESS_KEY ||
    process.env.DUCTAPE_ACCESSKEY ||
    process.env.ACCESS_KEY ||
    '';
  const ductapeWorkspaceId =
    process.env.DUCTAPE_WORKSPACE_ID ||
    process.env.DUCTAPE_WORKSPACE ||
    process.env.WORKSPACE_ID ||
    '';
  const ductapeProduct = process.env.DUCTAPE_PRODUCT || 'xavier_space:commerce_backend';
  const ductapeEnv = process.env.DUCTAPE_ENV || 'snd';

  const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';
  const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY || '';
  const flutterwaveSecretHash = process.env.FLUTTERWAVE_WEBHOOK_HASH || 'test_hash';

  const ductapeClient = new Ductape({
    accessKey: ductapeAccessKey,
    product: ductapeProduct,
    env: ductapeEnv,
  });
  if (ductapeWorkspaceId) {
    ductapeClient.setWorkspaceId(ductapeWorkspaceId);
  }

  await ductapeClient.databases.connect({
    env: ductapeEnv,
    product: ductapeProduct,
    database: 'commerce_db',
  });

  const dbClient = new DuctapeDatabaseClient(ductapeClient);

  // Ensure outbox table exists in live database
  await dbClient.query(`
    CREATE TABLE IF NOT EXISTS outbox (
      id VARCHAR(64) PRIMARY KEY,
      event_type VARCHAR(64) NOT NULL,
      payload JSONB NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      claimed_at TIMESTAMP WITH TIME ZONE,
      scheduled_for TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      processed_at TIMESTAMP WITH TIME ZONE
    )
  `);

  const inventoryService = new InventoryService(dbClient);
  const auditService = new AuditService(dbClient);
  const orderService = new OrderService(dbClient, inventoryService, auditService);

  const paymentRouter = new PaymentRouter();
  if (paystackSecretKey) {
    paymentRouter.register(new PaystackPaymentProvider({ secretKey: paystackSecretKey }));
  }
  if (flutterwaveSecretKey) {
    paymentRouter.register(
      new FlutterwavePaymentProvider({
        secretKey: flutterwaveSecretKey,
        secretHash: flutterwaveSecretHash,
      })
    );
  }

  const paymentService = new PaymentService(dbClient, paymentRouter);
  orderService.paymentService = paymentService;

  const notificationService = new NotificationService(
    dbClient,
    new MockTransport(),
    new HttpWebhookTransport(5000)
  );
  const idempotencyService = new IdempotencyService(dbClient);

  const checkoutSaga = new CheckoutSaga(
    dbClient,
    orderService,
    inventoryService,
    paymentService,
    notificationService,
    idempotencyService,
    auditService
  );

  return {
    dbClient,
    inventoryService,
    orderService,
    paymentService,
    checkoutSaga,
    paystackSecretKey,
    flutterwaveSecretKey,
  };
}

async function main() {
  const command = process.argv[2];

  if (!command || (command !== 'step1' && command !== 'step2')) {
    console.log(`
Usage:
  npx tsx scripts/real-payment-walkthrough.ts step1 [paystack|flutterwave]
  npx tsx scripts/real-payment-walkthrough.ts step2 <orderId>
`);
    process.exit(1);
  }

  const ctx = await setupContext();

  if (command === 'step1') {
    const provider = (process.argv[3] || 'paystack').toLowerCase();
    console.log(`\n======================================================`);
    console.log(`  STEP 1: REAL CHECKOUT WITH REAL PAYMENT PROVIDER`);
    console.log(`  Target Provider: ${provider.toUpperCase()}`);
    console.log(`======================================================\n`);

    // 1. Create live customer in real DB
    const customerId = `cus_wt_${Date.now()}`;
    const customerEmail = `shopper_${Date.now()}@example.com`;
    await ctx.dbClient.query(
      `INSERT INTO customers (id, email, name, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [customerId, customerEmail, 'Walkthrough Shopper']
    );
    console.log(`[1] Created Customer: ${customerId} (${customerEmail})`);

    // 2. Create product in real DB with stock
    const sku = `SKU_WT_${Date.now()}`;
    const { product, inventory } = await ctx.inventoryService.createProduct({
      sku,
      name: `Walkthrough Item (${sku})`,
      price_minor: 50000, // 500.00 NGN
      currency: 'NGN',
      initial_stock: 10,
    });
    console.log(`[2] Created Product: ${product.id} (${product.sku}) - On Hand: ${inventory.on_hand}, Reserved: ${inventory.reserved}`);

    // 3. Execute checkout saga using real payment provider (NOT mock)
    const idempotencyKey = `idemp_wt_${Date.now()}`;
    console.log(`[3] Initiating checkout with real ${provider.toUpperCase()} provider...`);

    const checkout = await ctx.checkoutSaga.executeCheckout({
      customerId,
      email: customerEmail,
      items: [{ productId: product.id, qty: 2 }],
      idempotencyKey,
      provider,
    });

    console.log(`\n================ CHECKOUT SUCCESS ================`);
    console.log(`Order ID:            ${checkout.order.id}`);
    console.log(`Order Status:        ${checkout.order.status}`);
    console.log(`Total Minor:         ${checkout.order.total_minor} ${checkout.order.currency}`);
    console.log(`Payment Intent ID:   ${checkout.paymentIntent.id}`);
    console.log(`Payment Provider:    ${checkout.paymentIntent.provider}`);
    console.log(`Provider Reference:  ${checkout.paymentIntent.provider_ref}`);
    console.log(`Checkout URL:        ${checkout.checkoutUrl}`);
    console.log(`Webhook Path:        /webhooks/${checkout.paymentIntent.provider}`);
    console.log(`Webhook Register:    https://<your-public-host>/webhooks/${checkout.paymentIntent.provider}`);
    console.log(`==================================================\n`);

    // Verify inventory state in real DB
    const invAfter = await ctx.inventoryService.getInventory(product.id);
    console.log(`Inventory Status: On Hand: ${invAfter.on_hand}, Reserved: ${invAfter.reserved}, Available: ${invAfter.on_hand - invAfter.reserved}`);

    console.log(`\nNext Step to cancel this order (do not run unless requested):`);
    console.log(`  npx tsx scripts/real-payment-walkthrough.ts step2 ${checkout.order.id}\n`);

    await ctx.dbClient.close();
  } else if (command === 'step2') {
    const orderId = process.argv[3];
    if (!orderId) {
      console.error('Error: Please provide orderId for step2: npx tsx scripts/real-payment-walkthrough.ts step2 <orderId>');
      process.exit(1);
    }

    console.log(`\n======================================================`);
    console.log(`  STEP 2: CANCEL ORDER & RELEASE RESERVED STOCK`);
    console.log(`  Order ID: ${orderId}`);
    console.log(`======================================================\n`);

    // Fetch order
    const order = await ctx.orderService.getOrder(orderId);
    console.log(`Current Order Status before cancellation: ${order.status}`);

    // Cancel order
    const cancelledOrder = await ctx.orderService.cancelOrder(orderId, {
      actorId: order.customer_id,
      actorType: 'user',
    });

    console.log(`\n================ CANCELLATION SUCCESS ================`);
    console.log(`Order ID:            ${cancelledOrder.id}`);
    console.log(`New Order Status:    ${cancelledOrder.status}`);
    console.log(`======================================================\n`);

    // Inspect reservation rows
    const resRows = await ctx.dbClient.query<{ id: string; product_id: string; qty: number; status: string }>(
      'SELECT id, product_id, qty, status FROM reservations WHERE order_id = $1',
      [orderId]
    );
    console.log(`Reservation rows:`);
    for (const r of resRows.rows) {
      console.log(`- Reservation [${r.id}]: Product ${r.product_id}, Qty: ${r.qty}, Status: ${r.status}`);
      const inv = await ctx.inventoryService.getInventory(r.product_id);
      console.log(`  Inventory -> On Hand: ${inv.on_hand}, Reserved: ${inv.reserved}, Available: ${inv.on_hand - inv.reserved}`);
    }

    console.log(`\nTo inspect all DB tables for this order, run:`);
    console.log(`  npx tsx scripts/inspect-order.ts ${orderId}\n`);

    await ctx.dbClient.close();
  }
}

main().catch((err) => {
  console.error('[real-payment-walkthrough] Fatal error:', err);
  process.exit(1);
});

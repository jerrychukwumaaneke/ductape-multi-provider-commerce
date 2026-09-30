import 'dotenv/config';
import Ductape from '@ductape/sdk';
import { DuctapeApiPaymentProvider } from '../src/modules/payments/providers/ductape-api.provider.js';
import { PaystackPaymentProvider } from '../src/modules/payments/providers/paystack.provider.js';

async function main() {
  const secretKey = process.env.PAYSTACK_SECRET_KEY || '';
  const accessKey = process.env.DUCTAPE_ACCESS_KEY || '';
  const workspaceId = process.env.DUCTAPE_WORKSPACE_ID || '';
  const env = process.env.DUCTAPE_ENV || 'dev';
  const product = process.env.DUCTAPE_PRODUCT || 'commerce-backend';

  console.log(`[Paystack Test] Using PAYSTACK_SECRET_KEY: ${secretKey ? secretKey.substring(0, 7) + '...' : '(none)'}`);
  console.log(`[Paystack Test] Using DUCTAPE_ACCESS_KEY: ${accessKey ? accessKey.substring(0, 7) + '...' : '(none)'}`);

  // 1. Try DuctapeApiPaymentProvider
  console.log('\n--- 1. Testing DuctapeApiPaymentProvider ---');
  try {
    const ductape = new Ductape({ accessKey, product, env });
    if (workspaceId) ductape.setWorkspaceId(workspaceId);

    const ductapeProvider = new DuctapeApiPaymentProvider(ductape);
    const result = await ductapeProvider.createPayment({
      orderId: 'ord_test_live_1',
      amountMinor: 500000, // 5000 NGN
      currency: 'NGN',
      email: 'customer@example.com',
      reference: `ref_dt_${Date.now()}`,
    });
    console.log('DuctapeApiPaymentProvider Result:', JSON.stringify(result, null, 2));
  } catch (error: any) {
    console.error('DuctapeApiPaymentProvider Error:');
    console.error(error?.message || error);
    if (error?.stack) console.error(error.stack);
  }

  // 2. Try Direct HTTPS PaystackPaymentProvider
  console.log('\n--- 2. Testing Direct PaystackPaymentProvider (HTTPS Adapter) ---');
  try {
    const directProvider = new PaystackPaymentProvider({ secretKey });
    const result = await directProvider.createPayment({
      orderId: 'ord_test_live_1',
      amountMinor: 500000, // 5000 NGN
      currency: 'NGN',
      email: 'customer@example.com',
      reference: `ref_direct_${Date.now()}`,
    });
    console.log('Direct PaystackPaymentProvider Result:', JSON.stringify(result, null, 2));
  } catch (error: any) {
    console.error('Direct PaystackPaymentProvider Error:');
    console.error(error?.message || error);
    if (error?.stack) console.error(error.stack);
  }
}

main();

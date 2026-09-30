import 'dotenv/config';
import Ductape from '@ductape/sdk';

async function main() {
  const accessKey = process.env.DUCTAPE_ACCESS_KEY || '';
  const workspaceId = process.env.DUCTAPE_WORKSPACE_ID || '';
  const env = process.env.DUCTAPE_ENV || 'dev';
  const product = process.env.DUCTAPE_PRODUCT || 'commerce-backend';

  console.log(`[Ductape DB Test] Initializing Ductape with workspace: "${workspaceId}", env: "${env}", product: "${product}"`);

  const ductape = new Ductape({
    accessKey,
    product,
    env,
  });

  if (workspaceId) {
    ductape.setWorkspaceId(workspaceId);
  }

  console.log('[Ductape DB Test] Attempting to connect to Ductape database...');
  try {
    // Attempt connection
    await ductape.databases.connect({
      env,
      product,
      database: 'commerce_db',
    });
    console.log('[Ductape DB Test] Connected successfully.');

    // Insert row
    const testId = `cus_test_${Date.now()}`;
    console.log(`[Ductape DB Test] Inserting customer ${testId}...`);
    const insertResult = await ductape.databases.insert({
      table: 'customers',
      data: {
        id: testId,
        email: `${testId}@example.com`,
        name: 'Test Customer',
      },
    });
    console.log('[Ductape DB Test] Insert result:', JSON.stringify(insertResult));

    // Query row back
    console.log(`[Ductape DB Test] Querying customer ${testId}...`);
    const queryResult = await ductape.databases.query({
      table: 'customers',
      where: { id: testId },
    });
    console.log('[Ductape DB Test] Query result:', JSON.stringify(queryResult));
  } catch (error: any) {
    console.error('[Ductape DB Test] Error encountered:');
    console.error(error);
  }
}

main();

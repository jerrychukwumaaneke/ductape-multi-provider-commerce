import 'dotenv/config';
import { getDuctapeClient } from '../src/common/ductape/index.js';
import { DuctapeDatabaseClient } from '../src/common/database/ductape.database.js';
import { NotificationService } from '../src/modules/notifications/notifications.service.js';
import { DuctapeNotificationTransport } from '../src/modules/notifications/transports/ductape.transport.js';
import { HttpWebhookTransport } from '../src/modules/notifications/transports/index.js';

async function main() {
  process.env.USE_DUCTAPE_NOTIF = 'true';
  const ductape = getDuctapeClient();
  const db = new DuctapeDatabaseClient(ductape);
  await db.connect();

  const ductapeTransport = new DuctapeNotificationTransport(ductape);
  const webhookTransport = new HttpWebhookTransport(5000);
  const notificationService = new NotificationService(db, ductapeTransport, webhookTransport);

  const recipientEmail = process.argv[2] || 'jerry.intern@example.com';
  console.log(`Sending real test notification via DuctapeNotificationTransport to: ${recipientEmail}`);

  const result = await notificationService.send({
    template_key: 'order_confirmed',
    recipient: recipientEmail,
    vars: {
      order_id: 'ord_live_notif_test',
      customer_name: 'Jerry',
      total: 'NGN 5000.00',
    },
  });

  console.log('\n--- Result from NotificationService.send() ---');
  console.log(JSON.stringify(result, null, 2));

  // Also query the local delivery_attempts table
  const deliveries = await db.query(
    'SELECT * FROM delivery_attempts WHERE notification_id = $1',
    [result.id]
  );
  console.log('\n--- Database Record in delivery_attempts ---');
  console.log(JSON.stringify(deliveries.rows, null, 2));
}

main().catch(console.error);

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '../test-db.js';
import { IDatabaseClient } from '../../src/common/database/index.js';
import { NotificationService } from '../../src/modules/notifications/notifications.service.js';
import { MockTransport } from '../../src/modules/notifications/transports/index.js';
import { ValidationError, RateLimitedError } from '../../src/common/errors/app-error.js';
import { SsrfGuard } from '../../src/modules/notifications/ssrf-guard.js';

describe('Milestone 3: Notification Service Test Suite', () => {
  let db: IDatabaseClient;
  let mockTransport: MockTransport;
  let notifService: NotificationService;

  beforeEach(async () => {
    db = await createTestDatabase();
    mockTransport = new MockTransport();
    notifService = new NotificationService(db, mockTransport, mockTransport);

    // Create default templates
    await notifService.createTemplate({
      key: 'order_confirmed',
      channel: 'email',
      category: 'transactional',
      subject: 'Order {{order_id}} Confirmed',
      body: 'Hello {{customer_name}}, your order of {{total}} is confirmed!',
      required_vars: ['order_id', 'customer_name', 'total'],
    });

    await notifService.createTemplate({
      key: 'marketing_offer',
      channel: 'email',
      category: 'optional',
      subject: 'Special 20% Discount!',
      body: 'Hi {{customer_name}}, check out our latest offers!',
      required_vars: ['customer_name'],
    });
  });

  afterEach(async () => {
    await db.close();
  });

  describe('1. Happy Path & Variable Interpolation', () => {
    it('renders and delivers email successfully, recording delivery attempt', async () => {
      const res = await notifService.send({
        template_key: 'order_confirmed',
        recipient: 'buyer@example.com',
        vars: { order_id: 'ord_101', customer_name: 'Jerry', total: '$50.00' },
      });

      expect(res.status).toBe('delivered');
      expect(mockTransport.sentMessages.length).toBe(1);
      expect(mockTransport.sentMessages[0].subject).toBe('Order ord_101 Confirmed');
      expect(mockTransport.sentMessages[0].body).toBe('Hello Jerry, your order of $50.00 is confirmed!');

      const details = await notifService.getNotification(res.id);
      expect(details.attempts.length).toBe(1);
      expect(details.attempts[0].outcome).toBe('success');
    });
  });

  describe('2. Validation & Missing Variables', () => {
    it('throws 422 ValidationError if a required variable is missing', async () => {
      await expect(
        notifService.send({
          template_key: 'order_confirmed',
          recipient: 'buyer@example.com',
          vars: { order_id: 'ord_101', customer_name: 'Jerry' }, // missing 'total'
        })
      ).rejects.toThrow(ValidationError);

      expect(mockTransport.sentMessages.length).toBe(0);
    });
  });

  describe('3. Preference Suppression vs Transactional Guarantee', () => {
    it('suppresses optional notifications when user opts out', async () => {
      // Opt out
      await notifService.setPreference({
        user_id: 'usr_optout',
        category: 'optional',
        channel: 'email',
        enabled: false,
      });

      const res = await notifService.send({
        template_key: 'marketing_offer',
        recipient: 'optout@example.com',
        user_id: 'usr_optout',
        vars: { customer_name: 'Opted Out User' },
      });

      expect(res.status).toBe('suppressed');
      expect(mockTransport.sentMessages.length).toBe(0); // not dispatched
    });

    it('always delivers transactional notifications even if user opted out', async () => {
      await notifService.setPreference({
        user_id: 'usr_optout',
        category: 'transactional',
        channel: 'email',
        enabled: false,
      });

      const res = await notifService.send({
        template_key: 'order_confirmed',
        recipient: 'optout@example.com',
        user_id: 'usr_optout',
        vars: { order_id: 'ord_102', customer_name: 'User', total: '$20' },
      });

      expect(res.status).toBe('delivered');
      expect(mockTransport.sentMessages.length).toBe(1);
    });
  });

  describe('4. Duplication & Idempotency', () => {
    it('returns existing notification on duplicate idempotency_key', async () => {
      const first = await notifService.send({
        template_key: 'order_confirmed',
        recipient: 'buyer@example.com',
        idempotency_key: 'notif_idemp_1',
        vars: { order_id: 'ord_103', customer_name: 'Jerry', total: '$10' },
      });

      const second = await notifService.send({
        template_key: 'order_confirmed',
        recipient: 'buyer@example.com',
        idempotency_key: 'notif_idemp_1',
        vars: { order_id: 'ord_103', customer_name: 'Jerry', total: '$10' },
      });

      expect(first.id).toBe(second.id);
      expect(mockTransport.sentMessages.length).toBe(1);
    });

    it('returns existing notification on duplicate dedupe_key', async () => {
      const first = await notifService.send({
        template_key: 'order_confirmed',
        recipient: 'buyer@example.com',
        dedupe_key: 'dedupe_order_104',
        vars: { order_id: 'ord_104', customer_name: 'Jerry', total: '$15' },
      });

      const second = await notifService.send({
        template_key: 'order_confirmed',
        recipient: 'buyer@example.com',
        dedupe_key: 'dedupe_order_104',
        vars: { order_id: 'ord_104', customer_name: 'Jerry', total: '$15' },
      });

      expect(first.id).toBe(second.id);
      expect(mockTransport.sentMessages.length).toBe(1);
    });
  });

  describe('5. Retries & Failure Handling', () => {
    it('retries on transient failure and marks delivered when a retry succeeds', async () => {
      mockTransport.failNextCount = 2; // fail first 2 attempts, then succeed

      const res = await notifService.send({
        template_key: 'order_confirmed',
        recipient: 'retry@example.com',
        vars: { order_id: 'ord_105', customer_name: 'Jerry', total: '$30' },
      });

      expect(res.status).toBe('delivered');
      const details = await notifService.getNotification(res.id);
      expect(details.attempts.length).toBe(3);
      expect(details.attempts[0].outcome).toBe('transient_failure');
      expect(details.attempts[1].outcome).toBe('transient_failure');
      expect(details.attempts[2].outcome).toBe('success');
    });

    it('marks failed without retrying on permanent failure', async () => {
      mockTransport.failPermanently = true;

      const res = await notifService.send({
        template_key: 'order_confirmed',
        recipient: 'invalid-address',
        vars: { order_id: 'ord_106', customer_name: 'Jerry', total: '$40' },
      });

      expect(res.status).toBe('failed');
      const details = await notifService.getNotification(res.id);
      expect(details.attempts.length).toBe(1);
      expect(details.attempts[0].outcome).toBe('permanent_failure');
    });

    it('replays a failed notification successfully', async () => {
      mockTransport.failPermanently = true;
      const failed = await notifService.send({
        template_key: 'order_confirmed',
        recipient: 'buyer@example.com',
        vars: { order_id: 'ord_107', customer_name: 'Jerry', total: '$50' },
      });

      expect(failed.status).toBe('failed');

      // Now recovery
      mockTransport.failPermanently = false;
      const replayed = await notifService.replayFailed(failed.id);
      expect(replayed.status).toBe('delivered');
    });
  });

  describe('6. Rate Limiting', () => {
    it('blocks excessive messages to the same recipient', async () => {
      const recipient = 'spam@example.com';
      // 10 messages allowed
      for (let i = 0; i < 10; i++) {
        await notifService.send({
          template_key: 'order_confirmed',
          recipient,
          vars: { order_id: `ord_${i}`, customer_name: 'Jerry', total: '$1' },
        });
      }

      // 11th message should throw RateLimitedError
      await expect(
        notifService.send({
          template_key: 'order_confirmed',
          recipient,
          vars: { order_id: 'ord_overflow', customer_name: 'Jerry', total: '$1' },
        })
      ).rejects.toThrow(RateLimitedError);
    });
  });

  describe('7. Outgoing Webhooks & SSRF Guard', () => {
    it('blocks internal and private IPs to protect against SSRF', () => {
      expect(SsrfGuard.isSafeUrl('http://localhost:8080/hook').safe).toBe(false);
      expect(SsrfGuard.isSafeUrl('http://127.0.0.1/hook').safe).toBe(false);
      expect(SsrfGuard.isSafeUrl('http://10.0.0.5:3000/webhook').safe).toBe(false);
      expect(SsrfGuard.isSafeUrl('http://192.168.1.1/admin').safe).toBe(false);
      expect(SsrfGuard.isSafeUrl('http://169.254.169.254/latest/meta-data').safe).toBe(false);
      expect(SsrfGuard.isSafeUrl('https://api.merchant.com/webhooks/orders').safe).toBe(true);
    });

    it('disables webhook endpoint after 5 consecutive failures', async () => {
      const endpoint = await notifService.registerWebhookEndpoint({
        ownerId: 'merchant_1',
        url: 'https://example.com/webhook',
        secret: 'whsec_abc',
      });

      expect(endpoint.active).toBe(true);

      for (let i = 0; i < 5; i++) {
        await notifService.recordEndpointFailure(endpoint.id);
      }

      const res = await db.query<{ active: boolean; consecutive_failures: number }>(
        'SELECT active, consecutive_failures FROM webhook_endpoints WHERE id = $1',
        [endpoint.id]
      );
      expect(res.rows[0].active).toBe(false);
      expect(res.rows[0].consecutive_failures).toBe(5);
    });
  });
});

import { Router, Response, NextFunction } from 'express';
import { NotificationService } from '../../modules/notifications/notifications.service.js';
import { IdentityService } from '../../modules/identity/identity.service.js';
import { AuthenticatedRequest, createAuthMiddleware } from '../middleware/auth.js';
import { ValidationError } from '../../common/errors/app-error.js';

export function createNotificationsRouter(
  notificationService: NotificationService,
  identityService: IdentityService
): Router {
  const router = Router();
  const auth = createAuthMiddleware(identityService);

  router.post('/notifications', auth.authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const idempotencyKey = (req.headers['idempotency-key'] as string) || req.body.idempotency_key;
      const { template_key, recipient, vars, dedupe_key } = req.body;

      if (!template_key || !recipient) {
        throw new ValidationError('template_key and recipient are required');
      }

      const record = await notificationService.send({
        template_key,
        recipient,
        vars: vars || {},
        idempotency_key: idempotencyKey,
        dedupe_key,
      });

      res.status(201).json(record);
    } catch (err) {
      next(err);
    }
  });

  router.get('/notifications/:id', auth.authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const status = await notificationService.getNotification(req.params.id as string);
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  router.post('/notifications/:id/replay', auth.authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const replayed = await notificationService.replayFailed(req.params.id as string);
      res.json(replayed);
    } catch (err) {
      next(err);
    }
  });

  // Template CRUD
  router.get('/notifications/templates/:key', auth.authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const template = await notificationService.getTemplate(req.params.key as string);
      res.json(template);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/notifications/templates',
    auth.authenticate,
    auth.requireRole('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { key, channel, category, subject, body, required_vars } = req.body;
        if (!key || !channel || !category || !body) {
          throw new ValidationError('key, channel, category, and body are required');
        }

        const template = await notificationService.createTemplate({
          key,
          channel,
          category,
          subject,
          body,
          required_vars: required_vars || [],
        });

        res.status(201).json(template);
      } catch (err) {
        next(err);
      }
    }
  );

  // Preference routes
  router.get('/notifications/preferences/:userId', auth.authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const preferences = await notificationService.getPreferences(req.params.userId as string);
      res.json({ userId: req.params.userId, preferences });
    } catch (err) {
      next(err);
    }
  });

  router.put('/notifications/preferences/:userId', auth.authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { channel, category, enabled } = req.body;
      if (!channel || !category || enabled === undefined) {
        throw new ValidationError('channel, category, and enabled are required');
      }

      await notificationService.setPreference({
        user_id: req.params.userId as string,
        channel,
        category,
        enabled: Boolean(enabled),
      });

      res.json({ message: 'Preference updated successfully' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

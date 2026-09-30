import { Router, Response, NextFunction } from 'express';
import { IdentityService } from '../../modules/identity/identity.service.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { ValidationError } from '../../common/errors/app-error.js';

export function createAuthRouter(identityService: IdentityService): Router {
  const router = Router();

  router.post('/register', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { email, password, role, name, customerId } = req.body;
      if (!email || !password) {
        throw new ValidationError('Email and password are required');
      }

      if (role && role !== 'customer') {
        throw new ValidationError("Registration with elevated roles is forbidden. Only 'customer' accounts can be registered via public signup.");
      }

      const user = await identityService.registerUser({
        email,
        password,
        role: 'customer',
        name,
        customerId,
      });

      res.status(201).json({
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          customerId: user.customer_id,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        throw new ValidationError('Email and password are required');
      }

      const tokens = await identityService.login({ email, password });
      res.json(tokens);
    } catch (err) {
      next(err);
    }
  });

  router.post('/refresh', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) {
        throw new ValidationError('refreshToken is required');
      }

      const payload = identityService.verifyToken(refreshToken);
      const newAccessToken = identityService.createAgentToken(payload.sub, payload.role, payload.scope);
      res.json({ accessToken: newAccessToken });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

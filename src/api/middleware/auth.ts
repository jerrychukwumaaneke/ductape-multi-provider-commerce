import { Request, Response, NextFunction } from 'express';
import { ForbiddenError, UnauthorizedError } from '../../common/errors/app-error.js';
import { ActorContext, UserRole } from '../../common/types/index.js';
import { IdentityService } from '../../modules/identity/identity.service.js';

export interface AuthenticatedRequest extends Request {
  actor?: ActorContext;
}

export function createAuthMiddleware(identityService: IdentityService) {
  return {
    authenticate: (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next(new UnauthorizedError('Missing or malformed Authorization header.'));
      }

      const token = authHeader.split(' ')[1];
      try {
        const actor = identityService.toActorContext(token);
        req.actor = actor;
        next();
      } catch (err) {
        next(err);
      }
    },

    optionalAuth: (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
          req.actor = identityService.toActorContext(token);
        } catch {
          // ignore optional token failure
        }
      }
      next();
    },

    requireRole: (...allowedRoles: UserRole[]) => {
      return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
        if (!req.actor) {
          return next(new UnauthorizedError());
        }
        if (!req.actor.role || !allowedRoles.includes(req.actor.role)) {
          return next(
            new ForbiddenError(`Required role [${allowedRoles.join(', ')}], but current role is '${req.actor.role}'.`)
          );
        }
        next();
      };
    },
  };
}

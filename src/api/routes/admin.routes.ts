import { Router, Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { IdentityService } from '../../modules/identity/identity.service.js';
import { IDatabaseClient } from '../../common/database/index.js';
import { createAuthMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';

function timingSafeMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function readLastLines(filePath: string, maxLines: number = 50): string[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];

    const maxBytes = 2 * 1024 * 1024; // Read at most the last 2MB
    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
    fs.closeSync(fd);

    const content = buffer.toString('utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    return lines.slice(-maxLines);
  } catch (err) {
    console.error(`[AdminLogs] Error reading file ${filePath}:`, err);
    return [];
  }
}

export function createAdminRouter(identityService: IdentityService, db?: IDatabaseClient): Router {
  const router = Router();
  const auth = createAuthMiddleware(identityService);

  // Hardened admin auth: accepts valid X-Admin-Key header (timing-safe, >= 32 chars) OR JWT with 'admin' role
  const requireAdminAccess = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const configuredKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET_KEY;
    const headerKey = req.headers['x-admin-key'];

    // If an X-Admin-Key header is supplied, strictly validate it (no query parameter fallback)
    if (headerKey) {
      const providedKey = Array.isArray(headerKey) ? headerKey[0] : headerKey;
      if (
        configuredKey &&
        configuredKey.length >= 32 &&
        timingSafeMatch(providedKey, configuredKey)
      ) {
        return next();
      }
      return next(new UnauthorizedError('Invalid or unauthorized X-Admin-Key.'));
    }

    // Otherwise, require standard JWT Bearer authentication with 'admin' role
    return auth.authenticate(req, res, () => {
      auth.requireRole('admin')(req, res, next);
    });
  };

  /**
   * GET /admin/logs/webhooks
   * Returns recent entries from incoming-webhooks.log
   */
  router.get('/logs/webhooks', requireAdminAccess, (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const logDir = path.resolve(process.cwd(), 'logs');
    const logFile = process.env.WEBHOOK_LOG_FILE || path.join(logDir, 'incoming-webhooks.log');

    const lines = readLastLines(logFile, limit);
    const parsed = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      })
      .reverse();

    res.json({
      file: 'logs/incoming-webhooks.log',
      count: parsed.length,
      limit,
      logs: parsed,
    });
  });

  /**
   * GET /admin/logs/outbound
   * Returns recent entries from outbound-provider-calls.log
   */
  router.get('/logs/outbound', requireAdminAccess, (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const logDir = path.resolve(process.cwd(), 'logs');
    const logFile = process.env.OUTBOUND_LOG_FILE || path.join(logDir, 'outbound-provider-calls.log');

    const lines = readLastLines(logFile, limit);
    const parsed = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      })
      .reverse();

    res.json({
      file: 'logs/outbound-provider-calls.log',
      count: parsed.length,
      limit,
      logs: parsed,
    });
  });

  /**
   * GET /admin/logs/db-webhooks
   * Returns persistent webhook events from the PostgreSQL database
   */
  router.get('/logs/db-webhooks', requireAdminAccess, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!db) {
        res.json({ count: 0, events: [], note: 'Database client not connected.' });
        return;
      }
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const result = await db.query(
        `SELECT id, provider, provider_event_id, type, payload, processed_at
         FROM webhook_events
         ORDER BY processed_at DESC
         LIMIT $1`,
        [limit]
      );
      res.json({
        count: result.rowCount,
        limit,
        events: result.rows,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /admin/logs/stats
   * Returns runtime diagnostic statistics
   */
  router.get('/logs/stats', requireAdminAccess, (_req: Request, res: Response) => {
    const logDir = path.resolve(process.cwd(), 'logs');
    const webhookFile = process.env.WEBHOOK_LOG_FILE || path.join(logDir, 'incoming-webhooks.log');
    const outboundFile = process.env.OUTBOUND_LOG_FILE || path.join(logDir, 'outbound-provider-calls.log');

    const getFileSize = (filePath: string) => {
      try {
        return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      } catch {
        return 0;
      }
    };

    res.json({
      uptime_seconds: Math.floor(process.uptime()),
      memory_usage_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      log_files: {
        'incoming-webhooks.log': {
          exists: fs.existsSync(webhookFile),
          size_bytes: getFileSize(webhookFile),
        },
        'outbound-provider-calls.log': {
          exists: fs.existsSync(outboundFile),
          size_bytes: getFileSize(outboundFile),
        },
      },
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

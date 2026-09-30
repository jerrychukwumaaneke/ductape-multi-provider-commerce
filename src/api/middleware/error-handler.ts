import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../common/errors/app-error.js';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  const message = err instanceof Error ? err.message : 'An unexpected internal error occurred';
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message,
      hint: 'Contact support if this issue persists.',
    },
  });
}

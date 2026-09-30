export type ErrorCode =
  | 'INSUFFICIENT_INVENTORY'
  | 'INVALID_TRANSITION'
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_PENDING'
  | 'PROVIDER_ERROR'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface AppErrorPayload {
  code: ErrorCode;
  message: string;
  details?: unknown;
  hint?: string;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;
  public readonly hint?: string;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
    hint?: string
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.hint = hint;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public toJSON(): { error: AppErrorPayload } {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        hint: this.hint,
      },
    };
  }
}

export class InsufficientInventoryError extends AppError {
  constructor(details?: { unavailableProducts: Array<{ productId: string; requestedQty: number; availableQty: number }> }) {
    super(
      409,
      'INSUFFICIENT_INVENTORY',
      'One or more requested items do not have sufficient available inventory.',
      details,
      'Reduce the requested quantities or remove out-of-stock items and try again.'
    );
  }
}

export class InvalidTransitionError extends AppError {
  constructor(entity: string, currentStatus: string, targetStatus: string, allowedTransitions?: string[]) {
    super(
      400,
      'INVALID_TRANSITION',
      `Cannot transition ${entity} from '${currentStatus}' to '${targetStatus}'.`,
      { entity, currentStatus, targetStatus, allowedTransitions },
      `Allowed transitions from '${currentStatus}': ${allowedTransitions ? allowedTransitions.join(', ') : 'none'}`
    );
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(422, 'VALIDATION_FAILED', message, details, 'Check request payload according to validation schema rules.');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.') {
    super(401, 'UNAUTHORIZED', message, undefined, 'Provide a valid Bearer token in the Authorization header.');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.') {
    super(403, 'FORBIDDEN', message, undefined, 'Check actor permissions or roles.');
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super(
      404,
      'NOT_FOUND',
      id ? `${entity} with ID '${id}' not found.` : `${entity} not found.`,
      { entity, id },
      'Verify the identifier exists.'
    );
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, 'CONFLICT', message, details, 'Resource conflict detected.');
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(key: string) {
    super(
      409,
      'IDEMPOTENCY_CONFLICT',
      `An in-flight or conflicting request already exists for Idempotency-Key '${key}'.`,
      { key },
      'Ensure each unique operation uses a distinct Idempotency-Key or wait for the current request to complete.'
    );
  }
}

export class PaymentFailedError extends AppError {
  constructor(message: string, details?: unknown) {
    super(402, 'PAYMENT_FAILED', message, details, 'Use an alternate payment method or retry.');
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds?: number) {
    super(
      429,
      'RATE_LIMITED',
      'Too many requests. Please slow down.',
      { retryAfter: retryAfterSeconds },
      `Try again in ${retryAfterSeconds ?? 'a few'} seconds.`
    );
  }
}

import { InvalidTransitionError } from '../errors/app-error.js';
import { OrderStatus, PaymentIntentStatus, ReservationStatus } from '../types/index.js';

// Order transition rules
const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['awaiting_payment', 'cancelled', 'expired'],
  awaiting_payment: ['paid', 'payment_failed', 'cancelled', 'expired'],
  paid: ['fulfilled', 'cancelled'], // cancellation from paid triggers refund
  fulfilled: ['shipped'],
  shipped: ['delivered'], // cancel not allowed from shipped
  delivered: [], // terminal
  cancelled: [], // terminal
  payment_failed: [], // terminal
  expired: [], // terminal
};

// Payment Intent transition rules
const PAYMENT_INTENT_TRANSITIONS: Record<PaymentIntentStatus, PaymentIntentStatus[]> = {
  created: ['processing', 'canceled', 'failed'],
  processing: ['succeeded', 'failed', 'canceled'],
  succeeded: [], // terminal
  failed: [], // terminal
  canceled: [], // terminal
};

// Reservation transition rules
const RESERVATION_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  held: ['committed', 'released', 'expired'],
  committed: [], // terminal
  released: [], // terminal
  expired: [], // terminal
};

export class StateMachine {
  public static validateOrderTransition(current: OrderStatus, next: OrderStatus): void {
    if (current === next) return; // idempotent same-state transition
    const allowed = ORDER_TRANSITIONS[current] || [];
    if (!allowed.includes(next)) {
      throw new InvalidTransitionError('Order', current, next, allowed);
    }
  }

  public static canCancelOrder(current: OrderStatus): boolean {
    return ['pending', 'awaiting_payment', 'paid'].includes(current);
  }

  public static validatePaymentIntentTransition(current: PaymentIntentStatus, next: PaymentIntentStatus): void {
    if (current === next) return; // idempotent same-state transition
    const allowed = PAYMENT_INTENT_TRANSITIONS[current] || [];
    if (!allowed.includes(next)) {
      throw new InvalidTransitionError('PaymentIntent', current, next, allowed);
    }
  }

  public static validateReservationTransition(current: ReservationStatus, next: ReservationStatus): void {
    if (current === next) return; // idempotent same-state transition
    const allowed = RESERVATION_TRANSITIONS[current] || [];
    if (!allowed.includes(next)) {
      throw new InvalidTransitionError('Reservation', current, next, allowed);
    }
  }
}

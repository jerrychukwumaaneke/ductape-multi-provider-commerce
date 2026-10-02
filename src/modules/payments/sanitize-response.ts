/**
 * Sanitizes transaction raw_response payloads to comply with data privacy and PCI hygiene.
 * Strictly retains only: id, status, amount, currency, reference, channel, paid_at.
 * Strips card authorization details (bin, last4, signature, authorization_code), customer PII, fees, logs, etc.
 */
export interface SanitizedTransactionPayload {
  id?: string | number;
  status?: string;
  amount?: number;
  currency?: string;
  reference?: string;
  channel?: string;
  paid_at?: string;
}

export function sanitizeTransactionRawResponse(
  raw: unknown,
  fallback?: {
    id?: string | number;
    status?: string;
    amount?: number;
    currency?: string;
    reference?: string;
    channel?: string;
    paid_at?: string;
  }
): SanitizedTransactionPayload {
  let parsedRaw = raw;
  if (typeof raw === 'string') {
    try {
      parsedRaw = JSON.parse(raw);
    } catch {
      parsedRaw = {};
    }
  }

  const src =
    parsedRaw && typeof parsedRaw === 'object' && 'data' in parsedRaw && (parsedRaw as any).data && typeof (parsedRaw as any).data === 'object' && !Array.isArray((parsedRaw as any).data)
      ? (parsedRaw as any).data
      : (typeof parsedRaw === 'object' && parsedRaw !== null ? (parsedRaw as any) : {});

  const id = src.id ?? (raw as any)?.id ?? fallback?.id;
  const status = src.status ?? (raw as any)?.status ?? fallback?.status;
  const amount = src.amount ?? src.amount_minor ?? (raw as any)?.amount ?? fallback?.amount;
  const currency = src.currency ?? (raw as any)?.currency ?? fallback?.currency;
  const reference = src.reference ?? src.tx_ref ?? src.transaction_reference ?? (raw as any)?.reference ?? fallback?.reference;
  const channel = src.channel ?? src.payment_type ?? src.refund_channel ?? (raw as any)?.channel ?? fallback?.channel ?? 'unknown';
  const paid_at = src.paid_at ?? src.paidAt ?? src.refunded_at ?? src.created_at ?? src.createdAt ?? (raw as any)?.paid_at ?? fallback?.paid_at ?? new Date().toISOString();

  const sanitized: SanitizedTransactionPayload = {};

  if (id !== undefined) sanitized.id = id;
  if (status !== undefined) sanitized.status = status;
  if (amount !== undefined) sanitized.amount = amount;
  if (currency !== undefined) sanitized.currency = currency;
  if (reference !== undefined) sanitized.reference = reference;
  if (channel !== undefined) sanitized.channel = channel;
  if (paid_at !== undefined) sanitized.paid_at = paid_at;

  return sanitized;
}

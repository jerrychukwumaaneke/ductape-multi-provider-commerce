import fs from 'node:fs';
import path from 'node:path';

export interface OutboundLogEntry {
  timestamp: string;
  provider: 'paystack' | 'flutterwave' | string;
  method: string;
  url: string;
  requestHeaders?: Record<string, unknown>;
  requestBody?: unknown;
  status?: number;
  statusText?: string;
  responseBody?: unknown;
  error?: string;
  durationMs: number;
}

export function redactSensitiveHeaders(headers: any): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  if (!headers) return redacted;

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'authorization' || lower === 'verif-hash' || lower === 'cookie') {
        redacted[key] = '[REDACTED]';
      } else {
        redacted[key] = value;
      }
    });
    return redacted;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      const lower = key.toLowerCase();
      if (lower === 'authorization' || lower === 'verif-hash' || lower === 'cookie') {
        redacted[key] = '[REDACTED]';
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'verif-hash' || lower === 'cookie') {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

export function logOutboundProviderCall(entry: OutboundLogEntry): void {
  try {
    const logDir = path.resolve(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = process.env.OUTBOUND_LOG_FILE || path.join(logDir, 'outbound-provider-calls.log');
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error('[Outbound Logger] Failed to log provider call:', err);
  }
}

export async function loggedFetch(
  provider: 'paystack' | 'flutterwave' | string,
  url: string,
  options: RequestInit = {},
  fetchFn: typeof fetch = fetch
): Promise<{ res: Response; body: any; text: string }> {
  const startTime = Date.now();
  const method = (options.method || 'GET').toUpperCase();
  let requestBodyParsed: unknown = undefined;

  if (options.body) {
    try {
      requestBodyParsed = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    } catch {
      requestBodyParsed = String(options.body);
    }
  }

  let res: Response | undefined;
  let responseText = '';
  let responseBody: any = null;
  let fetchError: Error | undefined;

  try {
    res = await fetchFn(url, options);
    responseText = await res.text();
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = responseText;
    }
    return { res, body: responseBody, text: responseText };
  } catch (err: any) {
    fetchError = err;
    throw err;
  } finally {
    const durationMs = Date.now() - startTime;
    logOutboundProviderCall({
      timestamp: new Date().toISOString(),
      provider,
      method,
      url,
      requestHeaders: redactSensitiveHeaders(options.headers),
      requestBody: requestBodyParsed,
      status: res?.status,
      statusText: res?.statusText,
      responseBody: responseBody || (responseText ? responseText : undefined),
      error: fetchError ? fetchError.message : undefined,
      durationMs,
    });
  }
}

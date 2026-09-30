import crypto from 'node:crypto';

export class CryptoUtils {
  public static generateId(prefix?: string): string {
    const uuid = crypto.randomUUID();
    return prefix ? `${prefix}_${uuid.replace(/-/g, '')}` : uuid;
  }

  public static hashRequest(payload: unknown): string {
    const canonical = JSON.stringify(payload ?? {}, Object.keys(payload ?? {}).sort());
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  public static sha256(data: Buffer | string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  public static createHmacSha512(data: Buffer | string, secret: string): string {
    return crypto.createHmac('sha512', secret).update(data).digest('hex');
  }

  public static createHmacSha256(data: Buffer | string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(data).digest('hex');
  }

  public static timingSafeEqual(a: string, b: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  public static verifyHmacSha512(rawBody: Buffer | string, signature: string, secret: string): boolean {
    const expected = this.createHmacSha512(rawBody, secret);
    return this.timingSafeEqual(expected, signature);
  }

  public static verifyHmacSha256(rawBody: Buffer | string, signature: string, secret: string): boolean {
    const expected = this.createHmacSha256(rawBody, secret);
    return this.timingSafeEqual(expected, signature);
  }
}

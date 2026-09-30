import { URL } from 'node:url';
import net from 'node:net';

export class SsrfGuard {
  private static readonly BLOCKED_HOSTS = new Set([
    'localhost',
    'metadata.google.internal',
    'instance-data',
  ]);

  public static isSafeUrl(rawUrl: string): { safe: boolean; reason?: string } {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { safe: false, reason: 'Invalid URL format' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { safe: false, reason: `Unsupported protocol: ${parsed.protocol}` };
    }

    const hostname = parsed.hostname.toLowerCase();

    if (this.BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return { safe: false, reason: `Blocked hostname: ${hostname}` };
    }

    // Check IP addresses
    if (net.isIP(hostname)) {
      if (this.isPrivateOrLoopbackIp(hostname)) {
        return { safe: false, reason: `Private or loopback IP blocked: ${hostname}` };
      }
    }

    return { safe: true };
  }

  public static isPrivateOrLoopbackIp(ip: string): boolean {
    if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return true;

    // IPv4 private ranges
    if (net.isIPv4(ip)) {
      const parts = ip.split('.').map(Number);
      // 127.0.0.0/8
      if (parts[0] === 127) return true;
      // 10.0.0.0/8
      if (parts[0] === 10) return true;
      // 172.16.0.0/12 (172.16.0.0 to 172.31.255.255)
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      // 192.168.0.0/16
      if (parts[0] === 192 && parts[1] === 168) return true;
      // 169.254.0.0/16 (link-local, cloud metadata)
      if (parts[0] === 169 && parts[1] === 254) return true;
    }

    return false;
  }
}

import Ductape from '@ductape/sdk';

export interface DuctapeConfig {
  accessKey?: string;
  workspaceId?: string;
  product?: string;
  env?: string;
  redisUrl?: string;
}

let ductapeInstance: Ductape | null = null;
let redisNoticeLogged = false;

// Ensure Ductape SDK's redis notice is logged only once at process startup, preventing log spam on queries
const originalLog = console.log;
console.log = function (...args: unknown[]) {
  if (typeof args[0] === 'string' && args[0].includes('No Redis URL provided, caching will use internal')) {
    if (redisNoticeLogged) return;
    redisNoticeLogged = true;
  }
  return originalLog.apply(console, args);
};

export function createDuctapeClient(config: DuctapeConfig = {}): Ductape {
  const accessKey =
    config.accessKey ||
    process.env.DUCTAPE_ACCESS_KEY ||
    process.env.DUCTAPE_ACCESSKEY ||
    process.env.ACCESS_KEY ||
    'dt_dev_access_key';
  const workspaceId =
    config.workspaceId ||
    process.env.DUCTAPE_WORKSPACE_ID ||
    process.env.DUCTAPE_WORKSPACE ||
    process.env.WORKSPACE_ID;
  const product = config.product || process.env.DUCTAPE_PRODUCT || 'xavier_space:commerce_backend';
  const env = config.env || process.env.DUCTAPE_ENV || 'snd';
  const redisUrl = config.redisUrl || process.env.REDIS_URL;

  const client = new Ductape({
    accessKey,
    product,
    env,
    redis_url: redisUrl,
  });

  if (!redisUrl) {
    // When no Redis URL is provided, Ductape SDK uses in-memory caching.
    // The SDK's connectCacheRedis() checks `if (this.redisClient || this.redisCacheUnavailable) return;`
    // but omits setting `this.redisCacheUnavailable = true` when `!this.redis_url`.
    // Setting it here ensures subsequent database service accesses return immediately without spamming.
    (client as any).redisCacheUnavailable = true;
  }

  if (workspaceId) {
    client.setWorkspaceId(workspaceId);
  }

  return client;
}

export function getDuctapeClient(config?: DuctapeConfig): Ductape {
  if (!ductapeInstance) {
    ductapeInstance = createDuctapeClient(config);
  }
  return ductapeInstance;
}

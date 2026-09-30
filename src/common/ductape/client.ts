import Ductape from '@ductape/sdk';

export interface DuctapeConfig {
  accessKey?: string;
  workspaceId?: string;
  product?: string;
  env?: string;
  redisUrl?: string;
}

let ductapeInstance: Ductape | null = null;

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

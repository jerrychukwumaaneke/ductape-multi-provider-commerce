import { IDatabaseClient } from '../../common/database/index.js';
import { CryptoUtils } from '../../common/utils/crypto.js';
import { ActorType, AuditLogEntry } from '../../common/types/index.js';

export interface RecordAuditInput {
  actorId: string;
  actorType: ActorType;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

export interface ListAuditOptions {
  entity?: string;
  entityId?: string;
  actorId?: string;
  limit?: number;
  offset?: number;
}

export class AuditService {
  constructor(private readonly db: IDatabaseClient) {}

  public async record(input: RecordAuditInput): Promise<AuditLogEntry> {
    const id = CryptoUtils.generateId('aud');
    const res = await this.db.query<AuditLogEntry>(
      `INSERT INTO audit_log (id, actor_id, actor_type, action, entity, entity_id, before, after, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING id, actor_id, actor_type, action, entity, entity_id, before, after, at`,
      [
        id,
        input.actorId,
        input.actorType,
        input.action,
        input.entity,
        input.entityId,
        input.before ? JSON.stringify(input.before) : null,
        input.after ? JSON.stringify(input.after) : null,
      ]
    );

    return res.rows[0];
  }

  public async listLogs(options: ListAuditOptions = {}): Promise<AuditLogEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (options.entity) {
      conditions.push(`entity = $${idx++}`);
      params.push(options.entity);
    }
    if (options.entityId) {
      conditions.push(`entity_id = $${idx++}`);
      params.push(options.entityId);
    }
    if (options.actorId) {
      conditions.push(`actor_id = $${idx++}`);
      params.push(options.actorId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    params.push(limit, offset);
    const sql = `SELECT id, actor_id, actor_type, action, entity, entity_id, before, after, at 
                 FROM audit_log ${where} 
                 ORDER BY at DESC 
                 LIMIT $${idx++} OFFSET $${idx++}`;

    const res = await this.db.query<AuditLogEntry>(sql, params);
    return res.rows;
  }
}

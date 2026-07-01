import { AppError } from '../../shared/errors.js';
import pool from './postgres.js';

const BROADCAST_INSERT_CHUNK_SIZE = 500;

export const defaultTenant = async () => {
  const { rows } = await pool.query("SELECT id FROM tenants WHERE name = 'default' LIMIT 1");
  return rows[0]?.id || null;
};

export const resolveTenantId = async (userId = null) => {
  if (userId) {
    const res = await pool.query('SELECT tenant_id FROM users WHERE id = $1 LIMIT 1', [userId]);
    if (res.rows[0]?.tenant_id) return res.rows[0].tenant_id;
  }
  return defaultTenant();
};

export const createBroadcastTemplate = async ({ name, type, body, media, metadata, createdBy }) => {
  const tenantId = await resolveTenantId(createdBy);
  const { rows } = await pool.query(
    `INSERT INTO broadcast_templates (name, type, body, media, metadata, created_by, tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [name, type, body, media || {}, metadata || {}, createdBy || null, tenantId]
  );
  return rows[0];
};

export const listBroadcastTemplates = async (tenantId = null) => {
  const resolved = tenantId || (await defaultTenant());
  const { rows } = await pool.query(
    `SELECT * FROM broadcast_templates WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [resolved]
  );
  return rows;
};

export const getBroadcastTemplateById = async (id) => {
  const { rows } = await pool.query('SELECT * FROM broadcast_templates WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
};

export const deleteBroadcastTemplate = async (id, tenantId = null) => {
  const resolved = tenantId || (await defaultTenant());
  const res = await pool.query('DELETE FROM broadcast_templates WHERE id = $1 AND tenant_id = $2', [id, resolved]);
  if (res.rowCount === 0) {
    throw new AppError('Template no encontrado', 404);
  }
};

export const createBroadcastCampaign = async ({
  name,
  messageType,
  templateId,
  delayMinSeconds,
  delayMaxSeconds,
  connections,
  startAt = null,
  stopAt = null,
  createdBy
}) => {
  const tenantId = await resolveTenantId(createdBy);
  const { rows } = await pool.query(
    `INSERT INTO broadcast_campaigns (name, message_type, template_id, delay_min_seconds, delay_max_seconds, connections, start_at, stop_at, created_by, tenant_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
     RETURNING *`,
    [
      name,
      messageType,
      templateId || null,
      delayMinSeconds,
      delayMaxSeconds,
      connections || [],
      startAt || null,
      stopAt || null,
      createdBy || null,
      tenantId
    ]
  );
  return rows[0];
};

export const insertBroadcastMessages = async ({ campaignId, templateId, messageType, messages, tenantId = null }) => {
  if (!Array.isArray(messages) || !messages.length) return;
  const resolvedTenant = tenantId || (await defaultTenant());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let start = 0; start < messages.length; start += BROADCAST_INSERT_CHUNK_SIZE) {
      const chunk = messages.slice(start, start + BROADCAST_INSERT_CHUNK_SIZE);
      const values = [];
      const placeholders = chunk.map((msg, idx) => {
        const base = idx * 8;
        values.push(
          campaignId,
          templateId || null,
          msg.target,
          messageType,
          msg.payload || {},
          msg.maxAttempts || 3,
          msg.nextAttemptAt || new Date(),
          resolvedTenant
        );
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},'pending',$${base + 6},$${base + 7},$${base + 8})`;
      });
      await client.query(
        `INSERT INTO broadcast_messages (campaign_id, template_id, target, message_type, payload, status, max_attempts, next_attempt_at, tenant_id)
         VALUES ${placeholders.join(',')}`,
        values
      );
    }
    await client.query(
      'UPDATE broadcast_campaigns SET total_targets = total_targets + $2, updated_at = NOW() WHERE id = $1',
      [campaignId, messages.length]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const fetchPendingBroadcastBatch = async (limit = 25) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `
      SELECT
        bm.*,
        bc.name AS campaign_name,
        bc.delay_min_seconds,
        bc.delay_max_seconds,
        bc.connections,
        bc.start_at,
        bc.stop_at,
        bc.last_delay_seconds,
        bc.last_connection,
        bc.message_type AS campaign_message_type,
        bc.template_id AS campaign_template_id
      FROM broadcast_messages bm
      INNER JOIN broadcast_campaigns bc ON bc.id = bm.campaign_id
      WHERE (bm.status = 'pending' AND bm.next_attempt_at <= NOW())
         OR (bm.status = 'sending' AND bm.updated_at < NOW() - INTERVAL '2 minutes')
      ORDER BY bm.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    `,
      [limit]
    );
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      await client.query(
        `UPDATE broadcast_messages
         SET status = 'sending',
             attempts = attempts + 1,
             last_attempt_at = NOW(),
             updated_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      const campaignIds = Array.from(new Set(rows.map((r) => r.campaign_id)));
      await client.query(
        `UPDATE broadcast_campaigns SET status = 'running', updated_at = NOW() WHERE id = ANY($1::uuid[])`,
        [campaignIds]
      );
    }
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const updateMessageSent = async ({ messageId, sessionName, delaySeconds }) => {
  await pool.query(
    `UPDATE broadcast_messages
     SET status = 'sent',
         session_name = $2,
         delay_seconds = $3,
         sent_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [messageId, sessionName || null, delaySeconds || null]
  );
};

export const updateMessageError = async ({ messageId, error, retryAt, final }) => {
  const status = final ? 'error' : 'pending';
  const nextAttempt = final ? null : retryAt || new Date(Date.now() + 30_000);
  await pool.query(
    `UPDATE broadcast_messages
     SET status = $2,
         error_reason = $3,
         next_attempt_at = COALESCE($4, next_attempt_at),
         updated_at = NOW()
     WHERE id = $1`,
    [messageId, status, error || null, nextAttempt]
  );
};

export const updateCampaignRuntime = async ({ campaignId, lastDelayMs, lastConnection }) => {
  await pool.query(
    `UPDATE broadcast_campaigns
     SET last_delay_seconds = $2,
         last_connection = $3,
         updated_at = NOW()
     WHERE id = $1`,
    [campaignId, lastDelayMs || null, lastConnection || null]
  );
};

export const lockAndUpdateCampaignRuntime = async (campaignId, updater) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, delay_min_seconds, delay_max_seconds, last_delay_seconds, last_connection, connections
       FROM broadcast_campaigns
       WHERE id = $1
       FOR UPDATE`,
      [campaignId]
    );
    const runtime = rows[0];
    if (!runtime) throw new AppError('Campaña no encontrada', 404);
    const next = (await updater(runtime)) || {};
    await client.query(
      `UPDATE broadcast_campaigns
       SET last_delay_seconds = $2,
           last_connection = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [campaignId, next.lastDelaySeconds || next.lastDelayMs || null, next.lastConnection || null]
    );
    await client.query('COMMIT');
    return { runtime, next };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const bumpCampaignCounters = async (campaignId) => {
  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
      COUNT(*) FILTER (WHERE status = 'error')::int AS failed
    FROM broadcast_messages
    WHERE campaign_id = $1
  `,
    [campaignId]
  );
  const stats = rows[0] || { total: 0, sent: 0, failed: 0 };
  const status =
    stats.total === stats.sent + stats.failed
      ? stats.failed > 0
        ? 'error'
        : 'completed'
      : 'running';
  await pool.query(
    `UPDATE broadcast_campaigns
     SET total_targets = $2,
         sent_count = $3,
         error_count = $4,
         status = $5,
         updated_at = NOW()
     WHERE id = $1`,
    [campaignId, stats.total, stats.sent, stats.failed, status]
  );
  return { ...stats, status };
};

export const listBroadcastCampaigns = async (tenantId = null, limit = 50) => {
  const resolved = tenantId || (await defaultTenant());
  const { rows } = await pool.query(
    `
    SELECT
      bc.*,
      (SELECT COUNT(*) FROM broadcast_messages bm WHERE bm.campaign_id = bc.id AND bm.status = 'sent') AS sent_messages,
      (SELECT COUNT(*) FROM broadcast_messages bm WHERE bm.campaign_id = bc.id AND bm.status = 'error') AS failed_messages
    FROM broadcast_campaigns bc
    WHERE bc.tenant_id = $1
    ORDER BY bc.created_at DESC
    LIMIT $2
  `,
    [resolved, limit]
  );
  return rows;
};

export const getCampaignById = async (id) => {
  const { rows } = await pool.query('SELECT * FROM broadcast_campaigns WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
};

export const listBroadcastMessagesByCampaign = async (campaignId, limit = 200) => {
  const { rows } = await pool.query(
    `SELECT id, target, status, attempts, error_reason, session_name, delay_seconds, message_type, sent_at, updated_at
     FROM broadcast_messages
     WHERE campaign_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [campaignId, limit]
  );
  return rows;
};

export const findActiveConnections = async (sessionNames = []) => {
  if (!sessionNames || !sessionNames.length) return [];
  const { rows } = await pool.query(
    `SELECT session_name, status, last_connected_at, updated_at
     FROM whatsapp_sessions
     WHERE session_name = ANY($1::text[])
       AND deleted_at IS NULL`,
    [sessionNames]
  );
  const now = Date.now();
  return rows.map((r) => {
    const normalized = (r.status || '').toLowerCase();
    const fresh = r.last_connected_at && new Date(r.last_connected_at).getTime() > now - 60 * 60 * 1000;
    const effectiveStatus = normalized === 'connected' || fresh ? 'connected' : normalized || 'unknown';
    return { ...r, status: effectiveStatus };
  });
};

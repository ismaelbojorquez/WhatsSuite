import pool from './postgres.js';

const mapRestriction = (row) => ({
  id: row.id,
  tenantId: row.tenant_id,
  sessionName: row.whatsapp_session_name,
  remoteNumber: row.remote_number,
  remoteJid: row.remote_jid || null,
  reason: row.reason,
  statusCode: row.status_code || null,
  statusError: row.status_error || null,
  messageId: row.message_id || null,
  blockedUntil: row.blocked_until,
  lastErrorAt: row.last_error_at,
  clearedAt: row.cleared_at || null,
  metadata: row.metadata || {},
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const normalizeRemoteNumber = (value) => String(value || '').replace(/[^\d]/g, '');

export const findActiveReachoutRestriction = async ({ tenantId = null, sessionName, remoteNumber }) => {
  const normalizedRemote = normalizeRemoteNumber(remoteNumber);
  if (!sessionName || !normalizedRemote) return null;

  const params = [sessionName, normalizedRemote];
  let tenantClause = '';
  if (tenantId) {
    params.push(tenantId);
    tenantClause = `AND tenant_id = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT *
     FROM whatsapp_reachout_restrictions
     WHERE whatsapp_session_name = $1
       AND remote_number = $2
       ${tenantClause}
       AND cleared_at IS NULL
       AND blocked_until > NOW()
     ORDER BY blocked_until DESC
     LIMIT 1`,
    params
  );
  return rows[0] ? mapRestriction(rows[0]) : null;
};

export const upsertReachoutRestriction = async ({
  tenantId = null,
  sessionName,
  remoteNumber,
  remoteJid = null,
  reason = 'reachout_timelock',
  statusCode = null,
  statusError = null,
  messageId = null,
  blockedUntil,
  metadata = {}
}) => {
  const normalizedRemote = normalizeRemoteNumber(remoteNumber);
  if (!tenantId || !sessionName || !normalizedRemote || !blockedUntil) return null;

  const { rows } = await pool.query(
    `INSERT INTO whatsapp_reachout_restrictions (
       tenant_id,
       whatsapp_session_name,
       remote_number,
       remote_jid,
       reason,
       status_code,
       status_error,
       message_id,
       blocked_until,
       last_error_at,
       metadata,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10::jsonb, NOW())
     ON CONFLICT (tenant_id, whatsapp_session_name, remote_number)
       WHERE cleared_at IS NULL
     DO UPDATE SET
       remote_jid = COALESCE(EXCLUDED.remote_jid, whatsapp_reachout_restrictions.remote_jid),
       reason = EXCLUDED.reason,
       status_code = EXCLUDED.status_code,
       status_error = EXCLUDED.status_error,
       message_id = EXCLUDED.message_id,
       blocked_until = GREATEST(whatsapp_reachout_restrictions.blocked_until, EXCLUDED.blocked_until),
       last_error_at = NOW(),
       metadata = whatsapp_reachout_restrictions.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [
      tenantId,
      sessionName,
      normalizedRemote,
      remoteJid,
      reason,
      statusCode === null || statusCode === undefined ? null : String(statusCode),
      statusError === null || statusError === undefined ? null : String(statusError),
      messageId,
      blockedUntil,
      JSON.stringify(metadata || {})
    ]
  );
  return rows[0] ? mapRestriction(rows[0]) : null;
};

export const clearReachoutRestriction = async ({ tenantId = null, sessionName, remoteNumber, reason = 'inbound_message' }) => {
  const normalizedRemote = normalizeRemoteNumber(remoteNumber);
  if (!sessionName || !normalizedRemote) return 0;

  const params = [sessionName, normalizedRemote, reason];
  let tenantClause = '';
  if (tenantId) {
    params.push(tenantId);
    tenantClause = `AND tenant_id = $${params.length}`;
  }

  const { rowCount } = await pool.query(
    `UPDATE whatsapp_reachout_restrictions
     SET cleared_at = NOW(),
         metadata = metadata || jsonb_build_object('clearedReason', $3),
         updated_at = NOW()
     WHERE whatsapp_session_name = $1
       AND remote_number = $2
       ${tenantClause}
       AND cleared_at IS NULL`,
    params
  );
  return rowCount;
};

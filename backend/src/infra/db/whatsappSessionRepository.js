import pool from './postgres.js';

let cachedDefaultTenantId = null;

const mapSessionRow = (row) => ({
  id: row.id || null,
  sessionName: row.session_name,
  tenantId: row.tenant_id,
  status: row.status || null,
  syncHistory: Boolean(row.sync_history),
  historySyncStatus: row.history_sync_status || 'idle',
  historySyncCursor: row.history_sync_cursor || {},
  historySyncProgress: row.history_sync_progress || {},
  historySyncedAt: row.history_synced_at || null,
  lastConnectedAt: row.last_connected_at || null,
  connectionId: row.connection_id || row.session_name || null,
  lastSyncedAt: row.last_synced_at || null,
  lastMessageId: row.last_message_id || null,
  lastDisconnectAt: row.last_disconnect_at || null,
  syncState: row.sync_state || 'IDLE',
  syncError: row.sync_error || null,
  lastConnectAt: row.last_connect_at || null,
  deletedAt: row.deleted_at || null,
  isDeleted: Boolean(row.deleted_at)
});

export const getDefaultTenantId = async () => {
  if (cachedDefaultTenantId) return cachedDefaultTenantId;
  const res = await pool.query("SELECT id FROM tenants WHERE name = 'default' LIMIT 1");
  cachedDefaultTenantId = res.rows[0]?.id || null;
  return cachedDefaultTenantId;
};

export const getTenantIdForSession = async (sessionName, fallbackTenantId = null) => {
  if (sessionName) {
    const { rows } = await pool.query('SELECT tenant_id FROM whatsapp_sessions WHERE session_name = $1 LIMIT 1', [sessionName]);
    if (rows[0]?.tenant_id) return rows[0].tenant_id;
  }
  if (fallbackTenantId) return fallbackTenantId;
  return getDefaultTenantId();
};

export const findSessionByName = async ({ sessionName, tenantId = null, includeDeleted = false }) => {
  const params = [sessionName];
  let where = 'session_name = $1';
  if (tenantId) {
    params.push(tenantId);
    where += ` AND tenant_id = $${params.length}`;
  }
  if (!includeDeleted) {
    where += ' AND deleted_at IS NULL';
  }
  const { rows } = await pool.query(
    `SELECT id, session_name, tenant_id, status, sync_history, history_sync_status, history_sync_cursor, history_sync_progress, history_synced_at, last_connected_at, connection_id, last_synced_at, last_message_id, last_disconnect_at, sync_state, sync_error, last_connect_at, deleted_at
     FROM whatsapp_sessions
     WHERE ${where}
     LIMIT 1`,
    params
  );
  if (!rows[0]) {
    const resolvedTenant = await getTenantIdForSession(sessionName, tenantId);
    return {
      id: null,
      sessionName,
      tenantId: resolvedTenant,
      status: 'unknown',
      syncHistory: true,
      historySyncStatus: 'idle',
      historySyncCursor: {},
      historySyncProgress: {},
      historySyncedAt: null,
      lastConnectedAt: null,
      connectionId: sessionName,
      lastSyncedAt: null,
      lastMessageId: null,
      lastDisconnectAt: null,
      syncState: 'IDLE',
      syncError: null,
      lastConnectAt: null,
      deletedAt: null,
      isDeleted: false
    };
  }
  return mapSessionRow(rows[0]);
};

export const prepareSessionForCreate = async ({ sessionName, tenantId = null }) => {
  const resolvedTenant = await getTenantIdForSession(sessionName, tenantId);
  const current = await findSessionByName({ sessionName, tenantId: resolvedTenant, includeDeleted: true });
  if (!current.id || !current.isDeleted) {
    return { ...current, wasDeleted: false };
  }

  const { rows } = await pool.query(
    `UPDATE whatsapp_sessions
     SET name = $1,
         tenant_id = COALESCE(tenant_id, $2),
         status = 'pending',
         creds = '{}'::jsonb,
         keys = '{}'::jsonb,
         connection_id = NULL,
         is_valid = FALSE,
         last_connected_at = NULL,
         sync_state = 'IDLE',
         sync_error = NULL,
         deleted_at = NULL,
         updated_at = NOW()
     WHERE id = $3
     RETURNING id, session_name, tenant_id, status, sync_history, history_sync_status, history_sync_cursor, history_sync_progress, history_synced_at, last_connected_at, connection_id, last_synced_at, last_message_id, last_disconnect_at, sync_state, sync_error, last_connect_at, deleted_at`,
    [sessionName, resolvedTenant, current.id]
  );
  return {
    ...mapSessionRow(rows[0]),
    wasDeleted: true
  };
};

export const softDeleteSessionByName = async ({ sessionName, tenantId = null }) => {
  const resolvedTenant = await getTenantIdForSession(sessionName, tenantId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `WITH target AS (
         SELECT id, session_name, tenant_id, connection_id
         FROM whatsapp_sessions
         WHERE (session_name = $1 OR name = $1)
           AND ($2::uuid IS NULL OR tenant_id = $2)
         FOR UPDATE
       ),
       updated AS (
         UPDATE whatsapp_sessions ws
         SET status = 'disconnected',
             creds = '{}'::jsonb,
             keys = '{}'::jsonb,
             connection_id = NULL,
             is_valid = FALSE,
             last_connected_at = NULL,
             last_disconnect_at = NOW(),
             sync_state = 'DISCONNECTED',
             sync_error = 'soft_deleted',
             deleted_at = NOW(),
             updated_at = NOW()
         FROM target
         WHERE ws.id = target.id
         RETURNING ws.id, ws.session_name, ws.tenant_id, target.connection_id AS old_connection_id
       )
       SELECT id, session_name, tenant_id, old_connection_id
       FROM updated`,
      [sessionName, resolvedTenant]
    );

    const sessionNames = rows.map((row) => row.session_name).filter(Boolean);
    const sessionIds = rows.map((row) => row.id).filter(Boolean);
    const oldConnectionIds = rows.map((row) => row.old_connection_id).filter(Boolean);

    if (sessionNames.length) {
      await client.query('DELETE FROM queue_connections WHERE whatsapp_session_name = ANY($1::text[])', [sessionNames]);
    }
    if (sessionIds.length) {
      await client.query('DELETE FROM whatsapp_auth_state WHERE session_id = ANY($1::uuid[])', [sessionIds]).catch(() => {});
    }
    if (oldConnectionIds.length) {
      await client.query('DELETE FROM whatsapp_connections WHERE id = ANY($1::uuid[])', [oldConnectionIds]);
    }

    await client.query('COMMIT');
    return rows[0]
      ? {
          id: rows[0].id,
          sessionName: rows[0].session_name,
          tenantId: rows[0].tenant_id,
          oldConnectionId: rows[0].old_connection_id || null,
          count: rows.length
        }
      : null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

export const upsertSessionSyncHistory = async ({ sessionName, tenantId = null, syncHistory = true }) => {
  const resolvedTenant = await getTenantIdForSession(sessionName, tenantId);
  await pool.query(
    `INSERT INTO whatsapp_sessions (session_name, name, connection_id, tenant_id, status, sync_history, creds, keys, updated_at)
     VALUES (
       $1,
       $2,
       COALESCE((SELECT connection_id FROM whatsapp_sessions WHERE session_name = $1), NULL),
       $3,
       'DISCONNECTED',
       $4,
       COALESCE((SELECT creds FROM whatsapp_sessions WHERE session_name = $1), '{}'::jsonb),
       COALESCE((SELECT keys FROM whatsapp_sessions WHERE session_name = $1), '{}'::jsonb),
       NOW()
     )
     ON CONFLICT (session_name) DO UPDATE
       SET sync_history = EXCLUDED.sync_history,
           tenant_id = COALESCE(whatsapp_sessions.tenant_id, EXCLUDED.tenant_id),
           updated_at = NOW(),
           connection_id = COALESCE(whatsapp_sessions.connection_id, EXCLUDED.connection_id)`,
    [sessionName, sessionName, resolvedTenant, syncHistory]
  );
  return findSessionByName({ sessionName, tenantId: resolvedTenant });
};

export const updateHistorySyncState = async ({ sessionName, tenantId = null, status = null, progress = null, cursor = null, syncedAt = null }) => {
  const resolvedTenant = await getTenantIdForSession(sessionName, tenantId);
  const { rows } = await pool.query(
    `UPDATE whatsapp_sessions
     SET history_sync_status = COALESCE($3, history_sync_status),
         history_sync_progress = CASE WHEN $4::jsonb IS NULL THEN history_sync_progress ELSE $4::jsonb END,
         history_sync_cursor = CASE WHEN $5::jsonb IS NULL THEN history_sync_cursor ELSE $5::jsonb END,
         history_synced_at = COALESCE($6, history_synced_at),
         updated_at = NOW()
     WHERE session_name = $1 AND tenant_id = $2
     RETURNING id, session_name, tenant_id, status, sync_history, history_sync_status, history_sync_cursor, history_sync_progress, history_synced_at, last_connected_at, connection_id`,
    [sessionName, resolvedTenant, status, progress, cursor, syncedAt]
  );
  if (rows[0]) return mapSessionRow(rows[0]);

  await pool.query(
    `INSERT INTO whatsapp_sessions (session_name, name, connection_id, tenant_id, status, sync_history, history_sync_status, history_sync_progress, history_sync_cursor, history_synced_at, creds, keys, updated_at)
     VALUES (
       $1,
       $2,
       COALESCE((SELECT connection_id FROM whatsapp_sessions WHERE session_name = $1), NULL),
       $3,
       'DISCONNECTED',
       FALSE,
       COALESCE($4, 'idle'),
       COALESCE($5, '{}'::jsonb),
       COALESCE($6, '{}'::jsonb),
       $7,
       COALESCE((SELECT creds FROM whatsapp_sessions WHERE session_name = $1), '{}'::jsonb),
       COALESCE((SELECT keys FROM whatsapp_sessions WHERE session_name = $1), '{}'::jsonb),
       NOW()
     )
     ON CONFLICT (session_name) DO NOTHING`,
    [sessionName, sessionName, resolvedTenant, status, progress, cursor, syncedAt]
  );
  return findSessionByName({ sessionName, tenantId: resolvedTenant });
};

export const updateSessionSyncTracking = async ({
  sessionName,
  tenantId = null,
  lastSyncedAt = null,
  lastMessageId = null,
  lastDisconnectAt = null,
  lastConnectAt = null,
  syncState = null,
  syncError = null
}) => {
  const resolvedTenant = await getTenantIdForSession(sessionName, tenantId);
  const fields = [];
  const params = [sessionName, resolvedTenant];
  if (lastSyncedAt) {
    params.push(lastSyncedAt);
    fields.push(`last_synced_at = $${params.length}`);
  }
  if (lastMessageId) {
    params.push(lastMessageId);
    fields.push(`last_message_id = $${params.length}`);
  }
  if (lastDisconnectAt) {
    params.push(lastDisconnectAt);
    fields.push(`last_disconnect_at = $${params.length}`);
  }
  if (lastConnectAt) {
    params.push(lastConnectAt);
    fields.push(`last_connect_at = $${params.length}`);
  }
  if (syncState) {
    params.push(syncState);
    fields.push(`sync_state = $${params.length}`);
  }
  if (syncError !== undefined) {
    params.push(syncError);
    fields.push(`sync_error = $${params.length}`);
  }
  if (!fields.length) return findSessionByName({ sessionName, tenantId: resolvedTenant });

  const sql = `
    UPDATE whatsapp_sessions
    SET ${fields.join(', ')},
        updated_at = NOW()
    WHERE session_name = $1 AND tenant_id = $2
    RETURNING *
  `;
  const { rows } = await pool.query(sql, params);
  if (rows[0]) return mapSessionRow(rows[0]);
  return findSessionByName({ sessionName, tenantId: resolvedTenant });
};

export const listWhatsappSessions = async () => {
  const { rows } = await pool.query(
    `SELECT session_name, tenant_id, status, last_connected_at, sync_history, updated_at
     FROM whatsapp_sessions
     WHERE deleted_at IS NULL
     ORDER BY session_name ASC`
  );
  return rows.map((r) => ({
    sessionName: r.session_name,
    tenantId: r.tenant_id,
    status: r.status,
    lastConnectedAt: r.last_connected_at,
    syncHistory: r.sync_history,
    updatedAt: r.updated_at
  }));
};

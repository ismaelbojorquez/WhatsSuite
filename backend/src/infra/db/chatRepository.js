import pool from './postgres.js';
import { AppError } from '../../shared/errors.js';
import { cacheChat, getCachedChat, invalidateChat, cacheAssignment, invalidateAssignment } from '../cache/chatCache.js';

let chatSchemaEnsured = false;
const ensureChatSchema = async () => {
  if (chatSchemaEnsured) return;
  await pool.query(`
    ALTER TABLE IF EXISTS chats
      ADD COLUMN IF NOT EXISTS assigned_agent_id UUID NULL,
      ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP NULL,
      ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP NULL,
      ADD COLUMN IF NOT EXISTS remote_jid TEXT NULL,
      ADD COLUMN IF NOT EXISTS reassigned_from_agent_id UUID NULL,
      ADD COLUMN IF NOT EXISTS reassigned_at TIMESTAMP NULL,
      ADD COLUMN IF NOT EXISTS reassigned_by_user_id UUID NULL,
      ADD COLUMN IF NOT EXISTS contact_name TEXT,
      ADD COLUMN IF NOT EXISTS push_name TEXT,
      ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS is_muted BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS inactivity_warning_sent_at TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS inactivity_warning_delivered_at TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS inactivity_warning_for_ts TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS remote_avatar_url TEXT;
  `);
  chatSchemaEnsured = true;
};

const executorFor = (client) => client || pool;

export const resolveTenantId = async (userId) => {
  if (userId) {
    const res = await pool.query('SELECT tenant_id FROM users WHERE id = $1 LIMIT 1', [userId]);
    if (res.rows[0]?.tenant_id) return res.rows[0].tenant_id;
  }
  const def = await pool.query("SELECT id FROM tenants WHERE name = 'default' LIMIT 1");
  return def.rows[0]?.id || null;
};

const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    if (!parsed?.t || !parsed?.id) return null;
    const ts = new Date(parsed.t);
    if (Number.isNaN(ts.getTime())) return null;
    return { ts, id: parsed.id };
  } catch {
    return null;
  }
};

const encodeCursor = (row) => {
  const sortAt = row?.sort_at || row?.updated_at || row?.created_at || new Date();
  const payload = { t: new Date(sortAt).toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
};

const mapChat = (row) => ({
  id: row.id,
  whatsappSessionName: row.whatsapp_session_name,
  whatsappStatus:
    typeof (row.whatsapp_status || row.connection_status) === 'string'
      ? (row.whatsapp_status || row.connection_status).toLowerCase()
      : row.whatsapp_status || row.connection_status || null,
  connectionStatus:
    typeof (row.whatsapp_status || row.connection_status) === 'string'
      ? (row.whatsapp_status || row.connection_status).toLowerCase()
      : row.whatsapp_status || row.connection_status || null,
  remoteNumber: row.remote_number,
  remoteJid: row.remote_jid,
  contactAvatar: row.remote_avatar_url,
  remoteAvatar: row.remote_avatar_url,
  remoteProfilePic: row.remote_avatar_url,
  profilePic: row.remote_avatar_url,
  queueId: row.queue_id,
  queueName: row.queue_name,
  tenantId: row.tenant_id,
  assignedAgentId: row.assigned_agent_id || row.assigned_user_id || null,
  assignedUserId: row.assigned_user_id || row.assigned_agent_id || null,
  assignedUserName: row.assigned_user_name || row.assigned_user_email || null,
  status: row.status ? row.status.toUpperCase() : row.status,
  assignedAt: row.assigned_at,
  closedAt: row.closed_at,
  reassignedFromAgentId: row.reassigned_from_agent_id,
  reassignedAt: row.reassigned_at,
  reassignedByUserId: row.reassigned_by_user_id,
  lastMessageAt: row.last_message_at,
  inactivityWarningSentAt: row.inactivity_warning_sent_at,
  inactivityWarningDeliveredAt: row.inactivity_warning_delivered_at,
  inactivityWarningForTs: row.inactivity_warning_for_ts,
  contactName: row.contact_name,
  pushName: row.push_name,
  contactAvatar: row.remote_avatar_url,
  isArchived: row.is_archived,
  isMuted: row.is_muted,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapLoad = (row) => ({
  agentId: row.assigned_agent_id,
  openChats: Number(row.count)
});

export const getChatById = async (id, { useCache = true } = {}) => {
  await ensureChatSchema();
  if (useCache) {
    const cached = await getCachedChat(id);
    if (cached) return cached;
  }
  const { rows } = await pool.query(
    `SELECT c.*, ws.status AS whatsapp_status
     FROM chats c
     LEFT JOIN whatsapp_sessions ws ON ws.session_name = c.whatsapp_session_name
     WHERE c.id = $1
     LIMIT 1`,
    [id]
  );
  const chat = rows[0] ? mapChat(rows[0]) : null;
  if (chat) await cacheChat(chat);
  return chat;
};

export const getChatBySessionAndRemote = async (sessionName, remoteNumber) => {
  await ensureChatSchema();
  const { rows } = await pool.query(
    `SELECT c.*, ws.status AS whatsapp_status
     FROM chats c
     LEFT JOIN whatsapp_sessions ws ON ws.session_name = c.whatsapp_session_name
     WHERE c.whatsapp_session_name = $1 AND c.remote_number = $2
     LIMIT 1`,
    [sessionName, remoteNumber]
  );
  const chat = rows[0] ? mapChat(rows[0]) : null;
  if (chat) await cacheChat(chat);
  return chat;
};

export const findOpenChatBySession = async ({
  tenantId,
  sessionName,
  remoteNumber = null,
  client = null,
  forUpdate = false
}) => {
  await ensureChatSchema();
  const exec = executorFor(client);
  const params = [tenantId, sessionName];
  const lock = forUpdate ? ' FOR UPDATE OF c' : '';
  let where = `
    c.tenant_id = $1
    AND c.whatsapp_session_name = $2
    AND c.status = 'OPEN'
  `;
  if (remoteNumber) {
    params.push(remoteNumber);
    where += ` AND c.remote_number = $${params.length}`;
  }
  const { rows } = await exec.query(
    `SELECT c.*, ws.status AS whatsapp_status
     FROM chats c
     LEFT JOIN whatsapp_sessions ws ON ws.session_name = c.whatsapp_session_name
     WHERE ${where}
     ORDER BY c.updated_at DESC
     LIMIT 1${lock}`,
    params
  );
  return rows[0] ? mapChat(rows[0]) : null;
};

export const findLatestClosedChatBySession = async ({
  tenantId,
  sessionName,
  remoteNumber = null,
  client = null,
  forUpdate = false
}) => {
  await ensureChatSchema();
  const exec = executorFor(client);
  const params = [tenantId, sessionName];
  const lock = forUpdate ? ' FOR UPDATE OF c' : '';
  let where = `
    c.tenant_id = $1
    AND c.whatsapp_session_name = $2
    AND c.status = 'CLOSED'
  `;
  if (remoteNumber) {
    params.push(remoteNumber);
    where += ` AND c.remote_number = $${params.length}`;
  }
  const { rows } = await exec.query(
    `SELECT c.*, ws.status AS whatsapp_status
     FROM chats c
     LEFT JOIN whatsapp_sessions ws ON ws.session_name = c.whatsapp_session_name
     WHERE ${where}
     ORDER BY c.updated_at DESC, c.created_at DESC
     LIMIT 1${lock}`,
    params
  );
  return rows[0] ? mapChat(rows[0]) : null;
};

export const createChatForConnection = async ({
  client = null,
  tenantId,
  sessionName,
  remoteNumber,
  remoteJid,
  status = 'OPEN',
  queueId = null
}) => {
  await ensureChatSchema();
  const exec = executorFor(client);
  const { rows } = await exec.query(
    `INSERT INTO chats (tenant_id, whatsapp_session_name, remote_number, remote_jid, status, queue_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [tenantId, sessionName, remoteNumber, remoteJid || `${remoteNumber}@s.whatsapp.net`, status, queueId]
  );
  const chat = rows[0] ? mapChat(rows[0]) : null;
  if (chat && !client) {
    await cacheChat(chat);
    await invalidateAssignment(chat.id);
  }
  return chat;
};

export const reopenChatRecord = async ({ client = null, chatId, remoteNumber = null, remoteJid = null, queueId = null }) => {
  await ensureChatSchema();
  const exec = executorFor(client);
  const params = [chatId];
  let setExtra = '';
  if (remoteNumber) {
    params.push(remoteNumber);
    setExtra += `, remote_number = $${params.length}`;
  }
  if (remoteJid) {
    params.push(remoteJid);
    setExtra += `, remote_jid = $${params.length}`;
  }
  if (queueId) {
    params.push(queueId);
    setExtra += `, queue_id = $${params.length}`;
  }
  const { rows } = await exec.query(
    `UPDATE chats
     SET status = 'OPEN',
         closed_at = NULL,
         updated_at = NOW()
         ${setExtra}
     WHERE id = $1
     RETURNING *`,
    params
  );
  const chat = rows[0] ? mapChat(rows[0]) : null;
  if (chat && !client) {
    await cacheChat(chat);
    await invalidateAssignment(chat.id);
  }
  return chat;
};

export const createChatRecord = async ({
  sessionName,
  remoteNumber,
  remoteJid = null,
  queueId = null,
  status = 'UNASSIGNED',
  lastMessageAt = null,
  tenantId = null,
  contactName = null,
  pushName = null,
  contactAvatar = null,
  isArchived = false,
  isMuted = false
}) => {
  await ensureChatSchema();
  let resolvedTenantId = tenantId;
  if (!resolvedTenantId) {
    const tenantRes = await pool.query("SELECT id FROM tenants WHERE name = 'default' LIMIT 1");
    resolvedTenantId = tenantRes.rows[0]?.id || null;
  }
  const { rows } = await pool.query(
    `INSERT INTO chats (whatsapp_session_name, remote_number, remote_jid, queue_id, status, last_message_at, tenant_id, contact_name, push_name, is_archived, is_muted, remote_avatar_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (whatsapp_session_name, remote_number) DO UPDATE
       SET queue_id = COALESCE(EXCLUDED.queue_id, chats.queue_id),
           status = EXCLUDED.status,
           remote_jid = COALESCE(EXCLUDED.remote_jid, chats.remote_jid),
           last_message_at = EXCLUDED.last_message_at,
           contact_name = COALESCE(EXCLUDED.contact_name, chats.contact_name),
           push_name = COALESCE(EXCLUDED.push_name, chats.push_name),
           remote_avatar_url = COALESCE(EXCLUDED.remote_avatar_url, chats.remote_avatar_url),
           is_archived = EXCLUDED.is_archived,
           is_muted = EXCLUDED.is_muted,
           updated_at = NOW()
       RETURNING *`,
    [
      sessionName,
      remoteNumber,
      remoteJid || `${remoteNumber}@s.whatsapp.net`,
      queueId,
      status,
      lastMessageAt,
      resolvedTenantId,
      contactName,
      pushName,
      isArchived,
      isMuted,
      contactAvatar
    ]
  );
  const chat = rows[0] ? mapChat(rows[0]) : null;
  if (chat) {
    await cacheChat(chat);
    await invalidateAssignment(chat.id);
  }
  return chat;
};

export const touchChatOnInbound = async ({
  chatId,
  status,
  lastMessageAt,
  contactName = null,
  pushName = null,
  contactAvatar = null,
  isArchived = null,
  isMuted = null
}) => {
  await ensureChatSchema();
  const params = [status, lastMessageAt, chatId];
  let setExtra = '';
  if (contactName) {
    params.push(contactName);
    setExtra += `, contact_name = $${params.length}`;
  }
  if (pushName) {
    params.push(pushName);
    setExtra += `, push_name = $${params.length}`;
  }
  if (contactAvatar) {
    params.push(contactAvatar);
    setExtra += `, remote_avatar_url = COALESCE($${params.length}, remote_avatar_url)`;
  }
  if (typeof isArchived === 'boolean') {
    params.push(isArchived);
    setExtra += `, is_archived = $${params.length}`;
  }
  if (typeof isMuted === 'boolean') {
    params.push(isMuted);
    setExtra += `, is_muted = $${params.length}`;
  }
  const { rows } = await pool.query(
    `UPDATE chats
     SET status = $1::varchar,
         assigned_agent_id = CASE WHEN $1::varchar = 'UNASSIGNED' THEN NULL ELSE assigned_agent_id END,
         assigned_user_id = CASE WHEN $1::varchar = 'UNASSIGNED' THEN NULL ELSE assigned_user_id END,
         assigned_at = CASE WHEN $1::varchar = 'UNASSIGNED' THEN NULL ELSE assigned_at END,
         closed_at = CASE WHEN $1::varchar = 'CLOSED' THEN closed_at ELSE NULL END,
         last_message_at = $2,
         updated_at = NOW()
         ${setExtra}
     WHERE id = $3
     RETURNING *`,
    params
  );
  const chat = rows[0] ? mapChat(rows[0]) : null;
  if (chat) {
    await cacheChat(chat);
    await invalidateAssignment(chat.id);
  }
  return chat;
};

export const lockChat = async (client, id) => {
  const { rows } = await client.query('SELECT * FROM chats WHERE id = $1 FOR UPDATE', [id]);
  return rows[0] ? mapChat(rows[0]) : null;
};

export const assignChatDb = async (chatId, userId, { actorUserId = null } = {}, client = null) => {
  await ensureChatSchema();
  const exec = executorFor(client);
  const { rows } = await exec.query(
    `UPDATE chats
     SET assigned_agent_id = $1,
         assigned_user_id = $1,
         status = 'OPEN',
         assigned_at = NOW(),
         reassigned_from_agent_id = CASE WHEN assigned_agent_id IS NOT NULL AND assigned_agent_id <> $1 THEN assigned_agent_id ELSE reassigned_from_agent_id END,
         reassigned_at = CASE WHEN assigned_agent_id IS NOT NULL AND assigned_agent_id <> $1 THEN NOW() ELSE reassigned_at END,
         reassigned_by_user_id = CASE WHEN assigned_agent_id IS NOT NULL AND assigned_agent_id <> $1 THEN $3 ELSE reassigned_by_user_id END,
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [userId, chatId, actorUserId]
  );
  if (!rows[0]) throw new AppError('Chat no encontrado', 404);
  const chat = mapChat(rows[0]);
  if (!client) {
    await cacheChat(chat);
    await cacheAssignment(chatId, { assignedAgentId: chat.assignedAgentId, assignedAt: chat.assignedAt });
  }
  return chat;
};

export const setChatQueue = async (chatId, queueId) => {
  await ensureChatSchema();
  const { rows } = await pool.query(
    `UPDATE chats
     SET queue_id = $1,
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [queueId, chatId]
  );
  if (!rows[0]) throw new AppError('Chat no encontrado', 404);
  const chat = mapChat(rows[0]);
  await cacheChat(chat);
  await invalidateAssignment(chatId);
  return chat;
};

export const setQueueForSessionMissingQueue = async (sessionName, queueId) => {
  await ensureChatSchema();
  const { rows } = await pool.query(
    `UPDATE chats
     SET queue_id = $2,
         updated_at = NOW()
     WHERE whatsapp_session_name = $1
       AND (queue_id IS NULL OR queue_id NOT IN (SELECT id FROM queues))
     RETURNING *`,
    [sessionName, queueId]
  );
  const updated = rows.map(mapChat);
  for (const chat of updated) {
    await cacheChat(chat);
    await invalidateAssignment(chat.id);
  }
  return updated.length;
};

export const listChatsForInactivityWarning = async (warnAfterMinutes) => {
  await ensureChatSchema();
  const minutes = Math.max(0, Number(warnAfterMinutes) || 0);
  if (minutes <= 0) return [];
  const { rows } = await pool.query(
    `
    SELECT *
    FROM chats
    WHERE status = 'OPEN'
      AND assigned_agent_id IS NOT NULL
      AND COALESCE(last_message_at, created_at) <= NOW() - ($1::int * INTERVAL '1 minute')
      AND (inactivity_warning_for_ts IS NULL OR inactivity_warning_for_ts < COALESCE(last_message_at, created_at))
    LIMIT 500
  `,
    [minutes]
  );
  return rows.map(mapChat);
};

export const markChatInactivityWarning = async (chatId, { delivered = false, referenceAt = null } = {}) => {
  await ensureChatSchema();
  const { rows } = await pool.query(
    `UPDATE chats
     SET inactivity_warning_sent_at = NOW(),
         inactivity_warning_for_ts = COALESCE($3, inactivity_warning_for_ts, last_message_at, created_at),
         inactivity_warning_delivered_at = CASE WHEN $2 THEN NOW() ELSE inactivity_warning_delivered_at END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [chatId, delivered, referenceAt]
  );
  return rows[0] ? mapChat(rows[0]) : null;
};

export const listPendingInactivityWarningsForUser = async ({ userId, warnAfterMinutes }) => {
  await ensureChatSchema();
  if (!userId) return [];
  const minutes = Math.max(0, Number(warnAfterMinutes) || 0);
  if (minutes <= 0) return [];
  const { rows } = await pool.query(
    `
    SELECT *
    FROM chats
    WHERE status = 'OPEN'
      AND assigned_agent_id = $1
      AND COALESCE(last_message_at, created_at) <= NOW() - ($2::int * INTERVAL '1 minute')
      AND inactivity_warning_sent_at IS NOT NULL
      AND inactivity_warning_for_ts IS NOT NULL
      AND inactivity_warning_for_ts >= COALESCE(last_message_at, created_at)
      AND (inactivity_warning_delivered_at IS NULL OR inactivity_warning_delivered_at < inactivity_warning_sent_at)
    LIMIT 200
  `,
    [userId, minutes]
  );
  return rows.map(mapChat);
};

export const listChatsForAutoClose = async (autoCloseMinutes) => {
  await ensureChatSchema();
  const minutes = Math.max(0, Number(autoCloseMinutes) || 0);
  if (minutes <= 0) return [];
  const { rows } = await pool.query(
    `
    SELECT *
    FROM chats
    WHERE status = 'OPEN'
      AND COALESCE(last_message_at, created_at) <= NOW() - ($1::int * INTERVAL '1 minute')
    LIMIT 200
  `,
    [minutes]
  );
  return rows.map(mapChat);
};

export const closeChatForInactivityDb = async (chatId) => {
  await ensureChatSchema();
  const { rows } = await pool.query(
    `UPDATE chats
     SET status = 'CLOSED',
         closed_at = NOW(),
         assigned_agent_id = NULL,
         assigned_user_id = NULL,
         assigned_at = NULL,
         inactivity_warning_sent_at = NULL,
         inactivity_warning_delivered_at = NULL,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [chatId]
  );
  if (!rows[0]) return null;
  const chat = mapChat(rows[0]);
  await cacheChat(chat);
  await cacheAssignment(chatId, { assignedAgentId: null, assignedAt: null });
  return chat;
};

export const reassignChatWithConnectionDb = async ({ chatId, newAgentId, newSessionName, actorUserId = null }) => {
  await ensureChatSchema();
  const { rows } = await pool.query(
    `UPDATE chats
     SET whatsapp_session_name = $1,
         assigned_agent_id = $2,
         assigned_user_id = $2,
         status = 'OPEN',
         assigned_at = NOW(),
         reassigned_from_agent_id = CASE WHEN assigned_agent_id IS NOT NULL AND assigned_agent_id <> $2 THEN assigned_agent_id ELSE reassigned_from_agent_id END,
         reassigned_at = CASE WHEN assigned_agent_id IS NOT NULL AND assigned_agent_id <> $2 THEN NOW() ELSE reassigned_at END,
         reassigned_by_user_id = CASE WHEN assigned_agent_id IS NOT NULL AND assigned_agent_id <> $2 THEN $4 ELSE reassigned_by_user_id END,
         updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [newSessionName, newAgentId, chatId, actorUserId]
  );
  if (!rows[0]) throw new AppError('Chat no encontrado', 404);
  const chat = mapChat(rows[0]);
  await cacheChat(chat);
  await cacheAssignment(chatId, { assignedAgentId: chat.assignedAgentId, assignedAt: chat.assignedAt });
  return chat;
};

export const hasOpenChatConflict = async ({ sessionName, remoteNumber, agentId, excludeChatId = null }) => {
  await ensureChatSchema();
  const params = [sessionName, remoteNumber, agentId];
  let sql = `
    SELECT 1
    FROM chats
    WHERE whatsapp_session_name = $1
      AND remote_number = $2
      AND status = 'OPEN'
      AND (assigned_agent_id IS NULL OR assigned_agent_id <> $3)
  `;
  if (excludeChatId) {
    params.push(excludeChatId);
    sql += ` AND id <> $${params.length}`;
  }
  sql += ' LIMIT 1';
  const { rows } = await pool.query(sql, params);
  return Boolean(rows[0]);
};

export const unassignChatDb = async (chatId) => {
  await ensureChatSchema();
  const { rows } = await pool.query(
    `UPDATE chats
     SET assigned_agent_id = NULL,
         assigned_user_id = NULL,
         status = 'UNASSIGNED',
         assigned_at = NULL,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [chatId]
  );
  if (!rows[0]) throw new AppError('Chat no encontrado', 404);
  const chat = mapChat(rows[0]);
  await cacheChat(chat);
  await invalidateAssignment(chatId);
  return chat;
};

export const bulkUnassignChatsByUser = async (userId, client = null) => {
  if (!userId) return [];
  await ensureChatSchema();
  const exec = executorFor(client);
  const { rows } = await exec.query(
    `UPDATE chats
     SET assigned_agent_id = NULL,
         assigned_user_id = NULL,
         status = CASE WHEN status = 'CLOSED' THEN status ELSE 'UNASSIGNED' END,
         assigned_at = NULL,
         updated_at = NOW()
     WHERE assigned_agent_id = $1 OR assigned_user_id = $1
     RETURNING *`,
    [userId]
  );
  const chats = rows.map(mapChat);
  if (!client) {
    for (const chat of chats) {
      await cacheChat(chat);
      await invalidateAssignment(chat.id);
    }
  }
  return chats;
};

export const isUserInQueue = async (userId, queueId) => {
  // Si el chat no tiene cola asociada, permitimos operar (modo abierto / transición).
  if (!queueId) return true;
  const { rows } = await pool.query('SELECT 1 FROM queue_users WHERE user_id = $1 AND queue_id = $2 LIMIT 1', [userId, queueId]);
  return Boolean(rows[0]);
};

export const getUserQueueIds = async (userId) => {
  const { rows } = await pool.query('SELECT queue_id FROM queue_users WHERE user_id = $1', [userId]);
  return rows.map((r) => r.queue_id);
};

export const listChatsByVisibility = async (user, statuses = undefined) => {
  await ensureChatSchema();
  const isAgent = user.role === 'AGENTE';
  const allowedStatuses = ['UNASSIGNED', 'OPEN', 'CLOSED'];
  let filterStatuses = Array.isArray(statuses) ? statuses.filter((s) => allowedStatuses.includes(s)) : [];

  if (isAgent) {
    // Agente: solo puede ver sus chats abiertos; ignoramos cualquier filtro distinto.
    filterStatuses = ['OPEN'];
  } else if (!filterStatuses.length) {
    filterStatuses = allowedStatuses;
  }

  const params = [];
  let sql = `
    SELECT c.*, u.full_name AS assigned_user_name, u.email AS assigned_user_email, ws.status AS whatsapp_status
    FROM chats c
    LEFT JOIN users u ON u.id = c.assigned_user_id
    LEFT JOIN whatsapp_sessions ws ON ws.session_name = c.whatsapp_session_name
    WHERE UPPER(c.status) = ANY($1)
  `;
  params.push(filterStatuses);

  if (isAgent) {
    params.push(user.id);
    sql += ` AND (c.assigned_agent_id = $${params.length} OR c.assigned_user_id = $${params.length})`;
  }

  sql += ' ORDER BY c.updated_at DESC LIMIT 200';

  const { rows } = await pool.query(sql, params);
  return rows.map(mapChat);
};

export const listChatsByVisibilityCursor = async ({ user, status, limit = 50, cursor, search = null }) => {
  await ensureChatSchema();
  if (!user) return { items: [], nextCursor: null };

  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const tenantId = await resolveTenantId(user.id);
  const cursorData = decodeCursor(cursor);
  const isAgent = user.role === 'AGENTE';
  const isAdmin = user.role === 'ADMIN';
  const isSupervisor = user.role === 'SUPERVISOR';

  const queueIds = isAdmin ? [] : await getUserQueueIds(user.id);
  if (!isAdmin && queueIds.length === 0) {
    // ISO 27001: sin pertenencia a colas no se exponen chats (least privilege)
    return { items: [], nextCursor: null };
  }

  const params = [];
  const filters = [];
  const statusKey = (status || '').toString().split(',')[0].trim().toUpperCase();
  const allowedStatuses = ['UNASSIGNED', 'OPEN', 'CLOSED'];
  const statusFilters = (() => {
    switch (statusKey) {
      case 'UNASSIGNED':
        return { statuses: ['UNASSIGNED'], requireUnassigned: true };
      case 'ASSIGNED':
        return { statuses: ['OPEN'], requireAssigned: true };
      case 'CLOSED':
        return { statuses: ['CLOSED'] };
      case 'OPEN':
        return { statuses: ['OPEN'] };
      default:
        return { statuses: allowedStatuses };
    }
  })();

  params.push(statusFilters.statuses);
  filters.push(`UPPER(c.status) = ANY($${params.length})`);
  if (tenantId) {
    params.push(tenantId);
    filters.push(`c.tenant_id = $${params.length}`);
  }

  if (statusFilters.requireAssigned) {
    filters.push('c.assigned_agent_id IS NOT NULL');
  }
  if (statusFilters.requireUnassigned) {
    filters.push('c.assigned_agent_id IS NULL');
  }

  if (!isAdmin) {
    if (isSupervisor) {
      if (queueIds.length > 0) {
        params.push(queueIds);
        filters.push(`(c.queue_id IS NULL OR c.queue_id = ANY($${params.length}))`);
      } else {
        filters.push('c.queue_id IS NULL');
      }
    } else {
      params.push(queueIds);
      filters.push(`c.queue_id = ANY($${params.length})`);
      filters.push('c.queue_id IS NOT NULL');
    }
  }

  if (search) {
    const term = `%${String(search).toLowerCase()}%`;
    params.push(term);
    const idx = params.length;
    filters.push(
      `(LOWER(c.remote_number) LIKE $${idx}
        OR LOWER(c.remote_jid) LIKE $${idx}
        OR EXISTS (
            SELECT 1 FROM chat_messages m
            WHERE m.chat_id = c.id
              AND LOWER(COALESCE(m.content->>'text', '')) LIKE $${idx}
          )
        )`
    );
  }

  if (isAgent) {
    params.push(user.id);
    // Agentes solo ven chats asignados a ellos (sin acceso a no asignados ni sin cola).
    const selfIdx = params.length;
    filters.push(`c.assigned_agent_id = $${selfIdx}`);
  } else if (isSupervisor && statusFilters.requireUnassigned) {
    // Supervisores sólo dentro de sus colas ya filtradas; sin extra restricciones
  }

  if (cursorData) {
    params.push(cursorData.ts);
    params.push(cursorData.id);
    const tsIdx = params.length - 1;
    const idIdx = params.length;
    filters.push(`(COALESCE(c.updated_at, c.created_at), c.id) < ($${tsIdx}, $${idIdx})`);
  }

  params.push(safeLimit);

  const sql = `
    WITH scoped AS (
      SELECT c.*, COALESCE(c.updated_at, c.created_at) AS sort_at,
             u.full_name AS assigned_user_name, u.email AS assigned_user_email,
             q.name AS queue_name,
             ws.status AS whatsapp_status
      FROM chats c
      LEFT JOIN users u ON u.id = c.assigned_user_id
      LEFT JOIN queues q ON q.id = c.queue_id
      LEFT JOIN whatsapp_sessions ws ON ws.session_name = c.whatsapp_session_name
      WHERE ${filters.join(' AND ')}
    )
    SELECT * FROM scoped
    ORDER BY sort_at DESC, id DESC
    LIMIT $${params.length}
  `;

  const { rows } = await pool.query(sql, params);
  const items = rows.map(mapChat);
  const nextCursor = rows.length === safeLimit ? encodeCursor(rows[rows.length - 1]) : null;
  // Cursores deterministas para trazabilidad y repetibilidad de consultas
  return { items, nextCursor };
};

export const listChatsByPhoneForExport = async ({ user, phoneCandidates = [], limit = 100 }) => {
  await ensureChatSchema();
  if (!user || !phoneCandidates.length) return [];

  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
  const tenantId = await resolveTenantId(user.id);
  const isAdmin = user.role === 'ADMIN';
  const isSupervisor = user.role === 'SUPERVISOR';
  const isAgent = user.role === 'AGENTE';

  const queueIds = isAdmin ? [] : await getUserQueueIds(user.id);
  if (!isAdmin && queueIds.length === 0) return [];

  const params = [];
  const filters = [];

  params.push(phoneCandidates);
  filters.push(
    `(c.remote_number = ANY($${params.length})
      OR regexp_replace(COALESCE(c.remote_jid, ''), '[^0-9]', '', 'g') = ANY($${params.length}))`
  );

  if (tenantId) {
    params.push(tenantId);
    filters.push(`c.tenant_id = $${params.length}`);
  }

  if (!isAdmin) {
    params.push(queueIds);
    if (isSupervisor) {
      filters.push(`(c.queue_id IS NULL OR c.queue_id = ANY($${params.length}))`);
    } else {
      filters.push(`c.queue_id = ANY($${params.length})`);
      filters.push('c.queue_id IS NOT NULL');
    }
  }

  if (isAgent) {
    params.push(user.id);
    filters.push('UPPER(c.status) = \'OPEN\'');
    filters.push(`c.assigned_agent_id = $${params.length}`);
  }

  params.push(safeLimit);

  const { rows } = await pool.query(
    `
    SELECT c.*, u.full_name AS assigned_user_name, u.email AS assigned_user_email, q.name AS queue_name, ws.status AS whatsapp_status
    FROM chats c
    LEFT JOIN users u ON u.id = c.assigned_user_id
    LEFT JOIN queues q ON q.id = c.queue_id
    LEFT JOIN whatsapp_sessions ws ON ws.session_name = c.whatsapp_session_name
    WHERE ${filters.join(' AND ')}
    ORDER BY COALESCE(c.last_message_at, c.updated_at, c.created_at) DESC, c.id DESC
    LIMIT $${params.length}
    `,
    params
  );

  return rows.map(mapChat);
};

export const listChatCountsByVisibility = async (user) => {
  await ensureChatSchema();
  const isAgent = user.role === 'AGENTE';
  const allowedStatuses = ['UNASSIGNED', 'OPEN', 'CLOSED'];

  if (isAgent) {
    const { rows } = await pool.query(
      `SELECT status, COUNT(*) AS count
       FROM chats
       WHERE (assigned_agent_id = $1 OR assigned_user_id = $1) AND UPPER(status) = 'OPEN'
       GROUP BY status`,
      [user.id]
    );
    const counts = { OPEN: 0, UNASSIGNED: 0, CLOSED: 0 };
    rows.forEach((r) => {
      const key = r.status ? r.status.toUpperCase() : r.status;
      counts[key] = Number(r.count || 0);
    });
    return counts;
  }

  const { rows } = await pool.query(
    `SELECT status, COUNT(*) AS count
     FROM chats
     WHERE UPPER(status) = ANY($1)
     GROUP BY status`,
    [allowedStatuses]
  );
  const counts = { OPEN: 0, UNASSIGNED: 0, CLOSED: 0 };
  rows.forEach((r) => {
    const key = r.status ? r.status.toUpperCase() : r.status;
    counts[key] = Number(r.count || 0);
  });
  return counts;
};

export const listUnassignedChats = async (limit = 100) => {
  const { rows } = await pool.query(
    `SELECT * FROM chats
     WHERE status = 'UNASSIGNED'
     ORDER BY last_message_at DESC NULLS LAST, created_at ASC
     LIMIT $1`,
    [limit]
  );
  return rows.map(mapChat);
};

export const getOpenChatCountsByAgent = async (agentIds = []) => {
  if (!agentIds.length) return [];
  const { rows } = await pool.query(
    `SELECT assigned_agent_id, COUNT(*) as count
     FROM chats
     WHERE assigned_agent_id = ANY($1) AND status = 'OPEN'
     GROUP BY assigned_agent_id`,
    [agentIds]
  );
  return rows.map(mapLoad);
};

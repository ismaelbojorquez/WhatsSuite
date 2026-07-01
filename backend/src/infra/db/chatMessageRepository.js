import pool from './postgres.js';
import { cacheMessages, getCachedMessages, invalidateChat } from '../cache/chatCache.js';
import logger from '../logging/logger.js';
import env from '../../config/env.js';

const mapMessage = (row) => ({
  id: row.id,
  chatId: row.chat_id,
  whatsappSessionName: row.whatsapp_session_name,
  remoteNumber: row.remote_number,
  connectionId: row.connection_id,
  direction: row.direction,
  messageType: row.message_type,
  content: row.content,
  whatsappMessageId: row.whatsapp_message_id,
  status: row.status,
  originalContent: row.original_content,
  editedAt: row.edited_at,
  deletedForRemote: row.deleted_for_remote,
  timestamp: row.timestamp,
  deletedAt: row.deleted_at,
  updatedAt: row.updated_at,
  createdAt: row.created_at
});

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
  const sortAt = row.sort_at || row.timestamp || row.created_at || row.createdAt || Date.now();
  const payload = { t: new Date(sortAt).toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
};

const loadAckMissCandidates = async ({ sessionName, remoteNumber, tenantId = null }) => {
  if (!env.whatsapp?.debugAck) return null;
  const params = [];
  const filters = ["direction = 'out'"];

  if (sessionName) {
    params.push(sessionName);
    filters.push(`whatsapp_session_name = $${params.length}`);
  }
  if (tenantId) {
    params.push(tenantId);
    filters.push(`tenant_id = $${params.length}`);
  }
  const normalizedRemote = remoteNumber ? String(remoteNumber).replace(/[^\d]/g, '') : null;
  const remoteCandidates = Array.from(
    new Set([remoteNumber, normalizedRemote].filter((value) => value !== null && value !== undefined && value !== ''))
  );
  if (remoteCandidates.length) {
    params.push(remoteCandidates);
    filters.push(`remote_number = ANY($${params.length}::text[])`);
  }

  const { rows } = await pool.query(
    `SELECT id, chat_id, whatsapp_session_name, remote_number, whatsapp_message_id, status, created_at, updated_at
     FROM chat_messages
     WHERE ${filters.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT 8`,
    params
  );

  return rows.map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    sessionName: row.whatsapp_session_name,
    remoteNumber: row.remote_number,
    whatsappMessageId: row.whatsapp_message_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
};

const resolveConnectionCandidates = async (sessionName, connectionId = null) => {
  const candidates = new Set([connectionId, sessionName].filter(Boolean).map(String));
  if (!sessionName) return Array.from(candidates);

  const { rows } = await pool.query(
    `SELECT connection_id FROM whatsapp_sessions WHERE session_name = $1 LIMIT 1`,
    [sessionName]
  );
  if (rows[0]?.connection_id) candidates.add(String(rows[0].connection_id));
  return Array.from(candidates);
};

export const findMessageByDedupeKey = async ({
  sessionName = null,
  connectionId = null,
  whatsappMessageId,
  tenantId = null
}) => {
  if (!whatsappMessageId) return null;
  const connectionCandidates = await resolveConnectionCandidates(sessionName, connectionId);
  if (!connectionCandidates.length && !tenantId) return null;

  const params = [String(whatsappMessageId).toLowerCase()];
  let sql = `
    SELECT *
    FROM chat_messages
    WHERE LOWER(whatsapp_message_id) = $1
  `;
  if (tenantId) {
    params.push(tenantId);
    sql += ` AND tenant_id = $${params.length}`;
  }
  if (connectionCandidates.length) {
    params.push(connectionCandidates);
    sql += ` AND COALESCE(connection_id::text, whatsapp_session_name::text) = ANY($${params.length}::text[])`;
  }
  sql += ' ORDER BY timestamp DESC NULLS LAST, created_at DESC LIMIT 1';

  const { rows } = await pool.query(sql, params);
  return rows[0] ? mapMessage(rows[0]) : null;
};

export const findMessageByUniqueKey = async ({ sessionName, remoteNumber, whatsappMessageId, timestamp = null, tenantId = null }) => {
  if (!sessionName || !remoteNumber || !whatsappMessageId) return null;
  const params = [sessionName, remoteNumber, whatsappMessageId];
  let sql = `
    SELECT * FROM chat_messages
    WHERE whatsapp_session_name = $1
      AND remote_number = $2
      AND whatsapp_message_id = $3
  `;
  if (tenantId) {
    params.push(tenantId);
    sql += ` AND tenant_id = $${params.length}`;
  }
  if (timestamp) {
    params.push(timestamp);
    sql += ` AND timestamp = $${params.length}`;
  }
  sql += ' LIMIT 1';
  const { rows } = await pool.query(sql, params);
  if (rows[0]) return mapMessage(rows[0]);
  return findMessageByDedupeKey({ sessionName, whatsappMessageId, tenantId });
};

export const findMessageByWhatsappId = async (whatsappMessageId, tenantId = null) => {
  if (!whatsappMessageId) return null;
  const params = [whatsappMessageId];
  let sql = `
    SELECT *
    FROM chat_messages
    WHERE whatsapp_message_id = $1
  `;
  if (tenantId) {
    params.push(tenantId);
    sql += ` AND tenant_id = $${params.length}`;
  }
  sql += ' ORDER BY timestamp DESC NULLS LAST, created_at DESC LIMIT 1';
  const { rows } = await pool.query(sql, params);
  if (rows[0]) return mapMessage(rows[0]);

  // Búsqueda insensible a mayúsculas por whatsapp_message_id
  const lower = whatsappMessageId.toLowerCase();
  const paramsLower = [lower];
  let sqlLower = `
    SELECT *
    FROM chat_messages
    WHERE LOWER(whatsapp_message_id) = $1
  `;
  if (tenantId) {
    paramsLower.push(tenantId);
    sqlLower += ` AND tenant_id = $${paramsLower.length}`;
  }
  sqlLower += ' ORDER BY timestamp DESC NULLS LAST, created_at DESC LIMIT 1';
  const resLower = await pool.query(sqlLower, paramsLower);
  if (resLower.rows[0]) return mapMessage(resLower.rows[0]);
  return rows[0] ? mapMessage(rows[0]) : null;
};

export const getMessageById = async (id) => {
  if (!id) return null;
  const { rows } = await pool.query('SELECT * FROM chat_messages WHERE id = $1 LIMIT 1', [id]);
  return rows[0] ? mapMessage(rows[0]) : null;
};

export const insertMessage = async ({
  chatId,
  direction,
  content,
  messageType = 'unknown',
  whatsappMessageId = null,
  timestamp = null,
  whatsappSessionName = null,
  remoteNumber = null,
  status = 'received',
  tenantId = null
}) => {
  let resolvedTenant = tenantId;
  let resolvedConnectionId = null;
  if (!resolvedTenant || !resolvedConnectionId) {
    const res = await pool.query(
      `SELECT tenant_id, whatsapp_session_name, queue_id
       FROM chats
       WHERE id = $1
       LIMIT 1`,
      [chatId]
    );
    resolvedTenant = resolvedTenant || res.rows[0]?.tenant_id || null;
    const sessionName = whatsappSessionName || res.rows[0]?.whatsapp_session_name || null;
    if (sessionName) {
      const connRes = await pool.query(
        `SELECT connection_id FROM whatsapp_sessions WHERE session_name = $1 LIMIT 1`,
        [sessionName]
      );
      resolvedConnectionId = connRes.rows[0]?.connection_id || sessionName;
    }
  }
  resolvedConnectionId = resolvedConnectionId || whatsappSessionName || null;

  const params = [
    chatId,
    direction,
    messageType,
    content,
    whatsappMessageId,
    whatsappSessionName,
    resolvedConnectionId,
    remoteNumber,
    status,
    resolvedTenant
  ];
  let sql = `INSERT INTO chat_messages (chat_id, direction, message_type, content, whatsapp_message_id, whatsapp_session_name, connection_id, remote_number, status, tenant_id`;
  let valuesSql = `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10`;

  if (timestamp) {
    params.push(timestamp);
    sql += `, timestamp`;
    valuesSql += `, $11`;
  }

  sql += `) ${valuesSql}) RETURNING *`;

  try {
    const { rows } = await pool.query(sql, params);
    const msg = mapMessage(rows[0]);
    await invalidateChat(chatId);
    return msg;
  } catch (err) {
    if (err?.code === '23505' && whatsappMessageId) {
      const existing = await findMessageByDedupeKey({
        sessionName: whatsappSessionName,
        connectionId: resolvedConnectionId,
        whatsappMessageId,
        tenantId: resolvedTenant
      });
      if (existing) {
        logger.info(
          {
            chatId,
            sessionName: whatsappSessionName,
            connectionId: resolvedConnectionId,
            whatsappMessageId,
            tag: 'CHAT_MESSAGE_DEDUPE_HIT'
          },
          'Duplicate WhatsApp message insert ignored'
        );
        return existing;
      }
    }
    throw err;
  }
};

export const updateMessageStatus = async ({
  sessionName,
  remoteNumber,
  whatsappMessageId,
  status = null,
  editPayload = null,
  timestamp = null,
  tenantId = null
}) => {
  const normalizedRemote = remoteNumber ? String(remoteNumber).replace(/[^\d]/g, '') : remoteNumber;
  const baseParams = [status, editPayload, timestamp].map((v) => (v === undefined ? null : v));

  // Intentos con remoteNumber (crudo y normalizado)
  const remoteCandidates = Array.from(
    new Set([remoteNumber, normalizedRemote].filter((v) => v !== null && v !== undefined && v !== ''))
  );
  for (const remote of remoteCandidates) {
    const paramsWithRemote = [...baseParams, sessionName, remote, whatsappMessageId];
    const updateSql = `
      UPDATE chat_messages
      SET status = COALESCE($1, status),
          content = CASE WHEN $2::jsonb IS NOT NULL THEN $2::jsonb ELSE content END,
          original_content = CASE WHEN $2::jsonb IS NOT NULL THEN COALESCE(original_content, content) ELSE original_content END,
          timestamp = COALESCE($3, timestamp),
          edited_at = CASE WHEN $2::jsonb IS NOT NULL THEN NOW() ELSE edited_at END,
          updated_at = NOW()
      WHERE whatsapp_session_name = $4
        AND remote_number = $5
        AND whatsapp_message_id = $6
        ${tenantId ? `AND tenant_id = $${paramsWithRemote.push(tenantId)}` : ''}
      RETURNING *`;

    let { rows } = await pool.query(updateSql, paramsWithRemote);
    if (rows[0]) {
      const msg = mapMessage(rows[0]);
      await invalidateChat(msg.chatId);
      if (env.whatsapp?.debugAck) {
        logger.info(
          { sessionName, remoteNumber: remote, whatsappMessageId, status, matchedBy: 'session_remote', tag: 'MSG_STATUS_UPDATE_HIT' },
          'Message status update matched by session and remote number'
        );
      }
      return msg;
    }
  }

  // Segundo intento: ignorar remoteNumber; algunas actualizaciones llegan con jid alterno.
  const paramsWithoutRemote = [...baseParams, sessionName, whatsappMessageId];
  const fallbackSql = `
    UPDATE chat_messages
    SET status = COALESCE($1, status),
        content = CASE WHEN $2::jsonb IS NOT NULL THEN $2::jsonb ELSE content END,
        original_content = CASE WHEN $2::jsonb IS NOT NULL THEN COALESCE(original_content, content) ELSE original_content END,
        timestamp = COALESCE($3, timestamp),
        edited_at = CASE WHEN $2::jsonb IS NOT NULL THEN NOW() ELSE edited_at END,
        updated_at = NOW()
    WHERE whatsapp_session_name = $4
      AND whatsapp_message_id = $5
      ${tenantId ? `AND tenant_id = $${paramsWithoutRemote.push(tenantId)}` : ''}
    RETURNING *`;
  let res = await pool.query(fallbackSql, paramsWithoutRemote);
  if (res.rows[0]) {
    const msg = mapMessage(res.rows[0]);
    await invalidateChat(msg.chatId);
    if (env.whatsapp?.debugAck) {
      logger.info(
        { sessionName, remoteNumber, whatsappMessageId, status, matchedBy: 'session_only', tag: 'MSG_STATUS_UPDATE_HIT' },
        'Message status update matched by session'
      );
    }
    return msg;
  }

  // Tercer intento: solo por whatsapp_message_id (último recurso).
  const paramsById = [...baseParams, whatsappMessageId];
  const idOnlySql = `
    UPDATE chat_messages
    SET status = COALESCE($1, status),
        content = CASE WHEN $2::jsonb IS NOT NULL THEN $2::jsonb ELSE content END,
        original_content = CASE WHEN $2::jsonb IS NOT NULL THEN COALESCE(original_content, content) ELSE original_content END,
        timestamp = COALESCE($3, timestamp),
        edited_at = CASE WHEN $2::jsonb IS NOT NULL THEN NOW() ELSE edited_at END,
        updated_at = NOW()
    WHERE whatsapp_message_id = $4
      ${tenantId ? `AND tenant_id = $${paramsById.push(tenantId)}` : ''}
    RETURNING *`;
  res = await pool.query(idOnlySql, paramsById);
  let matchedBy = 'id_only';
  if (!res.rows[0] && whatsappMessageId) {
    // Intento extra: insensible a mayúsculas (algunos drivers envían IDs upper/lower)
    const paramsCaseInsensitive = [...baseParams, whatsappMessageId.toLowerCase()];
    const caseSql = `
      UPDATE chat_messages
      SET status = COALESCE($1, status),
          content = CASE WHEN $2::jsonb IS NOT NULL THEN $2::jsonb ELSE content END,
          original_content = CASE WHEN $2::jsonb IS NOT NULL THEN COALESCE(original_content, content) ELSE original_content END,
          timestamp = COALESCE($3, timestamp),
          updated_at = NOW()
      WHERE LOWER(whatsapp_message_id) = $4
        ${tenantId ? `AND tenant_id = $${paramsCaseInsensitive.push(tenantId)}` : ''}
      RETURNING *`;
    res = await pool.query(caseSql, paramsCaseInsensitive);
    matchedBy = 'case_insensitive_id';
  }
  if (!res.rows[0]) {
    let candidates = null;
    try {
      candidates = await loadAckMissCandidates({ sessionName, remoteNumber, tenantId });
    } catch (err) {
      logger.warn({ err, sessionName, remoteNumber, whatsappMessageId, tag: 'MSG_STATUS_UPDATE_MISS_DIAG_FAILED' }, 'Failed to load ACK miss candidates');
    }
    logger.warn(
      {
        sessionName,
        remoteNumber,
        normalizedRemote,
        whatsappMessageId,
        status,
        tenantId,
        candidates,
        tag: 'MSG_STATUS_UPDATE_MISS'
      },
      'No se encontró mensaje para actualizar estado'
    );
    return null;
  }
  const msg = mapMessage(res.rows[0]);
  await invalidateChat(msg.chatId);
  if (env.whatsapp?.debugAck) {
    logger.info(
      { sessionName, remoteNumber, whatsappMessageId, status, matchedBy, tag: 'MSG_STATUS_UPDATE_HIT' },
      'Message status update matched by id'
    );
  }
  return msg;
};

export const softDeleteMessage = async ({ sessionName, remoteNumber, whatsappMessageId, tenantId = null }) => {
  const normalizedRemote = remoteNumber ? String(remoteNumber).replace(/[^\d]/g, '') : remoteNumber;
  const attempts = [
    { useSession: true, remote: remoteNumber },
    { useSession: true, remote: normalizedRemote && normalizedRemote !== remoteNumber ? normalizedRemote : null },
    { useSession: true, remote: null },
    { useSession: false, remote: null }
  ];

  for (const attempt of attempts) {
    if (!attempt.useSession && !whatsappMessageId) continue;
    const params = [];
    let where = 'whatsapp_message_id = $1';
    params.push(whatsappMessageId);

    if (attempt.useSession && sessionName) {
      params.unshift(sessionName);
      where = 'whatsapp_session_name = $1 AND whatsapp_message_id = $2';
    }
    if (attempt.remote) {
      params.push(attempt.remote);
      where += ` AND remote_number = $${params.length}`;
    }
    if (tenantId) {
      params.push(tenantId);
      where += ` AND tenant_id = $${params.length}`;
    }

    const { rows } = await pool.query(
      `UPDATE chat_messages
       SET deleted_at = NOW(),
           status = 'deleted',
           deleted_for_remote = TRUE,
           updated_at = NOW()
       WHERE ${where}
       RETURNING *`,
      params
    );
    if (rows[0]) {
      const msg = mapMessage(rows[0]);
      await invalidateChat(msg.chatId);
      return msg;
    }
  }
  logger.warn({ sessionName, remoteNumber, whatsappMessageId, tag: 'MSG_DELETE_MISS' }, 'No se pudo marcar mensaje como eliminado');
  return null;
};

export const listMessagesByChat = async ({ chatId, limit = 50, cursor = null }) => {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const cursorData = decodeCursor(cursor);

  const params = [chatId];
  let cursorClause = '';
  if (cursorData) {
    params.push(cursorData.ts);
    params.push(cursorData.id);
    const tsIdx = params.length - 1;
    const idIdx = params.length;
    cursorClause = `AND (COALESCE(timestamp, created_at), id) < ($${tsIdx}, $${idIdx})`;
  }
  params.push(safeLimit);
  const { rows } = await pool.query(
    `SELECT *, COALESCE(timestamp, created_at) AS sort_at
     FROM chat_messages
     WHERE chat_id = $1 ${cursorClause}
     ORDER BY sort_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
  const messages = rows.map(mapMessage);
  const nextCursor = rows.length === safeLimit ? encodeCursor(rows[rows.length - 1]) : null;
  return { messages, nextCursor };
};

export const findMediaByRelativePath = async (relativePath) => {
  if (!relativePath) return null;
  const { rows } = await pool.query(
    `SELECT chat_id, content
     FROM chat_messages
     WHERE content->'media'->>'relativePath' = $1
     LIMIT 1`,
    [relativePath]
  );
  if (!rows[0]) return null;
  return {
    chatId: rows[0].chat_id,
    media: rows[0].content?.media || null
  };
};

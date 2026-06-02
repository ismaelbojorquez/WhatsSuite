import pool from '../../infra/db/postgres.js';
import logger from '../../infra/logging/logger.js';

const dashboardCache = new Map();
const dashboardCacheTtlMs = 60_000;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const cacheKey = (scope, start, end) => `${scope}:${start}:${end}`;

const getDashboardCache = async (scope, start, end) => {
  const key = cacheKey(scope, start, end);
  const entry = dashboardCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    dashboardCache.delete(key);
    return null;
  }
  return entry.data;
};

const setDashboardCache = async (scope, start, end, data) => {
  dashboardCache.set(cacheKey(scope, start, end), {
    expiresAt: Date.now() + dashboardCacheTtlMs,
    data
  });
};

const invalidateDashboardCache = async () => {
  dashboardCache.clear();
};

const ensureDates = (from, to) => {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Fechas inválidas');
  }
  const endExclusive = new Date(end);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    endExclusive: endExclusive.toISOString().slice(0, 10)
  };
};

const toNumber = (value) => Number(value || 0);

const percentage = (value, total) => {
  const resolvedTotal = toNumber(total);
  if (!resolvedTotal) return 0;
  return Number(((toNumber(value) / resolvedTotal) * 100).toFixed(2));
};

const enrichOverview = (data, { start, end }) => {
  const totalMensajes = toNumber(data?.total_mensajes);
  const mensajesEntrantes = toNumber(data?.mensajes_entrantes);
  const mensajesSalientes = toNumber(data?.mensajes_salientes);
  const archivosEnviados = toNumber(data?.archivos_enviados);
  const audiosEnviados = toNumber(data?.audios_enviados);
  const totalChats = toNumber(data?.total_chats);
  const chatsAbiertos = toNumber(data?.total_chats_abiertos);
  const chatsCerrados = toNumber(data?.total_chats_cerrados);
  const periodDays = Math.max(1, Math.round((new Date(end) - new Date(start)) / 86_400_000) + 1);

  return {
    ...data,
    total_chats: totalChats,
    promedio_mensajes_dia: Number((totalMensajes / periodDays).toFixed(2)),
    mensajes_por_chat: Number((totalMensajes / Math.max(totalChats, 1)).toFixed(2)),
    porcentaje_entrantes: percentage(mensajesEntrantes, totalMensajes),
    porcentaje_salientes: percentage(mensajesSalientes, totalMensajes),
    porcentaje_media: percentage(archivosEnviados, totalMensajes),
    porcentaje_audio: percentage(audiosEnviados, totalMensajes),
    tasa_cierre: percentage(chatsCerrados, totalChats || chatsAbiertos + chatsCerrados),
    ratio_salientes_entrantes: Number((mensajesSalientes / Math.max(mensajesEntrantes, 1)).toFixed(2)),
    periodo_dias: periodDays
  };
};

const getLiveOverview = async ({ start, endExclusive }) => {
  const { rows } = await pool.query(
    `
    WITH msg_scope AS (
      SELECT
        m.*,
        COALESCE(m.timestamp, m.created_at) AS message_at
      FROM chat_messages m
      WHERE COALESCE(m.timestamp, m.created_at) >= $1::date
        AND COALESCE(m.timestamp, m.created_at) < $2::date
    ),
    msgs AS (
      SELECT
        COUNT(*)::bigint AS total_mensajes,
        COUNT(*) FILTER (WHERE direction = 'in')::bigint AS mensajes_entrantes,
        COUNT(*) FILTER (WHERE direction = 'out')::bigint AS mensajes_salientes,
        COUNT(*) FILTER (WHERE ((content ? 'media') OR (content ? 'files')) AND direction = 'out')::bigint AS archivos_enviados,
        COUNT(*) FILTER (WHERE ((content->'media'->>'type') = 'audio' OR content->>'payload_type' = 'audio') AND direction = 'out')::bigint AS audios_enviados
      FROM msg_scope
    ),
    chat_scope AS (
      SELECT c.*
      FROM chats c
      WHERE c.status IN ('OPEN','UNASSIGNED','open','unassigned')
         OR (c.created_at >= $1::date AND c.created_at < $2::date)
         OR (c.updated_at >= $1::date AND c.updated_at < $2::date)
         OR (c.last_message_at >= $1::date AND c.last_message_at < $2::date)
         OR (c.closed_at >= $1::date AND c.closed_at < $2::date)
         OR EXISTS (SELECT 1 FROM msg_scope m WHERE m.chat_id = c.id)
    ),
    chats AS (
      SELECT
        COUNT(*)::bigint AS total_chats,
        COUNT(*) FILTER (WHERE status IN ('OPEN','UNASSIGNED','open','unassigned'))::bigint AS total_chats_abiertos,
        COUNT(*) FILTER (WHERE status IN ('CLOSED','closed'))::bigint AS total_chats_cerrados
      FROM chat_scope
    ),
    first_inbound AS (
      SELECT chat_id, MIN(message_at) AS inbound_at
      FROM msg_scope
      WHERE direction = 'in'
        AND chat_id IS NOT NULL
      GROUP BY chat_id
    ),
    first_response AS (
      SELECT
        fi.chat_id,
        EXTRACT(EPOCH FROM (outbound.outbound_at - fi.inbound_at)) AS response_secs
      FROM first_inbound fi
      JOIN LATERAL (
        SELECT COALESCE(o.timestamp, o.created_at) AS outbound_at
        FROM chat_messages o
        WHERE o.chat_id = fi.chat_id
          AND o.direction = 'out'
          AND COALESCE(o.timestamp, o.created_at) > fi.inbound_at
        ORDER BY COALESCE(o.timestamp, o.created_at) ASC
        LIMIT 1
      ) outbound ON TRUE
    ),
    response AS (
      SELECT COALESCE(AVG(response_secs),0)::numeric(12,2) AS tiempo_respuesta_promedio
      FROM first_response
    )
    SELECT
      msgs.total_mensajes,
      msgs.mensajes_entrantes,
      msgs.mensajes_salientes,
      msgs.archivos_enviados,
      msgs.audios_enviados,
      chats.total_chats,
      chats.total_chats_abiertos,
      chats.total_chats_cerrados,
      response.tiempo_respuesta_promedio
    FROM msgs, chats, response
  `,
    [start, endExclusive]
  );
  return rows[0] || {};
};

const getLiveTimeseries = async ({ start, endExclusive }) => {
  const { rows } = await pool.query(
    `
    SELECT
      COALESCE(timestamp, created_at)::date AS date_key,
      COUNT(*)::bigint AS total_mensajes,
      COUNT(*) FILTER (WHERE direction = 'in')::bigint AS mensajes_entrantes,
      COUNT(*) FILTER (WHERE direction = 'out')::bigint AS mensajes_salientes,
      COUNT(*) FILTER (WHERE ((content ? 'media') OR (content ? 'files')) AND direction = 'out')::bigint AS archivos_enviados,
      COUNT(*) FILTER (WHERE ((content->'media'->>'type') = 'audio' OR content->>'payload_type' = 'audio') AND direction = 'out')::bigint AS audios_enviados
    FROM chat_messages
    WHERE COALESCE(timestamp, created_at) >= $1::date
      AND COALESCE(timestamp, created_at) < $2::date
    GROUP BY COALESCE(timestamp, created_at)::date
    ORDER BY date_key ASC
  `,
    [start, endExclusive]
  );
  return rows;
};

const getLiveChatsByQueue = async ({ start, endExclusive }) => {
  const { rows } = await pool.query(
    `
    WITH msg_scope AS (
      SELECT
        m.*,
        COALESCE(m.timestamp, m.created_at) AS message_at,
        COALESCE(c.queue_id, $3::uuid) AS queue_bucket
      FROM chat_messages m
      LEFT JOIN chats c ON c.id = m.chat_id
      WHERE COALESCE(m.timestamp, m.created_at) >= $1::date
        AND COALESCE(m.timestamp, m.created_at) < $2::date
    ),
    chat_scope AS (
      SELECT
        c.*,
        COALESCE(c.queue_id, $3::uuid) AS queue_bucket
      FROM chats c
      WHERE c.status IN ('OPEN','UNASSIGNED','open','unassigned')
         OR (c.created_at >= $1::date AND c.created_at < $2::date)
         OR (c.updated_at >= $1::date AND c.updated_at < $2::date)
         OR (c.last_message_at >= $1::date AND c.last_message_at < $2::date)
         OR (c.closed_at >= $1::date AND c.closed_at < $2::date)
         OR EXISTS (SELECT 1 FROM msg_scope m WHERE m.chat_id = c.id)
    ),
    first_inbound AS (
      SELECT chat_id, MIN(message_at) AS inbound_at
      FROM msg_scope
      WHERE direction = 'in'
        AND chat_id IS NOT NULL
      GROUP BY chat_id
    ),
    first_response AS (
      SELECT
        COALESCE(c.queue_id, $3::uuid) AS queue_bucket,
        EXTRACT(EPOCH FROM (outbound.outbound_at - fi.inbound_at)) AS response_secs
      FROM first_inbound fi
      JOIN chats c ON c.id = fi.chat_id
      JOIN LATERAL (
        SELECT COALESCE(o.timestamp, o.created_at) AS outbound_at
        FROM chat_messages o
        WHERE o.chat_id = fi.chat_id
          AND o.direction = 'out'
          AND COALESCE(o.timestamp, o.created_at) > fi.inbound_at
        ORDER BY COALESCE(o.timestamp, o.created_at) ASC
        LIMIT 1
      ) outbound ON TRUE
    ),
    msg_by_queue AS (
      SELECT
        queue_bucket,
        COUNT(*)::bigint AS total_mensajes
      FROM msg_scope
      GROUP BY queue_bucket
    ),
    chat_by_queue AS (
      SELECT
        queue_bucket,
        COUNT(DISTINCT id) FILTER (WHERE status IN ('OPEN','UNASSIGNED','open','unassigned'))::bigint AS total_abiertos,
        COUNT(DISTINCT id) FILTER (WHERE status IN ('CLOSED','closed'))::bigint AS total_cerrados,
        COUNT(DISTINCT id)::bigint AS total_chats
      FROM chat_scope
      GROUP BY queue_bucket
    ),
    response_by_queue AS (
      SELECT
        queue_bucket,
        COALESCE(AVG(response_secs),0)::numeric(12,2) AS tiempo_respuesta_promedio
      FROM first_response
      GROUP BY queue_bucket
    ),
    queue_buckets AS (
      SELECT queue_bucket FROM msg_by_queue
      UNION
      SELECT queue_bucket FROM chat_by_queue
      UNION
      SELECT queue_bucket FROM response_by_queue
    )
    SELECT
      NULLIF(qb.queue_bucket, $3::uuid) AS queue_id,
      COALESCE(q.name, 'Sin cola') AS queue_name,
      COALESCE(cb.total_abiertos, 0)::bigint AS total_abiertos,
      COALESCE(cb.total_cerrados, 0)::bigint AS total_cerrados,
      COALESCE(cb.total_chats, 0)::bigint AS total_chats,
      COALESCE(mb.total_mensajes, 0)::bigint AS total_mensajes,
      COALESCE(rb.tiempo_respuesta_promedio, 0)::numeric(12,2) AS tiempo_respuesta_promedio,
      ROUND((COALESCE(cb.total_cerrados, 0)::numeric / NULLIF(COALESCE(cb.total_chats, 0), 0)) * 100, 2) AS tasa_cierre,
      ROUND(COALESCE(mb.total_mensajes, 0)::numeric / NULLIF(COALESCE(cb.total_chats, 0), 0), 2) AS mensajes_por_chat
    FROM queue_buckets qb
    LEFT JOIN queues q ON q.id = NULLIF(qb.queue_bucket, $3::uuid)
    LEFT JOIN chat_by_queue cb ON cb.queue_bucket = qb.queue_bucket
    LEFT JOIN msg_by_queue mb ON mb.queue_bucket = qb.queue_bucket
    LEFT JOIN response_by_queue rb ON rb.queue_bucket = qb.queue_bucket
    ORDER BY total_mensajes DESC
  `,
    [start, endExclusive, ZERO_UUID]
  );
  return rows;
};

export const getOverviewMetrics = async ({ fecha_inicio, fecha_fin }) => {
  const { start, end, endExclusive } = ensureDates(fecha_inicio, fecha_fin);
  const result = await getLiveOverview({ start, endExclusive });
  return enrichOverview(result, { start, end });
};

export const getMessagesTimeseries = async ({ fecha_inicio, fecha_fin }) => {
  const { start, endExclusive } = ensureDates(fecha_inicio, fecha_fin);
  return getLiveTimeseries({ start, endExclusive });
};

export const getChatsByQueue = async ({ fecha_inicio, fecha_fin }) => {
  const { start, end, endExclusive } = ensureDates(fecha_inicio, fecha_fin);
  const cached = await getDashboardCache('chats', start, end);
  if (cached) return cached;

  const data = await getLiveChatsByQueue({ start, endExclusive });
  await setDashboardCache('chats', start, end, data);
  return data;
};

export const logDashboardAccess = async ({ userId, endpoint, fecha_inicio, fecha_fin }) => {
  const { start, end } = ensureDates(fecha_inicio, fecha_fin);
  try {
    await pool.query(
      `INSERT INTO dashboard_audit_logs (user_id, endpoint, fecha_inicio, fecha_fin)
       VALUES ($1, $2, $3, $4)`,
      [userId, endpoint, start, end]
    );
  } catch (err) {
    logger.warn(
      { err, userId, endpoint, start, end, tag: 'DASHBOARD_AUDIT_LOG' },
      'Failed to insert dashboard audit log; continuing without blocking response'
    );
  }
};

export const clearDashboardCache = async () => invalidateDashboardCache();

export const getDrilldown = async ({ fecha_inicio, fecha_fin, level }) => {
  const { start, endExclusive } = ensureDates(fecha_inicio, fecha_fin);
  const safeLevel = (level || '').toLowerCase();
  switch (safeLevel) {
    case 'agent': {
      const { rows } = await pool.query(
        `
        SELECT
          COALESCE(u.full_name, u.name, u.email, 'Sin asignar') AS label,
          COUNT(*)::bigint AS value
        FROM chat_messages m
        LEFT JOIN chats c ON c.id = m.chat_id
        LEFT JOIN users u ON u.id = COALESCE(c.assigned_agent_id, c.assigned_user_id)
        WHERE COALESCE(m.timestamp, m.created_at) >= $1::date
          AND COALESCE(m.timestamp, m.created_at) < $2::date
        GROUP BY label
        ORDER BY value DESC
        LIMIT 20
      `,
        [start, endExclusive]
      );
      return rows;
    }
    case 'connection': {
      const { rows } = await pool.query(
        `
        SELECT
          COALESCE(m.whatsapp_session_name, 'Desconocida') AS label,
          COUNT(*)::bigint AS value
        FROM chat_messages m
        WHERE COALESCE(m.timestamp, m.created_at) >= $1::date
          AND COALESCE(m.timestamp, m.created_at) < $2::date
        GROUP BY m.whatsapp_session_name
        ORDER BY value DESC
        LIMIT 20
      `,
        [start, endExclusive]
      );
      return rows;
    }
    case 'hour': {
      const { rows } = await pool.query(
        `
        SELECT
          TO_CHAR(COALESCE(m.timestamp, m.created_at), 'HH24') AS label,
          COUNT(*)::bigint AS value
        FROM chat_messages m
        WHERE COALESCE(m.timestamp, m.created_at) >= $1::date
          AND COALESCE(m.timestamp, m.created_at) < $2::date
        GROUP BY label
        ORDER BY label ASC
      `,
        [start, endExclusive]
      );
      return rows;
    }
    case 'day':
    case 'trend': {
      const { rows } = await pool.query(
        `
        SELECT
          COALESCE(m.timestamp, m.created_at)::date AS label,
          COUNT(*)::bigint AS value
        FROM chat_messages m
        WHERE COALESCE(m.timestamp, m.created_at) >= $1::date
          AND COALESCE(m.timestamp, m.created_at) < $2::date
        GROUP BY COALESCE(m.timestamp, m.created_at)::date
        ORDER BY label ASC
      `,
        [start, endExclusive]
      );
      return rows;
    }
    case 'queue': {
      const { rows } = await pool.query(
        `
        SELECT
          COALESCE(q.name, 'Sin cola') AS label,
          COUNT(*)::bigint AS value
        FROM chat_messages m
        LEFT JOIN chats c ON c.id = m.chat_id
        LEFT JOIN queues q ON q.id = c.queue_id
        WHERE COALESCE(m.timestamp, m.created_at) >= $1::date
          AND COALESCE(m.timestamp, m.created_at) < $2::date
        GROUP BY label
        ORDER BY value DESC
        LIMIT 20
      `,
        [start, endExclusive]
      );
      return rows;
    }
    case 'status': {
      const { rows } = await pool.query(
        `
        WITH msg_scope AS (
          SELECT DISTINCT m.chat_id
          FROM chat_messages m
          WHERE COALESCE(m.timestamp, m.created_at) >= $1::date
            AND COALESCE(m.timestamp, m.created_at) < $2::date
            AND m.chat_id IS NOT NULL
        ),
        chat_scope AS (
          SELECT c.*
          FROM chats c
          WHERE c.status IN ('OPEN','UNASSIGNED','open','unassigned')
             OR (c.created_at >= $1::date AND c.created_at < $2::date)
             OR (c.updated_at >= $1::date AND c.updated_at < $2::date)
             OR (c.last_message_at >= $1::date AND c.last_message_at < $2::date)
             OR (c.closed_at >= $1::date AND c.closed_at < $2::date)
             OR EXISTS (SELECT 1 FROM msg_scope m WHERE m.chat_id = c.id)
        )
        SELECT
          COALESCE(UPPER(c.status), 'SIN ESTADO') AS label,
          COUNT(*)::bigint AS value
        FROM chat_scope c
        GROUP BY label
        ORDER BY value DESC
      `,
        [start, endExclusive]
      );
      return rows;
    }
    case 'message_type': {
      const { rows } = await pool.query(
        `
        SELECT
          COALESCE(NULLIF(m.message_type, ''), m.content->>'type', m.content->>'payload_type', 'unknown') AS label,
          COUNT(*)::bigint AS value
        FROM chat_messages m
        WHERE COALESCE(m.timestamp, m.created_at) >= $1::date
          AND COALESCE(m.timestamp, m.created_at) < $2::date
        GROUP BY label
        ORDER BY value DESC
        LIMIT 20
      `,
        [start, endExclusive]
      );
      return rows;
    }
    default:
      return [];
  }
};

export default {
  getOverviewMetrics,
  getMessagesTimeseries,
  getChatsByQueue,
  logDashboardAccess,
  getDrilldown,
  clearDashboardCache
};

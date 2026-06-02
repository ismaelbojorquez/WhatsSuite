import pool from '../../infra/db/postgres.js';
import logger from '../../infra/logging/logger.js';

const dashboardCache = new Map();
const dashboardCacheTtlMs = 60_000;

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

const isEmptyOverview = (data) => {
  if (!data) return true;
  const numeric = [
    data.total_mensajes,
    data.mensajes_entrantes,
    data.mensajes_salientes,
    data.archivos_enviados,
    data.audios_enviados,
    data.total_chats_abiertos,
    data.total_chats_cerrados
  ];
  return numeric.every((v) => v === null || Number(v) === 0);
};

const fallbackOverview = async ({ start, endExclusive }) => {
  const { rows } = await pool.query(
    `
    WITH msgs AS (
      SELECT
        COUNT(*)::bigint AS total_mensajes,
        COUNT(*) FILTER (WHERE direction = 'in')::bigint AS mensajes_entrantes,
        COUNT(*) FILTER (WHERE direction = 'out')::bigint AS mensajes_salientes,
        COUNT(*) FILTER (WHERE ((content ? 'media') OR (content ? 'files')) AND direction = 'out')::bigint AS archivos_enviados,
        COUNT(*) FILTER (WHERE ((content->'media'->>'type') = 'audio' OR content->>'payload_type' = 'audio') AND direction = 'out')::bigint AS audios_enviados
      FROM chat_messages
      WHERE COALESCE(timestamp, created_at) >= $1::date
        AND COALESCE(timestamp, created_at) < $2::date
    ),
    chats AS (
      SELECT
        COUNT(*)::bigint AS total_chats,
        COUNT(*) FILTER (WHERE UPPER(status) IN ('OPEN','UNASSIGNED'))::bigint AS total_chats_abiertos,
        COUNT(*) FILTER (WHERE UPPER(status) = 'CLOSED')::bigint AS total_chats_cerrados,
        AVG(EXTRACT(EPOCH FROM (updated_at - created_at)))::numeric(12,2) AS tiempo_respuesta_promedio
      FROM chats
      WHERE COALESCE(updated_at, last_message_at, created_at) >= $1::date
        AND COALESCE(updated_at, last_message_at, created_at) < $2::date
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
      chats.tiempo_respuesta_promedio
    FROM msgs, chats
  `,
    [start, endExclusive]
  );
  return rows[0] || {};
};

const fallbackTimeseries = async ({ start, endExclusive }) => {
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

const fallbackChatsByQueue = async ({ start, endExclusive }) => {
  const { rows } = await pool.query(
    `
    SELECT
      c.queue_id,
      COALESCE(q.name, 'Sin cola') AS queue_name,
      COUNT(DISTINCT c.id) FILTER (WHERE UPPER(c.status) IN ('OPEN','UNASSIGNED'))::bigint AS total_abiertos,
      COUNT(DISTINCT c.id) FILTER (WHERE UPPER(c.status) = 'CLOSED')::bigint AS total_cerrados,
      COUNT(DISTINCT c.id)::bigint AS total_chats,
      COUNT(m.*)::bigint AS total_mensajes,
      AVG(EXTRACT(EPOCH FROM (c.updated_at - c.created_at)))::numeric(12,2) AS tiempo_respuesta_promedio,
      ROUND((COUNT(DISTINCT c.id) FILTER (WHERE UPPER(c.status) = 'CLOSED')::numeric / NULLIF(COUNT(DISTINCT c.id), 0)) * 100, 2) AS tasa_cierre,
      ROUND(COUNT(m.*)::numeric / NULLIF(COUNT(DISTINCT c.id), 0), 2) AS mensajes_por_chat
    FROM chats c
    LEFT JOIN queues q ON q.id = c.queue_id
    LEFT JOIN chat_messages m
      ON m.chat_id = c.id
     AND COALESCE(m.timestamp, m.created_at) >= $1::date
     AND COALESCE(m.timestamp, m.created_at) < $2::date
    WHERE COALESCE(c.updated_at, c.last_message_at, c.created_at) >= $1::date
      AND COALESCE(c.updated_at, c.last_message_at, c.created_at) < $2::date
    GROUP BY c.queue_id, q.name
    ORDER BY total_mensajes DESC
  `,
    [start, endExclusive]
  );
  return rows;
};

export const getOverviewMetrics = async ({ fecha_inicio, fecha_fin }) => {
  const { start, end, endExclusive } = ensureDates(fecha_inicio, fecha_fin);
  const { rows } = await pool.query(
    `
    WITH msgs AS (
      SELECT
        COALESCE(SUM(total_mensajes),0)::bigint AS total_mensajes,
        COALESCE(SUM(mensajes_in),0)::bigint AS mensajes_entrantes,
        COALESCE(SUM(mensajes_out),0)::bigint AS mensajes_salientes,
        COALESCE(SUM(archivos_out),0)::bigint AS archivos_enviados,
        COALESCE(SUM(audios_out),0)::bigint AS audios_enviados
      FROM dashboard_messages_daily
      WHERE date_key BETWEEN $1 AND $2
    ),
    chats AS (
      SELECT
        COALESCE(SUM(total_chats),0)::bigint AS total_chats,
        COALESCE(SUM(total_abiertos),0)::bigint AS total_chats_abiertos,
        COALESCE(SUM(total_cerrados),0)::bigint AS total_chats_cerrados,
        COALESCE(AVG(avg_tiempo_respuesta_secs),0)::numeric(12,2) AS tiempo_respuesta_promedio
      FROM dashboard_chats_daily
      WHERE date_key BETWEEN $1 AND $2
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
      chats.tiempo_respuesta_promedio
    FROM msgs, chats
  `,
    [start, end]
  );
  let result = rows[0] || {};
  if (isEmptyOverview(result)) {
    logger.warn({ start, end, tag: 'DASHBOARD_FALLBACK' }, 'Falling back to live aggregates for overview');
    result = await fallbackOverview({ start, endExclusive });
  }
  return enrichOverview(result, { start, end });
};

export const getMessagesTimeseries = async ({ fecha_inicio, fecha_fin }) => {
  const { start, end, endExclusive } = ensureDates(fecha_inicio, fecha_fin);
  const { rows } = await pool.query(
    `
    SELECT
      date_key,
      COALESCE(SUM(total_mensajes),0)::bigint AS total_mensajes,
      COALESCE(SUM(mensajes_in),0)::bigint AS mensajes_entrantes,
      COALESCE(SUM(mensajes_out),0)::bigint AS mensajes_salientes,
      COALESCE(SUM(archivos_out),0)::bigint AS archivos_enviados,
      COALESCE(SUM(audios_out),0)::bigint AS audios_enviados
    FROM dashboard_messages_daily
    WHERE date_key BETWEEN $1 AND $2
    GROUP BY date_key
    ORDER BY date_key ASC
  `,
    [start, end]
  );
  let data = rows;
  if (!data.length) {
    logger.warn({ start, end, tag: 'DASHBOARD_FALLBACK' }, 'Falling back to live aggregates for timeseries');
    data = await fallbackTimeseries({ start, endExclusive });
  }
  return data;
};

export const getChatsByQueue = async ({ fecha_inicio, fecha_fin }) => {
  const { start, end, endExclusive } = ensureDates(fecha_inicio, fecha_fin);
  const cached = await getDashboardCache('chats', start, end);
  if (cached) return cached;

  const { rows } = await pool.query(
    `
    WITH msg AS (
      SELECT queue_id,
             COALESCE(SUM(total_mensajes),0)::bigint AS total_mensajes
      FROM dashboard_messages_daily
      WHERE date_key BETWEEN $1 AND $2
      GROUP BY queue_id
    ),
    chat AS (
      SELECT queue_id,
             COALESCE(SUM(total_abiertos),0)::bigint AS total_abiertos,
             COALESCE(SUM(total_cerrados),0)::bigint AS total_cerrados,
             COALESCE(SUM(total_chats),0)::bigint AS total_chats,
             COALESCE(AVG(avg_tiempo_respuesta_secs),0)::numeric(12,2) AS avg_trs
      FROM dashboard_chats_daily
      WHERE date_key BETWEEN $1 AND $2
      GROUP BY queue_id
    )
    SELECT
      COALESCE(chat.queue_id, msg.queue_id) AS queue_id,
      COALESCE(q.name, 'Sin cola') AS queue_name,
      COALESCE(chat.total_abiertos, 0)::bigint AS total_abiertos,
      COALESCE(chat.total_cerrados, 0)::bigint AS total_cerrados,
      COALESCE(chat.total_chats, 0)::bigint AS total_chats,
      COALESCE(msg.total_mensajes, 0)::bigint AS total_mensajes,
      COALESCE(chat.avg_trs, 0)::numeric(12,2) AS tiempo_respuesta_promedio,
      ROUND((COALESCE(chat.total_cerrados, 0)::numeric / NULLIF(COALESCE(chat.total_chats, 0), 0)) * 100, 2) AS tasa_cierre,
      ROUND(COALESCE(msg.total_mensajes, 0)::numeric / NULLIF(COALESCE(chat.total_chats, 0), 0), 2) AS mensajes_por_chat
    FROM chat
    FULL OUTER JOIN msg ON msg.queue_id = chat.queue_id
    LEFT JOIN queues q ON q.id = COALESCE(chat.queue_id, msg.queue_id)
    ORDER BY total_mensajes DESC
  `,
    [start, end]
  );
  let data = rows;
  if (!data.length) {
    logger.warn({ start, end, tag: 'DASHBOARD_FALLBACK' }, 'Falling back to live aggregates for chats by queue');
    data = await fallbackChatsByQueue({ start, endExclusive });
  }
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
        SELECT
          COALESCE(UPPER(c.status), 'SIN ESTADO') AS label,
          COUNT(*)::bigint AS value
        FROM chats c
        WHERE COALESCE(c.updated_at, c.last_message_at, c.created_at) >= $1::date
          AND COALESCE(c.updated_at, c.last_message_at, c.created_at) < $2::date
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

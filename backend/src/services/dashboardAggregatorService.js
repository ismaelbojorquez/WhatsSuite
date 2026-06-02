import pool from '../infra/db/postgres.js';
import logger from '../infra/logging/logger.js';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
let running = false;

const ensureDashboardPartitionsForDates = async (dates) => {
  const uniqueMonths = new Set(
    dates
      .filter(Boolean)
      .map((date) => {
        const value = date instanceof Date ? date : new Date(date);
        if (Number.isNaN(value.getTime())) return null;
        return `${value.getUTCFullYear()}-${value.getUTCMonth() + 1}`;
      })
      .filter(Boolean)
  );

  for (const monthKey of uniqueMonths) {
    const [year, month] = monthKey.split('-').map(Number);
    await pool.query(`
      DO $$
      DECLARE
        start_date DATE := make_date(${year}, ${month}, 1);
      BEGIN
        IF to_regprocedure('ensure_monthly_range_partitions(regclass, text, date, date)') IS NOT NULL THEN
          PERFORM ensure_monthly_range_partitions(
            'dashboard_messages_daily'::regclass,
            'dashboard_messages_daily',
            start_date,
            start_date
          );
          PERFORM ensure_monthly_range_partitions(
            'dashboard_chats_daily'::regclass,
            'dashboard_chats_daily',
            start_date,
            start_date
          );
        ELSIF to_regprocedure('create_dashboard_partitions(integer, integer)') IS NOT NULL THEN
          PERFORM create_dashboard_partitions(${year}, ${month});
        END IF;
      END $$;
    `);
  }
};

const ensureMessageDailyPartitions = async () => {
  const { rows } = await pool.query(`
    SELECT DISTINCT COALESCE(timestamp, created_at)::date AS date_key
    FROM chat_messages
    WHERE COALESCE(timestamp, created_at) >= CURRENT_DATE - INTERVAL '2 days'
  `);
  await ensureDashboardPartitionsForDates(rows.map((row) => row.date_key));
};

const ensureChatDailyPartitions = async () => {
  const { rows } = await pool.query(`
    SELECT DISTINCT COALESCE(updated_at, last_message_at, created_at)::date AS date_key
    FROM chats
    WHERE COALESCE(updated_at, last_message_at, created_at) >= CURRENT_DATE - INTERVAL '2 days'
  `);
  await ensureDashboardPartitionsForDates(rows.map((row) => row.date_key));
};

const upsertMessagesDaily = async () => {
  await ensureMessageDailyPartitions();
  await pool.query(
    `
    WITH stats AS (
      SELECT
        COALESCE(cm.timestamp, cm.created_at)::date AS date_key,
        COALESCE(c.queue_id, $1::uuid) AS queue_id,
        COALESCE(c.assigned_agent_id, $1::uuid) AS agent_id,
        COUNT(*) AS total_mensajes,
        COUNT(*) FILTER (WHERE cm.direction = 'in') AS mensajes_in,
        COUNT(*) FILTER (WHERE cm.direction = 'out') AS mensajes_out,
        COUNT(*) FILTER (WHERE (cm.content ? 'media') OR (cm.content ? 'files')) AS archivos_out,
        COUNT(*) FILTER (WHERE (cm.content->'media'->>'type') = 'audio' OR cm.content->>'payload_type' = 'audio') AS audios_out
      FROM chat_messages cm
      INNER JOIN chats c ON c.id = cm.chat_id
      WHERE COALESCE(cm.timestamp, cm.created_at) >= CURRENT_DATE - INTERVAL '2 days'
      GROUP BY 1,2,3
    )
    INSERT INTO dashboard_messages_daily (date_key, queue_id, agent_id, status, total_mensajes, mensajes_in, mensajes_out, archivos_out, audios_out)
    SELECT date_key, queue_id, agent_id, NULL, total_mensajes, mensajes_in, mensajes_out, archivos_out, audios_out
    FROM stats
    ON CONFLICT (date_key, queue_id, agent_id) DO UPDATE
      SET total_mensajes = EXCLUDED.total_mensajes,
          mensajes_in    = EXCLUDED.mensajes_in,
          mensajes_out   = EXCLUDED.mensajes_out,
          archivos_out   = EXCLUDED.archivos_out,
          audios_out     = EXCLUDED.audios_out;
  `,
    [ZERO_UUID]
  );
};

const upsertChatsDaily = async () => {
  await ensureChatDailyPartitions();
  await pool.query(
    `
    WITH stats AS (
      SELECT
        COALESCE(c.updated_at, c.last_message_at, c.created_at)::date AS date_key,
        COALESCE(c.queue_id, $1::uuid) AS queue_id,
        COALESCE(c.assigned_agent_id, $1::uuid) AS agent_id,
        COUNT(*) AS total_chats,
        COUNT(*) FILTER (WHERE UPPER(c.status) IN ('OPEN','UNASSIGNED')) AS total_abiertos,
        COUNT(*) FILTER (WHERE UPPER(c.status) = 'CLOSED') AS total_cerrados,
        0::numeric(12,2) AS avg_tiempo_respuesta_secs
      FROM chats c
      WHERE COALESCE(c.updated_at, c.last_message_at, c.created_at) >= CURRENT_DATE - INTERVAL '2 days'
      GROUP BY 1,2,3
    )
    INSERT INTO dashboard_chats_daily (date_key, queue_id, agent_id, status, total_chats, total_abiertos, total_cerrados, avg_tiempo_respuesta_secs)
    SELECT date_key, queue_id, agent_id, NULL, total_chats, total_abiertos, total_cerrados, avg_tiempo_respuesta_secs
    FROM stats
    ON CONFLICT (date_key, queue_id, agent_id) DO UPDATE
      SET total_chats = EXCLUDED.total_chats,
          total_abiertos = EXCLUDED.total_abiertos,
          total_cerrados = EXCLUDED.total_cerrados,
          avg_tiempo_respuesta_secs = EXCLUDED.avg_tiempo_respuesta_secs;
  `,
    [ZERO_UUID]
  );
};

export const runDashboardAggregation = async () => {
  if (running) return;
  running = true;
  try {
    await upsertMessagesDaily();
    await upsertChatsDaily();
  } catch (err) {
    logger.error({ err, tag: 'DASHBOARD_AGG' }, 'Dashboard aggregation failed');
  } finally {
    running = false;
  }
};

export const startDashboardAggregator = () => {
  // Ejecuta cada 60 segundos.
  runDashboardAggregation().catch(() => {});
  return setInterval(() => runDashboardAggregation().catch(() => {}), 60_000);
};

import { promises as fs } from 'node:fs';
import logger from '../../infra/logging/logger.js';
import { createWorkerQueue } from '../../infra/queues/workerQueue.js';
import {
  bumpCampaignCounters,
  fetchPendingBroadcastBatch,
  lockAndUpdateCampaignRuntime,
  updateMessageError,
  updateMessageSent
} from '../../infra/db/broadcastRepository.js';
import { applySpintaxPayload } from './broadcast.spintax.js';
import { synthesizeVoiceNote } from './broadcast.tts.js';
import { sendWhatsAppMessage, getStatusForSession } from '../../services/whatsappService.js';
import { AppError } from '../../shared/errors.js';
import { findActiveReachoutRestriction } from '../../infra/db/whatsappReachoutRestrictionRepository.js';

const queue = createWorkerQueue({ concurrency: 5, maxQueue: 2000, name: 'broadcast', logger });
let poller = null;
let polling = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pickDelay = (min, max, last) => {
  const from = Math.max(0, Number(min) || 0);
  const to = Math.max(from, Number(max) || from);
  if (from === to) return from;
  let attempt = 0;
  let value = from;
  do {
    value = Math.floor(Math.random() * (to - from + 1)) + from;
    attempt += 1;
  } while (value === last && attempt < 5);
  return value;
};

const pickConnection = (available = [], statuses = [], lastConnection = null) => {
  if (!available.length) return null;
  const activeSet = new Set(
    statuses.filter((c) => (c.status || '').toLowerCase() === 'connected').map((c) => c.session_name)
  );
  const candidates = available.filter((c) => activeSet.has(c)) || [];
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const filtered = candidates.filter((c) => c !== lastConnection);
  const pool = filtered.length ? filtered : candidates;
  return pool[Math.floor(Math.random() * pool.length)];
};

const applyVariables = (payload = {}, variables = {}) => {
  const replacer = (val) =>
    typeof val === 'string'
      ? val.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key) => (variables[key] !== undefined && variables[key] !== null ? String(variables[key]) : ''))
      : val;
  const clone = JSON.parse(JSON.stringify(payload || {}));
  const applyField = (obj, key) => {
    if (obj && typeof obj === 'object' && typeof obj[key] === 'string') {
      obj[key] = replacer(obj[key]);
    }
  };
  applyField(clone, 'text');
  applyField(clone, 'body');
  applyField(clone, 'caption');
  if (clone.media) applyField(clone.media, 'caption');
  if (clone.tts) applyField(clone.tts, 'text');
  return clone;
};

const renderTemplate = (text, variables = {}) => {
  if (!text) return '';
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key) => {
    const v = variables[key];
    return v === undefined || v === null ? '' : String(v);
  });
};

const buildOutboundContent = async (message, payload) => {
  const type = message.message_type || message.campaign_message_type;
  const text = payload.text || payload.body || payload.caption || '';
  if (type === 'tts') {
    const voice = await synthesizeVoiceNote(text, payload.tts || {});
    return { audio: voice.buffer, mimetype: voice.mimeType, ptt: true, caption: payload.caption || null };
  }
  if (type === 'image') {
    const media = payload.media;
    if (!media?.path) throw new AppError('Imagen no disponible en almacenamiento', 422);
    const buffer = await fs.readFile(media.path);
    return { image: buffer, mimetype: media.mimeType || media.mimetype || 'image/jpeg', caption: text || null };
  }
  if (type === 'file') {
    const media = payload.media;
    if (!media?.path) throw new AppError('Archivo no disponible en almacenamiento', 422);
    const buffer = await fs.readFile(media.path);
    return {
      document: buffer,
      mimetype: media.mimeType || media.mimetype || 'application/octet-stream',
      fileName: media.fileName || 'archivo',
      caption: text || null
    };
  }
  return text;
};

const processMessage = async (message) => {
  const vars = message.payload?.variables || {};
  const rawPayload = { ...(message.payload || {}) };
  const baseTemplate = rawPayload.templateText || rawPayload.baseText || rawPayload.text || rawPayload.body || rawPayload.caption || '';
  const overrideText = typeof vars.textOverride === 'string' ? vars.textOverride.trim() : '';
  const textTemplate = overrideText || baseTemplate;
  const textWithVars = renderTemplate(textTemplate, vars);
  const basePayload = { ...rawPayload, text: textWithVars, body: textWithVars };
  if (basePayload.media) {
    basePayload.media.caption = renderTemplate(basePayload.media.caption || basePayload.caption || textWithVars, vars);
  }
  delete basePayload.variables;
  const payload = applySpintaxPayload(basePayload);
  const finalText = payload.text || payload.body || payload.caption || '';
  payload.text = finalText;
  payload.body = finalText;
  if (payload.media) {
    payload.media.caption = payload.media.caption || finalText;
  }
  const currentAttempt = (message.attempts || 0) + 1;
  const statuses = await Promise.all(
    (message.connections || []).map(async (session) => {
      try {
        const st = await getStatusForSession(session);
        const sessionStatus = st.status || 'unknown';
        const restriction = String(sessionStatus).toLowerCase() === 'connected'
          ? await findActiveReachoutRestriction({
              tenantId: message.tenant_id || null,
              sessionName: st.session,
              remoteNumber: message.target
            }).catch(() => null)
          : null;
        return {
          session_name: st.session,
          status: restriction ? 'target_blocked' : sessionStatus,
          reachoutRestriction: restriction
        };
      } catch (err) {
        logger.warn({ err, session, tag: 'BROADCAST_STATUS' }, 'No se pudo obtener estado de conexión');
        return { session_name: session, status: 'unknown' };
      }
    })
  );
  const now = new Date();
  if (message.start_at && new Date(message.start_at) > now) {
    await updateMessageError({
      messageId: message.id,
      error: 'Fuera de ventana de envío (antes de inicio)',
      retryAt: new Date(message.start_at),
      final: false
    });
    return;
  }
  if (message.stop_at && new Date(message.stop_at) < now) {
    await updateMessageError({
      messageId: message.id,
      error: 'Ventana de envío expirada',
      retryAt: null,
      final: true
    });
    await bumpCampaignCounters(message.campaign_id);
    return;
  }
  const { next, runtime } = await lockAndUpdateCampaignRuntime(message.campaign_id, (rt) => {
    const chosen = pickConnection(rt.connections || [], statuses, rt.last_connection || null);
    const delaySeconds = pickDelay(rt.delay_min_seconds, rt.delay_max_seconds, rt.last_delay_seconds);
    return { lastDelaySeconds: delaySeconds, lastConnection: chosen };
  });
  const connection = next?.lastConnection || runtime?.last_connection || null;
  const delaySeconds =
    typeof next?.lastDelaySeconds === 'number'
      ? next.lastDelaySeconds
      : typeof next?.lastDelayMs === 'number'
        ? next.lastDelayMs
        : runtime?.last_delay_seconds || 0;
  const delayMs = Math.max(0, Number(delaySeconds || 0) * 1000);
  if (!connection) {
    const blocked = statuses.filter((status) => status.reachoutRestriction);
    if (blocked.length) {
      const blockedUntil = blocked
        .map((status) => status.reachoutRestriction?.blockedUntil)
        .filter(Boolean)
        .sort()[0] || null;
      await updateMessageError({
        messageId: message.id,
        error: 'WhatsApp Web bloqueó temporalmente el envío a este contacto desde las conexiones disponibles',
        retryAt: blockedUntil ? new Date(blockedUntil) : null,
        final: false
      });
      await bumpCampaignCounters(message.campaign_id);
      logger.warn(
        {
          messageId: message.id,
          target: message.target,
          campaignId: message.campaign_id,
          blockedConnections: blocked.map((status) => status.session_name),
          blockedUntil,
          tag: 'BROADCAST_REACHOUT_BLOCKED'
        },
        'Broadcast message skipped because target is blocked for all available connections'
      );
      return;
    }
    const final = currentAttempt >= (message.max_attempts || 3);
    await updateMessageError({
      messageId: message.id,
      error: 'Sin conexiones activas para enviar',
      retryAt: new Date(Date.now() + 30_000),
      final
    });
    await bumpCampaignCounters(message.campaign_id);
    return;
  }
  if (delayMs > 0) {
    await sleep(delayMs);
  }
  try {
    const content = await buildOutboundContent(message, payload);
    await sendWhatsAppMessage({
      sessionName: connection,
      remoteNumber: message.target,
      contactNumber: message.target,
      content
    });
    await updateMessageSent({ messageId: message.id, sessionName: connection, delaySeconds });
  } catch (err) {
    const isReachoutBlocked = err?.code === 'WA_ACCOUNT_RESTRICTED' || err?.code === 'WA_REACHOUT_BLOCKED';
    const isFinal = !isReachoutBlocked && currentAttempt >= (message.max_attempts || 3);
    const reachoutRetryAt = err?.context?.blockedUntil ? new Date(err.context.blockedUntil) : new Date(Date.now() + 60 * 60 * 1000);
    await updateMessageError({
      messageId: message.id,
      error: err?.message || 'Error enviando mensaje',
      retryAt: isReachoutBlocked ? reachoutRetryAt : new Date(Date.now() + 45_000),
      final: isFinal
    });
    logger.error({ err, messageId: message.id, target: message.target, campaignId: message.campaign_id }, 'Broadcast send failed');
  } finally {
    await bumpCampaignCounters(message.campaign_id);
  }
};

const pump = async () => {
  if (polling) return;
  polling = true;
  try {
    const batch = await fetchPendingBroadcastBatch(40);
    for (const msg of batch) {
      queue.enqueue(() => processMessage(msg)).catch((err) =>
        logger.error({ err, messageId: msg.id, campaignId: msg.campaign_id }, 'Queue enqueue failed')
      );
    }
  } catch (err) {
    logger.error({ err }, 'Broadcast worker pump failed');
  } finally {
    polling = false;
  }
};

export const startBroadcastWorker = () => {
  if (poller) return;
  logger.info({ tag: 'BROADCAST_WORKER' }, 'Starting broadcast worker');
  pump().catch((err) => logger.error({ err }, 'Initial broadcast pump failed'));
  poller = setInterval(() => {
    pump().catch((err) => logger.error({ err }, 'Broadcast pump error'));
  }, 1000);
};

export const stopBroadcastWorker = () => {
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
};

// Socket conforme a documentación de Baileys: auto-conecta, emite eventos y persiste auth en Postgres.
import EventEmitter from 'node:events';
import makeWASocket, { fetchLatestBaileysVersion, DisconnectReason, jidNormalizedUser, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import logger from '../infra/logging/logger.js';
import { createPostgresAuthState } from './whatsappAuthState.js';
import pool from '../infra/db/postgres.js';
import { recordWhatsAppError } from '../infra/db/whatsappErrorRepository.js';
import { recordWhatsAppAudit } from '../infra/db/whatsappAuditRepository.js';
import { findMessageByUniqueKey } from '../infra/db/chatMessageRepository.js';
import env from '../config/env.js';
import { saveMediaBuffer } from '../infra/storage/mediaStorage.js';
import { createWorkerQueue } from '../infra/queues/workerQueue.js';
import {
  getTenantIdForSession,
  updateHistorySyncState,
  findSessionByName,
  updateSessionSyncTracking
} from '../infra/db/whatsappSessionRepository.js';
import { buildMediaUrl } from '../shared/mediaUrl.js';

const buildSocketLogger = () => pino({ level: 'silent' });

const normalizeRemoteJid = (jid) => (jid || '').split('@')[0];
const digitsOnly = (value) => (value ? String(value).replace(/[^\d]/g, '') : '');

const toMessageDate = (messageTimestamp) => {
  const tsNumber = messageTimestamp !== undefined && messageTimestamp !== null ? Number(messageTimestamp) : null;
  return Number.isFinite(tsNumber) ? new Date(tsNumber * 1000) : new Date();
};

const ACK_STATUS = {
  0: 'error',
  1: 'pending',
  2: 'server',
  3: 'delivered',
  4: 'read',
  5: 'played'
};

const attachedSockets = new WeakSet();
const realtimeQueue = createWorkerQueue({
  concurrency: env.workers.realtimeConcurrency,
  maxQueue: env.workers.realtimeQueueLimit,
  name: 'wa-realtime',
  logger
});
const historyQueue = createWorkerQueue({
  concurrency: 1,
  maxQueue: (env.workers?.realtimeQueueLimit || 500) * 4,
  name: 'wa-history',
  logger
});
const RESYNC_BATCH = 40;
const avatarCache = new Map();

const unwrapMessage = (message) => {
  let current = message;

  while (true) {
    if (current?.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }

    if (current?.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }

    if (current?.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }

    if (current?.editedMessage?.message) {
      current = current.editedMessage.message;
      continue;
    }

    break;
  }

  return current;
};

const extractMediaDescriptor = (contentMessage) => {
  if (!contentMessage || typeof contentMessage !== 'object') return null;
  if (contentMessage.imageMessage) {
    return {
      kind: 'image',
      mimeType: contentMessage.imageMessage.mimetype || null,
      fileName: contentMessage.imageMessage.fileName || contentMessage.imageMessage.caption || null,
      caption: contentMessage.imageMessage.caption || null
    };
  }
  if (contentMessage.stickerMessage) {
    return {
      kind: 'sticker',
      mimeType: contentMessage.stickerMessage.mimetype || 'image/webp',
      fileName: contentMessage.stickerMessage.fileName || 'sticker.webp',
      caption: null,
      isSticker: true
    };
  }
  if (contentMessage.videoMessage) {
    return {
      kind: 'video',
      mimeType: contentMessage.videoMessage.mimetype || null,
      fileName: contentMessage.videoMessage.fileName || contentMessage.videoMessage.caption || null,
      caption: contentMessage.videoMessage.caption || null
    };
  }
  if (contentMessage.audioMessage) {
    return {
      kind: 'audio',
      mimeType: contentMessage.audioMessage.mimetype || null,
      fileName: contentMessage.audioMessage.fileName || null,
      caption: null,
      isVoiceNote: !!contentMessage.audioMessage.ptt,
      duration: contentMessage.audioMessage.seconds || contentMessage.audioMessage.duration || null
    };
  }
  if (contentMessage.documentMessage) {
    const isAudioDoc = contentMessage.documentMessage.mimetype?.startsWith('audio/');
    return {
      kind: isAudioDoc ? 'audio' : 'document',
      mimeType: contentMessage.documentMessage.mimetype || null,
      fileName: contentMessage.documentMessage.fileName || null,
      caption: contentMessage.documentMessage.caption || null,
      isVoiceNote: false,
      duration: null
    };
  }
  return null;
};

const extractMessageContent = (contentMessage) => {
  const base = contentMessage || {};

  const sanitize = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  };

  const conversation = sanitize(base.conversation);
  if (conversation) return { text: conversation, type: 'text', raw: base };

  const extended = sanitize(base.extendedTextMessage?.text);
  if (extended) return { text: extended, type: 'text', raw: base };

  if (base.reactionMessage) return { text: null, type: 'reaction', raw: base };
  if (base.protocolMessage) return { text: null, type: 'protocol', raw: base };
  if (base.buttonsResponseMessage) return { text: sanitize(base.buttonsResponseMessage?.selectedDisplayText) || null, type: 'button', raw: base };
  if (base.listResponseMessage) return { text: sanitize(base.listResponseMessage?.title) || null, type: 'list', raw: base };

  if (base.imageMessage) {
    const text = sanitize(base.imageMessage.caption) || null;
    return { text, type: 'text', raw: base };
  }

  if (base.videoMessage) {
    const text = sanitize(base.videoMessage.caption) || null;
    return { text, type: 'text', raw: base };
  }

  if (base.stickerMessage) return { text: null, type: 'sticker', raw: base };

  if (base.audioMessage) return { text: null, type: 'unknown', raw: base };

  return { text: null, type: 'unknown', raw: base };
};

const setSessionStatus = async (sessionName, status, { lastConnectedAt, tenantId } = {}) => {
  const normalized = typeof status === 'string' ? status.toLowerCase() : 'pending';
  const allowedStatus =
    normalized === 'connected'
      ? 'connected'
      : normalized === 'disconnected' || normalized === 'invalid'
      ? 'disconnected'
      : 'pending';
  const resolvedTenant = await getTenantIdForSession(sessionName, tenantId);
  const sql = `
    INSERT INTO whatsapp_sessions (session_name, name, connection_id, status, creds, keys, tenant_id, updated_at${lastConnectedAt ? ', last_connected_at' : ''})
    VALUES (
      $1,
      $2,
      COALESCE((SELECT connection_id FROM whatsapp_sessions WHERE session_name = $1), NULL),
      $3,
      COALESCE((SELECT creds FROM whatsapp_sessions WHERE session_name = $1), '{}'::jsonb),
      COALESCE((SELECT keys FROM whatsapp_sessions WHERE session_name = $1), '{}'::jsonb),
      $4,
      NOW()
      ${lastConnectedAt ? ', $5' : ''}
    )
    ON CONFLICT (session_name) DO UPDATE
      SET name = EXCLUDED.name,
          connection_id = COALESCE(whatsapp_sessions.connection_id, EXCLUDED.connection_id),
          status = EXCLUDED.status,
          tenant_id = COALESCE(whatsapp_sessions.tenant_id, EXCLUDED.tenant_id),
          updated_at = NOW()
          ${lastConnectedAt ? ', last_connected_at = EXCLUDED.last_connected_at' : ''}
  `;

  const params = lastConnectedAt
    ? [sessionName, sessionName, allowedStatus, resolvedTenant, lastConnectedAt]
    : [sessionName, sessionName, allowedStatus, resolvedTenant];
  await pool.query(sql, params);
};

const socketRegistry = new Map();
const lastConnectionUpdate = new Map();
const lastQrBySession = new Map();
const LOG_TAG = undefined;

const logWhatsAppAckDebug = (tag, data, message) => {
  if (!env.whatsapp?.debugAck) return;
  logger.info({ tag, ...data }, message);
};

const summarizeMessageUpdate = (update) => ({
  key: {
    id: update?.key?.id || null,
    remoteJid: update?.key?.remoteJid || null,
    remoteJidAlt: update?.key?.remoteJidAlt || null,
    participant: update?.key?.participant || null,
    fromMe: update?.key?.fromMe ?? null
  },
  status: update?.status ?? null,
  updateStatus: update?.update?.status ?? null,
  updateKeys: update?.update && typeof update.update === 'object' ? Object.keys(update.update).slice(0, 12) : [],
  messageStubType: update?.messageStubType ?? update?.update?.messageStubType ?? null,
  messageStubParameters: update?.messageStubParameters || update?.update?.messageStubParameters || null,
  error: update?.error?.message || update?.error?.toString?.() || null
});

const summarizeBinaryNode = (node) => ({
  tag: node?.tag || null,
  attrs: node?.attrs || {},
  childTags: Array.isArray(node?.content)
    ? node.content
        .map((child) => child?.tag)
        .filter(Boolean)
        .slice(0, 12)
    : []
});

export const createWhatsAppSocket = async (
  sessionName = 'default',
  { syncHistory = false, tenantId = null, historyDays = env.whatsapp?.historySyncDays || 30 } = {}
) => {
  const events = new EventEmitter();
  const { state, saveCreds, resetState, getKeysSnapshot } = await createPostgresAuthState(sessionName);
  let authKeysSnapshot = getKeysSnapshot();
  const authState = {
    creds: state.creds,
    keys: {
      get: async (type, ids) => {
        const result = await state.keys.get(type, ids);
        authKeysSnapshot = getKeysSnapshot();
        return result;
      },
      set: async (data) => {
        await state.keys.set(data);
        authKeysSnapshot = getKeysSnapshot();
      },
      delete: async (data) => {
        await state.keys.delete(data);
        authKeysSnapshot = getKeysSnapshot();
      }
    }
  };
  const { version } = await fetchLatestBaileysVersion();
  const sessionContext = {
    syncHistory: Boolean(syncHistory),
    tenantId: tenantId || null,
    selfJid: state?.creds?.me?.id || null,
    selfNumber: digitsOnly(state?.creds?.me?.id),
    historyDays: Number(historyDays) || env.whatsapp?.historySyncDays || 30
  };

  let sock;
  let restarting = false;
  let resyncRunning = false;
  let reconnectAttempts = 0;
  let loggedOutQrRestarted = false;

  const logDiscard = ({ reason, messageId = null, remoteNumber = null, remoteJid = null, extra = {} }) => {
    logger.info({ sessionName, messageId, remoteNumber, remoteJid, reason, tag: LOG_TAG, ...extra }, 'Inbound message IGNORED');
  };

  const recordSyncAudit = async (event, metadata = {}) => {
    await recordWhatsAppAudit({
      sessionName,
      connectionId: null,
      event,
      tenantId: sessionContext.tenantId,
      metadata
    }).catch(() => {});
  };

  const markSyncState = async ({
    syncState = null,
    syncError = null,
    lastSyncedAt = null,
    lastMessageId = null,
    lastDisconnectAt = null,
    lastConnectAt = null
  } = {}) =>
    updateSessionSyncTracking({
      sessionName,
      tenantId: sessionContext.tenantId,
      syncState,
      syncError,
      lastSyncedAt,
      lastMessageId,
      lastDisconnectAt,
      lastConnectAt
    }).catch(() => {});

  const restartSocket = async (cause) => {
    if (restarting) return;
    restarting = true;
    try {
      try {
        sock?.end();
      } catch (_err) {
        // ignore
      }
      events.emit('status', { sessionName, status: 'restarting', cause });
      await setSessionStatus(sessionName, 'restarting', { tenantId: sessionContext.tenantId });
      sock = createSocketInstance();
      logger.info({ sessionName, cause }, 'WhatsApp socket restarted');
      reconnectAttempts += 1;
    } catch (err) {
      await recordWhatsAppError({
        sessionName,
        category: 'integration',
        message: err?.message || 'Error restarting socket',
        context: { cause },
        tenantId: sessionContext.tenantId
      }).catch(() => {});
      logger.error({ err, sessionName }, 'Failed to restart socket');
    } finally {
      restarting = false;
    }
  };

  const handleConnectionUpdate = async (update) => {
    try {
      const { connection, lastDisconnect, qr } = update;
      lastConnectionUpdate.set(sessionName, update);
      if (update?.user?.id || update?.id) {
        sessionContext.selfJid = update.user?.id || update.id;
        sessionContext.selfNumber = digitsOnly(sessionContext.selfJid);
      }

      if (qr) {
        if (lastQrBySession.get(sessionName) === qr) {
          await setSessionStatus(sessionName, 'pending', { tenantId: sessionContext.tenantId });
          return;
        }
        lastQrBySession.set(sessionName, qr);
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { type: 'image/png', margin: 1 });
          const qrBase64 = qrDataUrl.split(',')[1] || qrDataUrl;
          events.emit('qr', { sessionName, qr, qrBase64 });
          await setSessionStatus(sessionName, 'pending', { tenantId: sessionContext.tenantId });
          logger.info({ sessionName, tag: LOG_TAG }, 'QR ready for scan');
        } catch (err) {
          logger.error({ err, sessionName, tag: LOG_TAG }, 'Failed to process QR');
        }
        return;
      }

      if (connection === 'open') {
        const snapshot = authKeysSnapshot || {};
        const preKeysCount = Object.keys(snapshot?.preKeys || {}).length;
        const sessionsCount = Object.keys(snapshot?.sessions || {}).length;
        if (preKeysCount === 0 || sessionsCount === 0) {
          logger.warn(
            { sessionName, preKeysCount, sessionsCount, tag: 'WA_AUTH_COUNTS' },
            'Auth state missing preKeys or sessions after connect; allowing connection but investigate persistence'
          );
        }
        lastQrBySession.delete(sessionName);
        const connectedAt = new Date();
        await setSessionStatus(sessionName, 'connected', { lastConnectedAt: connectedAt, tenantId: sessionContext.tenantId });
        await markSyncState({ syncState: 'SYNCING', lastConnectAt: connectedAt, syncError: null });
        await recordSyncAudit('RECONNECT_DETECTED', { at: connectedAt });
        reconnectAttempts = 0;
        loggedOutQrRestarted = false;
        events.emit('status', { sessionName, status: 'connected' });
        logger.info({ sessionName, tag: LOG_TAG }, 'WhatsApp connection open');
        historyQueue.enqueue(() => performIncrementalResync());
        return;
      }

      if (connection === 'connecting') {
        // socket status connecting
        await setSessionStatus(sessionName, 'connecting', { tenantId: sessionContext.tenantId });
        events.emit('status', { sessionName, status: 'connecting' });
        logger.info({ sessionName, tag: LOG_TAG }, 'WhatsApp connection connecting');
        return;
      }

      if (connection === 'close') {
        lastQrBySession.delete(sessionName);
        const reasonCode =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.output?.payload?.statusCode ||
          lastDisconnect?.error?.code ||
          null;
        const reasonKey = reasonCode !== null ? DisconnectReason[reasonCode] : undefined;
        const reasonMessage =
          lastDisconnect?.error?.message || lastDisconnect?.error?.toString() || reasonKey || null;
        const disconnectAt = new Date();
        await markSyncState({ syncState: 'DISCONNECTED', syncError: reasonMessage, lastDisconnectAt: disconnectAt });
        await recordSyncAudit('DISCONNECT_DETECTED', { reason: reasonMessage, at: disconnectAt });

        if (reasonCode === DisconnectReason.restartRequired) {
          logger.warn(
            { sessionName, reasonCode, reasonKey, attempt: reconnectAttempts, tag: LOG_TAG },
            'Restart required; attempting auto-reconnect'
          );
          if (reconnectAttempts < 5) {
            await setSessionStatus(sessionName, 'reconnecting', { tenantId: sessionContext.tenantId });
            await restartSocket('restartRequired');
            return;
          }
        }

      if (reasonCode === DisconnectReason.loggedOut) {
        let resetSucceeded = false;
        try {
          const reset = await resetState();
          state.creds = reset.creds;
          authState.creds = reset.creds;
          authKeysSnapshot = reset.keys || {};
          resetSucceeded = true;
          reconnectAttempts = 0;
          await setSessionStatus(sessionName, 'pending', { tenantId: sessionContext.tenantId });
        } catch (err) {
          logger.error({ err, sessionName }, 'Failed to reset auth state after loggedOut');
        }

        if (!resetSucceeded) {
          events.emit('status', {
            sessionName,
            status: 'invalid',
            reasonCode,
            reason: reasonMessage
          });
          return;
        }

        events.emit('status', {
          sessionName,
          status: 'pending',
          reasonCode,
          reason: reasonMessage
        });
        logger.warn(
          { sessionName, reasonCode, reasonKey, reasonMessage, tag: LOG_TAG },
          'WhatsApp session logged out; auth reset and QR scan required'
        );
        if (!loggedOutQrRestarted) {
          loggedOutQrRestarted = true;
          await restartSocket('loggedOutReset');
        }
        return;
      }

        if (reasonCode === DisconnectReason.connectionLost) {
          logger.warn(
            { sessionName, reasonCode, reasonKey, attempt: reconnectAttempts, tag: LOG_TAG },
            'Connection lost; attempting auto-reconnect'
          );
          if (reconnectAttempts < 5) {
            await setSessionStatus(sessionName, 'reconnecting', { tenantId: sessionContext.tenantId });
            await restartSocket('connectionLost');
            return;
          }
        }

        if (reconnectAttempts < 5) {
          reconnectAttempts += 1;
          logger.warn(
            { sessionName, reasonCode, reasonKey, attempt: reconnectAttempts, tag: LOG_TAG },
            'Connection closed; auto-reconnect attempt'
          );
          await setSessionStatus(sessionName, 'reconnecting', { tenantId: sessionContext.tenantId });
          await restartSocket('connectionClosed');
          return;
        }

        await setSessionStatus(sessionName, 'disconnected', { tenantId: sessionContext.tenantId });
        events.emit('status', {
          sessionName,
          status: 'disconnected',
          reasonCode,
          reason: reasonMessage
        });
        logger.warn({ sessionName, reasonCode, reasonKey, reasonMessage, tag: LOG_TAG }, 'WhatsApp connection closed');
        return;
      }
    } catch (err) {
      await recordWhatsAppError({
        sessionName,
        category: 'integration',
        message: err?.message || 'Error handling connection.update',
        context: { stack: err?.stack },
        tenantId: sessionContext.tenantId
      }).catch(() => {});
      logger.error({ err, sessionName, tag: LOG_TAG }, 'Error handling connection.update');
    }
  };

  const handleMessagesUpsert = async ({ type, messages, isHistory = false }) => {

    const historyDays = Number(sessionContext.historyDays || env.whatsapp?.historySyncDays || 0);
    const historyCutoffMs =
      isHistory && historyDays > 0 ? Date.now() - historyDays * 24 * 60 * 60 * 1000 : null;

    try {
      if (!Array.isArray(messages) || messages.length === 0) {
        return;
      }

      for (const msg of messages) {
        // Refrescar JID propio con datos de socket vivos.
        sessionContext.selfJid = sock?.user?.id || sock?.authState?.creds?.me?.id || sessionContext.selfJid;
        sessionContext.selfNumber = digitsOnly(sessionContext.selfJid) || sessionContext.selfNumber || digitsOnly(sessionName);

        const messageId = msg?.key?.id || null;
        const pushName = typeof msg?.pushName === 'string' ? msg.pushName : null;
        // Selecciona el JID real prefiriendo cualquier variante @s.whatsapp.net si está presente (sea remoteJid o remoteJidAlt).
        const primaryJid = msg?.key?.remoteJid || null;
        const altJid = msg?.key?.remoteJidAlt || null;
        const jidWithDomain =
          [primaryJid, altJid].find((jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')) ||
          primaryJid ||
          altJid ||
          null;
        const normalizedJid = jidWithDomain ? jidNormalizedUser(jidWithDomain) : jidWithDomain;
        const remoteNumber = normalizeRemoteJid(normalizedJid);
        const selfJid = sessionContext.selfJid ? jidNormalizedUser(sessionContext.selfJid) : null;
        const selfDigits = sessionContext.selfNumber || digitsOnly(sessionName);
        const avatarCacheKey = normalizedJid ? `${sessionName}:${normalizedJid}` : null;

        if (!msg) {
          logDiscard({ reason: 'null_message' });
          continue;
        }
        if (!messageId) {
          logDiscard({ reason: 'missing_id', remoteNumber, remoteJid: normalizedJid });
          continue;
        }
        if (!normalizedJid) {
          logDiscard({ reason: 'missing_remote_jid', messageId });
          continue;
        }
        if (normalizedJid === 'status@broadcast' || normalizedJid.endsWith('@broadcast') || normalizedJid.endsWith('@g.us')) {
          logDiscard({ reason: 'broadcast', messageId, remoteNumber, remoteJid: normalizedJid });
          continue;
        }
        if ((selfJid && normalizedJid === selfJid) || (selfDigits && digitsOnly(remoteNumber) === selfDigits)) {
          logDiscard({ reason: 'self_message', messageId, remoteNumber, remoteJid: normalizedJid });
          continue;
        }

        // messageStubType === 2 es un stub de Signal/PreKey: WhatsApp Web envía este placeholder mientras negocia claves.
        // No contiene el payload; el mensaje real llega en un upsert posterior (puede reutilizar el mismo messageId).
        if (msg.messageStubType === 2) {
          continue;
        }

        const contentMessage = unwrapMessage(msg?.message || {});
        const protocolType = contentMessage?.protocolMessage?.type || null;
        const hasHistorySync = Boolean(contentMessage?.protocolMessage?.historySyncNotification);
        if (protocolType || hasHistorySync) {
          logDiscard({ reason: 'protocol_message', protocolType, messageId, remoteNumber, remoteJid: normalizedJid });
          continue;
        }

        if (historyCutoffMs && msg.messageTimestamp) {
          const tsMs = Number(msg.messageTimestamp) * 1000;
          if (Number.isFinite(tsMs) && tsMs < historyCutoffMs) {
            logDiscard({ reason: 'history_cutoff', messageId, remoteNumber, remoteJid: normalizedJid, cutoffMs: historyCutoffMs });
            continue;
          }
        }

        const { text, type: messageType, raw } = extractMessageContent(contentMessage);
        if (contentMessage?.templateMessage) {
          logDiscard({ reason: 'template_message', messageId, remoteNumber, remoteJid: normalizedJid });
          continue;
        }
        const mediaDescriptor = extractMediaDescriptor(contentMessage);
        let mediaMeta = null;

        if (mediaDescriptor) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: buildSocketLogger(), reuploadRequest: sock?.updateMediaMessage });
            const mimeType = mediaDescriptor.mimeType || 'application/octet-stream';
            const sizeBytes = buffer.length;
            const maxBytes = env.media?.maxBytes || 6 * 1024 * 1024;
            const allowed = env.media?.allowedMimePrefixes || ['image/', 'video/', 'audio/', 'application/'];
            const isAllowed = allowed.some((p) => mimeType.toLowerCase().startsWith(p.toLowerCase()));
            if (!isAllowed) {
              throw new Error(`Mime no permitido: ${mimeType}`);
            }
            if (sizeBytes > maxBytes) {
              throw new Error(`Archivo supera límite (${sizeBytes} > ${maxBytes})`);
            }
            const stored = await saveMediaBuffer({
              buffer,
              mimeType,
              originalName: mediaDescriptor.fileName || `${mediaDescriptor.kind}-${messageId}`
            });
            mediaMeta = {
              type: mediaDescriptor.kind,
              mimeType,
              sizeBytes,
              sha256: stored.sha256,
              fileName: stored.fileName,
              storagePath: stored.path,
              relativePath: stored.relativePath,
              caption: mediaDescriptor.caption || text || null,
              isVoiceNote: mediaDescriptor.isVoiceNote || false,
              duration: mediaDescriptor.duration || null
            };
          } catch (err) {
            await recordWhatsAppError({
              sessionName,
              category: 'media',
              message: err?.message || 'Error al procesar media entrante',
              context: { messageId, mimeType: mediaDescriptor?.mimeType || null },
              tenantId: sessionContext.tenantId
            }).catch(() => {});
            logger.warn({ err, sessionName, messageId, tag: 'WA_MEDIA_SKIP' }, 'Media entrante ignorada por validación');
            continue;
          } finally {
            // downloadMediaMessage puede dejar streams temporales; cualquier error se ignora aquí.
          }
        }

        const existing = await findMessageByUniqueKey({
          sessionName,
          remoteNumber,
          whatsappMessageId: messageId,
          tenantId: sessionContext.tenantId
        });
        if (existing) {
          continue;
        }

        const timestamp = toMessageDate(msg.messageTimestamp);
        const contentPreview = text ? text.slice(0, 120) : null;

        logger.info(
          { sessionName, messageId, remoteJid: normalizedJid, remoteNumber, contentPreview, messageType, tag: 'WA_ACCEPTED_MESSAGE' },
          'Inbound message ACCEPTED'
        );

        logger.info(
          { sessionName, messageId, remoteJid: normalizedJid, contentPreview, messageType, tag: 'WA_MESSAGE_PARSED' },
          'Inbound WhatsApp message parsed'
        );

        let contactAvatar = null;
        if (avatarCacheKey) {
          const cached = avatarCache.get(avatarCacheKey);
          const now = Date.now();
          const ttlMs = 30 * 60 * 1000; // 30 minutos para evitar golpes excesivos
          if (cached && now - cached.ts < ttlMs) {
            contactAvatar = cached.url;
          } else if (sock?.profilePictureUrl) {
            try {
              const url = await sock.profilePictureUrl(normalizedJid, 'image');
              if (url) {
                const resp = await fetch(url);
                if (resp.ok) {
                  const buffer = Buffer.from(await resp.arrayBuffer());
                  const mimeType = resp.headers.get('content-type') || 'image/jpeg';
                  const media = await saveMediaBuffer({ buffer, mimeType });
                  contactAvatar = buildMediaUrl(media);
                } else {
                  contactAvatar = url; // fallback público si no pudimos descargar
                }
              }
              avatarCache.set(avatarCacheKey, { url: contactAvatar, ts: now });
            } catch (err) {
              avatarCache.set(avatarCacheKey, { url: null, ts: now });
            }
          }
        }

        const statusFromUpsert = msg.key?.fromMe ? mapUpsertStatus(msg.status) : null;

        await events.emit('message', {
          sessionName,
          remoteNumber,
          remoteJid: normalizedJid,
          messageId,
          messageTimestamp: msg.messageTimestamp,
          content: raw || contentMessage || {},
          text,
          timestamp,
          fromMe: Boolean(msg.key?.fromMe),
          messageType,
          messageStatus: statusFromUpsert,
          media: mediaMeta,
          tenantId: sessionContext.tenantId,
          contactName: pushName,
          contactAvatar,
          pushName,
          isArchived: false,
          isMuted: false,
          isHistory: Boolean(isHistory || (type && String(type).toLowerCase().includes('history')))
        });

        logger.info(
          { sessionName, messageId, remoteJid: normalizedJid, contentPreview, messageType, tag: 'WA_MESSAGE_DISPATCHED' },
          'Inbound WhatsApp message dispatched'
        );

        await recordWhatsAppAudit({
          sessionName,
          event: 'message_in',
          tenantId: sessionContext.tenantId,
          metadata: { remoteNumber, messageId, timestamp }
        }).catch(() => {});
      }
    } catch (err) {
      logger.error({ err, sessionName }, 'Failed to process messages.upsert');
    }
  };

  const handleMessagingHistory = async (history) => {
    const messages = history?.messages || [];
    const syncType = history?.syncType || null;
    const total = Array.isArray(messages) ? messages.length : 0;

    if (!sessionContext.syncHistory) {
      if (total > 0) {
        updateHistorySyncState({
          sessionName,
          tenantId: sessionContext.tenantId,
          status: 'disabled',
          progress: { syncType, total, processed: 0 }
        }).catch(() => {});
      }
      logger.info({ sessionName, count: total, syncType, tag: LOG_TAG }, 'History sync skipped (disabled)');
      return;
    }

    if (!Array.isArray(messages) || messages.length === 0) return;

    let processed = 0;
    await updateHistorySyncState({
      sessionName,
      tenantId: sessionContext.tenantId,
      status: 'running',
      progress: { syncType, total, processed }
    }).catch(() => {});
        await recordWhatsAppAudit({
          sessionName,
          event: 'history_sync_started',
          tenantId: sessionContext.tenantId,
          metadata: { syncType, total }
        }).catch(() => {});

    try {
      const batchSize = 25;
      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        await historyQueue.enqueue(() =>
          handleMessagesUpsert({ messages: batch, type: syncType || 'history', isHistory: true })
        );
        processed += batch.length;
        await updateHistorySyncState({
          sessionName,
          tenantId: sessionContext.tenantId,
          status: 'running',
          progress: { syncType, total, processed }
        }).catch(() => {});
      }

      await updateHistorySyncState({
        sessionName,
        tenantId: sessionContext.tenantId,
        status: 'completed',
        progress: { syncType, total, processed },
        syncedAt: new Date().toISOString()
      }).catch(() => {});
      await recordWhatsAppAudit({
        sessionName,
        event: 'history_sync_completed',
        tenantId: sessionContext.tenantId,
        metadata: { syncType, total, processed }
      }).catch(() => {});
      logger.info({ sessionName, total, syncType, tag: LOG_TAG }, 'History sync completed');
    } catch (err) {
      await updateHistorySyncState({
        sessionName,
        tenantId: sessionContext.tenantId,
        status: 'error',
        progress: { syncType, total, processed },
        cursor: { error: err?.message || 'history_sync_failed' }
      }).catch(() => {});
      await recordWhatsAppAudit({
        sessionName,
        event: 'history_sync_error',
        tenantId: sessionContext.tenantId,
        metadata: { syncType, total, processed, message: err?.message || null }
      }).catch(() => {});
      logger.error({ err, sessionName, count: total, syncType, tag: LOG_TAG }, 'Failed to process messaging-history.set');
    }
  };

  const performIncrementalResync = async () => {
    if (resyncRunning) return;
    resyncRunning = true;
    try {
      if (!sock?.fetchMessagesFromWA) {
        await markSyncState({ syncState: 'SYNCED', syncError: 'resync_not_supported' });
        await recordSyncAudit('RESYNC_COMPLETED', {
          from_timestamp: null,
          to_timestamp: new Date(),
          messages_recovered: 0,
          reason: 'fetchMessagesFromWA_unavailable'
        });
        logger.warn({ sessionName, tag: LOG_TAG }, 'Incremental resync skipped: fetchMessagesFromWA not available');
        return;
      }
      const sessionRecord = await findSessionByName({ sessionName, tenantId: sessionContext.tenantId });
      const tenantId = sessionRecord?.tenantId || sessionContext.tenantId || null;
      const fromDate =
        sessionRecord?.lastSyncedAt ||
        sessionRecord?.lastDisconnectAt ||
        sessionRecord?.lastConnectAt ||
        new Date(Date.now() - 10 * 60 * 1000);
      await markSyncState({ syncState: 'SYNCING', syncError: null, lastConnectAt: sessionRecord?.lastConnectAt || new Date() });
      await recordSyncAudit('RESYNC_STARTED', { from_timestamp: fromDate, to_timestamp: new Date(), reason: 'reconnect' });

      const params = [sessionName];
      let sql = `
        SELECT remote_jid, remote_number
        FROM chats
        WHERE whatsapp_session_name = $1
          AND remote_jid IS NOT NULL
          AND remote_jid NOT LIKE '%@g.us'
      `;
      if (tenantId) {
        params.push(tenantId);
        sql += ' AND tenant_id = $2';
      }
      sql += ' ORDER BY updated_at DESC LIMIT 5000';
      const { rows } = await pool.query(sql, params);
      const chats = rows || [];

      let recovered = 0;
      let newestMs = fromDate ? new Date(fromDate).getTime() : 0;

      for (const chat of chats) {
        const jid = chat.remote_jid;
        if (!jid || jid.endsWith('@g.us')) continue;
        let cursor = null;
        // Iterar hasta cubrir ventana desde fromDate
        while (true) {
          let batch;
          try {
            batch = await sock.fetchMessagesFromWA(jid, RESYNC_BATCH, cursor ? { cursor } : undefined);
          } catch (err) {
            throw new Error(`fetchMessagesFromWA fallo para ${jid}: ${err?.message || err}`);
          }
          if (!Array.isArray(batch) || batch.length === 0) break;
          const filtered = batch.filter((m) => {
            const tsMs = Number(m?.messageTimestamp || 0) * 1000;
            if (Number.isFinite(tsMs) && fromDate && tsMs <= new Date(fromDate).getTime()) return false;
            const remote = m?.key?.remoteJid || '';
            if (typeof remote === 'string' && remote.endsWith('@g.us')) return false;
            return true;
          });
          const ordered = filtered.sort(
            (a, b) => Number(a?.messageTimestamp || 0) - Number(b?.messageTimestamp || 0)
          );
          for (const msg of ordered) {
            await handleMessagesUpsert({ messages: [msg], type: 'notify', isHistory: true });
            const tsMs = Number(msg?.messageTimestamp || 0) * 1000;
            if (Number.isFinite(tsMs) && tsMs > newestMs) {
              newestMs = tsMs;
            }
            recovered += 1;
          }
          const oldestTs = Math.min(
            ...batch.map((m) => Number(m?.messageTimestamp || 0) * 1000).filter((v) => Number.isFinite(v))
          );
          if (!Number.isFinite(oldestTs) || (fromDate && oldestTs <= new Date(fromDate).getTime())) break;
          cursor = batch[batch.length - 1]?.key || null;
          if (!cursor) break;
        }
      }

      const lastSyncedAt = newestMs ? new Date(newestMs) : fromDate || new Date();
      await markSyncState({ syncState: 'SYNCED', syncError: null, lastSyncedAt });
      await recordSyncAudit('RESYNC_COMPLETED', {
        from_timestamp: fromDate,
        to_timestamp: lastSyncedAt,
        messages_recovered: recovered
      });
    } catch (err) {
      await markSyncState({ syncState: 'ERROR', syncError: err?.message || 'resync_failed' });
      await recordSyncAudit('RESYNC_FAILED', {
        error: err?.message || 'resync_failed',
        timestamp: new Date().toISOString()
      });
      logger.error({ err, sessionName, tag: LOG_TAG }, 'Incremental resync failed');
    } finally {
      resyncRunning = false;
    }
  };

  const handleMessagesUpdate = async (updates = []) => {
    if (!Array.isArray(updates) || updates.length === 0) return;
    for (const update of updates) {
      logWhatsAppAckDebug(
        'WA_ACK_RAW_UPDATE',
        { sessionName, update: summarizeMessageUpdate(update) },
        'Raw WhatsApp messages.update received'
      );
      const messageId = update?.key?.id || null;
      // Priorizar cualquier JID en dominio s.whatsapp.net (incluyendo remoteJidAlt) para alinear con la deduplicación de inbound/outbound.
      const primaryJid = update?.key?.remoteJid || null;
      const altJid = update?.key?.remoteJidAlt || null;
      const jidWithDomain =
        [primaryJid, altJid].find((jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')) ||
        primaryJid ||
        altJid ||
        null;
      const normalizedJid = jidWithDomain ? jidNormalizedUser(jidWithDomain) : jidWithDomain;
      if (!messageId || !normalizedJid) {
        logDiscard({ reason: 'update_missing_key' });
        continue;
      }
      const remoteNumber = normalizeRemoteJid(normalizedJid);
      const statusRaw = update?.status ?? update?.update?.status ?? null;
      const statusCode = statusRaw;
      let normalizedStatus = null;
      if (statusRaw !== null && statusRaw !== undefined) {
        if (ACK_STATUS[statusRaw]) {
          normalizedStatus = ACK_STATUS[statusRaw];
        } else if (typeof statusRaw === 'string') {
          const s = statusRaw.toString().toLowerCase();
          if (s.includes('server')) normalizedStatus = 'server';
          else if (s.includes('deliver')) normalizedStatus = 'delivered';
          else if (s.includes('read')) normalizedStatus = 'read';
          else if (s.includes('play')) normalizedStatus = 'played';
          else if (s.includes('pending')) normalizedStatus = 'pending';
        }
      }
      if (statusRaw !== null && statusRaw !== undefined && !normalizedStatus) {
        logger.warn(
          { sessionName, messageId, remoteNumber, statusRaw, update: summarizeMessageUpdate(update), tag: 'WA_ACK_STATUS_UNMAPPED' },
          'WhatsApp message update status could not be mapped'
        );
      }
      const editPayload = update?.update?.message || null;
      const statusError =
        update?.update?.messageStubParameters?.[0] ||
        update?.messageStubParameters?.[0] ||
        update?.error ||
        null;
      // No mover timestamps al recibir ACKs; solo cambios de contenido deberían traer timestamp explícito.
      const timestamp = null;

      events.emit('message_update', {
        sessionName,
        remoteNumber,
        messageId,
        status: normalizedStatus,
        statusCode,
        statusError,
        editPayload,
        timestamp,
        tenantId: sessionContext.tenantId
      });

      logWhatsAppAckDebug(
        'WA_ACK_MAPPED_UPDATE',
        {
          sessionName,
          messageId,
          remoteNumber,
          normalizedJid,
          status: normalizedStatus,
          statusCode,
          statusError,
          fromMe: update?.key?.fromMe ?? null
        },
        'WhatsApp messages.update mapped and emitted'
      );

      logger.info(
        { sessionName, messageId, remoteNumber, status: normalizedStatus, statusCode, statusError, tag: 'WA_ACK_DISPATCHED' },
        'messages.update dispatched'
      );
    }
  };

  const handleMessagesDelete = async (deletes = []) => {
    const keys = Array.isArray(deletes?.keys) ? deletes.keys : deletes;
    if (!Array.isArray(keys) || keys.length === 0) return;
    for (const key of keys) {
      const messageId = key?.id || null;
      const remoteJid = key?.remoteJid || null;
      if (!messageId || !remoteJid) {
        logDiscard({ reason: 'delete_missing_key' });
        continue;
      }
      const remoteNumber = normalizeRemoteJid(remoteJid);
      events.emit('message_delete', {
        sessionName,
        remoteNumber,
        messageId,
        fromMe: !!key?.fromMe,
        timestamp: new Date().toISOString(),
        tenantId: sessionContext.tenantId
      });
      logger.info(
        { sessionName, messageId, remoteNumber, tag: LOG_TAG },
        'messages.delete dispatched'
      );
    }
  };

  const attachListeners = (instance) => {
    if (attachedSockets.has(instance)) return;
    attachedSockets.add(instance);

    const enqueueRealtime = (label, handler) => (payload) =>
      realtimeQueue
        .enqueue(() => handler(payload))
        .catch((err) => logger.warn({ err, sessionName, label, tag: LOG_TAG }, 'Dropped realtime event due to queue pressure'));

    instance.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        logger.info({ sessionName }, 'Persisted creds after update');
      } catch (err) {
        await recordWhatsAppError({
          sessionName,
          category: 'integration',
          message: err?.message || 'Failed to persist creds',
          context: {},
          tenantId: sessionContext.tenantId
        }).catch(() => {});
        logger.error({ err, sessionName }, 'Failed to persist creds');
      }
    });

    instance.ev.on('connection.update', enqueueRealtime('connection.update', handleConnectionUpdate));
    instance.ev.on('messages.upsert', enqueueRealtime('messages.upsert', handleMessagesUpsert));
    instance.ev.on('messages.update', enqueueRealtime('messages.update', handleMessagesUpdate));
    instance.ev.on('messages.delete', enqueueRealtime('messages.delete', handleMessagesDelete));
    instance.ev.on('messaging-history.set', enqueueRealtime('messaging-history.set', handleMessagingHistory));

    if (env.whatsapp?.debugAck && instance.ws?.on) {
      instance.ws.on('CB:ack,class:message', (node) => {
        logWhatsAppAckDebug(
          'WA_ACK_LOW_LEVEL',
          { sessionName, node: summarizeBinaryNode(node) },
          'Low-level WhatsApp message ACK received'
        );
      });
      instance.ws.on('CB:receipt', (node) => {
        logWhatsAppAckDebug(
          'WA_RECEIPT_LOW_LEVEL',
          { sessionName, node: summarizeBinaryNode(node) },
          'Low-level WhatsApp receipt received'
        );
      });
      instance.ws.on('CB:notification', (node) => {
        if (node?.attrs?.type !== 'privacy_token') return;
        logWhatsAppAckDebug(
          'WA_PRIVACY_TOKEN_NOTIFICATION',
          { sessionName, node: summarizeBinaryNode(node) },
          'Low-level WhatsApp privacy token notification received'
        );
      });
    }
  };

  const createSocketInstance = () => {
    const instance = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      browser: ['WhatsSuite', 'Chrome', '1.0'],
      logger: buildSocketLogger(),
      syncFullHistory: sessionContext.syncHistory,
      markOnlineOnConnect: false
    });
    attachListeners(instance);
    return instance;
  };

  sock = createSocketInstance();
  // Estado inicial mientras Baileys negocia
  await setSessionStatus(sessionName, 'connecting', { tenantId: sessionContext.tenantId });
  events.emit('status', { sessionName, status: 'connecting' });

  socketRegistry.set(sessionName, {
    getSock: () => sock,
    events
  });

  return {
    get sock() {
      return sock;
    },
    saveCreds,
    state,
    events
  };
};

export const requestPairingCode = async (sessionName = 'default', phoneNumber) => {
  const entry = socketRegistry.get(sessionName);
  if (!entry) {
    throw new Error(`Socket for session ${sessionName} not initialized`);
  }

  const sanitized = String(phoneNumber || '').replace(/[^\d]/g, '');
  if (!sanitized || sanitized.length < 8 || sanitized.length > 15 || sanitized !== String(phoneNumber)) {
    throw new Error('Phone number must be E.164 digits only without "+"');
  }

  const sock = entry.getSock();

  const waitForReady = () =>
    new Promise((resolve, reject) => {
      let timeoutId;
      const handler = (update) => {
        const { connection, qr } = update;
        if (connection === 'connecting' || qr) {
          cleanup();
          resolve(update);
        }
      };
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        sock.ev.off('connection.update', handler);
      };
      const last = lastConnectionUpdate.get(sessionName);
      if (last && (last.connection === 'connecting' || last.qr)) {
        resolve(last);
        return;
      }
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout waiting for connection.update to request pairing code'));
      }, 15000);
      sock.ev.on('connection.update', handler);
    });

  await waitForReady();
  const code = await sock.requestPairingCode(sanitized);
  entry.events.emit('pairing_code', { sessionName, code });
  return code;
};

export default createWhatsAppSocket;
const mapUpsertStatus = (status) => {
  if (!status) return null;
  if (typeof status === 'number' && ACK_STATUS[status]) return ACK_STATUS[status];
  const upper = String(status).toUpperCase();
  if (upper === 'PENDING') return 'pending';
  if (upper === 'SERVER' || upper === 'SENT') return 'server';
  if (upper === 'DELIVERED') return 'delivered';
  if (upper === 'READ') return 'read';
  if (upper === 'PLAYED') return 'played';
  return null;
};

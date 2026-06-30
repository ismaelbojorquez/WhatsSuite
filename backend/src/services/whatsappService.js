import { AppError } from '../shared/errors.js';
import createWhatsAppSocket, { requestPairingCode as requestPairingCodeRaw } from '../whatsapp/whatsappSocket.js';
import { createPostgresAuthState } from '../whatsapp/whatsappAuthState.js';
import { recordWhatsAppAudit } from '../infra/db/whatsappAuditRepository.js';
import { recordWhatsAppError } from '../infra/db/whatsappErrorRepository.js';
import { WhatsAppErrorMessages } from '../whatsapp/whatsappErrors.js';
import pool from '../infra/db/postgres.js';
import { findSessionByName, upsertSessionSyncHistory, updateHistorySyncState, getTenantIdForSession } from '../infra/db/whatsappSessionRepository.js';
import {
  handleIncomingWhatsAppMessage,
  handleWhatsAppMessageDelete,
  handleWhatsAppMessageUpdate
} from './whatsappInboundService.js';
import { runAutoAssignmentLocked } from './chatAutoAssignmentService.js';
import logger from '../infra/logging/logger.js';
import { emitToAll } from '../infra/realtime/socketHub.js';
import { Buffer } from 'node:buffer';
import env from '../config/env.js';
import { getSystemSettings } from '../infra/db/systemSettingsRepository.js';
import { normalizeWhatsAppNumber } from '../shared/phoneNormalizer.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const sessions = new Map();
const creationLocks = new Map();
const reconnectLocks = new Map();
const deletedSessions = new Set();
const LOG_TAG = undefined;
const execFileAsync = promisify(execFile);
const DEFAULT_HISTORY_DAYS = Number(env.whatsapp?.historySyncDays || 30);
let cachedHistoryDays = DEFAULT_HISTORY_DAYS;
let lastHistoryDaysFetch = 0;
const HISTORY_CACHE_MS = 5 * 60 * 1000;

const normalizeSessionName = (name) => (name || 'default').trim() || 'default';

const normalizeKeysPayload = (keys) => {
  if (!keys) return {};
  if (typeof keys === 'string') {
    try {
      const parsed = JSON.parse(keys);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_err) {
      return {};
    }
  }
  return keys && typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
};

const hasStoredKeysSnapshot = (keysPayload) => {
  const keys = normalizeKeysPayload(keysPayload);
  const buckets = ['preKeys', 'sessions', 'senderKeys', 'appStateSyncKeys'];
  return buckets.some((bucket) => Object.keys(keys?.[bucket] || {}).length > 0);
};

const getStoredKeysInfo = async (sessionName, tenantId = null) => {
  const name = normalizeSessionName(sessionName);
  const resolvedTenant = tenantId || await getTenantIdForSession(name, tenantId);
  const { rows } = await pool.query(
    'SELECT keys FROM whatsapp_sessions WHERE session_name = $1 AND tenant_id = $2 LIMIT 1',
    [name, resolvedTenant]
  );
  return { hasStoredKeys: hasStoredKeysSnapshot(rows[0]?.keys) };
};

const resolveHistoryDays = async () => {
  const now = Date.now();
  if (cachedHistoryDays && now - lastHistoryDaysFetch < HISTORY_CACHE_MS) return cachedHistoryDays;
  try {
    const settings = await getSystemSettings();
    const days = Number(settings?.whatsappHistoryDays || DEFAULT_HISTORY_DAYS);
    cachedHistoryDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_HISTORY_DAYS;
  } catch (err) {
    logger.warn({ err, tag: LOG_TAG }, 'Falling back to default history days');
    cachedHistoryDays = DEFAULT_HISTORY_DAYS;
  }
  lastHistoryDaysFetch = now;
  return cachedHistoryDays;
};

const persistSessionRuntimeStatus = async (sessionName, status, tenantId = null) => {
  const name = normalizeSessionName(sessionName);
  const resolvedTenant = tenantId || await getTenantIdForSession(name, tenantId);
  const normalized = typeof status === 'string' ? status.toLowerCase() : 'pending';
  const persistedStatus =
    normalized === 'connected'
      ? 'connected'
      : normalized === 'disconnected' || normalized === 'invalid'
        ? 'disconnected'
        : 'pending';
  await pool
    .query(
      `UPDATE whatsapp_sessions
       SET status = $2,
           updated_at = NOW()
       WHERE session_name = $1
         AND ($3::uuid IS NULL OR tenant_id = $3)`,
      [name, persistedStatus, resolvedTenant]
    )
    .catch(() => {});
};

const OUTBOUND_SEND_ERROR_TTL_MS = 30000;
const OUTBOUND_SEND_ERROR_WAIT_MS = 750;

const pruneImmediateSendErrors = (record) => {
  if (!record?.immediateSendErrors) return;
  const now = Date.now();
  for (const [messageId, payload] of record.immediateSendErrors.entries()) {
    if (!payload?.at || now - payload.at > OUTBOUND_SEND_ERROR_TTL_MS) {
      record.immediateSendErrors.delete(messageId);
    }
  }
};

const rememberImmediateSendError = (record, payload) => {
  if (!record || !payload?.messageId || payload.status !== 'error') return;
  record.immediateSendErrors = record.immediateSendErrors || new Map();
  pruneImmediateSendErrors(record);
  record.immediateSendErrors.set(payload.messageId, { ...payload, at: Date.now() });
};

const getImmediateSendError = (record, messageId) => {
  if (!record || !messageId) return null;
  pruneImmediateSendErrors(record);
  return record.immediateSendErrors?.get(messageId) || null;
};

const waitForImmediateSendError = (record, messageId) => {
  const existing = getImmediateSendError(record, messageId);
  if (existing || !record?.controller?.events || !messageId) {
    return Promise.resolve(existing);
  }

  return new Promise((resolve) => {
    let timer = null;
    const cleanup = (payload = null) => {
      if (timer) clearTimeout(timer);
      record.controller.events.off?.('message_update', handler);
      resolve(payload || getImmediateSendError(record, messageId));
    };
    const handler = (payload) => {
      if (payload?.messageId === messageId && payload?.status === 'error') {
        cleanup(payload);
      }
    };

    record.controller.events.on('message_update', handler);
    timer = setTimeout(() => cleanup(null), OUTBOUND_SEND_ERROR_WAIT_MS);
  });
};

const attachEvents = (record) => {
  const { controller } = record;
  controller.events.on('qr', ({ qr, qrBase64 }) => {
    record.lastQr = { qr, qrBase64, at: new Date().toISOString() };
    record.lastStatus = 'pending';
    emitToAll('whatsapp:status', { sessionId: record.sessionName, status: record.lastStatus });
    recordWhatsAppAudit({
      sessionName: record.sessionName,
      event: 'qr_issued',
      userId: record.context?.userId || null,
      ip: record.context?.ip || null,
      userAgent: record.context?.userAgent || null,
      tenantId: record.tenantId
    }).catch(() => {});
  });
  controller.events.on('status', ({ status, reason, reasonCode }) => {
    record.lastStatus = status || record.lastStatus || 'unknown';
    record.lastStatusReason = reason || reasonCode || null;
    emitToAll('whatsapp:status', {
      sessionId: record.sessionName,
      status: record.lastStatus,
      reason: record.lastStatusReason
    });
    if (status === 'connected') {
      record.lastConnectedAt = new Date().toISOString();
      recordWhatsAppAudit({
        sessionName: record.sessionName,
        event: 'connected',
        userId: record.context?.userId || null,
        ip: record.context?.ip || null,
        userAgent: record.context?.userAgent || null,
        tenantId: record.tenantId
      }).catch(() => {});
    }
    if (status === 'disconnected' || status === 'invalid') {
      recordWhatsAppAudit({
        sessionName: record.sessionName,
        event: 'disconnected',
        userId: record.context?.userId || null,
        ip: record.context?.ip || null,
        userAgent: record.context?.userAgent || null,
        tenantId: record.tenantId,
        metadata: { reason: reason || reasonCode || null }
      }).catch(() => {});
    }
    logger.info({ sessionName: record.sessionName, status, tag: LOG_TAG }, 'WA status event');
  });
  controller.events.on('pairing_code', ({ code }) => {
    record.lastPairingCode = { code, at: new Date().toISOString() };
    record.lastStatus = 'pairing_code';
    emitToAll('whatsapp:status', { sessionId: record.sessionName, status: record.lastStatus });
    recordWhatsAppAudit({
      sessionName: record.sessionName,
      event: 'pairing_code_requested',
      userId: record.context?.userId || null,
      ip: record.context?.ip || null,
      userAgent: record.context?.userAgent || null,
      tenantId: record.tenantId
    }).catch(() => {});
  });
  controller.events.on('message', async (payload) => {
    try {
      const chat = await handleIncomingWhatsAppMessage({ ...payload, tenantId: record.tenantId });
      // Trigger auto-asignación inmediatamente cuando quede en UNASSIGNED y la configuración lo permita.
      if (chat && chat.status === 'UNASSIGNED') {
        runAutoAssignmentLocked().catch((err) =>
          logger.error({ err, sessionName: record.sessionName, tag: LOG_TAG }, 'Auto-assign on inbound failed')
        );
      }
    } catch (err) {
      await recordWhatsAppError({
        sessionName: record.sessionName,
        category: 'integration',
        message: err?.message || 'Error processing inbound message',
        context: { payload: { remoteNumber: payload?.remoteNumber, messageId: payload?.messageId } },
        tenantId: record.tenantId
      }).catch(() => {});
      logger.error({ err, sessionName: record.sessionName }, 'Failed to handle inbound message');
    }
  });
  controller.events.on('message_update', async (payload) => {
    try {
      rememberImmediateSendError(record, payload);
      const updated = await handleWhatsAppMessageUpdate({ ...payload, tenantId: record.tenantId });
      if (updated?.internal) {
        return;
      }
      if (updated) {
        emitToAll('message:update', {
          chatId: updated.chatId,
          messageId: updated.id,
          whatsappMessageId: updated.whatsappMessageId,
          status: updated.status,
          timestamp: updated.timestamp,
          remoteNumber: updated.remoteNumber,
          sessionName: updated.whatsappSessionName
        });
      } else {
        logger.warn({ payload, tag: LOG_TAG }, 'message_update received but no message matched');
      }
    } catch (err) {
      await recordWhatsAppError({
        sessionName: record.sessionName,
        category: 'integration',
        message: err?.message || 'Error processing message update',
        context: { payload: { remoteNumber: payload?.remoteNumber, messageId: payload?.messageId } },
        tenantId: record.tenantId
      }).catch(() => {});
      logger.error({ err, sessionName: record.sessionName }, 'Failed to handle message update');
    }
  });
  controller.events.on('message_delete', async (payload) => {
    try {
      await handleWhatsAppMessageDelete({ ...payload, tenantId: record.tenantId });
    } catch (err) {
      await recordWhatsAppError({
        sessionName: record.sessionName,
        category: 'integration',
        message: err?.message || 'Error processing message delete',
        context: { payload: { remoteNumber: payload?.remoteNumber, messageId: payload?.messageId } },
        tenantId: record.tenantId
      }).catch(() => {});
      logger.error({ err, sessionName: record.sessionName }, 'Failed to handle message delete');
    }
  });
};

const createRecord = async (sessionName, sessionConfig = null) => {
  let config = sessionConfig || (await findSessionByName({ sessionName }));
  if (!config.id && !config.syncHistory) {
    config = await upsertSessionSyncHistory({ sessionName, tenantId: config.tenantId, syncHistory: true });
  }
  const historyDays = await resolveHistoryDays();
  const controller = await createWhatsAppSocket(sessionName, {
    syncHistory: config.syncHistory,
    tenantId: config.tenantId,
    historyDays
  });
  const record = {
    controller,
    lastQr: null,
    lastPairingCode: null,
    lastStatus: 'connecting',
    lastStatusReason: null,
    lastConnectedAt: null,
    sessionName,
    context: {},
    tenantId: config.tenantId,
    syncHistory: config.syncHistory,
    historySyncStatus: config.historySyncStatus || 'idle',
    historyDays
  };
  attachEvents(record);
  sessions.set(sessionName, record);
  logger.info({ sessionName, tag: LOG_TAG, syncHistory: record.syncHistory, tenantId: record.tenantId }, 'WA session created/ensured');
  return record;
};

const ensureSessionRecord = async (sessionName, { tenantId = null } = {}) => {
  const name = normalizeSessionName(sessionName);
  const config = await findSessionByName({ sessionName: name, tenantId });
  if (deletedSessions.has(name)) {
    const historyDays = await resolveHistoryDays();
    return {
      controller: { events: { on: () => {}, removeAllListeners: () => {} }, sock: null },
      lastQr: null,
      lastPairingCode: null,
      lastStatus: 'deleted',
      lastStatusReason: 'deleted',
      lastConnectedAt: null,
      sessionName: name,
      context: {},
      tenantId: config.tenantId,
      syncHistory: config.syncHistory,
      historySyncStatus: config.historySyncStatus || 'idle',
      historyDays
    };
  }
  if (sessions.has(name)) {
    const existing = sessions.get(name);
    existing.tenantId = config.tenantId || existing.tenantId || null;
    existing.syncHistory = config.syncHistory;
    existing.historySyncStatus = config.historySyncStatus || existing.historySyncStatus || 'idle';
    existing.historyDays = existing.historyDays || (await resolveHistoryDays());
    return existing;
  }

  const pending = creationLocks.get(name);
  if (pending) return pending;

  const promise = createRecord(name, config)
    .catch((err) => {
      sessions.delete(name);
      throw err;
    })
    .finally(() => {
      creationLocks.delete(name);
    });

  creationLocks.set(name, promise);
  return promise;
};

export const createSession = async (sessionName, { userId = null, ip = null, tenantId = null, userAgent = null } = {}) => {
  const name = normalizeSessionName(sessionName);
  deletedSessions.delete(name);
  const record = await ensureSessionRecord(name, { tenantId });
  record.context = { userId, ip, userAgent };
  await recordWhatsAppAudit({
    sessionName: record.sessionName,
    event: 'session_created',
    userId,
    ip,
    userAgent,
    tenantId: record.tenantId
  }).catch(() => {});
  logger.info({ sessionName: record.sessionName, tag: LOG_TAG }, 'WA createSession called');
  return {
    session: normalizeSessionName(sessionName),
    status: record.lastStatus,
    qr: record.lastQr?.qr || null,
    qrBase64: record.lastQr?.qrBase64 || null
  };
};

export const getQrForSession = async (sessionName, { tenantId = null } = {}) => {
  const record = await ensureSessionRecord(sessionName, { tenantId });
  const { hasStoredKeys } = await getStoredKeysInfo(sessionName, record?.tenantId || tenantId);
  const hasQr = Boolean(record.lastQr?.qr || record.lastQr?.qrBase64);
  return {
    session: normalizeSessionName(sessionName),
    qr: record.lastQr?.qr || null,
    qrBase64: record.lastQr?.qrBase64 || null,
    status: hasQr ? 'pending' : record.lastStatus || 'unknown',
    hasStoredKeys
  };
};

export const requestPairingCode = async (sessionName, phoneNumber, { userId = null, ip = null, tenantId = null, userAgent = null } = {}) => {
  const name = normalizeSessionName(sessionName);
  await ensureSessionRecord(name, { tenantId });
  if (!phoneNumber) {
    await recordWhatsAppError({
      sessionName: name,
      category: 'operational',
      message: WhatsAppErrorMessages.invalidPhone,
      tenantId
    });
    throw new AppError(WhatsAppErrorMessages.invalidPhone, 400);
  }
  const record = sessions.get(name);
  if (record) {
    record.context = { userId, ip, userAgent };
    if (record.lastStatus === 'connected') {
      await recordWhatsAppError({
        sessionName: name,
        category: 'operational',
        message: WhatsAppErrorMessages.pairingWhileConnected,
        tenantId: record.tenantId
      });
      throw new AppError(WhatsAppErrorMessages.pairingWhileConnected, 400);
    }
  }
  let code;
  try {
    code = await requestPairingCodeRaw(name, phoneNumber);
  } catch (err) {
    await recordWhatsAppError({
      sessionName: name,
      category: 'integration',
      message: err?.message || WhatsAppErrorMessages.timeoutPairing,
      context: { phoneNumber },
      tenantId: record?.tenantId || tenantId
    });
    throw err;
  }
  if (record) {
    record.lastPairingCode = { code, at: new Date().toISOString() };
    record.lastStatus = 'pairing_code';
    await persistSessionRuntimeStatus(name, record.lastStatus, record.tenantId || tenantId);
    emitToAll('whatsapp:status', { sessionId: name, status: record.lastStatus });
  }
  await recordWhatsAppAudit({
    sessionName: name,
    event: 'pairing_code_requested',
    userId,
    ip,
    userAgent,
    tenantId: record?.tenantId
  }).catch(() => {});
  return { session: name, code };
};

export const getStatusForSession = async (sessionName, { tenantId = null } = {}) => {
  const name = normalizeSessionName(sessionName);
  if (deletedSessions.has(name)) {
    return {
      session: name,
      status: 'deleted',
      reason: 'deleted',
      lastConnectedAt: null,
      syncHistory: false,
      historySyncStatus: 'idle',
      historySyncedAt: null,
      historySyncProgress: {},
      hasStoredKeys: false
    };
  }

  const config = await findSessionByName({ sessionName: name, tenantId });
  if (!config.id) {
    deletedSessions.add(name);
    return {
      session: name,
      status: 'deleted',
      reason: 'deleted',
      lastConnectedAt: null,
      syncHistory: false,
      historySyncStatus: 'idle',
      historySyncedAt: null,
      historySyncProgress: {},
      hasStoredKeys: false
    };
  }

  const record = await ensureSessionRecord(sessionName, { tenantId: config.tenantId });
  const { hasStoredKeys } = await getStoredKeysInfo(name, record?.tenantId || config.tenantId);
  return {
    session: name,
    status: record.lastStatus || config.status || 'unknown',
    reason: record.lastStatusReason || null,
    lastConnectedAt: record.lastConnectedAt || config.lastConnectedAt || null,
    syncHistory: record.syncHistory ?? config.syncHistory,
    historySyncStatus: record.historySyncStatus || config.historySyncStatus || 'idle',
    historySyncedAt: config.historySyncedAt || null,
    historySyncProgress: config.historySyncProgress || {},
    hasStoredKeys
  };
};

export const reconnectSession = async (
  sessionName,
  { userId = null, ip = null, tenantId = null, userAgent = null, resetAuth = false } = {}
) => {
  const name = normalizeSessionName(sessionName);
  const existing = await ensureSessionRecord(name, { tenantId });
  if (existing) {
    existing.context = { userId, ip, userAgent };
  }

  const lockPromise = reconnectLocks.get(name);
  if (lockPromise) return lockPromise;

  const promise = (async () => {
    if (existing?.controller?.sock) {
      try {
        existing.controller.sock.ev?.removeAllListeners?.();
        existing.controller.sock.end();
      } catch (_err) {
        // ignore close errors
      }
      existing.controller.events.removeAllListeners();
    }
    if (resetAuth) {
      try {
        const auth = await createPostgresAuthState(name);
        await auth.resetState();
      } catch (err) {
        logger.error({ err, sessionName: name, tag: LOG_TAG }, 'Failed to reset auth state');
        throw err;
      }
    }
    const controller = await createWhatsAppSocket(name);
    existing.lastQr = null;
    existing.lastPairingCode = null;
    existing.lastStatus = 'connecting';
    existing.lastStatusReason = null;
    await persistSessionRuntimeStatus(name, existing.lastStatus, existing.tenantId || tenantId);
    emitToAll('whatsapp:status', { sessionId: name, status: existing.lastStatus });
    existing.controller = controller;
    attachEvents(existing);
    sessions.set(name, existing);
    await recordWhatsAppAudit({
      sessionName: name,
      event: 'session_reconnect_requested',
      userId,
      ip,
      userAgent,
      tenantId: existing.tenantId
    }).catch(() => {});
    logger.info({ sessionName: name, tag: LOG_TAG }, 'WA manual reconnect triggered');
    return getStatusForSession(name);
  })()
    .finally(() => reconnectLocks.delete(name));

  reconnectLocks.set(name, promise);
  return promise;
};

export const renewQrSession = async (sessionName, { userId = null, ip = null, tenantId = null, userAgent = null } = {}) => {
  const name = normalizeSessionName(sessionName);
  const record = await ensureSessionRecord(name, { tenantId });
  if (record) {
    record.context = { userId, ip, userAgent };
  }
  const status = record?.lastStatus || 'unknown';
  if (status !== 'pending') {
    throw new AppError('La sesión no está en estado pendiente', 409);
  }
  const { hasStoredKeys } = await getStoredKeysInfo(name, record?.tenantId || tenantId);
  if (!hasStoredKeys) {
    throw new AppError('No hay claves guardadas para regenerar el QR', 400);
  }
  await recordWhatsAppAudit({
    sessionName: name,
    event: 'session_qr_renewed',
    userId,
    ip,
    userAgent,
    tenantId: record?.tenantId || tenantId
  }).catch(() => {});
  return reconnectSession(name, {
    userId,
    ip,
    tenantId: record?.tenantId || tenantId,
    userAgent,
    resetAuth: true
  });
};

export const resetSessionAuth = async (
  sessionName,
  { userId = null, ip = null, tenantId = null, userAgent = null } = {}
) => {
  const name = normalizeSessionName(sessionName);
  deletedSessions.delete(name);
  const record = await ensureSessionRecord(name, { tenantId });
  if (record) {
    record.context = { userId, ip, userAgent };
  }

  await recordWhatsAppAudit({
    sessionName: name,
    event: 'session_force_new_qr',
    userId,
    ip,
    userAgent,
    tenantId: record?.tenantId || tenantId
  }).catch(() => {});

  return reconnectSession(name, {
    userId,
    ip,
    tenantId: record?.tenantId || tenantId,
    userAgent,
    resetAuth: true
  });
};

export const shutdownWhatsAppSessions = async () => {
  for (const [name, record] of sessions.entries()) {
    try {
      record.controller?.events?.removeAllListeners();
      if (record.controller?.sock) {
        record.controller.sock.end();
      }
    } catch (_err) {
      // best effort
    }
    sessions.delete(name);
  }
};

export const disconnectSession = async (sessionName, { userId = null, ip = null, tenantId = null, userAgent = null } = {}) => {
  const name = normalizeSessionName(sessionName);
  const record = await ensureSessionRecord(name, { tenantId });
  record.context = { userId, ip, userAgent };
  if (record?.controller?.sock) {
    try {
      record.controller.sock.end();
    } catch (_err) {
      // ignore
    }
    record.controller.events.removeAllListeners();
  }
  record.lastStatus = 'disconnected';
  record.lastStatusReason = 'manual_disconnect';
  sessions.set(name, record);
  await persistSessionRuntimeStatus(name, record.lastStatus, record.tenantId || tenantId);
  emitToAll('whatsapp:status', { sessionId: name, status: record.lastStatus, reason: record.lastStatusReason });
  await recordWhatsAppAudit({
    sessionName: name,
    event: 'session_disconnected',
    userId,
    ip,
    userAgent,
    tenantId: record.tenantId
  }).catch(() => {});
  logger.info({ sessionName: name, tag: LOG_TAG }, 'WA manual disconnect triggered');
  return getStatusForSession(name);
};

export const listSessions = async (tenantId = null) => {
  const resolvedTenant = await getTenantIdForSession(null, tenantId);
  const params = [];
  let sql = `
    SELECT session_name, status, last_connected_at, updated_at, sync_history, history_sync_status, history_synced_at, history_sync_progress,
           last_synced_at, last_message_id, last_disconnect_at, last_connect_at, sync_state, sync_error
    FROM whatsapp_sessions
  `;
  if (resolvedTenant) {
    params.push(resolvedTenant);
    sql += ' WHERE tenant_id = $1';
  }
  sql += ' ORDER BY updated_at DESC';
  const { rows } = await pool.query(sql, params);
  const enriched = await Promise.all(
    rows.map(async (r) => {
      try {
        const live = await getStatusForSession(r.session_name, { tenantId: resolvedTenant });
        return {
          session: live.session,
          status: live.status || r.status || 'unknown',
          lastConnectedAt: live.lastConnectedAt || r.last_connected_at,
          updatedAt: r.updated_at,
          syncHistory: live.syncHistory ?? r.sync_history ?? false,
          historySyncStatus: live.historySyncStatus || r.history_sync_status || 'idle',
          historySyncedAt: live.historySyncedAt || r.history_synced_at || null,
          historySyncProgress: live.historySyncProgress || r.history_sync_progress || {},
          lastSyncedAt: live.lastSyncedAt || r.last_synced_at || null,
          lastMessageId: live.lastMessageId || r.last_message_id || null,
          lastDisconnectAt: live.lastDisconnectAt || r.last_disconnect_at || null,
          lastConnectAt: live.lastConnectAt || r.last_connect_at || null,
          syncState: live.syncState || r.sync_state || 'IDLE',
          syncError: live.syncError || r.sync_error || null,
          hasStoredKeys: live.hasStoredKeys ?? false
        };
      } catch (_err) {
        let hasStoredKeys = false;
        try {
          ({ hasStoredKeys } = await getStoredKeysInfo(r.session_name, resolvedTenant));
        } catch (_innerErr) {
          hasStoredKeys = false;
        }
        return {
          session: r.session_name,
          status: r.status || 'unknown',
          lastConnectedAt: r.last_connected_at,
          updatedAt: r.updated_at,
          syncHistory: r.sync_history ?? false,
          historySyncStatus: r.history_sync_status || 'idle',
          historySyncedAt: r.history_synced_at || null,
          historySyncProgress: r.history_sync_progress || {},
          lastSyncedAt: r.last_synced_at || null,
          lastMessageId: r.last_message_id || null,
          lastDisconnectAt: r.last_disconnect_at || null,
          lastConnectAt: r.last_connect_at || null,
          syncState: r.sync_state || 'IDLE',
          syncError: r.sync_error || null,
          hasStoredKeys
        };
      }
    })
  );
  return enriched;
};

export const updateSessionSettings = async (
  sessionName,
  { tenantId = null, syncHistory = null, userId = null, ip = null, userAgent = null } = {}
) => {
  const name = normalizeSessionName(sessionName);
  const resolvedTenant = await getTenantIdForSession(name, tenantId);
  const updated = await upsertSessionSyncHistory({
    sessionName: name,
    tenantId: resolvedTenant,
    syncHistory: Boolean(syncHistory)
  });

  if (syncHistory === true) {
    await updateHistorySyncState({
      sessionName: name,
      tenantId: resolvedTenant,
      status: 'idle',
      progress: { syncType: null, total: 0, processed: 0 }
    }).catch(() => {});
  } else if (syncHistory === false) {
    await updateHistorySyncState({
      sessionName: name,
      tenantId: resolvedTenant,
      status: 'disabled',
      progress: { syncType: null, total: 0, processed: 0 }
    }).catch(() => {});
  }

  await recordWhatsAppAudit({
    sessionName: name,
    event: syncHistory ? 'sync_history_enabled' : 'sync_history_disabled',
    userId,
    ip,
    userAgent,
    tenantId: resolvedTenant,
    metadata: { syncHistory: Boolean(syncHistory) }
  }).catch(() => {});

  const active = sessions.get(name);
  if (active) {
    active.syncHistory = updated.syncHistory;
    active.tenantId = updated.tenantId;
    if (syncHistory && active.lastStatus === 'connected') {
      try {
        await reconnectSession(name, { userId, ip, tenantId: resolvedTenant, userAgent });
      } catch (err) {
        logger.warn({ err, sessionName: name, tag: LOG_TAG }, 'Failed to restart session after enabling history sync');
      }
    }
  }

  return {
    session: name,
    syncHistory: updated.syncHistory,
    historySyncStatus: updated.historySyncStatus,
    historySyncedAt: updated.historySyncedAt,
    historySyncProgress: updated.historySyncProgress || {}
  };
};

export const getSocketForSession = async (sessionName = 'default', { tenantId = null } = {}) => {
  const name = normalizeSessionName(sessionName);
  const record = await ensureSessionRecord(name, { tenantId });
  return record?.controller?.sock || null;
};

const parseDataUrl = (dataUrl) => {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!match || match.length < 3) return null;
  const mimeType = match[1] || 'application/octet-stream';
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');
  return { buffer, mimeType, size: buffer.length };
};

const convertWebmToOgg = async (buffer) => {
  if (!ffmpegPath) throw new AppError('ffmpeg no está disponible para convertir audio', 500);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-audio-'));
  const input = path.join(tmpDir, 'input.webm');
  const output = path.join(tmpDir, 'output.ogg');
  await fs.writeFile(input, buffer);
  try {
    await execFileAsync(ffmpegPath, ['-y', '-i', input, '-c:a', 'libopus', '-ac', '1', '-b:a', '64k', output]);
    const data = await fs.readFile(output);
    return data;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
};

const buildMediaMessage = async (normalizedContent) => {
  const file = Array.isArray(normalizedContent.files) && normalizedContent.files.length ? normalizedContent.files[0] : null;
  if (!file || !file.dataUrl) return null;
  const parsed = parseDataUrl(file.dataUrl);
  if (!parsed) return null;
  // 6 MB limit to avoid bloat
  const max = env.media?.maxBytes || 6 * 1024 * 1024;
  if (parsed.size > max) {
    throw new AppError(`Archivo demasiado grande (máx ${Math.round(max / 1024 / 1024)}MB)`, 400);
  }
  const caption = normalizedContent.text || normalizedContent.caption || '';
  let fileName = file.name || `file-${Date.now()}`;
  let mime = file.type || parsed.mimeType;

  if (mime.startsWith('image/')) {
    return { payload: { image: parsed.buffer, caption, mimetype: mime }, meta: { type: 'image', fileName, mime, size: parsed.size } };
  }
  if (mime.startsWith('video/')) {
    return { payload: { video: parsed.buffer, caption, mimetype: mime }, meta: { type: 'video', fileName, mime, size: parsed.size } };
  }
  if (mime.startsWith('audio/')) {
    let audioBuffer = parsed.buffer;
    if (mime.includes('webm')) {
      // Convertimos a ogg/opus para compatibilidad
      audioBuffer = await convertWebmToOgg(parsed.buffer);
      mime = 'audio/ogg; codecs=opus';
      fileName = fileName?.replace(/\.webm$/i, '') || 'audio';
      fileName = `${fileName}.ogg`;
    }
    return {
      payload: { audio: audioBuffer, mimetype: mime, ptt: true },
      meta: { type: 'audio', fileName, mime, size: audioBuffer.length }
    };
  }
  // default document
  return {
    payload: { document: parsed.buffer, fileName, mimetype: mime, caption },
    meta: { type: 'document', fileName, mime, size: parsed.size }
  };
};

const summarizeOutboundContent = (content) => {
  if (typeof content === 'string') {
    return { kind: 'text', textLength: content.trim().length };
  }
  if (!content || typeof content !== 'object') {
    return { kind: typeof content };
  }

  const text = [content.text, content.body, content.message].find((value) => typeof value === 'string') || '';
  const files = Array.isArray(content.files) ? content.files : [];
  const hasMedia = Boolean(content.media || content.file || content.document || content.image || content.video || content.audio || files.length);

  return {
    kind: text ? 'text' : hasMedia ? 'media' : 'object',
    textLength: typeof text === 'string' ? text.length : null,
    fileCount: files.length || null,
    keys: Object.keys(content)
      .filter((key) => !['data', 'buffer', 'base64', 'file', 'files'].includes(key))
      .slice(0, 8)
  };
};

const withSendTimeout = (promise, timeoutMs, context) => {
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new AppError('Tiempo agotado al enviar mensaje por WhatsApp', 504);
        err.code = 'WA_SEND_TIMEOUT';
        err.context = context;
        reject(err);
      }, timeoutMs);
    })
  ]);
};

export const sendWhatsAppMessage = async ({ sessionName, remoteNumber, content }) => {
  const name = normalizeSessionName(sessionName);
  const sock = await getSocketForSession(sessionName);
  if (!sock) {
    throw new AppError('Socket no disponible para la sesión', 503);
  }
  const record = sessions.get(name);
  if (record && record.lastStatus !== 'connected') {
    throw new AppError(`La sesión ${name} no está conectada para enviar mensajes`, 409);
  }
  // Normalizar strings o payloads mínimos a formato Baileys
  let normalizedContent = null;
  logger.info(
    { tag: 'WA_SEND_NORMALIZE', sessionName, remoteNumber, content: summarizeOutboundContent(content) },
    'Normalizing outbound WhatsApp message'
  );
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed) throw new AppError('Contenido de mensaje inválido o vacío para WhatsApp', 400);
    normalizedContent = { text: trimmed };
  } else if (content && typeof content === 'object') {
    // Mapear posibles campos de texto
    const textField =
      typeof content.text === 'string'
        ? content.text
      : typeof content.body === 'string'
        ? content.body
      : typeof content.message === 'string'
        ? content.message
        : null;
    normalizedContent = { ...content };
    if (textField) normalizedContent.text = textField;
  }

  if (!normalizedContent || typeof normalizedContent !== 'object' || Object.keys(normalizedContent).length === 0) {
    logger.error(
      { tag: 'WA_SEND_INVALID', sessionName, remoteNumber, normalizedContent },
      'Contenido de mensaje inválido o vacío para WhatsApp'
    );
    throw new AppError('Contenido de mensaje inválido o vacío para WhatsApp', 400);
  }

  const sanitized = String(remoteNumber || '').replace(/[^\d]/g, '');
  const normalizedDigits = normalizeWhatsAppNumber(sanitized);
  if (!normalizedDigits) {
    throw new AppError('Número remoto inválido', 400);
  }
  const selfJid = sock?.user?.id || sock?.authState?.creds?.me?.id || null;
  const selfNumber = selfJid ? String(selfJid).split('@')[0].replace(/[^\d]/g, '') : null;
  if (selfNumber && selfNumber === normalizedDigits) {
    throw new AppError('No se puede enviar a la misma sesión (JID destino coincide con la sesión)', 400);
  }
  const jid = remoteNumber?.includes('@') ? remoteNumber : `${normalizedDigits}@s.whatsapp.net`;

  let toSend = normalizedContent;
  let mediaMeta = null;
  const mediaCandidate = await buildMediaMessage(normalizedContent);
  if (mediaCandidate) {
    toSend = mediaCandidate.payload;
    mediaMeta = mediaCandidate.meta;
    if (normalizedContent.text && normalizedContent.text.length && !toSend.caption && !toSend.document) {
      toSend.caption = normalizedContent.text;
    }
  }

  let result = null;
  try {
    result = await withSendTimeout(sock.sendMessage(jid, toSend), env.whatsapp.sendTimeoutMs, {
      sessionName: name,
      remoteNumber: normalizedDigits
    });
  } catch (err) {
    if (err?.code === 'WA_SEND_TIMEOUT') {
      logger.error(
        { tag: 'WA_SEND_TIMEOUT', sessionName: name, remoteNumber: normalizedDigits, timeoutMs: env.whatsapp.sendTimeoutMs },
        'WhatsApp send timed out'
      );
    }
    throw err;
  }
  const messageId = result?.key?.id || null;
  const immediateError = await waitForImmediateSendError(record, messageId);
  if (immediateError) {
    const statusError = immediateError.statusError || immediateError.statusCode || 'unknown';
    const err = new AppError(`WhatsApp rechazó el mensaje (${statusError})`, 502);
    err.code = 'WA_SEND_REJECTED';
    err.context = {
      sessionName: name,
      remoteNumber: normalizedDigits,
      messageId,
      statusCode: immediateError.statusCode || null,
      statusError: immediateError.statusError || null
    };
    logger.error(
      { tag: 'WA_SEND_REJECTED', ...err.context },
      'WhatsApp rejected outbound message'
    );
    throw err;
  }
  return { messageId, mediaMeta };
};

export const deleteSession = async (sessionName, { userId = null, ip = null, tenantId = null, userAgent = null } = {}) => {
  const name = normalizeSessionName(sessionName);
  const resolvedTenant = await getTenantIdForSession(name, tenantId);
  const record = sessions.get(name);
  if (record?.controller?.sock) {
    try {
      record.controller.events.removeAllListeners();
      record.controller.sock.end();
    } catch (_err) {
      // ignore
    }
  }
  sessions.delete(name);
  creationLocks.delete(name);
  reconnectLocks.delete(name);
  deletedSessions.add(name);

  await pool.query('DELETE FROM whatsapp_sessions WHERE (session_name = $1 OR name = $1) AND tenant_id = $2', [name, resolvedTenant]);
  await recordWhatsAppAudit({
    sessionName: name,
    event: 'session_deleted',
    userId,
    ip,
    userAgent,
    tenantId: resolvedTenant
  }).catch(() => {});
  return { session: name, deleted: true };
};

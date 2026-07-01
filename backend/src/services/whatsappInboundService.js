import logger from '../infra/logging/logger.js';
import { getQueueIdsForSession } from '../infra/db/queueConnectionRepository.js';
import {
  createChatRecord,
  findOpenChatBySession,
  findLatestClosedChatBySession,
  touchChatOnInbound,
  setChatQueue
} from '../infra/db/chatRepository.js';
import {
  findMessageByDedupeKey,
  findMessageByUniqueKey,
  insertMessage,
  softDeleteMessage,
  updateMessageStatus
} from '../infra/db/chatMessageRepository.js';
import { updateSessionSyncTracking } from '../infra/db/whatsappSessionRepository.js';
import { recordChatAudit } from '../infra/db/chatAuditRepository.js';
import { recordChatAssignmentAudit } from '../infra/db/chatAssignmentAuditRepository.js';
import { emitToUsers, emitToRoles } from '../infra/realtime/socketHub.js';
import { ROLES } from '../domain/user/user.js';
import { buildMediaUrl } from '../shared/mediaUrl.js';
import { findWarmupMessage } from './warmupMessageRegistry.js';

const LOG_TAG = undefined;

const sanitizeText = (text) => {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed.length ? trimmed : null;
};

const digits = (value) => (value ? String(value).replace(/[^\d]/g, '') : '');

const resolveQueueForSession = async (sessionName) => {
  const ids = await getQueueIdsForSession(sessionName);
  if (!ids || ids.length === 0) return { queueId: null, multiple: false };
  if (ids.length === 1) return { queueId: ids[0], multiple: false };
  return { queueId: ids[0], multiple: true, allQueueIds: ids };
};

export const handleIncomingWhatsAppMessage = async ({
  sessionName,
  remoteNumber,
  remoteJid = null,
  messageId,
  content,
  text,
  timestamp,
  messageTimestamp = null,
  messageType = 'unknown',
  messageStatus = null,
  media = null,
  fromMe = false,
  tenantId = null,
  contactName = null,
  contactAvatar = null,
  pushName = null,
  isArchived = false,
  isMuted = false,
  isHistory = false
}) => {
  if (!sessionName || !remoteNumber) return null;
  if (!messageId) return null;
  if (!content) return null;
  const historyFlag = Boolean(isHistory);

  // Ignorar sincronización de historial al conectar el dispositivo.
  const protocolType =
    content?.protocolMessage?.type ||
    content?.message?.protocolMessage?.type ||
    content?.ephemeralMessage?.message?.protocolMessage?.type;
  if (protocolType === 'HISTORY_SYNC_NOTIFICATION') return null;

  const remoteDigits = digits(remoteNumber);
  const sessionDigits = digits(sessionName);
  // Ignorar chats con el mismo número de la sesión (autonotificación al conectar).
  if (remoteDigits && sessionDigits && remoteDigits === sessionDigits) return null;
  // Ignorar mensajes de grupos.
  if (remoteJid && typeof remoteJid === 'string' && remoteJid.endsWith('@g.us')) return null;

  const messageTime = timestamp
    ? new Date(timestamp)
    : messageTimestamp
    ? new Date(Number(messageTimestamp) * 1000)
    : new Date();
  const normalizedText = sanitizeText(text);
  const resolvedType = messageType || (content ? Object.keys(content)[0] || 'unknown' : 'unknown');
  const hasRenderableContent = Boolean(normalizedText || media);
  const isProtocolOnly = !hasRenderableContent && !!protocolType;
  const warmupMatch = await findWarmupMessage({
    sessionName,
    remoteNumber,
    messageId,
    tenantId,
    text: normalizedText || ''
  });
  if (warmupMatch) {
    await updateSessionSyncTracking({
      sessionName,
      tenantId,
      lastSyncedAt: messageTime,
      lastMessageId: messageId,
      syncState: historyFlag ? 'SYNCING' : 'IDLE',
      syncError: null
    }).catch(() => {});
    logger.info(
      {
        sessionName,
        remoteNumber,
        messageId,
        direction: fromMe ? 'out' : 'in',
        matchedBy: warmupMatch.matchedBy,
        tag: 'WARMUP_INTERNAL_MESSAGE'
      },
      'Warmup WhatsApp message ignored by chat inbox'
    );
    return null;
  }

  // Mensajes enviados por nosotros mismos (broadcast/masivos) o históricos outbound: registrar en chat cerrado sin notificaciones.
  if (fromMe) {
    if (isProtocolOnly) {
      return null;
    }
    let chat = await findOpenChatBySession({ tenantId, sessionName, remoteNumber });
    if (!chat) {
      chat = await findLatestClosedChatBySession({ tenantId, sessionName, remoteNumber });
    }
    if (!chat) {
      const historyQueue = await resolveQueueForSession(sessionName);
      chat = await createChatRecord({
        sessionName,
        remoteNumber,
        remoteJid,
        tenantId,
        contactName,
        contactAvatar,
        pushName,
        isArchived,
        isMuted,
        queueId: historyQueue.queueId || null,
        status: 'CLOSED',
        lastMessageAt: messageTime
      });
    } else {
      const statusUpper = (chat.status || '').toUpperCase();
      const protectedStatuses = ['UNASSIGNED', 'OPEN'];
      const nextStatus = protectedStatuses.includes(statusUpper) ? statusUpper : 'CLOSED';
      chat = await touchChatOnInbound({
        chatId: chat.id,
        status: nextStatus,
        lastMessageAt: messageTime,
        contactName,
        contactAvatar,
        pushName,
        isArchived,
        isMuted
      });
    }
    const existing = await findMessageByDedupeKey({
      sessionName,
      whatsappMessageId: messageId,
      tenantId: chat.tenantId || tenantId
    });
    if (existing) {
      await updateSessionSyncTracking({
        sessionName,
        tenantId: chat.tenantId || tenantId,
        lastSyncedAt: messageTime,
        lastMessageId: messageId,
        syncState: 'IDLE',
        syncError: null
      }).catch(() => {});
      return chat;
    }
    const saved = await insertMessage({
      chatId: chat.id,
      direction: 'out',
      content: {
        messageId,
        remoteNumber,
        remoteJid,
        text: normalizedText,
        payload: content,
        media
      },
      messageType: resolvedType,
      whatsappMessageId: messageId || null,
      timestamp: messageTime,
      whatsappSessionName: sessionName,
      remoteNumber,
      status: messageStatus || 'sent',
      tenantId: chat.tenantId || tenantId
    });
    await updateSessionSyncTracking({
      sessionName,
      tenantId: chat.tenantId || tenantId,
      lastSyncedAt: messageTime,
      lastMessageId: messageId,
      syncState: 'IDLE',
      syncError: null
    }).catch(() => {});
    return chat;
  }

  const existing = await findMessageByUniqueKey({
    sessionName,
    remoteNumber,
    whatsappMessageId: messageId,
    timestamp: messageTime,
    tenantId
  });
  if (existing) return existing;

  const queueResolution = await resolveQueueForSession(sessionName);
  const queueId = queueResolution.queueId;

  let chat = await findOpenChatBySession({ tenantId, sessionName, remoteNumber });
  if (!chat) {
    chat = await findLatestClosedChatBySession({ tenantId, sessionName, remoteNumber });
  }
  if (!chat) {
      chat = await createChatRecord({
        sessionName,
        remoteNumber,
        remoteJid,
        tenantId,
        contactName,
        contactAvatar,
        pushName,
        isArchived,
        isMuted,
        queueId,
        status: historyFlag ? 'CLOSED' : 'UNASSIGNED',
        lastMessageAt: messageTime
      });
  } else {
    const allowedStatuses = ['UNASSIGNED', 'OPEN', 'CLOSED'];
    const currentStatus = allowedStatuses.includes(chat.status) ? chat.status : 'UNASSIGNED';
    // Historia no debe reabrir chats; mantiene CLOSED. En vivo, reabre si estaba cerrado.
    const nextStatus = historyFlag ? 'CLOSED' : currentStatus === 'CLOSED' ? 'UNASSIGNED' : currentStatus;
    const statusChanged = currentStatus !== nextStatus;
    const previousAssignedAgentId = chat.assignedAgentId || null;
    chat = await touchChatOnInbound({
      chatId: chat.id,
      status: nextStatus,
      lastMessageAt: messageTime,
      contactName,
      contactAvatar,
      pushName,
      isArchived,
      isMuted
      });
    if (statusChanged) {
      await recordChatAudit({
        actorUserId: null,
        action: 'chat_status_updated',
        chatId: chat.id,
        queueId: chat.queueId,
        ip: null,
        metadata: {
          previousStatus: currentStatus,
          nextStatus,
          reason: historyFlag ? 'history_sync' : 'inbound_message',
          messageId: messageId || null,
          sessionName,
          previousAssignedAgentId
        }
      }).catch(() => {});
      if (nextStatus === 'UNASSIGNED' && previousAssignedAgentId) {
        await recordChatAssignmentAudit({
          chatId: chat.id,
          previousAgentId: previousAssignedAgentId,
          newAgentId: null,
          action: 'UNASSIGN',
          executedByUserId: null,
          reason: historyFlag ? 'history_reopen_unassign' : 'inbound_reopen_unassign',
          validatedQueue: true,
          fromConnectionId: chat.whatsappSessionName,
          toConnectionId: null
        }).catch(() => {});
      }
    }
    if (!chat.queueId && queueId) {
      chat = await setChatQueue(chat.id, queueId);
      if (queueResolution.multiple) {
        logger.warn({ sessionName, chatId: chat.id, queueIds: queueResolution.allQueueIds }, `${LOG_TAG}: multiple queues linked, assigned first`);
      }
    }
  }

  if (isProtocolOnly) {
    return chat;
  }

  const saved = await insertMessage({
    chatId: chat.id,
    direction: 'in',
    content: {
      messageId,
      remoteNumber,
      remoteJid,
      text: normalizedText,
      payload: content,
      media
    },
    messageType: resolvedType,
    whatsappMessageId: messageId || null,
    timestamp: messageTime,
    whatsappSessionName: sessionName,
    remoteNumber,
    status: 'received',
    tenantId: chat.tenantId || tenantId
  });
  await updateSessionSyncTracking({
    sessionName,
    tenantId: chat.tenantId || tenantId,
    lastSyncedAt: messageTime,
    lastMessageId: messageId,
    syncState: historyFlag ? 'SYNCING' : 'IDLE',
    syncError: null
  }).catch(() => {});
  // No emitir notificaciones durante sincronización histórica
  if (!historyFlag) {
    const payload = {
      chatId: chat.id,
      chat,
      message: {
        chatId: chat.id,
        direction: 'in',
        content: {
          messageId,
          remoteNumber,
          remoteJid,
          text: normalizedText,
          payload: content,
          media
        },
        whatsappMessageId: messageId || null,
        whatsappSessionName: sessionName,
        remoteNumber,
        status: 'received',
        timestamp: messageTime
      },
      messageId,
      messageType: resolvedType,
      mediaUrl: buildMediaUrl(media),
      sender: remoteNumber
    };

    const targets = [];
    if (chat.assignedAgentId) targets.push(chat.assignedAgentId);
    if (chat.assignedUserId && chat.assignedUserId !== chat.assignedAgentId) targets.push(chat.assignedUserId);
    if (targets.length) {
      await emitToUsers(targets, 'message:new', payload);
      if (payload.mediaUrl) await emitToUsers(targets, 'message:media', payload);
    }
    await emitToRoles([ROLES.ADMIN, ROLES.SUPERVISOR], 'message:new', payload);
    if (payload.mediaUrl) await emitToRoles([ROLES.ADMIN, ROLES.SUPERVISOR], 'message:media', payload);
  }

  await recordChatAudit({
    actorUserId: null,
    action: 'chat_message_in',
    chatId: chat.id,
    queueId: chat.queueId,
    ip: null,
    metadata: {
      remoteNumber,
      whatsappMessageId: messageId || null,
      timestamp: messageTime,
      direction: 'in',
      mediaType: media?.type || null,
      sha256: media?.sha256 || null
    }
  }).catch(() => {});

  if (media) {
    await recordChatAudit({
      actorUserId: null,
      action: 'RECEIVE_MEDIA',
      chatId: chat.id,
      queueId: chat.queueId,
      ip: null,
      metadata: {
        userId: null,
        chatId: chat.id,
        messageType: media.type || media.mimeType || 'media',
        fileSize: media.sizeBytes || null,
        hash: media.sha256 || null,
        timestamp: messageTime.toISOString()
      }
    }).catch(() => {});
  }

  logger.info(
    { sessionName, remoteNumber, chatId: chat.id, direction: 'in', tag: LOG_TAG },
    'Inbound WhatsApp message processed and persisted'
  );

  return chat;
};

export const handleWhatsAppMessageUpdate = async ({
  sessionName,
  remoteNumber,
  messageId,
  status = null,
  statusCode = null,
  statusError = null,
  editPayload = null,
  timestamp = null,
  tenantId = null
}) => {
  if (!sessionName || !remoteNumber || !messageId) {
    return null;
  }
  const warmupMatch = await findWarmupMessage({ sessionName, remoteNumber, messageId, tenantId });
  if (warmupMatch) {
    logger.info(
      {
        sessionName,
        remoteNumber,
      messageId,
      status,
      statusCode,
      statusError,
      matchedBy: warmupMatch.matchedBy,
      tag: 'WARMUP_INTERNAL_MESSAGE'
    },
      'Warmup WhatsApp message status ignored by chat inbox'
    );
    return { internal: true, warmup: true };
  }
  const updated = await updateMessageStatus({
    sessionName,
    remoteNumber,
    whatsappMessageId: messageId,
    status: status || null,
    editPayload,
    timestamp,
    tenantId
  });
  if (!updated) return null;
  logger.info(
    {
      sessionName,
      remoteNumber,
      messageId,
      status,
      statusCode,
      statusError,
      dbMessageId: updated.id,
      chatId: updated.chatId,
      tag: 'WA_ACK_STATUS_UPDATED'
    },
    'WhatsApp message status updated'
  );
  return updated;
};

export const handleWhatsAppMessageDelete = async ({ sessionName, remoteNumber, messageId, tenantId = null }) => {
  if (!sessionName || !remoteNumber || !messageId) {
    return null;
  }
  const warmupMatch = await findWarmupMessage({ sessionName, remoteNumber, messageId, tenantId });
  if (warmupMatch) {
    logger.info(
      { sessionName, remoteNumber, messageId, matchedBy: warmupMatch.matchedBy, tag: 'WARMUP_INTERNAL_MESSAGE' },
      'Warmup WhatsApp message delete ignored by chat inbox'
    );
    return null;
  }
  const deleted = await softDeleteMessage({ sessionName, remoteNumber, whatsappMessageId: messageId, tenantId });
  if (!deleted) {
    return null;
  }
  logger.info({ sessionName, remoteNumber, messageId, tag: LOG_TAG }, 'WhatsApp message marked as deleted');
  return deleted;
};

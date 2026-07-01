import { AppError } from '../shared/errors.js';
import { buildChatAccessTraceWithAudit } from '../shared/chatAccessTrace.js';
import { getChatById, getUserQueueIds, isUserInQueue, setChatQueue } from '../infra/db/chatRepository.js';
import { insertMessage, listMessagesByChat } from '../infra/db/chatMessageRepository.js';
import { recordAuditLog } from '../infra/db/auditRepository.js';
import { recordChatAudit } from '../infra/db/chatAuditRepository.js';
import { sendWhatsAppMessage } from './whatsappService.js';
import { emitToUsers, emitToRoles } from '../infra/realtime/socketHub.js';
import env from '../config/env.js';
import { ROLES } from '../domain/user/user.js';
import { buildMediaUrl } from '../shared/mediaUrl.js';
import crypto from 'node:crypto';
import pool from '../infra/db/postgres.js';
import { normalizeWhatsAppNumber } from '../shared/phoneNormalizer.js';
import logger from '../infra/logging/logger.js';
import { saveMediaBuffer } from '../infra/storage/mediaStorage.js';
import { emitMessageSentEvent, emitMessageReceivedEvent } from '../infra/realtime/chatEvents.js';
import { getQueueIdsForSession } from '../infra/db/queueConnectionRepository.js';
import { updateSessionSyncTracking } from '../infra/db/whatsappSessionRepository.js';

const logChatMsgAudit = async ({ actorId, action, chatId, ip, metadata }) => {
  await recordAuditLog({
    userId: actorId || null,
    action,
    resource: 'chat',
    resourceId: chatId,
    ip: ip || null,
    userAgent: null,
    metadata: metadata || {}
  });
};

const accessError = (message, trace, code = 'CHAT_ACCESS_DENIED') => new AppError(message, 403, trace, code);

const summarizeChatOutboundContent = (content) => {
  if (typeof content === 'string') return { kind: 'text', textLength: content.trim().length };
  if (!content || typeof content !== 'object') return { kind: typeof content };
  const text = [content.text, content.body, content.message].find((value) => typeof value === 'string') || '';
  const files = Array.isArray(content.files) ? content.files : [];
  return {
    kind: text ? 'text' : files.length ? 'media' : 'object',
    textLength: text ? text.length : null,
    fileCount: files.length || null,
    keys: Object.keys(content)
      .filter((key) => !['data', 'buffer', 'base64', 'file', 'files'].includes(key))
      .slice(0, 8)
  };
};

const logOutboundSendDebug = (tag, data, message) => {
  if (!env.whatsapp?.debugSend) return;
  logger.info({ tag, ...data }, message);
};

const ensureSendPermission = async (chat, user) => {
  const action = 'chat_send';
  if (!chat || !user) {
    throw accessError(
      'No autorizado',
      await buildChatAccessTraceWithAudit({ action, reason: 'missing_chat_or_user', chat, user }),
      'CHAT_SEND_DENIED'
    );
  }
  if (chat.status === 'CLOSED') {
    throw accessError(
      'Chat no está abierto para enviar mensajes',
      await buildChatAccessTraceWithAudit({ action, reason: 'chat_closed', chat, user }),
      'CHAT_SEND_DENIED'
    );
  }
  const isSupervisor = user.role === 'SUPERVISOR' || user.role === 'ADMIN';
  if (chat.queueId) {
    const inQueue = await isUserInQueue(user.id, chat.queueId);
    if (!inQueue && !isSupervisor) {
      const queueIds = await getUserQueueIds(user.id).catch(() => null);
      throw accessError(
        'No autorizado a enviar en este chat',
        await buildChatAccessTraceWithAudit({ action, reason: 'out_of_queue', chat, user, queueIds }),
        'CHAT_SEND_DENIED'
      );
    }
  }

  if (isSupervisor) return;

  // AGENTE: solo si es el asignado
  if (user.role === 'AGENTE') {
    if (!chat.assignedAgentId || chat.assignedAgentId !== user.id) {
      throw accessError(
        'Chat no asignado a este agente',
        await buildChatAccessTraceWithAudit({ action, reason: 'agent_not_assigned', chat, user }),
        'CHAT_SEND_DENIED'
      );
    }
  }
};

const resolveQueueForSessionOrThrow = async (sessionName, user) => {
  const sessionQueueIds = await getQueueIdsForSession(sessionName);
  if (!sessionQueueIds || sessionQueueIds.length === 0) return { queueId: null };
  if (sessionQueueIds.length > 1) {
    throw new AppError('La sesión está vinculada a múltiples colas. Selecciona una antes de continuar.', 400);
  }
  const queueId = sessionQueueIds[0];
  if (user.role !== 'ADMIN') {
    const inQueue = await isUserInQueue(user.id, queueId);
    if (!inQueue) {
      const userQueues = await getUserQueueIds(user.id).catch(() => null);
      throw accessError(
        'No perteneces a la cola configurada para este chat',
        await buildChatAccessTraceWithAudit({
          action: 'chat_send',
          reason: 'out_of_queue',
          chat: null,
          user,
          queueIds: userQueues,
          extra: { queueId, sessionName }
        }),
        'CHAT_SEND_DENIED'
      );
    }
  }
  return { queueId };
};

const logReadDeny = (reason, { chat, user, queueIds = null }) => {
  logger.warn(
    {
      tag: 'CHAT_READ_DENY',
      reason,
      chatId: chat?.id,
      chatStatus: chat?.status,
      chatQueueId: chat?.queueId,
      assignedAgentId: chat?.assignedAgentId,
      assignedUserId: chat?.assignedUserId,
      userId: user?.id,
      userRole: user?.role,
      userQueues: queueIds,
      tenantId: user?.tenantId
    },
    'Chat read denied'
  );
};

const ensureReadPermission = async (chat, user) => {
  if (!chat || !user) {
    logReadDeny('missing_chat_or_user', { chat, user });
    throw accessError(
      'No autorizado a ver este chat',
      await buildChatAccessTraceWithAudit({ action: 'chat_read', reason: 'missing_chat_or_user', chat, user }),
      'CHAT_READ_DENIED'
    );
  }
  if (user.role === 'ADMIN') return;

  const queueIds = (await getUserQueueIds(user.id)).map(String);
  const queueId = chat.queueId ? String(chat.queueId) : null;
  const inQueue = queueId ? queueIds.includes(queueId) : true;
  if (!inQueue) {
    // ISO 27001: control de acceso por cola; evita fuga de chats entre equipos
    logReadDeny('out_of_queue', { chat, user, queueIds });
    throw accessError(
      'No autorizado a ver este chat',
      await buildChatAccessTraceWithAudit({ action: 'chat_read', reason: 'out_of_queue', chat, user, queueIds }),
      'CHAT_READ_DENIED'
    );
  }

  if (user.role === 'SUPERVISOR') return;
  if (user.role === 'AGENTE') {
    if (chat.status !== 'OPEN' || chat.assignedAgentId !== user.id) {
      logReadDeny('agent_not_owner_or_closed', { chat, user, queueIds });
      throw accessError(
        'No autorizado a ver este chat',
        await buildChatAccessTraceWithAudit({ action: 'chat_read', reason: 'agent_not_owner_or_closed', chat, user, queueIds }),
        'CHAT_READ_DENIED'
      );
    }
    return;
  }
  logReadDeny('role_not_allowed', { chat, user, queueIds });
  throw accessError(
    'No autorizado a ver este chat',
    await buildChatAccessTraceWithAudit({ action: 'chat_read', reason: 'role_not_allowed', chat, user, queueIds }),
    'CHAT_READ_DENIED'
  );
};

const emitChatEvents = async (chat, message, { actorUserId = null } = {}) => {
  if (!chat || !message) return;
  const payload = {
    chatId: chat.id,
    messageId: message.id,
    messageType: message.messageType || message.content?.media?.type || null,
    mediaUrl: buildMediaUrl(message.content?.media),
    sender: message.direction === 'out' ? chat.assignedAgentId || chat.assignedUserId || 'agent' : chat.remoteNumber,
    chat,
    message
  };
  const targets = [];
  const addTarget = (id) => {
    if (!id) return;
    if (actorUserId && id === actorUserId) return; // No notificar al emisor local
    targets.push(id);
  };
  addTarget(chat.assignedAgentId);
  addTarget(chat.assignedUserId);
  if (targets.length) {
    await emitToUsers(targets, 'message:new', payload);
    if (payload.mediaUrl) await emitToUsers(targets, 'message:media', payload);
  }
  await emitToRoles([ROLES.ADMIN, ROLES.SUPERVISOR], 'message:new', payload);
  if (payload.mediaUrl) await emitToRoles([ROLES.ADMIN, ROLES.SUPERVISOR], 'message:media', payload);
};

export const sendMessage = async ({ chatId, content, user, ip = null, messageType, metadata = null }) => {
  const chat = await getChatById(chatId, { useCache: false });
  if (!chat) throw new AppError('Chat no encontrado', 404);
  logOutboundSendDebug(
    'CHAT_OUTBOUND_REQUEST',
    {
      chatId,
      userId: user?.id || null,
      userRole: user?.role || null,
      sessionName: chat.whatsappSessionName,
      remoteNumber: chat.remoteNumber,
      remoteJid: chat.remoteJid,
      chatStatus: chat.status,
      queueId: chat.queueId,
      content: summarizeChatOutboundContent(content)
    },
    'Chat outbound send requested'
  );
  try {
    if (!chat.queueId) {
      const { queueId } = await resolveQueueForSessionOrThrow(chat.whatsappSessionName, user);
      if (queueId) {
        const updated = await setChatQueue(chat.id, queueId);
        chat.queueId = updated.queueId;
      }
    }
    await ensureSendPermission(chat, user);
    const rawNumber = String(chat.remoteJid || chat.remoteNumber || '').replace(/[^\d]/g, '');
    const normalizedNumber = normalizeWhatsAppNumber(rawNumber);
    if (!normalizedNumber) throw new AppError('Número remoto inválido', 400);
    const target = chat.remoteJid || `${normalizedNumber}@s.whatsapp.net`;
    if (chat.remoteNumber !== normalizedNumber || !chat.remoteJid || !chat.remoteJid.includes(normalizedNumber)) {
      await pool
        .query('UPDATE chats SET remote_number = $1, remote_jid = $2, updated_at = NOW() WHERE id = $3', [
          normalizedNumber,
          target,
          chat.id
        ])
        .catch(() => {});
    }
    logger.info(
      { chatId, targetJid: target, normalizedNumber, sessionName: chat.whatsappSessionName, tag: 'WA_SEND_TARGET' },
      'Preparing outbound WhatsApp message'
    );
    if (chat.remoteNumber !== normalizedNumber || (chat.remoteJid && !chat.remoteJid.includes(normalizedNumber))) {
      await pool
        .query('UPDATE chats SET remote_number = $1, remote_jid = $2, updated_at = NOW() WHERE id = $3', [
          normalizedNumber,
          target,
          chat.id
        ])
        .catch(() => {});
    }

    const normalizedContent = typeof content === 'string' ? { text: content } : { ...(content || {}) };
    const transportContent = { ...normalizedContent };
    delete transportContent.metadata;
    delete transportContent.quickReply;

    const storedContent = { ...normalizedContent };
    if (Array.isArray(storedContent.files)) {
      storedContent.files = storedContent.files.map((f) => ({
        name: f.name,
        type: f.type,
        size: f.size
      }));
    }
    if (metadata) {
      storedContent.metadata = { ...(storedContent.metadata || {}), ...metadata };
    }
    const outbound = await sendWhatsAppMessage({
      sessionName: chat.whatsappSessionName,
      remoteNumber: target,
      content: transportContent
    });
    logOutboundSendDebug(
      'CHAT_OUTBOUND_TRANSPORT_OK',
      {
        chatId,
        sessionName: chat.whatsappSessionName,
        targetJid: target,
        whatsappMessageId: outbound?.messageId || null,
        hasMediaMeta: Boolean(outbound?.mediaMeta)
      },
      'Chat outbound transport accepted message'
    );
    const now = new Date();
    const msg = await insertMessage({
      chatId,
      direction: 'out',
      content: storedContent,
      messageType: messageType || normalizedContent?.type || Object.keys(normalizedContent || {})[0] || 'text',
      whatsappMessageId: outbound?.messageId || normalizedContent?.id || null,
      whatsappSessionName: chat.whatsappSessionName,
      remoteNumber: normalizedNumber,
      status: 'server',
      timestamp: now
    });
    logOutboundSendDebug(
      'CHAT_OUTBOUND_PERSISTED',
      {
        chatId,
        dbMessageId: msg.id,
        sessionName: msg.whatsappSessionName,
        remoteNumber: msg.remoteNumber,
        whatsappMessageId: msg.whatsappMessageId,
        status: msg.status
      },
      'Chat outbound message persisted'
    );
    await pool
      .query('UPDATE chats SET last_message_at = $1, updated_at = NOW() WHERE id = $2', [now, chatId])
      .catch(() => {});
    await updateSessionSyncTracking({
      sessionName: chat.whatsappSessionName,
      tenantId: chat.tenantId,
      lastSyncedAt: now,
      lastMessageId: msg.whatsappMessageId || msg.id,
      syncState: 'IDLE',
      syncError: null
    }).catch(() => {});
    await emitChatEvents(chat, msg, { actorUserId: user.id });
    const auditMetadata = {
      contentPreview: normalizedContent?.text || storedContent?.files?.[0]?.name || null,
      whatsappMessageId: msg?.whatsappMessageId || outbound?.messageId || null,
      direction: 'out',
      files: storedContent?.files || null,
      mediaMeta: outbound?.mediaMeta || null,
      quickReply: metadata?.quickReply || storedContent?.metadata?.quickReply || null
    };
    await logChatMsgAudit({ actorId: user.id, action: 'chat_message_out', chatId, ip, metadata: auditMetadata });
    await recordChatAudit({
      actorUserId: user.id,
      action: 'chat_message_out',
      chatId,
      queueId: chat.queueId,
      ip,
      metadata: auditMetadata
    });
    emitMessageSentEvent({ chat, message: msg });
    return msg;
  } catch (err) {
    logOutboundSendDebug(
      'CHAT_OUTBOUND_FAILED',
      {
        chatId: chat.id,
        sessionName: chat.whatsappSessionName,
        remoteNumber: chat.remoteNumber,
        errorName: err?.name || null,
        errorCode: err?.code || null,
        errorStatus: err?.status || err?.statusCode || null,
        errorMessage: err?.message || 'send_failed',
        errorContext: err?.context || null
      },
      'Chat outbound send failed'
    );
    const action = err?.status === 403 ? 'chat_send_denied' : 'chat_message_out_error';
    const errorMetadata = {
      error: err?.message || 'send_failed',
      direction: 'out'
    };
    await recordChatAudit({
      actorUserId: user.id,
      action,
      chatId: chat.id,
      queueId: chat.queueId,
      ip,
      metadata: errorMetadata
    }).catch(() => {});
    throw err;
  }
};

export const sendMediaMessage = async ({ chatId, file, caption = '', user, ip = null }) => {
  const chat = await getChatById(chatId, { useCache: false });
  if (!chat) throw new AppError('Chat no encontrado', 404);
  if (!chat.queueId) {
    const { queueId } = await resolveQueueForSessionOrThrow(chat.whatsappSessionName, user);
    if (queueId) {
      const updated = await setChatQueue(chat.id, queueId);
      chat.queueId = updated.queueId;
    }
  }
  await ensureSendPermission(chat, user);
  if (chat.status !== 'OPEN') {
    throw accessError(
      'Chat no está abierto para enviar media',
      await buildChatAccessTraceWithAudit({ action: 'chat_send_media', reason: 'chat_not_open', chat, user }),
      'CHAT_SEND_DENIED'
    );
  }
  if (!file?.buffer || !file.mimetype) throw new AppError('Archivo inválido', 400);
  const rawNumber = String(chat.remoteJid || chat.remoteNumber || '').replace(/[^\d]/g, '');
  const normalizedNumber = normalizeWhatsAppNumber(rawNumber);
  if (!normalizedNumber) throw new AppError('Número remoto inválido', 400);
  const target = chat.remoteJid || `${normalizedNumber}@s.whatsapp.net`;
  if (chat.remoteNumber !== normalizedNumber || (chat.remoteJid && !chat.remoteJid.includes(normalizedNumber))) {
    await pool
      .query('UPDATE chats SET remote_number = $1, remote_jid = $2, updated_at = NOW() WHERE id = $3', [
        normalizedNumber,
        target,
        chat.id
      ])
      .catch(() => {});
  }
  logger.info(
    { chatId, targetJid: target, normalizedNumber, sessionName: chat.whatsappSessionName, tag: 'WA_SEND_TARGET_MEDIA' },
    'Preparing outbound WhatsApp media message'
  );
  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');

  const maxBytes = env.media?.maxBytes || 6 * 1024 * 1024;
  if (file.size > maxBytes) throw new AppError(`Archivo supera el límite (${maxBytes} bytes)`, 400);
  const allowed = env.media?.allowedMimePrefixes || ['image/', 'video/', 'audio/', 'application/'];
  const isAllowed = allowed.some((p) => file.mimetype.toLowerCase().startsWith(p.toLowerCase()));
  if (!isAllowed) throw new AppError(`Tipo no permitido: ${file.mimetype}`, 400);

  const dataUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
  const content = {
    text: caption || '',
    files: [
      {
        name: file.originalname || file.filename || 'file',
        type: file.mimetype,
        size: file.size,
        dataUrl
      }
    ]
  };

  const storedContent = {
    text: caption || '',
    files: [
      {
        name: file.originalname || file.filename || 'file',
        type: file.mimetype,
        size: file.size
      }
    ]
  };

  const outbound = await sendWhatsAppMessage({
    sessionName: chat.whatsappSessionName,
    remoteNumber: target,
    content
  });

  const storedFile = await saveMediaBuffer({
    buffer: file.buffer,
    mimeType: file.mimetype,
    originalName: file.originalname || file.filename || 'file'
  });

  const mediaType = outbound?.mediaMeta?.type
    || (file.mimetype.startsWith('image/') && 'image')
    || (file.mimetype.startsWith('video/') && 'video')
    || (file.mimetype.startsWith('audio/') && 'audio')
    || 'document';

  const mediaMeta = {
    ...(outbound?.mediaMeta || {}),
    type: mediaType,
    sha256: hash,
    sizeBytes: file.size,
    mimeType: file.mimetype,
    fileId: storedFile.fileId,
    fileName: storedFile.fileName || file.originalname || file.filename || 'file',
    storagePath: storedFile.path,
    relativePath: storedFile.relativePath,
    caption: caption || null,
    isVoiceNote: outbound?.mediaMeta?.isVoiceNote || false,
    duration: outbound?.mediaMeta?.duration || null
  };

  const msg = await insertMessage({
    chatId,
    direction: 'out',
    content: { ...storedContent, media: mediaMeta },
    messageType: file.mimetype || 'media',
    whatsappMessageId: outbound?.messageId || null,
    whatsappSessionName: chat.whatsappSessionName,
    remoteNumber: chat.remoteNumber,
    status: 'server'
  });

  const auditMetadata = {
    contentPreview: caption || file.originalname || null,
    whatsappMessageId: msg?.whatsappMessageId || outbound?.messageId || null,
    direction: 'out',
    files: storedContent.files,
    mediaMeta: outbound?.mediaMeta || null
  };

  await emitChatEvents(chat, msg);
  await logChatMsgAudit({ actorId: user.id, action: 'chat_media_out', chatId, ip, metadata: auditMetadata });
  await recordChatAudit({
    actorUserId: user.id,
    action: 'chat_media_out',
    chatId,
    queueId: chat.queueId,
    ip,
    metadata: auditMetadata
  });

  await recordChatAudit({
    actorUserId: user.id,
    action: 'SEND_MEDIA',
    chatId,
    queueId: chat.queueId,
    ip,
    metadata: {
      userId: user.id,
      chatId,
      messageType: mediaMeta?.mimeType || file.mimetype,
      fileSize: file.size,
      hash,
      timestamp: new Date().toISOString()
    }
  });

  return msg;
};

export const receiveMessage = async ({ chatId, content }) => {
  // Para inbound no validamos usuario; se asume origen webhook/proceso interno
  const chat = await getChatById(chatId, { useCache: false });
  if (!chat) throw new AppError('Chat no encontrado', 404);
  const msg = await insertMessage({
    chatId,
    direction: 'in',
    content,
    messageType: content ? Object.keys(content)[0] || 'unknown' : 'unknown',
    whatsappMessageId: content?.id || null,
    whatsappSessionName: chat.whatsappSessionName,
    remoteNumber: chat.remoteNumber,
    status: 'received',
    tenantId: chat.tenantId
  });
  await recordChatAudit({
    actorUserId: null,
    action: 'chat_message_in',
    chatId,
    queueId: chat.queueId,
    ip: null,
    metadata: { whatsappMessageId: content?.id || null, direction: 'in' }
  }).catch(() => {});
  emitMessageReceivedEvent({ chat, message: msg });
  return msg;
};

export const getChatMessages = async ({ chatId, limit, cursor }, user) => {
  const chat = await getChatById(chatId, { useCache: false });
  if (!chat) throw new AppError('Chat no encontrado', 404);
  await ensureReadPermission(chat, user);
  return listMessagesByChat({ chatId, limit, cursor });
};

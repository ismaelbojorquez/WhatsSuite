import { AppError } from '../shared/errors.js';
import { buildChatAccessTraceWithAudit } from '../shared/chatAccessTrace.js';
import {
  getChatById,
  assignChatDb,
  unassignChatDb,
  isUserInQueue,
  getUserQueueIds,
  listChatCountsByVisibility,
  listChatsByVisibilityCursor,
  hasOpenChatConflict,
  findOpenChatBySession,
  findLatestClosedChatBySession,
  createChatForConnection,
  reopenChatRecord,
  resolveTenantId,
  listChatsByPhoneForExport
} from '../infra/db/chatRepository.js';
import { recordAuditLog } from '../infra/db/auditRepository.js';
import { recordChatAudit } from '../infra/db/chatAuditRepository.js';
import { recordChatAssignmentAudit } from '../infra/db/chatAssignmentAuditRepository.js';
import pool from '../infra/db/postgres.js';
import logger from '../infra/logging/logger.js';
import { invalidateChat, cacheAssignment } from '../infra/cache/chatCache.js';
import { emitChatAssignedEvent, emitChatClosedEvent } from '../infra/realtime/chatEvents.js';
import { normalizeWhatsAppNumber } from '../shared/phoneNormalizer.js';
import {
  listConnectionsForUser,
  userHasConnection,
  listQueuesForSessionAndUser,
  listQueuesForSession,
  connectionExists
} from '../infra/db/queueConnectionRepository.js';
import { selectAutoConnectionForChat } from './connectionSelectionService.js';
import { listSessions as listWhatsappSessions, getStatusForSession } from './whatsappService.js';

const logChatAudit = async ({ actorId, action, chatId, ip, metadata }) => {
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

export const assignChat = async (chatId, user, { ip = null } = {}) => {
  const chat = await getChatById(chatId);
  if (!chat) throw new AppError('Chat no encontrado', 404);

  // Solo agentes de la cola
  const isSupervisor = user.role === 'SUPERVISOR' || user.role === 'ADMIN';
  const allowed = isSupervisor ? true : await isUserInQueue(user.id, chat.queueId);
  if (!allowed) {
    const queueIds = await getUserQueueIds(user.id).catch(() => null);
    throw accessError(
      'No puedes asignarte un chat fuera de tus colas',
      await buildChatAccessTraceWithAudit({ action: 'chat_assign', reason: 'out_of_queue', chat, user, queueIds }),
      'CHAT_ASSIGN_DENIED'
    );
  }

  const wasClosed = chat.status === 'CLOSED';

  // Exclusividad: evitar dos agentes con mismo número/conexión
  const conflict = await hasOpenChatConflict({
    sessionName: chat.whatsappSessionName,
    remoteNumber: chat.remoteNumber,
    agentId: user.id,
    excludeChatId: chat.id
  });
  if (conflict) {
    throw new AppError('Conflicto: ya existe un chat abierto con ese número en esta conexión', 409);
  }

  const isReassigning = chat.assignedAgentId && chat.assignedAgentId !== user.id;

  // Agente no puede reasignar un chat que ya está asignado a otro
  if (!isSupervisor && isReassigning) {
    logger.warn(
      { chatId, userId: user.id, role: user.role, currentAssignee: chat.assignedAgentId, tag: 'CHAT_SECURITY' },
      'Reassign attempt blocked for non-supervisor'
    );
    throw accessError(
      'No autorizado a reasignar este chat',
      await buildChatAccessTraceWithAudit({
        action: 'chat_assign',
        reason: 'reassign_not_allowed',
        chat,
        user,
        extra: { currentAssignee: chat.assignedAgentId }
      }),
      'CHAT_ASSIGN_DENIED'
    );
  }

  const updated = await assignChatDb(chatId, user.id, { actorUserId: user.id });
  const auditAction = isReassigning ? 'REASSIGN' : 'MANUAL_ASSIGN';
  await recordChatAssignmentAudit({
    chatId,
    previousAgentId: chat.assignedAgentId || null,
    newAgentId: user.id,
    action: auditAction,
    executedByUserId: user.id,
    reason: auditAction === 'REASSIGN' ? 'manual_reassign' : 'manual_assign',
    validatedQueue: !!allowed
  });
  await logChatAudit({ actorId: user.id, action: 'chat_assigned', chatId, ip, metadata: { queueId: chat.queueId } });
  await recordChatAudit({
    actorUserId: user.id,
    action: 'chat_assigned',
    chatId,
    queueId: chat.queueId,
    ip,
    metadata: { assigned_agent_id: user.id, reopened: wasClosed }
  });
  if (wasClosed) {
    await logChatAudit({ actorId: user.id, action: 'chat_reopened', chatId, ip, metadata: { from_status: 'CLOSED' } });
  }
  await cacheAssignment(chatId, { assignedAgentId: updated.assignedAgentId, assignedAt: updated.assignedAt });
  await invalidateChat(chatId);
  emitChatAssignedEvent(updated);
  return updated;
};

export const unassignChat = async (chatId, user, { ip = null } = {}) => {
  const chat = await getChatById(chatId);
  if (!chat) throw new AppError('Chat no encontrado', 404);

  // Supervisor/Admin pueden, agente solo si es el asignado
  const isSupervisor = user.role === 'SUPERVISOR' || user.role === 'ADMIN';
  const allowedQueue = await isUserInQueue(user.id, chat.queueId);
  if (!allowedQueue) {
    const queueIds = await getUserQueueIds(user.id).catch(() => null);
    throw accessError(
      'No puedes operar chats fuera de tus colas',
      await buildChatAccessTraceWithAudit({ action: 'chat_unassign', reason: 'out_of_queue', chat, user, queueIds }),
      'CHAT_UNASSIGN_DENIED'
    );
  }

  if (!isSupervisor) {
    if (!chat.assignedAgentId || chat.assignedAgentId !== user.id) {
      throw accessError(
        'No puedes desasignar este chat',
        await buildChatAccessTraceWithAudit({ action: 'chat_unassign', reason: 'not_owner', chat, user }),
        'CHAT_UNASSIGN_DENIED'
      );
    }
  }

  const updated = await unassignChatDb(chatId);
  await recordChatAssignmentAudit({
    chatId,
    previousAgentId: chat.assignedAgentId || null,
    newAgentId: null,
    action: 'UNASSIGN',
    executedByUserId: user.id,
    reason: 'manual_unassign',
    validatedQueue: !!allowedQueue
  });
  await logChatAudit({ actorId: user.id, action: 'chat_unassigned', chatId, ip, metadata: { queueId: chat.queueId } });
  await recordChatAudit({
    actorUserId: user.id,
    action: 'chat_unassigned',
    chatId,
    queueId: chat.queueId,
    ip,
    metadata: {}
  });
  await cacheAssignment(chatId, { assignedAgentId: null, assignedAt: null });
  await invalidateChat(chatId);
  return updated;
};

export const listVisibleChats = async (user, { status, limit, cursor, search } = {}) => {
  if (!user) return { items: [], nextCursor: null };
  return listChatsByVisibilityCursor({ user, status, limit, cursor, search });
};

export const chatSummary = async (user) => {
  if (!user) return { OPEN: 0, UNASSIGNED: 0, CLOSED: 0 };
  return listChatCountsByVisibility(user);
};

export const listExportChatsByPhone = async (user, { phone, limit } = {}) => {
  const rawPhone = (phone || '').toString().trim();
  const digits = normalizeWhatsAppNumber(rawPhone);
  const rawDigits = rawPhone.replace(/[^\d]/g, '');
  if (!rawDigits || rawDigits.length < 6 || rawDigits.length > 32) {
    throw new AppError('Número de teléfono inválido', 400);
  }
  const phoneCandidates = Array.from(new Set([rawDigits, digits].filter(Boolean)));
  if (!phoneCandidates.length) throw new AppError('Número de teléfono inválido', 400);

  const items = await listChatsByPhoneForExport({ user, phoneCandidates, limit });
  return {
    phone: digits || rawDigits,
    phoneCandidates,
    items
  };
};

export const closeChat = async (chatId, user, { ip = null } = {}) => {
  const chat = await getChatById(chatId);
  if (!chat) throw new AppError('Chat no encontrado', 404);
  const inQueue = await isUserInQueue(user.id, chat.queueId);
  if (!inQueue) {
    const queueIds = await getUserQueueIds(user.id).catch(() => null);
    throw accessError(
      'No autorizado a operar este chat',
      await buildChatAccessTraceWithAudit({ action: 'chat_close', reason: 'out_of_queue', chat, user, queueIds }),
      'CHAT_CLOSE_DENIED'
    );
  }
  const isSupervisor = user.role === 'SUPERVISOR' || user.role === 'ADMIN';
  if (!isSupervisor) {
    if (!chat.assignedAgentId || chat.assignedAgentId !== user.id) {
      throw accessError(
        'No autorizado a cerrar este chat',
        await buildChatAccessTraceWithAudit({ action: 'chat_close', reason: 'not_owner', chat, user }),
        'CHAT_CLOSE_DENIED'
      );
    }
  }
  const { rows } = await pool.query(
    `UPDATE chats
     SET status = 'CLOSED',
         closed_at = NOW(),
         assigned_agent_id = NULL,
         assigned_user_id = NULL,
         assigned_at = NULL,
         updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [chatId]
  );
  const updated = rows[0]
    ? {
        ...chat,
        status: 'CLOSED',
        closedAt: rows[0].closed_at,
        assignedAgentId: null,
        assignedUserId: null
      }
    : null;
  await recordChatAssignmentAudit({
    chatId,
    previousAgentId: chat.assignedAgentId || null,
    newAgentId: null,
    action: 'CLOSE',
    executedByUserId: user.id,
    reason: 'manual_close',
    validatedQueue: !!inQueue
  });
  await recordChatAudit({
    actorUserId: user.id,
    action: 'chat_closed',
    chatId,
    queueId: chat.queueId,
    ip,
    metadata: {}
  });
  if (updated) {
    await cacheAssignment(chatId, { assignedAgentId: null, assignedAt: null });
    await invalidateChat(chatId);
    emitChatClosedEvent(updated);
  }
  return updated;
};

export const reopenChat = async (chatId, user, { ip = null } = {}) => {
  const chat = await getChatById(chatId);
  if (!chat) throw new AppError('Chat no encontrado', 404);
  const inQueue = await isUserInQueue(user.id, chat.queueId);
  if (!inQueue) {
    const queueIds = await getUserQueueIds(user.id).catch(() => null);
    throw accessError(
      'No autorizado a operar este chat',
      await buildChatAccessTraceWithAudit({ action: 'chat_reopen', reason: 'out_of_queue', chat, user, queueIds }),
      'CHAT_REOPEN_DENIED'
    );
  }
  const nextStatus = chat.assignedAgentId ? 'OPEN' : 'UNASSIGNED';
  const { rows } = await pool.query(
    `UPDATE chats SET status = $1, closed_at = NULL, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [nextStatus, chatId]
  );
  const updated = rows[0] ? { ...chat, status: nextStatus } : null;
  await recordChatAssignmentAudit({
    chatId,
    previousAgentId: chat.assignedAgentId || null,
    newAgentId: updated?.assignedAgentId || chat.assignedAgentId || null,
    action: 'AUTO_ASSIGN',
    executedByUserId: user.id,
    reason: 'reopen',
    validatedQueue: !!inQueue
  });
  await recordChatAudit({
    actorUserId: user.id,
    action: 'chat_reopened',
    chatId,
    queueId: chat.queueId,
    ip,
    metadata: {}
  });
  if (updated) {
    await cacheAssignment(chatId, { assignedAgentId: updated.assignedAgentId, assignedAt: updated.assignedAt });
    await invalidateChat(chatId);
  }
  return updated;
};

export const createOrReopenChat = async ({ sessionName, contact, queueId }, user, { ip = null, userAgent = null } = {}) => {
  let trimmedSession = (sessionName || '').trim();
  let selectionMeta = { sessionName: trimmedSession || null, score: null, reason: trimmedSession ? 'client_provided' : 'auto_select' };
  const rawContact = (contact || '').toString().trim();
  if (!rawContact) throw new AppError('Contacto requerido', 400);
  const normalizedNumber = normalizeWhatsAppNumber(rawContact);
  if (!normalizedNumber) throw new AppError('Número de contacto inválido', 400);
  const remoteJid = `${normalizedNumber}@s.whatsapp.net`;
  const tenantId = await resolveTenantId(user?.id || null);

  // Selección automática de conexión solo cuando el cliente no especifica sessionName.
  // Se ejecuta antes de validaciones de permisos/colas y antes de persistir el chat.
  if (!trimmedSession) {
    // Reservar la conexión ganadora y excluirla de otras selecciones concurrentes con el mismo usuario/tenant.
    await pool.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`auto_conn_${tenantId || 'default'}_${user.id}`]);

    const selection = await selectAutoConnectionForChat({ user, tenantId, queueId }).catch((err) => {
      // Falla controlada: sin teléfono seguro no se crea el chat.
      throw new AppError(err.message || 'No se pudo seleccionar una conexión elegible', err.statusCode || 503);
    });
    trimmedSession = selection.sessionName;
    selectionMeta = { sessionName: selection.sessionName, score: selection.score, reason: 'auto_select' };
  }

  const isPrivileged = user?.role === 'ADMIN' || user?.role === 'SUPERVISOR';

  const allowedConnection = isPrivileged
    ? await connectionExists(trimmedSession)
    : await userHasConnection(user?.id || null, trimmedSession);
  if (!allowedConnection) {
    throw accessError(
      'No hay una conexión segura disponible para crear el chat',
      await buildChatAccessTraceWithAudit({
        action: 'chat_create',
        reason: 'connection_not_allowed',
        chat: null,
        user,
        extra: { sessionName: trimmedSession }
      }),
      'CHAT_CREATE_DENIED'
    );
  }

  const queuesForConnection = isPrivileged
    ? await listQueuesForSession(trimmedSession)
    : await listQueuesForSessionAndUser(trimmedSession, user?.id || null);
  if (!queuesForConnection.length) {
    throw accessError(
      'No tienes colas asignadas para esta conexión',
      await buildChatAccessTraceWithAudit({
        action: 'chat_create',
        reason: 'no_queues_for_connection',
        chat: null,
        user,
        extra: { sessionName: trimmedSession }
      }),
      'CHAT_CREATE_DENIED'
    );
  }
  const requestedQueueId = queueId ? String(queueId) : null;
  let targetQueueId = null;
  if (requestedQueueId) {
    const match = queuesForConnection.find((q) => q.id === requestedQueueId);
    if (!match) throw new AppError('Cola inválida para esta conexión', 400);
    targetQueueId = match.id;
  } else if (queuesForConnection.length === 1) {
    targetQueueId = queuesForConnection[0].id;
  } else {
    throw new AppError('Selecciona una cola para esta conexión', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock lógico por conexión para evitar carreras.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [trimmedSession]);

    const openChat = await findOpenChatBySession({
      tenantId,
      sessionName: trimmedSession,
      remoteNumber: normalizedNumber,
      client,
      forUpdate: true
    });
    if (openChat) {
      await client.query('ROLLBACK');
      await recordAuditLog({
        userId: user?.id || null,
        action: 'CHAT_BLOCKED_ALREADY_OPEN',
        resource: 'chat',
        resourceId: openChat.id,
        ip,
        userAgent,
        metadata: { sessionName: trimmedSession, tenantId }
      }).catch(() => {});
      await recordChatAudit({
        actorUserId: user?.id || null,
        action: 'CHAT_BLOCKED_ALREADY_OPEN',
        chatId: openChat.id,
        queueId: openChat.queueId || null,
        ip,
        metadata: { sessionName: trimmedSession, tenantId }
      }).catch(() => {});
      throw new AppError('Ya existe un chat activo para este contacto en esta conexión', 409);
    }

    const closedChat = await findLatestClosedChatBySession({
      tenantId,
      sessionName: trimmedSession,
      remoteNumber: normalizedNumber,
      client,
      forUpdate: true
    });

    const canReuseClosed =
      closedChat &&
      (!closedChat.remoteNumber || closedChat.remoteNumber === normalizedNumber);

    let chat = null;
    let action = 'CHAT_CREATE';
    if (canReuseClosed) {
      chat = await reopenChatRecord({
        client,
        chatId: closedChat.id,
        remoteNumber: closedChat.remoteNumber ? undefined : normalizedNumber,
        remoteJid: closedChat.remoteJid ? undefined : remoteJid,
        queueId: targetQueueId
      });
      action = 'CHAT_REOPEN';
    } else {
      chat = await createChatForConnection({
        client,
        tenantId,
        sessionName: trimmedSession,
        remoteNumber: normalizedNumber,
        remoteJid,
        status: 'OPEN',
        queueId: targetQueueId
      });
    }

    // Asignación automática al creador
    chat = await assignChatDb(chat.id, user?.id || null, { actorUserId: user?.id || null }, client);

    await client.query('COMMIT');

    await recordChatAssignmentAudit({
      chatId: chat?.id || null,
      previousAgentId: null,
      newAgentId: user?.id || null,
      action: 'AUTO_ASSIGN',
      executedByUserId: user?.id || null,
      reason: 'creator_auto_assign',
      fromConnectionId: null,
      toConnectionId: trimmedSession,
      validatedQueue: true,
      tenantId
    }).catch(() => {});

    await recordAuditLog({
      userId: user?.id || null,
      action,
      resource: 'chat',
      resourceId: chat?.id || null,
      ip,
      userAgent,
      metadata: { sessionName: trimmedSession, contact: normalizedNumber, tenantId, queueId: targetQueueId }
    }).catch(() => {});
    await recordChatAudit({
      actorUserId: user?.id || null,
      action,
      chatId: chat?.id || null,
      queueId: chat?.queueId || targetQueueId || null,
      ip,
      metadata: { sessionName: trimmedSession, contact: normalizedNumber, queueId: targetQueueId }
    }).catch(() => {});
    // Trazabilidad de selección de conexión (chat_id, connection, score, motivo, timestamp).
    await recordChatAudit({
      actorUserId: user?.id || null,
      action: 'chat_connection_selected',
      chatId: chat?.id || null,
      queueId: chat?.queueId || targetQueueId || null,
      ip,
      metadata: {
        connectionId: trimmedSession,
        score: selectionMeta?.score ?? null,
        reason: selectionMeta?.reason || 'auto_select',
        at: new Date().toISOString()
      }
    }).catch(() => {});

    await cacheAssignment(chat.id, { assignedAgentId: chat.assignedAgentId, assignedAt: chat.assignedAt });
    await invalidateChat(chat.id);
    return chat;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
};

export const listConnectionsForUserService = async (user) => {
  if (!user?.id) return { connections: [] };
  const connections = await listConnectionsForUser(user.id, { includeAll: false });

  // Enriquecer con estado vivo igual que la página de Conexiones
  let liveStatusMap = new Map();
  try {
    const live = await listWhatsappSessions();
    liveStatusMap = new Map(
      (live || []).map((s) => [
        s.session || s.sessionName || s.id,
        (s.status || '').toLowerCase() || 'unknown'
      ])
    );
  } catch (_err) {
    // si falla, se deja el status que viene de DB
  }

  // Para asegurar que los estados sean los más frescos, intenta obtener /status por sesión si sigue pendiente.
  const enriched = await Promise.all(
    connections.map(async (c) => {
      let status = liveStatusMap.get(c.sessionName) || c.status || null;
      if (!status || status === 'pending' || status === 'connecting') {
        try {
          const st = await getStatusForSession(c.sessionName);
          status = (st?.status || status || 'unknown').toLowerCase();
        } catch (_err) {
          // ignorar y conservar status actual
        }
      }
      return { ...c, status };
    })
  );

  return { connections: enriched };
};

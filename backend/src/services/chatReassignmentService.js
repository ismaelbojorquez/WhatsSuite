import { AppError } from '../shared/errors.js';
import { buildChatAccessTraceWithAudit } from '../shared/chatAccessTrace.js';
import {
  getChatById,
  assignChatDb,
  isUserInQueue,
  getChatBySessionAndRemote,
  reassignChatWithConnectionDb,
  hasOpenChatConflict
} from '../infra/db/chatRepository.js';
import { recordChatAssignmentAudit } from '../infra/db/chatAssignmentAuditRepository.js';
import logger from '../infra/logging/logger.js';
import pool from '../infra/db/postgres.js';
import { recordChatAudit } from '../infra/db/chatAuditRepository.js';
import { emitToUsers, emitToRoles } from '../infra/realtime/socketHub.js';
import { emitChatReassignedEvent } from '../infra/realtime/chatEvents.js';

const LOG_TAG = 'CHAT_REASSIGN';
const accessError = (message, trace, code = 'CHAT_REASSIGN_DENIED') => new AppError(message, 403, trace, code);

const assertQueueCompatibility = async (agentId, queueId) => {
  if (!queueId) return true; // Chats sin cola: permitido.
  return isUserInQueue(agentId, queueId);
};

const assertSessionExists = async (sessionName) => {
  const { rows } = await pool.query('SELECT 1 FROM whatsapp_sessions WHERE session_name = $1 AND deleted_at IS NULL LIMIT 1', [sessionName]);
  if (!rows[0]) throw new AppError('Conexión/WhatsApp session no existe', 404);
};

const isSupervisor = (role) => role === 'ADMIN' || role === 'SUPERVISOR';

export const reassignChat = async ({ chatId, toAgentId, reason = null, user, sessionName = null }) => {
  if (!user) {
    throw accessError(
      'No autorizado a reasignar',
      await buildChatAccessTraceWithAudit({
        action: 'chat_reassign',
        reason: 'missing_user',
        chat: chatId ? { id: chatId } : null,
        user,
        extra: { toAgentId, sessionName }
      })
    );
  }
  const supervisorRole = isSupervisor(user.role);
  const isAgent = user.role === 'AGENTE';
  if (!supervisorRole && !isAgent) {
    logger.warn({ userId: user?.id, role: user?.role, tag: LOG_TAG }, 'Reassign blocked: insufficient role');
    throw accessError(
      'No autorizado a reasignar',
      await buildChatAccessTraceWithAudit({
        action: 'chat_reassign',
        reason: 'role_not_allowed',
        chat: chatId ? { id: chatId } : null,
        user,
        extra: { toAgentId, sessionName }
      })
    );
  }
  if (!chatId || !toAgentId) throw new AppError('Parámetros incompletos para reasignar', 400);

  const chat = await getChatById(chatId);
  if (!chat) throw new AppError('Chat no encontrado', 404);
  // Permitimos reasignar aunque el chat estuviera cerrado; la reasignación lo reabre.
  if (chat.assignedAgentId && chat.assignedAgentId === toAgentId) {
    throw new AppError('Chat ya asignado a ese agente', 409);
  }

  if (isAgent) {
    if (!chat.assignedAgentId || chat.assignedAgentId !== user.id) {
      throw accessError(
        'Solo puedes transferir chats asignados a ti',
        await buildChatAccessTraceWithAudit({
          action: 'chat_reassign',
          reason: 'agent_not_owner',
          chat,
          user,
          extra: { toAgentId, sessionName }
        })
      );
    }
    if (!chat.queueId) {
      throw accessError(
        'Solo puedes transferir chats con cola asignada',
        await buildChatAccessTraceWithAudit({
          action: 'chat_reassign',
          reason: 'agent_missing_queue',
          chat,
          user,
          extra: { toAgentId, sessionName }
        })
      );
    }
    const actorInQueue = await assertQueueCompatibility(user.id, chat.queueId);
    if (!actorInQueue) {
      throw accessError(
        'No puedes transferir chats fuera de tu cola',
        await buildChatAccessTraceWithAudit({
          action: 'chat_reassign',
          reason: 'actor_out_of_queue',
          chat,
          user,
          extra: { toAgentId, sessionName }
        })
      );
    }
    if (sessionName && sessionName !== chat.whatsappSessionName) {
      throw accessError(
        'No puedes cambiar la conexión al transferir el chat',
        await buildChatAccessTraceWithAudit({
          action: 'chat_reassign',
          reason: 'agent_session_change_denied',
          chat,
          user,
          extra: { toAgentId, sessionName }
        })
      );
    }
  }

  const targetSession = isAgent ? chat.whatsappSessionName : sessionName || chat.whatsappSessionName;
  await assertSessionExists(targetSession);

  const allowedQueue = await assertQueueCompatibility(toAgentId, chat.queueId);
  if (!allowedQueue) {
    logger.warn(
      { chatId, queueId: chat.queueId, toAgentId, tag: LOG_TAG },
      'Reassign blocked: agent not in queue'
    );
    throw accessError(
      'Agente destino no pertenece a la cola del chat',
      await buildChatAccessTraceWithAudit({
        action: 'chat_reassign',
        reason: 'target_agent_out_of_queue',
        chat,
        user,
        extra: { toAgentId, sessionName: targetSession }
      })
    );
  }

  // Requisito: ambos agentes deben compartir la cola
  if (chat.assignedAgentId) {
    const fromAllowed = await assertQueueCompatibility(chat.assignedAgentId, chat.queueId);
    if (!fromAllowed) {
      logger.warn(
        { chatId, queueId: chat.queueId, fromAgentId: chat.assignedAgentId, tag: LOG_TAG },
        'Reassign blocked: origin agent not in queue'
      );
      throw accessError(
        'Agente origen no pertenece a la cola del chat',
        await buildChatAccessTraceWithAudit({
          action: 'chat_reassign',
          reason: 'origin_agent_out_of_queue',
          chat,
          user,
          extra: { toAgentId, sessionName: targetSession }
        })
      );
    }
  }

  // Para reasignación manual, no se exige que el agente esté conectado (solo distribución automática lo requiere).

  // Exclusividad: no permitir otro chat abierto con el mismo número en la misma conexión asignado a otro agente.
  const conflict = await hasOpenChatConflict({
    sessionName: targetSession,
    remoteNumber: chat.remoteNumber,
    agentId: toAgentId,
    excludeChatId: chat.id
  });
  if (conflict) {
    logger.warn(
      { chatId, toAgentId, sessionName: targetSession, remoteNumber: chat.remoteNumber, tag: LOG_TAG },
      'Reassign blocked: conflict with existing open chat on same connection/number'
    );
    await recordChatAudit({
      actorUserId: user.id,
      action: 'chat_reassign_denied',
      chatId: chat.id,
      queueId: chat.queueId,
      ip: null,
      metadata: {
        reason: 'conflict_same_connection_number',
        toAgentId,
        sessionName: targetSession
      }
    }).catch(() => {});
    throw new AppError('Conflicto: otro chat abierto con ese número en la misma conexión', 409);
  }

  const updated =
    targetSession && targetSession !== chat.whatsappSessionName
      ? await reassignChatWithConnectionDb({ chatId, newAgentId: toAgentId, newSessionName: targetSession, actorUserId: user.id })
      : await assignChatDb(chatId, toAgentId, { actorUserId: user.id });

  await recordChatAssignmentAudit({
    chatId,
    previousAgentId: chat.assignedAgentId || null,
    newAgentId: toAgentId,
    action: 'REASSIGN',
    executedByUserId: user.id,
    reason: reason || (isAgent ? 'agent_transfer' : 'manual_reassign'),
    validatedQueue: !!allowedQueue,
    fromConnectionId: chat.whatsappSessionName,
    toConnectionId: targetSession
  });

  // Emitir eventos en tiempo real
  const payload = { chat: updated, fromAgentId: chat.assignedAgentId || null, toAgentId, fromSession: chat.whatsappSessionName, toSession: targetSession };
  if (chat.assignedAgentId) {
    await emitToUsers([chat.assignedAgentId], 'chat:reassigned', { ...payload, action: 'removed' });
  }
  await emitToUsers([toAgentId], 'chat:reassigned', { ...payload, action: 'added' });
  if (chat.whatsappSessionName !== targetSession) {
    await emitToUsers([toAgentId], 'chat:connectionChanged', { chatId, fromSession: chat.whatsappSessionName, toSession: targetSession });
  }
  await emitToRoles(['ADMIN', 'SUPERVISOR'], 'chat:update', updated);
  // Para el agente previo removemos visibilidad; para el nuevo añadimos visibilidad inmediata
  if (chat.assignedAgentId && chat.assignedAgentId !== toAgentId) {
    await emitToUsers([chat.assignedAgentId], 'chat:update', { ...updated, hidden: true });
  }
  await emitToUsers([toAgentId], 'chat:update', updated);
  emitChatReassignedEvent({ chat: updated, fromAgentId: chat.assignedAgentId || null, toAgentId });

  logger.info(
    { tag: LOG_TAG, chatId, fromAgentId: chat.assignedAgentId || null, toAgentId, executor: user.id },
    'Chat reassigned'
  );

  return updated;
};

// Helper por si se usa en base a remoteId/session (opcional para integraciones)
export const reassignChatByJid = async ({ sessionName, remoteNumber, toAgentId, reason = null, user }) => {
  const chat = await getChatBySessionAndRemote(sessionName, remoteNumber);
  if (!chat) throw new AppError('Chat no encontrado', 404);
  return reassignChat({ chatId: chat.id, toAgentId, reason, user });
};

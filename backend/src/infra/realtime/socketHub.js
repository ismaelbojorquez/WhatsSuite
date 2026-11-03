import logger from '../logging/logger.js';
import {
  listConnectionsByUserIds,
  listConnectionsByRoles
} from '../db/userConnectionRepository.js';

let ioInstance = null;
let eventsNamespace = null;

// Actual authenticated sockets, never the persisted rows left behind by a crashed process.
export const connectedWorkforceUsers = () => eventsNamespace === null ? null : new Set(
  [...eventsNamespace.sockets.values()].filter(s => s.connected && s.data?.userId).map(s => s.data.userId)
);

export const initSocketHub = (io) => {
  ioInstance = io;
  eventsNamespace = io.of('/events');
};

const emitToSocketIds = (socketIds, event, payload) => {
  if (!ioInstance) return;
  for (const id of socketIds) {
    // Priorizar namespace /events; si no existe, intentar en el namespace raíz
    const socket =
      eventsNamespace?.sockets?.get(id) ||
      ioInstance.sockets?.sockets?.get(id) ||
      eventsNamespace?.to ? null : null;
    if (socket) {
      // emit direct socket
      socket.emit(event, payload);
    } else if (eventsNamespace) {
      // fallback: emitir por room directa al id; Socket.IO entrega al namespace correcto si coincide
      // emit socket room
      eventsNamespace.to(id).emit(event, payload);
    }
  }
};

export const emitToUsers = async (userIds = [], event, payload) => {
  if (!ioInstance || !Array.isArray(userIds) || userIds.length === 0) return;
  try {
    const connections = await listConnectionsByUserIds(userIds);
    const socketIds = connections.map((c) => c.socketId).filter(Boolean);
    // emit users
    emitToSocketIds(socketIds, event, payload);
  } catch (err) {
    logger.warn({ err, event, tag: 'SOCKET_HUB' }, 'Failed to emit to users');
  }
};

export const emitToRoles = async (roles = [], event, payload) => {
  if (!ioInstance || !Array.isArray(roles) || roles.length === 0) return;
  try {
    const connections = await listConnectionsByRoles(roles);
    const socketIds = connections.map((c) => c.socketId).filter(Boolean);
    // emit roles
    emitToSocketIds(socketIds, event, payload);
  } catch (err) {
    logger.warn({ err, event, tag: 'SOCKET_HUB' }, 'Failed to emit to roles');
  }
};

export const emitToAll = (event, payload) => {
  if (!ioInstance) return;
  ioInstance.emit(event, payload);
  if (eventsNamespace) {
    eventsNamespace.emit(event, payload);
  }
};

export const joinRooms = (socket, { userId, role, queueIds = [] } = {}) => {
  if (!socket) return;
  if (userId) {
    socket.join(`agent:${userId}`);
  }
  if (Array.isArray(queueIds)) {
    queueIds.forEach((q) => socket.join(`queue:${q}`));
  }
  if (role) {
    socket.join(`role:${role}`);
  }
};

export const emitToAgentRoom = (agentId, event, payload) => {
  if (!ioInstance || !agentId) return;
  // emit agent room
  ioInstance.to(`agent:${agentId}`).emit(event, payload);
  if (eventsNamespace) eventsNamespace.to(`agent:${agentId}`).emit(event, payload);
};

export const emitToQueueRoom = (queueId, event, payload) => {
  if (!ioInstance || !queueId) return;
  // emit queue room
  ioInstance.to(`queue:${queueId}`).emit(event, payload);
  if (eventsNamespace) eventsNamespace.to(`queue:${queueId}`).emit(event, payload);
};

export const emitToRoleRoom = (role, event, payload) => {
  if (!ioInstance || !role) return;
  // emit role room
  ioInstance.to(`role:${role}`).emit(event, payload);
  if (eventsNamespace) eventsNamespace.to(`role:${role}`).emit(event, payload);
};

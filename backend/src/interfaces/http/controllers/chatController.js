import httpStatus from 'http-status';
import {
  listVisibleChats,
  assignChat,
  unassignChat,
  closeChat,
  reopenChat,
  chatSummary,
  createOrReopenChat,
  listConnectionsForUserService,
  listExportChatsByPhone
} from '../../../services/chatService.js';
import { reassignChat } from '../../../services/chatReassignmentService.js';
import { getChatMessages, sendMessage, sendMediaMessage } from '../../../services/chatMessageService.js';
import { AppError } from '../../../shared/errors.js';

const ok = (data, message = 'OK', code = 'OK') => ({ success: true, data, message, code });

export const listChatsController = async (req, res, next) => {
  try {
    const { status, cursor, limit, search } = req.query;
    const chats = await listVisibleChats(req.user, {
      status,
      cursor,
      limit: limit ? Number(limit) : undefined,
      search
    });
    res.status(httpStatus.OK).json(ok(chats));
  } catch (err) {
    next(err);
  }
};

export const chatSummaryController = async (req, res, next) => {
  try {
    const summary = await chatSummary(req.user);
    res.status(httpStatus.OK).json(ok(summary));
  } catch (err) {
    next(err);
  }
};

export const getChatMessagesController = async (req, res, next) => {
  try {
    const { chatId } = req.params;
    const { limit, cursor } = req.query;
    const result = await getChatMessages({ chatId, limit: limit ? Number(limit) : undefined, cursor }, req.user);
    res.status(httpStatus.OK).json(ok(result));
  } catch (err) {
    next(err);
  }
};

export const assignChatController = async (req, res, next) => {
  try {
    const { chatId } = req.params;
    const result = await assignChat(chatId, req.user, { ip: req.ip });
    res.status(httpStatus.OK).json(ok(result));
  } catch (err) {
    next(err);
  }
};

export const unassignChatController = async (req, res, next) => {
  try {
    const { chatId } = req.params;
    const result = await unassignChat(chatId, req.user, { ip: req.ip });
    res.status(httpStatus.OK).json(ok(result));
  } catch (err) {
    next(err);
  }
};

export const closeChatController = async (req, res, next) => {
  try {
    const { chatId } = req.params;
    const result = await closeChat(chatId, req.user, { ip: req.ip });
    if (!result) throw new AppError('Chat no encontrado', 404);
    res.status(httpStatus.OK).json(ok(result));
  } catch (err) {
    next(err);
  }
};

export const reopenChatController = async (req, res, next) => {
  try {
    const { chatId } = req.params;
    const result = await reopenChat(chatId, req.user, { ip: req.ip });
    if (!result) throw new AppError('Chat no encontrado', 404);
    res.status(httpStatus.OK).json(ok(result));
  } catch (err) {
    next(err);
  }
};

export const createChatController = async (req, res, next) => {
  try {
    const { sessionName, contact, queueId } = req.body || {};
    const chat = await createOrReopenChat({ sessionName, contact, queueId }, req.user, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null
    });
    res.status(httpStatus.CREATED).json(ok(chat, 'CREATED', 'CREATED'));
  } catch (err) {
    next(err);
  }
};

export const listChatConnectionsController = async (req, res, next) => {
  try {
    const data = await listConnectionsForUserService(req.user);
    res.status(httpStatus.OK).json(ok(data));
  } catch (err) {
    next(err);
  }
};

export const listExportChatsByPhoneController = async (req, res, next) => {
  try {
    const { phone, limit } = req.query;
    const data = await listExportChatsByPhone(req.user, {
      phone,
      limit: limit ? Number(limit) : undefined
    });
    res.status(httpStatus.OK).json(ok(data));
  } catch (err) {
    next(err);
  }
};

export const sendMessageController = async (req, res, next) => {
  try {
    const { chatId } = req.params;
    const body = req.body || {};
    // Si el frontend envía { text: "..."} sin envolver en "content", lo usamos directamente.
    const content = Object.prototype.hasOwnProperty.call(body, 'content') ? body.content : body;
    const result = await sendMessage({ chatId, content, user: req.user, ip: req.ip });
    res.status(httpStatus.CREATED).json(ok(result, 'SENT', 'SENT'));
  } catch (err) {
    next(err);
  }
};

export const sendMediaMessageController = async (req, res, next) => {
  try {
    const { chatId } = req.params;
    const file = req.file;
    const { caption } = req.body || {};
    if (!file) throw new AppError('Archivo requerido', 400);
    const result = await sendMediaMessage({ chatId, file, caption, user: req.user, ip: req.ip });
    res.status(httpStatus.CREATED).json(ok(result, 'SENT', 'SENT'));
  } catch (err) {
    next(err);
  }
};

export const reassignChatController = async (req, res, next) => {
  try {
    const { chatId } = req.params;
    const { toAgentId, reason, sessionName } = req.body || {};
    const result = await reassignChat({ chatId, toAgentId, reason, user: req.user, sessionName });
    res.status(httpStatus.OK).json(ok(result, 'REASSIGNED', 'REASSIGNED'));
  } catch (err) {
    next(err);
  }
};

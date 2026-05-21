import { Router } from 'express';
import { authorize, authenticate } from '../middlewares/authMiddleware.js';
import multer from 'multer';
import env from '../../../config/env.js';
import {
  listChatsController,
  getChatMessagesController,
  assignChatController,
  unassignChatController,
  closeChatController,
  reopenChatController,
  sendMessageController,
  chatSummaryController,
  reassignChatController,
  sendMediaMessageController,
  createChatController,
  listChatConnectionsController,
  listExportChatsByPhoneController
} from '../controllers/chatController.js';
import { ROLES } from '../../../domain/user/user.js';
import { chatCreateValidator } from '../validators/chatValidators.js';
import validateRequest from '../middlewares/validateRequest.js';

const router = Router();
router.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.media?.maxBytes || 50 * 1024 * 1024 }
});

// List visible chats per rules
router.get('/', authorize(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.AGENTE), listChatsController);
router.get(
  '/summary',
  authorize(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.AGENTE),
  chatSummaryController
);
router.post(
  '/',
  authorize(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.AGENTE),
  chatCreateValidator,
  validateRequest,
  createChatController
);
router.get(
  '/connections',
  authorize(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.AGENTE),
  listChatConnectionsController
);
router.get(
  '/export/by-phone',
  authorize(ROLES.ADMIN, ROLES.SUPERVISOR),
  listExportChatsByPhoneController
);

// Messages in a chat
router.get('/:chatId/messages', authorize(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.AGENTE), getChatMessagesController);

// Assign / Unassign
router.post('/:chatId/assign', authorize(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.AGENTE), assignChatController);
router.post('/:chatId/unassign', authorize(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.AGENTE), unassignChatController);

// Close / Reopen
router.post('/:chatId/close', authorize(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.AGENTE), closeChatController);
router.post('/:chatId/reopen', authorize(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.AGENTE), reopenChatController);
router.post('/:chatId/reassign', authorize(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.AGENTE), reassignChatController);

// Send outbound message (agent restrictions enforced inside service)
router.post('/:chatId/messages', authorize(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.AGENTE), sendMessageController);
router.post(
  '/:chatId/messages/media',
  authorize(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.AGENTE),
  upload.single('file'),
  sendMediaMessageController
);

export default router;

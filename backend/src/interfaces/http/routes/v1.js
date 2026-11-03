// API v1 – versión estable (ISO compliant)
import { Router } from 'express';
import healthRoutes from './healthRoutes.js';
import authRoutes from './authRoutes.js';
import messageRoutes from './messageRoutes.js';
import { sendChatMessageCommandController } from '../controllers/messageController.js';
import { authorize } from '../middlewares/authMiddleware.js';
import validateRequest from '../middlewares/validateRequest.js';
import { sendMessageValidator } from '../validators/messageValidators.js';
import { ROLES } from '../../../domain/user/user.js';
import assignmentRoutes from './assignmentRoutes.js';
import massMessagingRoutes from './massMessagingRoutes.js';
import auditRoutes from './auditRoutes.js';
import whatsappApiRoutes from './whatsappApiRoutes.js';
import userRoutes from './userRoutes.js';
import chatRoutes from './chatRoutes.js';
import queueRoutes from './queueRoutes.js';
import queueMembershipRoutes from './queueMembershipRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import mediaRoutes from './mediaRoutes.js';
import metricsRoutes from './metricsRoutes.js';
import dashboardRoutes from '../../../modules/dashboard/dashboard.routes.js';
import broadcastRoutes from '../../../modules/broadcast/broadcast.routes.js';
import quickReplyRoutes from '../../../modules/quickReplies/quickReply.routes.js';
import contactRoutes from './contactRoutes.js';
import { apiVersionHeader } from '../middlewares/apiVersion.js';
import { authenticate } from '../middlewares/authMiddleware.js';
import { audit } from '../middlewares/auditMiddleware.js';
import warmupRoutes from './warmupRoutes.js';
import contactIntelligenceRoutes from './contactIntelligenceRoutes.js';
import workforceRoutes from './workforceRoutes.js';

const router = Router();

router.use(apiVersionHeader);

router.use('/health', healthRoutes); // health sin auth pero con header
router.use('/auth', authRoutes); // login abierto; otras rutas de auth tienen su propio middleware
router.use('/integrations/contact-intelligence', contactIntelligenceRoutes);
router.use('/integrations/workforce', workforceRoutes);

// Rutas protegidas por auth + audit global
router.use(authenticate, audit('api_call', (req) => ({ resource: req.path })));

// Command API: envío de mensaje directo (intención)
router.post(
  '/messages/send',
  authorize(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.AGENTE),
  sendMessageValidator,
  validateRequest,
  sendChatMessageCommandController
);
router.use('/messages', messageRoutes);
router.use('/assignments', assignmentRoutes);
router.use('/mass', massMessagingRoutes);
router.use('/audit', auditRoutes);
router.use('/whatsapp', whatsappApiRoutes);
router.use('/users', userRoutes);
router.use('/chat', chatRoutes); // legacy
router.use('/chats', chatRoutes); // preferred plural
router.use('/queues', queueRoutes);
router.use('/queues', queueMembershipRoutes);
router.use('/settings', settingsRoutes);
router.use('/media', mediaRoutes);
router.use('/metrics', metricsRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/broadcast', authorize(ROLES.ADMIN, ROLES.SUPERVISOR), broadcastRoutes);
router.use('/quick-replies', quickReplyRoutes);
router.use('/contacts', contactRoutes);
router.use('/warmup', warmupRoutes);

export default router;

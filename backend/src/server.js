import http from 'node:http';
import process from 'node:process';
import app from './app.js';
import env from './config/env.js';
import logger from './infra/logging/logger.js';
import pool from './infra/db/postgres.js';
import { ensureRedisConnection, closeRedis } from './infra/cache/redisClient.js';
import ensureAdminSeed from './services/bootstrapService.js';
import { bootstrapValidSessions } from './whatsapp/index.js';
import { shutdownWhatsAppSessions } from './services/whatsappService.js';
import { Server as SocketIOServer } from 'socket.io';
import { registerConnection, registerDisconnect } from './services/userConnectionService.js';
import { runAutoAssignmentLocked } from './services/chatAutoAssignmentService.js';
import { getSystemSettings, ensureSystemSettingsTable } from './infra/db/systemSettingsRepository.js';
import { initSocketHub } from './infra/realtime/socketHub.js';
import { getUserQueueIds } from './infra/db/chatRepository.js';
import { startBroadcastWorker, stopBroadcastWorker } from './modules/broadcast/broadcast.worker.js';
import { startDashboardAggregator } from './services/dashboardAggregatorService.js';
import runPendingMigrations from './infra/db/migrationRunner.js';
import { startChatInactivityMonitor, stopChatInactivityMonitor } from './services/chatInactivityService.js';
import {
  isStartupReady,
  markStartupFailed,
  markStartupReady,
  setStartupPhase
} from './infra/runtime/startupState.js';

const server = http.createServer(app);

process.on('uncaughtException', (err) => {
  logger.error({ err, tag: 'UNCAUGHT' }, 'Unhandled exception caught; keeping process alive');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason, tag: 'UNHANDLED_REJECTION' }, 'Unhandled rejection caught; keeping process alive');
});

// Socket.IO mínimo para evitar 404 en /socket.io; sin lógica de negocio por ahora.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['*'];
const io = new SocketIOServer(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  },
  allowRequest: (req, callback) => {
    if (!isStartupReady()) {
      callback('Service starting', false);
      return;
    }
    // Acepta conexiones con token tanto en query como en header para compatibilidad.
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tokenInQuery = url.searchParams.get('token');
    if (tokenInQuery) {
      req.headers.authorization = `Bearer ${tokenInQuery}`;
    }
    callback(null, true);
  }
});
initSocketHub(io);
io.of('/events').on('connection', (socket) => {
  logger.info({ id: socket.id, nsp: socket.nsp?.name }, 'Socket.IO client connected');
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.query?.token ||
    socket.handshake.headers?.authorization?.replace(/^Bearer\\s+/i, '');
  if (!token) {
    logger.warn({ id: socket.id, nsp: socket.nsp?.name }, 'Socket.IO connection without token rejected');
    // socket auth missing token
    socket.disconnect(true);
    return;
  }
  registerConnection({ token, socketId: socket.id })
    .then(async ({ eligible, userId, role }) => {
      socket.data.eligible = eligible;
      socket.data.userId = userId;
      socket.data.role = role;
      // Rooms por agente y colas para emisiones selectivas
      const queueIds = await getUserQueueIds(userId).catch(() => []);
      socket.join(`agent:${userId}`);
      queueIds.forEach((q) => socket.join(`queue:${q}`));
      if (role) socket.join(`role:${role}`);
      // socket join
      logger.info({ id: socket.id, userId, role, queues: queueIds, eligible }, 'Socket.IO join completed');
    })
    .catch((err) => {
      // socket auth fail
      logger.warn({ id: socket.id, err }, 'Socket.IO auth failed; disconnecting');
      socket.disconnect(true);
  });
  socket.on('disconnect', (reason) => {
    registerDisconnect({ socketId: socket.id }).catch(() => {});
    logger.info({ id: socket.id, reason }, 'Socket.IO client disconnected');
  });
});

let autoAssignTimer = null;
let dashboardAggTimer = null;
let bootstrapTimer = null;
let bootstrapping = false;

const listenServer = async () =>
  new Promise((resolve, reject) => {
    const handleError = (err) => {
      server.off('listening', handleListening);
      reject(err);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(env.http.port);
  });

const scheduleBootstrapRetry = () => {
  if (bootstrapTimer) return;
  const retryMs = Math.max(1000, Number(env.startup?.retryMs || 5000));
  bootstrapTimer = setTimeout(() => {
    bootstrapTimer = null;
    bootstrap().catch((err) => {
      logger.error({ err }, 'Unexpected bootstrap retry failure');
    });
  }, retryMs);
  if (typeof bootstrapTimer.unref === 'function') {
    bootstrapTimer.unref();
  }
  logger.warn({ retryMs }, 'Startup bootstrap scheduled for retry');
};

const startAutoAssignScheduler = async () => {
  await ensureSystemSettingsTable();
  const settings = await getSystemSettings();
  const intervalSeconds = Math.max(5, Number(settings.autoAssignIntervalSeconds || 30));
  if (autoAssignTimer) clearInterval(autoAssignTimer);
  logger.info({ intervalSeconds, tag: 'AUTO_ASSIGN' }, 'Starting auto-assign scheduler');
  // Primera ejecución inmediata para no esperar al primer tick.
  runAutoAssignmentLocked().catch((err) => logger.error({ err, tag: 'AUTO_ASSIGN' }, 'Auto-assign job failed'));
  autoAssignTimer = setInterval(() => {
    runAutoAssignmentLocked().catch((err) => logger.error({ err, tag: 'AUTO_ASSIGN' }, 'Auto-assign job failed'));
  }, intervalSeconds * 1000);
};

const bootstrap = async () => {
  if (bootstrapping || isStartupReady()) return;
  bootstrapping = true;
  try {
    setStartupPhase('postgres');
    await pool.query('SELECT 1');

    setStartupPhase('redis');
    await ensureRedisConnection();

    setStartupPhase('migrations');
    await runPendingMigrations();

    setStartupPhase('admin-seed');
    await ensureAdminSeed();

    setStartupPhase('whatsapp-bootstrap');
    const recovered = await bootstrapValidSessions();
    logger.info({ recovered }, 'Bootstrap WhatsApp sessions');

    setStartupPhase('auto-assign');
    await startAutoAssignScheduler();

    setStartupPhase('broadcast-worker');
    startBroadcastWorker();

    setStartupPhase('dashboard-aggregator');
    if (!dashboardAggTimer) {
      dashboardAggTimer = startDashboardAggregator();
    }

    setStartupPhase('chat-inactivity');
    startChatInactivityMonitor();
    markStartupReady();
    logger.info({ port: env.http.port, env: env.nodeEnv }, 'WhatsSuite backend ready');
  } catch (err) {
    markStartupFailed(err);
    logger.error({ err }, 'Failed to bootstrap backend; service will stay up and retry');
    scheduleBootstrapRetry();
  } finally {
    bootstrapping = false;
  }
};

const start = async () => {
  try {
    setStartupPhase('listening');
    await listenServer();
    logger.info({ port: env.http.port, env: env.nodeEnv }, 'HTTP server listening');
    await bootstrap();
  } catch (err) {
    markStartupFailed(err);
    logger.error({ err }, 'Failed to start HTTP server');
    process.exit(1);
  }
};

const shutdown = async (signal) => {
  logger.info({ signal }, 'Graceful shutdown initiated');
  if (bootstrapTimer) {
    clearTimeout(bootstrapTimer);
    bootstrapTimer = null;
  }
  server.close(async () => {
    stopBroadcastWorker();
    stopChatInactivityMonitor();
    if (dashboardAggTimer) clearInterval(dashboardAggTimer);
    await shutdownWhatsAppSessions();
    await closeRedis();
    await pool.end();
    process.exit(0);
  });
};

['SIGTERM', 'SIGINT'].forEach((signal) => {
  process.on(signal, () => shutdown(signal));
});

start();

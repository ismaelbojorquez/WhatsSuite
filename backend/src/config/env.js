import 'dotenv/config';
import process from 'node:process';

const requireEnv = (key) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Environment variable ${key} is required for secure startup`);
  }
  return value;
};

const numberFromEnv = (key, defaultValue) => {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a valid number`);
  }
  return parsed;
};

const sizeFromEnv = (key, defaultValue) => {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const normalized = raw.trim().toUpperCase();
  const mbMatch = normalized.match(/^(\d+)\s*MB$/);
  const gbMatch = normalized.match(/^(\d+)\s*GB$/);
  if (mbMatch) return Number.parseInt(mbMatch[1], 10) * 1024 * 1024;
  if (gbMatch) return Number.parseInt(gbMatch[1], 10) * 1024 * 1024 * 1024;
  const asNumber = Number.parseInt(normalized, 10);
  if (Number.isNaN(asNumber)) {
    throw new Error(`Environment variable ${key} must be a number or use MB/GB suffix`);
  }
  return asNumber;
};

const boolFromEnv = (key, defaultValue = false) => {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());
};

const mediaMaxBytes = sizeFromEnv('MEDIA_MAX_BYTES', 25 * 1024 * 1024);

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  serviceName: process.env.SERVICE_NAME || 'whatssuite-api',
  instanceId: process.env.SERVICE_INSTANCE_ID || `instance-${process.pid}`,
  logLevel: process.env.LOG_LEVEL || 'info',
  timezone: process.env.TZ || 'UTC',
  http: {
    port: numberFromEnv('PORT', 3000),
    requestTimeoutMs: numberFromEnv('REQUEST_TIMEOUT_MS', 15000),
    maxConcurrentRequests: numberFromEnv('HTTP_MAX_CONCURRENT', 500),
    backpressureQueueLimit: numberFromEnv('HTTP_BACKPRESSURE_QUEUE', 200),
    requireHttps: boolFromEnv('HTTP_REQUIRE_HTTPS', true),
    bodyLimit: sizeFromEnv('HTTP_BODY_LIMIT', mediaMaxBytes)
  },
  rateLimit: {
    windowSeconds: numberFromEnv('RATE_LIMIT_WINDOW_SECONDS', 60),
    maxRequests: numberFromEnv('RATE_LIMIT_MAX_REQUESTS', 300),
    userWindowSeconds: numberFromEnv('RATE_LIMIT_USER_WINDOW_SECONDS', 60),
    userMaxRequests: numberFromEnv('RATE_LIMIT_USER_MAX_REQUESTS', 300),
    apiWindowSeconds: numberFromEnv('RATE_LIMIT_API_WINDOW_SECONDS', 60),
    apiMaxRequests: numberFromEnv('RATE_LIMIT_API_MAX_REQUESTS', 600)
  },
  db: {
    host: requireEnv('POSTGRES_HOST'),
    port: numberFromEnv('POSTGRES_PORT', 5432),
    user: requireEnv('POSTGRES_USER'),
    password: requireEnv('POSTGRES_PASSWORD'),
    database: requireEnv('POSTGRES_DB'),
    ssl: process.env.POSTGRES_SSL === 'true',
    pool: {
      min: numberFromEnv('POSTGRES_POOL_MIN', 2),
      max: numberFromEnv('POSTGRES_POOL_MAX', 15),
      idle: numberFromEnv('POSTGRES_POOL_IDLE', 10000),
      maxUses: numberFromEnv('POSTGRES_POOL_MAX_USES', 0)
    }
  },
  redis: {
    url: requireEnv('REDIS_URL'),
    tls: process.env.REDIS_TLS === 'true',
    sessionPrefix: process.env.REDIS_SESSION_PREFIX || 'session'
  },
  auth: {
    jwtSecret: requireEnv('JWT_SECRET'),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '15m',
    jwtIssuer: process.env.JWT_ISSUER || 'whatssuite',
    jwtAudience: process.env.JWT_AUDIENCE || 'whatssuite-clients',
    bcryptRounds: numberFromEnv('BCRYPT_SALT_ROUNDS', 12)
  },
  whatsapp: {
    sessionSecret: requireEnv('WHATSAPP_SESSION_SECRET'),
    historySyncDays: numberFromEnv('WHATSAPP_HISTORY_DAYS', 30)
  },
  media: {
    storageDir: process.env.MEDIA_STORAGE_DIR || 'storage/media',
    maxBytes: mediaMaxBytes,
    allowedMimePrefixes: (process.env.MEDIA_ALLOWED_MIME_PREFIXES ||
      'image/,video/,audio/,application/pdf,application/msword,application/vnd.openxmlformats-officedocument').split(',').map((s) => s.trim()).filter(Boolean),
    encryptionKey: process.env.MEDIA_ENCRYPTION_KEY || null,
    encryptionEnabled: boolFromEnv('MEDIA_ENCRYPTION_ENABLED', false),
    signingSecret: process.env.MEDIA_SIGNING_SECRET || process.env.JWT_SECRET || 'change-me-media'
  },
  cache: {
    chatTtlSeconds: numberFromEnv('CACHE_CHAT_TTL_SECONDS', 30),
    messagesTtlSeconds: numberFromEnv('CACHE_MESSAGES_TTL_SECONDS', 20),
    assignmentTtlSeconds: numberFromEnv('CACHE_ASSIGNMENT_TTL_SECONDS', 15),
    dashboardTtlSeconds: numberFromEnv('CACHE_DASHBOARD_TTL_SECONDS', 180)
  },
  features: {
    campaigns: boolFromEnv('FEATURE_CAMPAIGNS', true),
    whatsappConnections: boolFromEnv('FEATURE_WHATSAPP_CONNECTIONS', true),
    auditExports: boolFromEnv('FEATURE_AUDIT_EXPORTS', false),
    coldArchive: boolFromEnv('FEATURE_COLD_ARCHIVE', true)
  },
  workers: {
    realtimeConcurrency: numberFromEnv('WORKER_REALTIME_CONCURRENCY', 10),
    realtimeQueueLimit: numberFromEnv('WORKER_REALTIME_QUEUE', 500)
  },
  maintenance: {
    partitionIntervalHours: numberFromEnv('PARTITION_MAINTENANCE_INTERVAL_HOURS', 6),
    partitionMonthsBack: numberFromEnv('PARTITION_MAINTENANCE_MONTHS_BACK', 2),
    partitionMonthsAhead: numberFromEnv('PARTITION_MAINTENANCE_MONTHS_AHEAD', 12)
  },
  startup: {
    retryMs: numberFromEnv('STARTUP_RETRY_MS', 5000)
  }
};

export default env;

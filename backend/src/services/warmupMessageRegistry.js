import crypto from 'node:crypto';
import { ensureRedisConnection } from '../infra/cache/redisClient.js';
import redisClient from '../infra/cache/redisClient.js';
import logger from '../infra/logging/logger.js';
import { normalizeWhatsAppNumber } from '../shared/phoneNormalizer.js';

const PREFIX = 'warmup:internal-message';
const GLOBAL_SCOPE = 'global';
const PENDING_PAIR_TTL_SECONDS = 90;
const SENT_PAIR_TTL_SECONDS = 30 * 60;
const MESSAGE_ID_TTL_SECONDS = 45 * 24 * 60 * 60;
const MEMORY_MAX_KEYS = 5000;

const memoryRegistry = new Map();

const digits = (value) => (value ? String(value).replace(/[^\d]/g, '') : '');
const unique = (items) => [...new Set(items.filter(Boolean))];

const normalizeEndpoint = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const digitValue = digits(raw);
  return digitValue || raw.toLowerCase();
};

const endpointVariants = (value) => {
  const normalized = normalizeEndpoint(value);
  if (!normalized) return [];
  const digitValue = digits(normalized);
  return unique([
    normalized,
    digitValue ? normalizeWhatsAppNumber(digitValue) : null
  ]);
};

const normalizeMessageId = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  return raw || null;
};

const normalizeScope = (tenantId = null) => {
  if (!tenantId) return null;
  const raw = String(tenantId).trim();
  return raw || null;
};

const lineEndpoints = (line = {}) =>
  unique([
    ...endpointVariants(line.id),
    ...endpointVariants(line.sessionName),
    ...endpointVariants(line.phone),
    ...endpointVariants(line.number)
  ]);

const scopesFor = (...tenantIds) => unique([GLOBAL_SCOPE, ...tenantIds.map(normalizeScope)]);

const pairKey = (scope, left, right) => `${PREFIX}:scope:${scope}:pair:${left}:${right}`;
const idKey = (scope, messageId) => `${PREFIX}:scope:${scope}:id:${messageId}`;

const textHash = (text) => {
  if (!text || typeof text !== 'string') return null;
  const normalized = text.trim();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
};

const cleanupMemory = () => {
  const now = Date.now();
  for (const [key, entry] of memoryRegistry.entries()) {
    if (!entry?.expiresAt || entry.expiresAt <= now) {
      memoryRegistry.delete(key);
    }
  }
  if (memoryRegistry.size <= MEMORY_MAX_KEYS) return;
  const overflow = memoryRegistry.size - MEMORY_MAX_KEYS;
  let removed = 0;
  for (const key of memoryRegistry.keys()) {
    memoryRegistry.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
};

const setMemory = (keys, payload, ttlSeconds) => {
  cleanupMemory();
  const expiresAt = Date.now() + Math.max(1, ttlSeconds) * 1000;
  for (const key of keys) {
    memoryRegistry.set(key, { payload, expiresAt });
  }
};

const getMemory = (key) => {
  const entry = memoryRegistry.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memoryRegistry.delete(key);
    return null;
  }
  return entry.payload;
};

const parsePayload = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
};

const buildRegistrationKeys = ({ from, to, messageId = null }) => {
  const scopes = scopesFor(from?.tenantId, to?.tenantId);
  const fromEndpoints = lineEndpoints(from);
  const toEndpoints = lineEndpoints(to);
  const keys = new Map();
  for (const scope of scopes) {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (normalizedMessageId) {
      const key = idKey(scope, normalizedMessageId);
      keys.set(key, { key, kind: 'id' });
    }
    for (const left of fromEndpoints) {
      for (const right of toEndpoints) {
        if (left === right) continue;
        const directPairKey = pairKey(scope, left, right);
        const reversePairKey = pairKey(scope, right, left);
        keys.set(directPairKey, { key: directPairKey, kind: 'pair' });
        keys.set(reversePairKey, { key: reversePairKey, kind: 'pair' });
      }
    }
  }
  return [...keys.values()];
};

const buildLookupKeys = ({ sessionName, remoteNumber, messageId = null, tenantId = null }) => {
  const scopes = scopesFor(tenantId);
  const sessionEndpoints = endpointVariants(sessionName);
  const remoteEndpoints = endpointVariants(remoteNumber);
  const normalizedMessageId = normalizeMessageId(messageId);
  const keys = [];
  for (const scope of scopes) {
    if (normalizedMessageId) keys.push({ key: idKey(scope, normalizedMessageId), kind: 'id' });
    for (const sessionEndpoint of sessionEndpoints) {
      for (const remoteEndpoint of remoteEndpoints) {
        keys.push({ key: pairKey(scope, sessionEndpoint, remoteEndpoint), kind: 'pair' });
      }
    }
  }
  return keys;
};

export const registerWarmupMessage = async ({
  from,
  to,
  messageId = null,
  text = '',
  meta = {},
  profile = null,
  ttlSeconds = null,
  phase = 'sent'
}) => {
  const entries = buildRegistrationKeys({ from, to, messageId });
  if (!entries.length) {
    throw new Error('No warmup registry keys could be built');
  }
  const payload = JSON.stringify({
    kind: 'warmup',
    phase,
    registeredAt: new Date().toISOString(),
    messageId: normalizeMessageId(messageId),
    textHash: textHash(text),
    from: {
      id: from?.id || null,
      sessionName: from?.sessionName || null,
      phone: from?.phone || null,
      tenantId: from?.tenantId || null
    },
    to: {
      id: to?.id || null,
      sessionName: to?.sessionName || null,
      phone: to?.phone || null,
      tenantId: to?.tenantId || null
    },
    topic: meta?.topic || null,
    profile: profile?.key || profile || null
  });

  const ttlForEntry = (entry) => {
    if (ttlSeconds) return ttlSeconds;
    if (entry.kind === 'id') return MESSAGE_ID_TTL_SECONDS;
    return messageId ? SENT_PAIR_TTL_SECONDS : PENDING_PAIR_TTL_SECONDS;
  };

  for (const entry of entries) {
    setMemory([entry.key], payload, ttlForEntry(entry));
  }
  await ensureRedisConnection();
  const tx = redisClient.multi();
  entries.forEach((entry) => tx.set(entry.key, payload, { EX: ttlForEntry(entry) }));
  await tx.exec();
  return { keys: entries.length };
};

export const findWarmupMessage = async ({ sessionName, remoteNumber, messageId = null, tenantId = null, text = '' }) => {
  const lookups = buildLookupKeys({ sessionName, remoteNumber, messageId, tenantId });
  if (!lookups.length) return null;
  const incomingTextHash = textHash(text);

  const acceptMatch = (raw, lookup) => {
    const payload = parsePayload(raw);
    if (!payload || payload.kind !== 'warmup') return null;
    if (lookup.kind === 'pair') {
      if (payload.phase !== 'pending') return null;
      if (!payload.textHash || !incomingTextHash) return null;
      if (payload.textHash !== incomingTextHash) return null;
    }
    return { ...payload, matchedKey: lookup.key, matchedBy: lookup.kind };
  };

  for (const lookup of lookups) {
    const match = acceptMatch(getMemory(lookup.key), lookup);
    if (match) return match;
  }

  try {
    await ensureRedisConnection();
    const values = await redisClient.mGet(lookups.map((lookup) => lookup.key));
    for (let i = 0; i < values.length; i += 1) {
      const match = acceptMatch(values[i], lookups[i]);
      if (match) return match;
    }
  } catch (err) {
    logger.warn(
      { err, sessionName, remoteNumber, messageId, tag: 'WARMUP_MESSAGE_REGISTRY' },
      'Failed to check warmup message registry'
    );
  }

  return null;
};

export const isWarmupMessage = async (payload) => Boolean(await findWarmupMessage(payload));

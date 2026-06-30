// Auth state persistido en PostgreSQL para Baileys: incluye creds y todas las claves (preKeys, sessions, senderKeys, appStateSyncKeys).
// Evita regenerar sesiones y preKeys para resolver errores "Invalid PreKey ID" / "No session record".
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import pool from '../infra/db/postgres.js';
import logger from '../infra/logging/logger.js';

const encode = (data) => JSON.parse(JSON.stringify(data || {}, BufferJSON.replacer));
const decode = (data, fallback = {}) => {
  try {
    return JSON.parse(JSON.stringify(data ?? fallback), BufferJSON.reviver);
  } catch (_err) {
    return fallback;
  }
};

const isPlainObject = (val) => val && typeof val === 'object' && !Array.isArray(val);
const sanitizeCreds = (creds) => (isPlainObject(creds) ? creds : initAuthCreds());
const sanitizeKeys = (keys) => (isPlainObject(keys) ? keys : {});

const normalizeType = (type) => {
  switch (type) {
    case 'pre-key':
    case 'preKeys':
      return 'preKeys';
    case 'session':
    case 'sessions':
      return 'sessions';
    case 'sender-key':
    case 'senderKeys':
      return 'senderKeys';
    case 'app-state-sync-key':
    case 'appStateSyncKeys':
      return 'appStateSyncKeys';
    default:
      return type;
  }
};

const mergeKeys = (base = {}, updates = {}) => {
  const next = { ...base };
  for (const type of Object.keys(updates || {})) {
    const norm = normalizeType(type);
    if (!next[norm]) next[norm] = {};
    for (const id of Object.keys(updates[type] || {})) {
      next[norm][id] = updates[type][id];
    }
  }
  // counts kept internally; no debug output
  return next;
};

const withSessionLock = async (sessionName, fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionName]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const resolveTenantId = async () => {
  const res = await pool.query("SELECT id FROM tenants WHERE name = 'default' LIMIT 1");
  return res.rows[0]?.id || null;
};

const loadState = async (sessionName) => {
  return withSessionLock(sessionName, async (client) => {
    const res = await client.query(
      'SELECT creds, keys FROM whatsapp_sessions WHERE session_name = $1 LIMIT 1',
      [sessionName]
    );
    if (res.rowCount === 0) {
      const emptyCreds = initAuthCreds();
      const emptyKeys = {};
      const tenantId = await resolveTenantId();
      await client.query(
        `INSERT INTO whatsapp_sessions (session_name, name, creds, keys, status, tenant_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (session_name) DO NOTHING`,
        [sessionName, sessionName, encode(emptyCreds), encode(emptyKeys), 'pending', tenantId]
      );
      logger.info({ sessionName, status: 'new' }, 'Initialized new WhatsApp auth state');
      return { creds: emptyCreds, keys: emptyKeys, existing: false };
    }
    const creds = sanitizeCreds(decode(res.rows[0].creds, initAuthCreds()));
    const keys = sanitizeKeys(decode(res.rows[0].keys, {}));
    logger.info(
      {
        sessionName,
        status: 'existing',
        preKeys: Object.keys(keys?.preKeys || {}).length,
        sessions: Object.keys(keys?.sessions || {}).length,
        senderKeys: Object.keys(keys?.senderKeys || {}).length,
        appStateSyncKeys: Object.keys(keys?.appStateSyncKeys || {}).length
      },
      'Loaded WhatsApp auth state from DB'
    );
    return {
      creds,
      keys,
      existing: true
    };
  });
};

const persistState = async (sessionName, { creds, keys, status = 'pending', replace = false }) => {
  return withSessionLock(sessionName, async (client) => {
    const current = await client.query(
      'SELECT creds, keys FROM whatsapp_sessions WHERE session_name = $1 FOR UPDATE',
      [sessionName]
    );
    const dbCreds = current.rowCount ? sanitizeCreds(decode(current.rows[0].creds, initAuthCreds())) : initAuthCreds();
    const dbKeys = current.rowCount ? sanitizeKeys(decode(current.rows[0].keys, {})) : {};
    const mergedCreds = replace ? sanitizeCreds(creds || initAuthCreds()) : creds || dbCreds;
    const mergedKeys = replace ? sanitizeKeys(keys || {}) : keys ? mergeKeys(dbKeys, sanitizeKeys(keys)) : dbKeys;

    const tenantId = await resolveTenantId();
    await client.query(
      `INSERT INTO whatsapp_sessions (session_name, name, creds, keys, status, tenant_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (session_name) DO UPDATE
         SET name = EXCLUDED.name,
             creds = EXCLUDED.creds,
             keys = EXCLUDED.keys,
             status = EXCLUDED.status,
             tenant_id = COALESCE(whatsapp_sessions.tenant_id, EXCLUDED.tenant_id),
             updated_at = EXCLUDED.updated_at`,
      [sessionName, sessionName, encode(mergedCreds), encode(mergedKeys), status, tenantId]
    );
    logger.info(
      {
        sessionName,
        preKeys: Object.keys(mergedKeys?.preKeys || {}).length,
        sessions: Object.keys(mergedKeys?.sessions || {}).length,
        senderKeys: Object.keys(mergedKeys?.senderKeys || {}).length,
        appStateSyncKeys: Object.keys(mergedKeys?.appStateSyncKeys || {}).length
      },
      'Persisted WhatsApp auth state'
    );
    return { creds: mergedCreds, keys: mergedKeys };
  });
};

export const createPostgresAuthState = async (sessionName = 'default') => {
  const name = sessionName || 'default';
  const loaded = await loadState(name);
  let creds = loaded.creds || initAuthCreds();
  let keys = loaded.keys || {};

  if (loaded.existing) {
    logger.info({ sessionName: name }, 'WhatsApp session recovered from DB');
  }

  const keyStore = {
    async get(type, ids) {
      const norm = normalizeType(type);
      const result = {};
      for (const id of ids) {
        const value = keys?.[norm]?.[id] ?? keys?.[type]?.[id];
        if (value !== undefined) {
          result[id] = value;
        }
      }
      if (Object.keys(result).length === 0 && (norm === 'preKeys' || norm === 'sessions')) {
        logger.warn({ sessionName: name, type, ids }, 'Auth adapter get returned empty set');
      }
      return result;
    },
    async set(data) {
      if (!data || Object.keys(data).length === 0) {
        throw new Error(`AUTH ADAPTER SET NOT CALLED or empty payload for session ${name}`);
      }
      const normalized = {};
      for (const type of Object.keys(data)) {
        const norm = normalizeType(type);
        normalized[norm] = data[type];
      }
      keys = mergeKeys(keys, normalized);
      const persisted = await persistState(name, { creds, keys });
      creds = persisted.creds;
      keys = persisted.keys;
    },
    async delete(data) {
      for (const category of Object.keys(data || {})) {
        for (const id of data[category] || []) {
          if (keys?.[category]?.[id]) {
            delete keys[category][id];
          }
        }
      }
      const persisted = await persistState(name, { creds, keys });
      creds = persisted.creds;
      keys = persisted.keys;
    }
  };

  const saveCreds = async () => {
    const persisted = await persistState(name, { creds, keys });
    creds = persisted.creds;
    keys = persisted.keys;
  };

  const counts = {
    preKeys: Object.keys(keys?.preKeys || {}).length,
    sessions: Object.keys(keys?.sessions || {}).length
  };
  logger.info({ sessionName: name, ...counts }, 'Auth state key counts');
  if (counts.preKeys === 0 || counts.sessions === 0) {
    logger.warn(
      { sessionName: name, ...counts },
      'Auth state missing preKeys or sessions; Baileys will populate on next connect'
    );
  }

  return {
    state: {
      creds,
      keys: keyStore
    },
    saveCreds,
    resetState: async () => {
      creds = initAuthCreds();
      keys = {};
      const persisted = await persistState(name, { creds, keys, status: 'pending', replace: true });
      creds = persisted.creds;
      keys = persisted.keys;
      return persisted;
    },
    getKeysSnapshot: () => keys
  };
};

export default createPostgresAuthState;

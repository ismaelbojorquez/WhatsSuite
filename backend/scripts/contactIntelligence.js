import { createHash } from 'node:crypto';
import pool from '../src/infra/db/postgres.js';

// Token arrives on stdin, never through a command argument, log or Git file.
const tenantId = process.argv[2];
let token = '';
for await (const chunk of process.stdin) token += chunk;
token = token.trim();
if (!/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9-]{36}$/.test(tenantId || '')) {
  throw new Error('Usage: supply tenant UUID and a 64-character hex token on stdin');
}
const db = await pool.connect();
try {
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='10s'");
  await db.query('LOCK TABLE chats,chat_messages IN SHARE ROW EXCLUSIVE MODE');
  const tenant = await db.query("SELECT 1 FROM tenants WHERE id=$1 AND status='active'", [tenantId]);
  if (!tenant.rowCount) throw new Error('Active tenant not found');
  const { rows } = await db.query('SELECT * FROM contact_intelligence_sources WHERE tenant_id=$1 FOR UPDATE', [tenantId]);
  const hash = createHash('sha256').update(token).digest('hex');
  if (rows.length) {
    if (!rows[0].enabled) throw new Error('Source disabled; history gap requires a reviewed reactivation');
    await db.query('UPDATE contact_intelligence_sources SET token_hash=$2 WHERE tenant_id=$1', [tenantId, hash]);
  } else {
    await db.query('INSERT INTO contact_intelligence_sources(tenant_id,activated_at,token_hash) VALUES($1,clock_timestamp(),$2)', [tenantId, hash]);
    await db.query(`SELECT contact_intelligence_append(c.tenant_id,'state',c.id,c.remote_number,c.status,s.activated_at)
      FROM chats c JOIN contact_intelligence_sources s ON s.tenant_id=c.tenant_id
      WHERE c.tenant_id=$1 ORDER BY c.id`, [tenantId]);
  }
  await db.query('COMMIT');
  const result = await db.query('SELECT source_id,activated_at,last_sequence FROM contact_intelligence_sources WHERE tenant_id=$1', [tenantId]);
  console.log(JSON.stringify({ status: 'PASS', source: result.rows[0] }));
} catch (err) { await db.query('ROLLBACK'); throw err; }
finally { db.release(); await pool.end(); }

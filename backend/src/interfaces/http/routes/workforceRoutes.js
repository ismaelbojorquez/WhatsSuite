import { Router } from 'express';
import { createHash } from 'node:crypto';
import pool from '../../../infra/db/postgres.js';
import { connectedWorkforceUsers } from '../../../infra/realtime/socketHub.js';

export const createWorkforceRouter = (db = pool, online = connectedWorkforceUsers) => {
  const router = Router();
  router.get('/events', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.get('authorization') || '')?.[1];
      if (!token) return res.status(401).json({ success: false });
      const { rows: sources } = await db.query(`SELECT s.tenant_id,s.source_id,w.last_sequence,
        to_char(w.activated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') activated_at
        FROM contact_intelligence_sources s JOIN workforce_sources w USING(tenant_id)
        JOIN tenants t ON t.id=s.tenant_id WHERE s.enabled AND t.status='active' AND s.token_hash=$1`,
      [createHash('sha256').update(token).digest('hex')]);
      if (sources.length !== 1) return res.status(401).json({ success: false });
      const s = sources[0], after = req.query.after ?? '0', limit = req.query.limit ?? '500';
      if (typeof after !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(after) || BigInt(after) > BigInt(s.last_sequence)
        || typeof limit !== 'string' || !/^[1-9][0-9]{0,3}$/.test(limit) || Number(limit) > 1000) {
        return res.status(422).json({ success: false });
      }
      const { rows: events } = await db.query(`SELECT e.sequence::text,actor_id,actor_name,actor_username,chat_id,kind,
        to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') occurred_at
        FROM workforce_events e WHERE tenant_id=$1 AND e.sequence>$2 AND e.sequence<=$3 ORDER BY e.sequence LIMIT $4`,
      [s.tenant_id, after, s.last_sequence, Number(limit)]);
      const { rows: users } = await db.query(`SELECT u.id,u.username,u.full_name AS name,r.name AS role,u.status,
        (SELECT count(*)::int FROM chats c WHERE c.tenant_id=u.tenant_id AND c.assigned_agent_id=u.id AND c.status='OPEN') open_chats
        FROM users u JOIN roles r ON r.id=u.role_id WHERE u.tenant_id=$1 AND u.deleted_at IS NULL ORDER BY u.id`, [s.tenant_id]);
      const live = online();
      const nextCursor = events.at(-1)?.sequence || after;
      return res.json({ success: true, data: { version: 1, source_id: s.source_id, activated_at: s.activated_at,
        observed_at: new Date().toISOString(), events, users: users.map(u => ({ ...u, online: live === null ? null : u.status === 'ACTIVE' && live.has(u.id) })),
        next_cursor: nextCursor, has_more: BigInt(nextCursor) < BigInt(s.last_sequence) } });
    } catch (err) { next(err); }
  });
  return router;
};
export default createWorkforceRouter();

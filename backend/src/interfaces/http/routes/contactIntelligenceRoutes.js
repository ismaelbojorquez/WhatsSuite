import { Router } from 'express';
import { createHash } from 'node:crypto';
import pool from '../../../infra/db/postgres.js';

// Dedicated machine credential: read this tenant's minimal feed only; never a user session.
export const createContactIntelligenceRouter = (db = pool) => {
  const router = Router();
  router.get('/events', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.get('authorization') || '')?.[1];
      if (!token) return res.status(401).json({ success: false, code: 'UNAUTHORIZED' });
      const { rows: sources } = await db.query(`SELECT s.*,
        to_char(s.activated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') activation_iso FROM contact_intelligence_sources s
        JOIN tenants t ON t.id=s.tenant_id WHERE s.token_hash=$1 AND s.enabled AND t.status='active'`,
      [createHash('sha256').update(token).digest('hex')]);
      if (sources.length !== 1) return res.status(401).json({ success: false, code: 'UNAUTHORIZED' });
      const source = sources[0];
      const after = req.query.after ?? '0';
      const limit = req.query.limit ?? '500';
      if (typeof after !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(after)
        || BigInt(after) > BigInt(source.last_sequence)
        || typeof limit !== 'string' || !/^[1-9][0-9]{0,3}$/.test(limit) || Number(limit) > 1000) {
        return res.status(422).json({ success: false, code: 'INVALID_CURSOR' });
      }
      const { rows } = await db.query(`SELECT sequence::text,kind,chat_id,phone,state,
        to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') occurred_at,
        to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') captured_at
        FROM contact_intelligence_events WHERE tenant_id=$1 AND sequence>$2 AND sequence<=$3
        ORDER BY sequence LIMIT $4`, [source.tenant_id, after, source.last_sequence, Number(limit)]);
      const nextCursor = rows.at(-1)?.sequence || after;
      return res.json({ success: true, data: { version: 1, source_id: source.source_id,
        activated_at: source.activation_iso, timezone: 'America/Mexico_City', events: rows,
        next_cursor: nextCursor, has_more: BigInt(nextCursor) < BigInt(source.last_sequence) } });
    } catch (err) { next(err); }
  });
  return router;
};
export default createContactIntelligenceRouter();

-- Advisor activity, captured prospectively and independently of mutable chat ownership.
CREATE TABLE workforce_sources (
 tenant_id UUID PRIMARY KEY REFERENCES contact_intelligence_sources(tenant_id),
 activated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 last_sequence BIGINT NOT NULL DEFAULT 0
);
INSERT INTO workforce_sources(tenant_id) SELECT tenant_id FROM contact_intelligence_sources WHERE enabled;
CREATE TABLE workforce_events (
 tenant_id UUID NOT NULL REFERENCES workforce_sources(tenant_id), sequence BIGINT NOT NULL,
 actor_id UUID NOT NULL, actor_name TEXT NOT NULL, actor_username TEXT NOT NULL,
 chat_id UUID NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('sent','closed','reopened')),
 occurred_at TIMESTAMPTZ NOT NULL, source_key TEXT NOT NULL,
 PRIMARY KEY(tenant_id,sequence), UNIQUE(tenant_id,kind,source_key)
);
CREATE FUNCTION workforce_audit_capture() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_tenant UUID; v_name TEXT; v_username TEXT; v_start TIMESTAMPTZ;
 v_at TIMESTAMPTZ; v_kind TEXT; v_key TEXT; v_seq BIGINT;
BEGIN
 IF NEW.actor_user_id IS NULL OR NEW.action NOT IN ('chat_message_out','chat_media_out','chat_closed','chat_reopened') THEN RETURN NEW; END IF;
 SELECT c.tenant_id,u.full_name,u.username INTO v_tenant,v_name,v_username FROM chats c
  JOIN users u ON u.id=NEW.actor_user_id AND u.tenant_id=c.tenant_id WHERE c.id=NEW.chat_id;
 IF v_tenant IS NULL THEN RETURN NEW; END IF;
 SELECT activated_at INTO v_start FROM workforce_sources WHERE tenant_id=v_tenant FOR UPDATE;
 IF v_start IS NULL OR NEW.created_at<v_start THEN RETURN NEW; END IF;
 v_at=NEW.created_at; v_key=NEW.id::text;
 IF NEW.action IN ('chat_message_out','chat_media_out') THEN
  -- The audit identifies the sender. The accepted message proves that a send actually occurred.
  SELECT m.timestamp,m.chat_id::text||':'||lower(m.whatsapp_message_id) INTO v_at,v_key FROM chat_messages m
   WHERE m.tenant_id=v_tenant AND m.chat_id=NEW.chat_id AND m.direction='out'
   AND m.whatsapp_message_id=NEW.metadata->>'whatsappMessageId'
   AND lower(COALESCE(m.status,'')) IN ('server','sent','delivered','read','played')
   AND m.timestamp>=v_start AND m.timestamp<=clock_timestamp()+INTERVAL '5 seconds'
   AND lower(COALESCE(m.message_type,'')) NOT IN ('protocolmessage','protocol','reactionmessage')
   ORDER BY m.timestamp LIMIT 1;
  IF v_at IS NULL THEN RETURN NEW; END IF;
  v_kind='sent';
 ELSE v_kind=CASE NEW.action WHEN 'chat_closed' THEN 'closed' ELSE 'reopened' END;
 END IF;
 IF EXISTS(SELECT 1 FROM workforce_events WHERE tenant_id=v_tenant AND kind=v_kind AND source_key=v_key) THEN RETURN NEW; END IF;
 UPDATE workforce_sources SET last_sequence=last_sequence+1 WHERE tenant_id=v_tenant RETURNING last_sequence INTO v_seq;
 INSERT INTO workforce_events VALUES(v_tenant,v_seq,NEW.actor_user_id,COALESCE(v_name,v_username),v_username,NEW.chat_id,v_kind,v_at,v_key);
 RETURN NEW;
END $$;
CREATE TRIGGER workforce_audit AFTER INSERT ON chat_audit_log FOR EACH ROW EXECUTE FUNCTION workforce_audit_capture();

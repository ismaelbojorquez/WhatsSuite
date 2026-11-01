-- Prospective, tenant-scoped contact history. No message bodies or old messages are copied.
CREATE TABLE contact_intelligence_sources (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id),
  source_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  activated_at TIMESTAMPTZ NOT NULL,
  token_hash CHAR(64) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_sequence BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE contact_intelligence_events (
  tenant_id UUID NOT NULL REFERENCES contact_intelligence_sources(tenant_id),
  sequence BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('state','sent')),
  chat_id UUID NOT NULL,
  phone TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN','CLOSED','UNASSIGNED','REMOVED')),
  occurred_at TIMESTAMPTZ NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  source_key TEXT,
  PRIMARY KEY(tenant_id, sequence),
  UNIQUE(tenant_id, kind, source_key)
);
CREATE INDEX contact_intelligence_chat_state ON contact_intelligence_events
  (tenant_id, chat_id, occurred_at DESC, sequence DESC) WHERE kind='state';

-- The counter row is locked until commit: readers cannot skip a lower, uncommitted sequence.
CREATE FUNCTION contact_intelligence_append(p_tenant UUID,p_kind TEXT,p_chat UUID,p_phone TEXT,
  p_state TEXT,p_at TIMESTAMPTZ,p_key TEXT DEFAULT NULL) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_seq BIGINT;
BEGIN
  PERFORM 1 FROM contact_intelligence_sources WHERE tenant_id=p_tenant AND enabled FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_key IS NOT NULL AND EXISTS(SELECT 1 FROM contact_intelligence_events
      WHERE tenant_id=p_tenant AND kind=p_kind AND source_key=p_key) THEN RETURN; END IF;
  UPDATE contact_intelligence_sources SET last_sequence=last_sequence+1
    WHERE tenant_id=p_tenant RETURNING last_sequence INTO v_seq;
  INSERT INTO contact_intelligence_events(tenant_id,sequence,kind,chat_id,phone,state,occurred_at,source_key)
    VALUES(p_tenant,v_seq,p_kind,p_chat,p_phone,p_state,p_at,p_key);
END $$;

CREATE FUNCTION contact_intelligence_chat_capture() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM contact_intelligence_append(OLD.tenant_id,'state',OLD.id,OLD.remote_number,'REMOVED',clock_timestamp());
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
      PERFORM contact_intelligence_append(OLD.tenant_id,'state',OLD.id,OLD.remote_number,'REMOVED',clock_timestamp());
    ELSIF OLD.status IS NOT DISTINCT FROM NEW.status AND OLD.remote_number IS NOT DISTINCT FROM NEW.remote_number THEN
      RETURN NEW;
    END IF;
  END IF;
  PERFORM contact_intelligence_append(NEW.tenant_id,'state',NEW.id,NEW.remote_number,NEW.status,clock_timestamp());
  RETURN NEW;
END $$;
CREATE TRIGGER contact_intelligence_chat AFTER INSERT OR UPDATE OR DELETE ON chats
  FOR EACH ROW EXECUTE FUNCTION contact_intelligence_chat_capture();

CREATE FUNCTION contact_intelligence_message_capture() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_start TIMESTAMPTZ; v_state TEXT; v_phone TEXT;
BEGIN
  IF NEW.direction<>'out' OR NEW.chat_id IS NULL OR NEW.whatsapp_message_id IS NULL
    OR lower(COALESCE(NEW.status,'')) NOT IN ('server','sent','delivered','read','played') THEN RETURN NEW; END IF;
  SELECT activated_at INTO v_start FROM contact_intelligence_sources WHERE tenant_id=NEW.tenant_id AND enabled;
  IF v_start IS NULL OR NEW.timestamp<v_start OR NEW.timestamp>clock_timestamp()+INTERVAL '5 seconds' THEN RETURN NEW; END IF;
  -- Look up the state at sending time, including late acknowledgements after closing a chat.
  SELECT state,phone INTO v_state,v_phone FROM contact_intelligence_events
    WHERE tenant_id=NEW.tenant_id AND chat_id=NEW.chat_id AND kind='state' AND occurred_at<=NEW.timestamp
    ORDER BY occurred_at DESC,sequence DESC LIMIT 1;
  IF v_state IS DISTINCT FROM 'OPEN' THEN RETURN NEW; END IF;
  -- Protocol updates, imported history before activation and inbound messages are never touches.
  IF lower(COALESCE(NEW.message_type,'')) IN ('protocolmessage','protocol','reactionmessage') THEN RETURN NEW; END IF;
  PERFORM contact_intelligence_append(NEW.tenant_id,'sent',NEW.chat_id,COALESCE(NULLIF(NEW.remote_number,''),v_phone),
    'OPEN',NEW.timestamp,COALESCE(NEW.connection_id::text,NEW.whatsapp_session_name::text)||':'||lower(NEW.whatsapp_message_id));
  RETURN NEW;
END $$;
CREATE TRIGGER contact_intelligence_message AFTER INSERT OR UPDATE OF status ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION contact_intelligence_message_capture();

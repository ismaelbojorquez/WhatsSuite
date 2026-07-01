-- Soft-delete WhatsApp sessions so chats/messages keep their FK anchor.
-- A deleted session can be reactivated by creating a connection with the same session_name.

ALTER TABLE whatsapp_sessions
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS name VARCHAR(255);

UPDATE whatsapp_sessions
SET name = COALESCE(name, session_name)
WHERE name IS NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_deleted_at
  ON whatsapp_sessions(deleted_at);

CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_active_tenant_updated
  ON whatsapp_sessions(tenant_id, updated_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN whatsapp_sessions.deleted_at IS 'Soft-delete marker. Kept to preserve chats/messages that reference session_name.';

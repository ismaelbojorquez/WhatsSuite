-- Cache WhatsApp Web reach-out / account restriction rejections per connection + contact.
-- This prevents repeated sends to contacts that WhatsApp has already rejected with 463.

CREATE TABLE IF NOT EXISTS whatsapp_reachout_restrictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  whatsapp_session_name TEXT NOT NULL,
  remote_number TEXT NOT NULL,
  remote_jid TEXT,
  reason TEXT NOT NULL DEFAULT 'reachout_timelock',
  status_code TEXT,
  status_error TEXT,
  message_id TEXT,
  blocked_until TIMESTAMPTZ NOT NULL,
  last_error_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_whatsapp_reachout_active
  ON whatsapp_reachout_restrictions(tenant_id, whatsapp_session_name, remote_number)
  WHERE cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_reachout_lookup
  ON whatsapp_reachout_restrictions(tenant_id, whatsapp_session_name, remote_number, blocked_until)
  WHERE cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_reachout_expiry
  ON whatsapp_reachout_restrictions(blocked_until)
  WHERE cleared_at IS NULL;

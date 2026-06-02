-- migrate: no-transaction
-- Online indexes for high-volume tables and hot query paths.

CREATE INDEX CONCURRENTLY IF NOT EXISTS brin_chat_messages_created_at
  ON chat_messages USING BRIN (created_at) WITH (pages_per_range = 64);

CREATE INDEX CONCURRENTLY IF NOT EXISTS brin_chat_messages_timestamp
  ON chat_messages USING BRIN (timestamp) WITH (pages_per_range = 64);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_chat_sort_desc
  ON chat_messages (chat_id, (COALESCE(timestamp, created_at)) DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_session_created_at
  ON chat_messages (whatsapp_session_name, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_tenant_session_created
  ON chat_messages (tenant_id, whatsapp_session_name, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_chat_direction_created
  ON chat_messages (chat_id, direction, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_lower_whatsapp_id
  ON chat_messages (LOWER(whatsapp_message_id))
  WHERE whatsapp_message_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_tenant_lower_whatsapp_id
  ON chat_messages (tenant_id, LOWER(whatsapp_message_id))
  WHERE whatsapp_message_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_text_trgm
  ON chat_messages USING GIN (LOWER(COALESCE(content->>'text', '')) gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_media_relative_path
  ON chat_messages ((content->'media'->>'relativePath'))
  WHERE content ? 'media';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chats_tenant_status_sort
  ON chats (tenant_id, status, updated_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chats_tenant_queue_status_sort
  ON chats (tenant_id, queue_id, status, updated_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chats_agent_status_sort
  ON chats (assigned_agent_id, status, updated_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_broadcast_messages_pending_due
  ON broadcast_messages (next_attempt_at, created_at, id)
  WHERE status = 'pending';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_broadcast_messages_sending_stale
  ON broadcast_messages (updated_at, created_at, id)
  WHERE status = 'sending';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_broadcast_messages_campaign_created
  ON broadcast_messages (campaign_id, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_broadcast_campaigns_tenant_created
  ON broadcast_campaigns (tenant_id, created_at DESC);

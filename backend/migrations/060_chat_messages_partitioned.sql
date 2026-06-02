-- Partition chat_messages by created_at while preserving global WhatsApp-message dedupe.
-- PostgreSQL cannot enforce UNIQUE(tenant_id, connection_id, whatsapp_message_id)
-- on a range-partitioned table unless created_at is part of the key. The registry
-- below keeps that global uniqueness independent from the time partition key.

CREATE TABLE IF NOT EXISTS chat_message_dedupe_keys (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  whatsapp_message_id TEXT NOT NULL,
  message_id UUID NOT NULL,
  message_created_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, connection_id, whatsapp_message_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_message_dedupe_message
  ON chat_message_dedupe_keys(message_id, message_created_at);

DO $$
DECLARE
  is_partitioned BOOLEAN;
  min_month DATE;
  max_month DATE;
  part_start DATE;
  part_end DATE;
  part_name TEXT;
  temp_name TEXT;
  moved_rows BIGINT;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_partitioned_table
    WHERE partrelid = to_regclass('chat_messages')
  ) INTO is_partitioned;

  IF is_partitioned THEN
    RETURN;
  END IF;

  LOCK TABLE chat_messages IN ACCESS EXCLUSIVE MODE;

  UPDATE chat_messages
  SET connection_id = COALESCE(connection_id, whatsapp_session_name::text)
  WHERE whatsapp_message_id IS NOT NULL
    AND connection_id IS NULL;

  WITH duplicates AS (
    SELECT id,
           created_at,
           ROW_NUMBER() OVER (
             PARTITION BY tenant_id, COALESCE(connection_id, whatsapp_session_name::text), whatsapp_message_id
             ORDER BY created_at, id
           ) AS rn
    FROM chat_messages
    WHERE whatsapp_message_id IS NOT NULL
  )
  DELETE FROM chat_messages cm
  USING duplicates d
  WHERE cm.id = d.id
    AND cm.created_at = d.created_at
    AND d.rn > 1;

  SELECT date_trunc('month', MIN(created_at))::date,
         date_trunc('month', MAX(created_at))::date
  INTO min_month, max_month
  FROM chat_messages;

  ALTER TABLE chat_messages RENAME TO chat_messages_default;

  ALTER TABLE chat_messages_default DROP CONSTRAINT IF EXISTS chat_messages_chat_id_fkey;
  ALTER TABLE chat_messages_default DROP CONSTRAINT IF EXISTS chat_messages_tenant_fk;

  EXECUTE '
    CREATE TABLE chat_messages (
      LIKE chat_messages_default
        INCLUDING DEFAULTS
        INCLUDING STORAGE
        INCLUDING COMMENTS
    ) PARTITION BY RANGE (created_at)
  ';

  ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_chat_id_fkey
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL;

  ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

  ALTER TABLE chat_messages ATTACH PARTITION chat_messages_default DEFAULT;

  ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_direction_chk CHECK (direction IN ('in','out'));

  IF min_month IS NOT NULL THEN
    part_start := min_month;
    WHILE part_start <= max_month LOOP
      part_end := (part_start + INTERVAL '1 month')::date;
      part_name := format('chat_messages_%s', to_char(part_start, 'YYYY_MM'));
      temp_name := format('chat_messages_move_%s', to_char(part_start, 'YYYY_MM'));

      EXECUTE format('CREATE TEMP TABLE %I (LIKE chat_messages INCLUDING DEFAULTS) ON COMMIT DROP', temp_name);
      EXECUTE format(
        'WITH moved AS (
           DELETE FROM chat_messages_default
           WHERE created_at >= %L AND created_at < %L
           RETURNING *
         )
         INSERT INTO %I SELECT * FROM moved',
        part_start,
        part_end,
        temp_name
      );
      GET DIAGNOSTICS moved_rows = ROW_COUNT;

      IF moved_rows > 0 THEN
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS %I PARTITION OF chat_messages FOR VALUES FROM (%L) TO (%L)',
          part_name,
          part_start,
          part_end
        );
        EXECUTE format('INSERT INTO chat_messages SELECT * FROM %I', temp_name);
      END IF;

      EXECUTE format('DROP TABLE IF EXISTS %I', temp_name);
      part_start := part_end;
    END LOOP;
  END IF;
END $$;

INSERT INTO chat_message_dedupe_keys (
  tenant_id,
  connection_id,
  whatsapp_message_id,
  message_id,
  message_created_at
)
SELECT tenant_id,
       COALESCE(connection_id, whatsapp_session_name::text),
       whatsapp_message_id,
       id,
       created_at
FROM chat_messages
WHERE whatsapp_message_id IS NOT NULL
ON CONFLICT (tenant_id, connection_id, whatsapp_message_id) DO UPDATE
SET message_id = EXCLUDED.message_id,
    message_created_at = EXCLUDED.message_created_at,
    updated_at = NOW();

CREATE OR REPLACE FUNCTION enforce_chat_message_global_dedupe()
RETURNS TRIGGER AS $$
DECLARE
  old_connection TEXT;
  new_connection TEXT;
  inserted_rows BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.whatsapp_message_id IS NULL THEN
      RETURN NEW;
    END IF;

    NEW.connection_id := COALESCE(NEW.connection_id, NEW.whatsapp_session_name::text);
    INSERT INTO chat_message_dedupe_keys (
      tenant_id,
      connection_id,
      whatsapp_message_id,
      message_id,
      message_created_at
    )
    VALUES (
      NEW.tenant_id,
      NEW.connection_id,
      NEW.whatsapp_message_id,
      NEW.id,
      NEW.created_at
    )
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS inserted_rows = ROW_COUNT;
    IF inserted_rows = 0 THEN
      RAISE EXCEPTION
        'duplicate chat message dedupe key tenant=% connection=% whatsapp_message_id=%',
        NEW.tenant_id,
        NEW.connection_id,
        NEW.whatsapp_message_id
        USING ERRCODE = '23505';
    END IF;

    RETURN NEW;
  END IF;

  old_connection := COALESCE(OLD.connection_id, OLD.whatsapp_session_name::text);
  new_connection := COALESCE(NEW.connection_id, NEW.whatsapp_session_name::text);
  NEW.connection_id := new_connection;

  IF OLD.whatsapp_message_id IS NOT NULL
     AND (
       NEW.whatsapp_message_id IS NULL
       OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR old_connection IS DISTINCT FROM new_connection
       OR OLD.whatsapp_message_id IS DISTINCT FROM NEW.whatsapp_message_id
     ) THEN
    DELETE FROM chat_message_dedupe_keys
    WHERE tenant_id = OLD.tenant_id
      AND connection_id = old_connection
      AND whatsapp_message_id = OLD.whatsapp_message_id
      AND message_id = OLD.id;
  END IF;

  IF NEW.whatsapp_message_id IS NOT NULL THEN
    INSERT INTO chat_message_dedupe_keys (
      tenant_id,
      connection_id,
      whatsapp_message_id,
      message_id,
      message_created_at
    )
    VALUES (
      NEW.tenant_id,
      new_connection,
      NEW.whatsapp_message_id,
      NEW.id,
      NEW.created_at
    )
    ON CONFLICT (tenant_id, connection_id, whatsapp_message_id) DO UPDATE
    SET message_id = CASE
          WHEN chat_message_dedupe_keys.message_id = OLD.id THEN EXCLUDED.message_id
          ELSE chat_message_dedupe_keys.message_id
        END,
        message_created_at = CASE
          WHEN chat_message_dedupe_keys.message_id = OLD.id THEN EXCLUDED.message_created_at
          ELSE chat_message_dedupe_keys.message_created_at
        END,
        updated_at = CASE
          WHEN chat_message_dedupe_keys.message_id = OLD.id THEN NOW()
          ELSE chat_message_dedupe_keys.updated_at
        END;

    IF EXISTS (
      SELECT 1
      FROM chat_message_dedupe_keys
      WHERE tenant_id = NEW.tenant_id
        AND connection_id = new_connection
        AND whatsapp_message_id = NEW.whatsapp_message_id
        AND message_id <> NEW.id
    ) THEN
      RAISE EXCEPTION
        'duplicate chat message dedupe key tenant=% connection=% whatsapp_message_id=%',
        NEW.tenant_id,
        new_connection,
        NEW.whatsapp_message_id
        USING ERRCODE = '23505';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cleanup_chat_message_global_dedupe()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.whatsapp_message_id IS NOT NULL THEN
    DELETE FROM chat_message_dedupe_keys
    WHERE tenant_id = OLD.tenant_id
      AND connection_id = COALESCE(OLD.connection_id, OLD.whatsapp_session_name::text)
      AND whatsapp_message_id = OLD.whatsapp_message_id
      AND message_id = OLD.id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chat_messages_global_dedupe ON chat_messages;
CREATE TRIGGER trg_chat_messages_global_dedupe
BEFORE INSERT OR UPDATE ON chat_messages
FOR EACH ROW EXECUTE FUNCTION enforce_chat_message_global_dedupe();

DROP TRIGGER IF EXISTS trg_chat_messages_global_dedupe_delete ON chat_messages;
CREATE TRIGGER trg_chat_messages_global_dedupe_delete
AFTER DELETE ON chat_messages
FOR EACH ROW EXECUTE FUNCTION cleanup_chat_message_global_dedupe();

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_id
  ON chat_messages(id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_chat_id
  ON chat_messages(chat_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_direction
  ON chat_messages(direction);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_session_remote
  ON chat_messages(whatsapp_session_name, remote_number);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_whatsapp_message_id
  ON chat_messages(whatsapp_message_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_tenant
  ON chat_messages(tenant_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_tenant_chat
  ON chat_messages(tenant_id, chat_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_tenant_whatsapp_message
  ON chat_messages(tenant_id, whatsapp_message_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_tenant_timestamp
  ON chat_messages(tenant_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_tenant_conn_ts
  ON chat_messages(tenant_id, connection_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_chat_created
  ON chat_messages(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_chat_created_at
  ON chat_messages(chat_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_content_gin
  ON chat_messages USING GIN (content jsonb_path_ops);

CREATE INDEX IF NOT EXISTS brin_chat_messages_part_created_at
  ON chat_messages USING BRIN (created_at) WITH (pages_per_range = 64);

CREATE INDEX IF NOT EXISTS brin_chat_messages_part_timestamp
  ON chat_messages USING BRIN (timestamp) WITH (pages_per_range = 64);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_chat_sort_desc
  ON chat_messages (chat_id, (COALESCE(timestamp, created_at)) DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_session_created_at
  ON chat_messages (whatsapp_session_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_tenant_session_created
  ON chat_messages (tenant_id, whatsapp_session_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_chat_direction_created
  ON chat_messages (chat_id, direction, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_lower_whatsapp_id
  ON chat_messages (LOWER(whatsapp_message_id))
  WHERE whatsapp_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_tenant_lower_whatsapp_id
  ON chat_messages (tenant_id, LOWER(whatsapp_message_id))
  WHERE whatsapp_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_text_trgm
  ON chat_messages USING GIN (LOWER(COALESCE(content->>'text', '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_chat_messages_part_media_relative_path
  ON chat_messages ((content->'media'->>'relativePath'))
  WHERE content ? 'media';

SELECT ensure_database_partitions(2, 12);

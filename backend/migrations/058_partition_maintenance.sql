-- Partition maintenance helpers.
-- Existing migrations created time partitions only for the initial deployment window.
-- This keeps future inserts away from DEFAULT partitions as the installation ages.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION ensure_range_partition(
  p_parent REGCLASS,
  p_partition_name TEXT,
  p_from DATE,
  p_to DATE
) RETURNS void AS $$
DECLARE
  partition_column TEXT;
  default_partition REGCLASS;
  range_check_name TEXT := format('%s_range_chk', p_partition_name);
  moved_rows BIGINT;
BEGIN
  SELECT a.attname INTO partition_column
  FROM pg_partitioned_table p
  JOIN LATERAL unnest(p.partattrs) WITH ORDINALITY attrs(attnum, ord) ON true
  JOIN pg_attribute a ON a.attrelid = p.partrelid AND a.attnum = attrs.attnum
  WHERE p.partrelid = p_parent
    AND attrs.ord = 1;

  IF partition_column IS NULL THEN
    RAISE EXCEPTION 'Cannot ensure partition for %, partition key is not a simple single column', p_parent::text;
  END IF;

  SELECT c.oid::regclass INTO default_partition
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  WHERE i.inhparent = p_parent
    AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT';

  BEGIN
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
      p_partition_name,
      p_parent::text,
      p_from,
      p_to
    );
    RETURN;
  EXCEPTION
    WHEN duplicate_table OR invalid_object_definition THEN
      -- The range may already be covered by partitions created by older naming schemes.
      RETURN;
    WHEN check_violation THEN
      IF default_partition IS NULL THEN
        RAISE;
      END IF;
  END;

  EXECUTE format(
    'CREATE TABLE %I (LIKE %s INCLUDING DEFAULTS INCLUDING STORAGE INCLUDING COMMENTS)',
    p_partition_name,
    p_parent::text
  );
  EXECUTE format(
    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I >= %L AND %I < %L)',
    p_partition_name,
    range_check_name,
    partition_column,
    p_from,
    partition_column,
    p_to
  );
  EXECUTE format(
    'WITH moved AS (
       DELETE FROM %s
       WHERE %I >= %L AND %I < %L
       RETURNING *
     )
     INSERT INTO %I SELECT * FROM moved',
    default_partition::text,
    partition_column,
    p_from,
    partition_column,
    p_to,
    p_partition_name
  );
  GET DIAGNOSTICS moved_rows = ROW_COUNT;

  EXECUTE format(
    'ALTER TABLE %s ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
    p_parent::text,
    p_partition_name,
    p_from,
    p_to
  );

  RAISE NOTICE 'Moved % row(s) from % into new partition %', moved_rows, default_partition::text, p_partition_name;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ensure_monthly_range_partitions(
  p_parent REGCLASS,
  p_prefix TEXT,
  p_from_month DATE,
  p_through_month DATE
) RETURNS void AS $$
DECLARE
  part_start DATE := date_trunc('month', p_from_month)::date;
  part_end DATE;
  part_name TEXT;
BEGIN
  WHILE part_start <= date_trunc('month', p_through_month)::date LOOP
    part_end := (part_start + INTERVAL '1 month')::date;
    part_name := format('%s_%s', p_prefix, to_char(part_start, 'YYYY_MM'));

    PERFORM ensure_range_partition(p_parent, part_name, part_start, part_end);

    part_start := part_end;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ensure_yearly_range_partitions(
  p_parent REGCLASS,
  p_prefix TEXT,
  p_from_year DATE,
  p_through_year DATE
) RETURNS void AS $$
DECLARE
  part_start DATE := date_trunc('year', p_from_year)::date;
  part_end DATE;
  part_name TEXT;
BEGIN
  WHILE part_start <= date_trunc('year', p_through_year)::date LOOP
    part_end := (part_start + INTERVAL '1 year')::date;
    part_name := format('%s_%s', p_prefix, to_char(part_start, 'YYYY'));

    PERFORM ensure_range_partition(p_parent, part_name, part_start, part_end);

    part_start := part_end;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ensure_database_partitions(
  p_months_back INTEGER DEFAULT 2,
  p_months_ahead INTEGER DEFAULT 12
) RETURNS void AS $$
DECLARE
  from_month DATE := date_trunc('month', CURRENT_DATE - make_interval(months => GREATEST(p_months_back, 0)))::date;
  through_month DATE := date_trunc('month', CURRENT_DATE + make_interval(months => GREATEST(p_months_ahead, 1)))::date;
  from_year DATE := date_trunc('year', from_month)::date;
  through_year DATE := date_trunc('year', through_month + INTERVAL '1 year')::date;
  parent_oid OID;
BEGIN
  SELECT c.oid INTO parent_oid
  FROM pg_class c
  JOIN pg_partitioned_table p ON p.partrelid = c.oid
  WHERE c.oid = to_regclass('chat_messages');
  IF parent_oid IS NOT NULL THEN
    PERFORM ensure_monthly_range_partitions(parent_oid::regclass, 'chat_messages', from_month, through_month);
  END IF;

  SELECT c.oid INTO parent_oid
  FROM pg_class c
  JOIN pg_partitioned_table p ON p.partrelid = c.oid
  WHERE c.oid = to_regclass('messages_core');
  IF parent_oid IS NOT NULL THEN
    PERFORM ensure_monthly_range_partitions(parent_oid::regclass, 'messages_core', from_month, through_month);
  END IF;

  SELECT c.oid INTO parent_oid
  FROM pg_class c
  JOIN pg_partitioned_table p ON p.partrelid = c.oid
  WHERE c.oid = to_regclass('messages_content');
  IF parent_oid IS NOT NULL THEN
    PERFORM ensure_monthly_range_partitions(parent_oid::regclass, 'messages_content', from_month, through_month);
  END IF;

  SELECT c.oid INTO parent_oid
  FROM pg_class c
  JOIN pg_partitioned_table p ON p.partrelid = c.oid
  WHERE c.oid = to_regclass('audit_logs');
  IF parent_oid IS NOT NULL THEN
    PERFORM ensure_monthly_range_partitions(parent_oid::regclass, 'audit_logs', from_month, through_month);
  END IF;

  SELECT c.oid INTO parent_oid
  FROM pg_class c
  JOIN pg_partitioned_table p ON p.partrelid = c.oid
  WHERE c.oid = to_regclass('dashboard_messages_daily');
  IF parent_oid IS NOT NULL THEN
    PERFORM ensure_monthly_range_partitions(parent_oid::regclass, 'dashboard_messages_daily', from_month, through_month);
  END IF;

  SELECT c.oid INTO parent_oid
  FROM pg_class c
  JOIN pg_partitioned_table p ON p.partrelid = c.oid
  WHERE c.oid = to_regclass('dashboard_chats_daily');
  IF parent_oid IS NOT NULL THEN
    PERFORM ensure_monthly_range_partitions(parent_oid::regclass, 'dashboard_chats_daily', from_month, through_month);
  END IF;

  SELECT c.oid INTO parent_oid
  FROM pg_class c
  JOIN pg_partitioned_table p ON p.partrelid = c.oid
  WHERE c.oid = to_regclass('media_files');
  IF parent_oid IS NOT NULL THEN
    PERFORM ensure_yearly_range_partitions(parent_oid::regclass, 'media_files', from_year, through_year);
  END IF;
END;
$$ LANGUAGE plpgsql;

SELECT ensure_database_partitions(2, 12);

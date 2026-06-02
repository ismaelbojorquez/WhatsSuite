-- Partition maintenance helpers.
-- Existing migrations created time partitions only for the initial deployment window.
-- This keeps future inserts away from DEFAULT partitions as the installation ages.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

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

    BEGIN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        part_name,
        p_parent::text,
        part_start,
        part_end
      );
    EXCEPTION
      WHEN duplicate_table OR invalid_object_definition THEN
        -- The range may already be covered by partitions created by older naming schemes.
        NULL;
    END;

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

    BEGIN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        part_name,
        p_parent::text,
        part_start,
        part_end
      );
    EXCEPTION
      WHEN duplicate_table OR invalid_object_definition THEN
        NULL;
    END;

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

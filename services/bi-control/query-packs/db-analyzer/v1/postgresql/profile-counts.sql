SELECT
  count(*)::bigint AS row_count,
  count(*) FILTER (WHERE {{COLUMN}} IS NULL)::bigint AS null_count,
  count(DISTINCT {{COLUMN}})::bigint AS distinct_count
FROM {{SCHEMA}}.{{RELATION}};

SELECT
  namespace.nspname AS schema_name,
  relation.relname AS relation_name,
  CASE relation.relkind
    WHEN 'r' THEN 'TABLE'
    WHEN 'p' THEN 'PARTITIONED_TABLE'
    WHEN 'v' THEN 'VIEW'
    WHEN 'm' THEN 'MATERIALIZED_VIEW'
    WHEN 'f' THEN 'FOREIGN_TABLE'
  END AS relation_kind,
  attribute.attname AS column_name,
  attribute.attnum AS ordinal_position,
  type_namespace.nspname AS type_schema_name,
  type.typname AS data_type,
  type.oid AS native_type_oid,
  NOT attribute.attnotnull AS is_nullable,
  attribute.atthasdef AS has_default,
  attribute.attidentity AS identity_kind,
  attribute.attgenerated AS generated_kind
FROM pg_catalog.pg_attribute AS attribute
JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_type AS type ON type.oid = attribute.atttypid
JOIN pg_catalog.pg_namespace AS type_namespace ON type_namespace.oid = type.typnamespace
WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
ORDER BY namespace.nspname, relation.relname, attribute.attnum, attribute.attname;

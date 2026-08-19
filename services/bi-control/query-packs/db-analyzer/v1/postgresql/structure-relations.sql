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
  relation.oid AS native_relation_oid,
  relation.relpersistence AS persistence,
  relation.relrowsecurity AS row_security_enabled,
  relation.relispartition AS is_partition
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
ORDER BY namespace.nspname, relation.relname, relation.relkind;

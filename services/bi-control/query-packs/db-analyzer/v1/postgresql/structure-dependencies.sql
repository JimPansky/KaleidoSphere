SELECT
  source_namespace.nspname AS source_schema_name,
  source_relation.relname AS source_relation_name,
  CASE source_relation.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED_VIEW' END AS source_relation_kind,
  target_namespace.nspname AS target_schema_name,
  target_relation.relname AS target_relation_name,
  CASE target_relation.relkind
    WHEN 'r' THEN 'TABLE'
    WHEN 'p' THEN 'PARTITIONED_TABLE'
    WHEN 'v' THEN 'VIEW'
    WHEN 'm' THEN 'MATERIALIZED_VIEW'
    WHEN 'f' THEN 'FOREIGN_TABLE'
  END AS target_relation_kind,
  'PG_DEPEND_REWRITE_NORMAL' AS dependency_kind,
  'CATALOG_DECLARED' AS relationship_authority,
  false AS inferred
FROM pg_catalog.pg_rewrite AS rewrite
JOIN pg_catalog.pg_class AS source_relation ON source_relation.oid = rewrite.ev_class
JOIN pg_catalog.pg_namespace AS source_namespace ON source_namespace.oid = source_relation.relnamespace
JOIN pg_catalog.pg_depend AS dependency
  ON dependency.classid = 'pg_rewrite'::regclass
  AND dependency.objid = rewrite.oid
  AND dependency.refclassid = 'pg_class'::regclass
JOIN pg_catalog.pg_class AS target_relation ON target_relation.oid = dependency.refobjid
JOIN pg_catalog.pg_namespace AS target_namespace ON target_namespace.oid = target_relation.relnamespace
WHERE source_relation.relkind IN ('v', 'm')
  AND target_relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND dependency.deptype = 'n'
  AND source_relation.oid <> target_relation.oid
ORDER BY source_namespace.nspname, source_relation.relname, target_namespace.nspname, target_relation.relname;

SELECT
  namespace.nspname AS schema_name,
  relation.relname AS relation_name,
  constraint_row.conname AS constraint_name,
  CASE constraint_row.contype
    WHEN 'p' THEN 'PRIMARY_KEY'
    WHEN 'u' THEN 'UNIQUE'
    WHEN 'f' THEN 'FOREIGN_KEY'
  END AS constraint_kind,
  source_attribute.attname AS column_name,
  array_position(constraint_row.conkey, source_attribute.attnum) AS ordinal_position,
  target_namespace.nspname AS referenced_schema_name,
  target_relation.relname AS referenced_relation_name,
  target_attribute.attname AS referenced_column_name,
  'OMITTED_NO_RAW_DEFINITION' AS definition_disclosure,
  CASE constraint_row.confdeltype WHEN 'a' THEN 'NO_ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET_NULL' WHEN 'd' THEN 'SET_DEFAULT' END AS delete_rule,
  CASE constraint_row.confupdtype WHEN 'a' THEN 'NO_ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET_NULL' WHEN 'd' THEN 'SET_DEFAULT' END AS update_rule,
  true AS is_enabled,
  constraint_row.convalidated AS is_validated,
  constraint_row.condeferrable AS is_deferrable,
  constraint_row.condeferred AS is_initially_deferred
FROM pg_catalog.pg_constraint AS constraint_row
JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_attribute AS source_attribute
  ON source_attribute.attrelid = constraint_row.conrelid
  AND source_attribute.attnum = ANY(constraint_row.conkey)
LEFT JOIN pg_catalog.pg_class AS target_relation ON target_relation.oid = constraint_row.confrelid
LEFT JOIN pg_catalog.pg_namespace AS target_namespace ON target_namespace.oid = target_relation.relnamespace
LEFT JOIN pg_catalog.pg_attribute AS target_attribute
  ON target_attribute.attrelid = constraint_row.confrelid
  AND array_position(constraint_row.confkey, target_attribute.attnum) = array_position(constraint_row.conkey, source_attribute.attnum)
WHERE constraint_row.contype IN ('p', 'u', 'f')
UNION ALL
SELECT
  namespace.nspname AS schema_name,
  relation.relname AS relation_name,
  constraint_row.conname AS constraint_name,
  'CHECK' AS constraint_kind,
  source_attribute.attname AS column_name,
  array_position(constraint_row.conkey, source_attribute.attnum) AS ordinal_position,
  CAST(NULL AS text) AS referenced_schema_name,
  CAST(NULL AS text) AS referenced_relation_name,
  CAST(NULL AS text) AS referenced_column_name,
  'OMITTED_NO_RAW_DEFINITION' AS definition_disclosure,
  CAST(NULL AS text) AS delete_rule,
  CAST(NULL AS text) AS update_rule,
  true AS is_enabled,
  constraint_row.convalidated AS is_validated,
  constraint_row.condeferrable AS is_deferrable,
  constraint_row.condeferred AS is_initially_deferred
FROM pg_catalog.pg_constraint AS constraint_row
JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
LEFT JOIN pg_catalog.pg_attribute AS source_attribute
  ON source_attribute.attrelid = constraint_row.conrelid
  AND source_attribute.attnum = ANY(constraint_row.conkey)
WHERE constraint_row.contype = 'c'
ORDER BY schema_name, relation_name, constraint_kind, constraint_name, ordinal_position, column_name;

SELECT
  (SELECT count({{SOURCE_COLUMN}})::bigint
   FROM {{SOURCE_SCHEMA}}.{{SOURCE_RELATION}}
   WHERE {{SOURCE_COLUMN}} IS NOT NULL) AS source_non_null_count,
  (SELECT count(DISTINCT {{SOURCE_COLUMN}})::bigint
   FROM {{SOURCE_SCHEMA}}.{{SOURCE_RELATION}}
   WHERE {{SOURCE_COLUMN}} IS NOT NULL) AS source_distinct_count,
  (SELECT count(DISTINCT {{TARGET_COLUMN}})::bigint
   FROM {{TARGET_SCHEMA}}.{{TARGET_RELATION}}
   WHERE {{TARGET_COLUMN}} IS NOT NULL) AS target_distinct_count,
  (SELECT count(DISTINCT source_row.{{SOURCE_COLUMN}})::bigint
   FROM {{SOURCE_SCHEMA}}.{{SOURCE_RELATION}} AS source_row
   WHERE source_row.{{SOURCE_COLUMN}} IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM {{TARGET_SCHEMA}}.{{TARGET_RELATION}} AS target_row
       WHERE target_row.{{TARGET_COLUMN}} = source_row.{{SOURCE_COLUMN}}
     )) AS matched_distinct_count;

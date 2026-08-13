SELECT DISTINCT
  owner AS schema_name
FROM all_objects
WHERE object_type IN ('TABLE', 'VIEW')
ORDER BY owner;

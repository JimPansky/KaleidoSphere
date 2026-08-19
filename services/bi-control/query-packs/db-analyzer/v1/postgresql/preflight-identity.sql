SELECT
  'postgresql' AS engine,
  current_setting('server_version') AS engine_version,
  current_database() AS database_name,
  CAST(NULL AS text) AS container_name
FROM pg_catalog.pg_settings AS settings
WHERE settings.name = 'server_version'
ORDER BY engine, database_name;

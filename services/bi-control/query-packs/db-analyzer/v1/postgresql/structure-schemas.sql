SELECT
  namespace.nspname AS schema_name,
  namespace.oid AS native_schema_oid,
  role.rolname AS owner_name
FROM pg_catalog.pg_namespace AS namespace
JOIN pg_catalog.pg_roles AS role ON role.oid = namespace.nspowner
ORDER BY namespace.nspname;

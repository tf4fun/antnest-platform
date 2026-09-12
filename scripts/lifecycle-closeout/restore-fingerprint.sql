\set ON_ERROR_STOP on
SELECT 'database|' || jsonb_build_object(
  'name', datname, 'owner', pg_get_userbyid(datdba), 'acl', datacl)::text
FROM pg_database WHERE datname = current_database();

SELECT 'schema|' || jsonb_build_object(
  'name', nspname, 'owner', pg_get_userbyid(nspowner), 'acl', nspacl)::text
FROM pg_namespace
WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
ORDER BY nspname;

SELECT 'object|' || jsonb_build_object(
  'schema', n.nspname, 'name', c.relname, 'kind', c.relkind,
  'owner', pg_get_userbyid(c.relowner), 'acl', c.relacl,
  'row_security', c.relrowsecurity, 'force_row_security', c.relforcerowsecurity)::text
FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relname;

SELECT 'default_acl|' || jsonb_build_object(
  'role', pg_get_userbyid(d.defaclrole), 'schema', n.nspname,
  'kind', d.defaclobjtype, 'acl', d.defaclacl)::text
FROM pg_default_acl d LEFT JOIN pg_namespace n ON d.defaclnamespace = n.oid
ORDER BY pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype;

SELECT format(
  'SELECT %L || ''|'' || count(*) || ''|'' || md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, ''[]'')) FROM %I.%I t',
  'table:' || schemaname || '.' || tablename, schemaname, tablename)
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY schemaname, tablename
\gexec

SELECT format('SELECT %L || ''|'' || last_value || ''|'' || is_called FROM %I.%I',
  'sequence:' || schemaname || '.' || sequencename, schemaname, sequencename)
FROM pg_sequences
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY schemaname, sequencename
\gexec

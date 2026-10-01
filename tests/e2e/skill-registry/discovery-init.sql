CREATE ROLE registry_service LOGIN PASSWORD 'discovery-fixture-registry';
CREATE DATABASE registry OWNER registry_service;
REVOKE CONNECT ON DATABASE registry FROM PUBLIC;
GRANT CONNECT ON DATABASE registry TO registry_service;

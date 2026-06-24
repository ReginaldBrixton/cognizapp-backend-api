CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS app;

ALTER DATABASE cognizap SET search_path = app, auth, public;
ALTER ROLE CURRENT_USER IN DATABASE cognizap SET search_path = app, auth, public;

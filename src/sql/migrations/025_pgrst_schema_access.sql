DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    GRANT USAGE ON SCHEMA app TO authenticator;
    GRANT USAGE ON SCHEMA auth TO authenticator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT USAGE ON SCHEMA app TO authenticated;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO authenticated;
    GRANT SELECT ON ALL TABLES IN SCHEMA auth TO authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT ON TABLES TO authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anonymous') THEN
    GRANT USAGE ON SCHEMA app TO anonymous;
    GRANT SELECT ON ALL TABLES IN SCHEMA app TO anonymous;
    ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO anonymous;
  END IF;
END $$;

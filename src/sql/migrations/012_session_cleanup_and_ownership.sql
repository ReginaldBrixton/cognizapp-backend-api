-- 012_session_cleanup_and_ownership.sql
-- Fixes:
--   1. Auto-cleanup of expired/revoked sessions older than 24 hours
--   2. Proper session tracking with cleanup triggers
--   3. Strict workspace ownership enforcement
--   4. Session cleanup function callable from API

-- ═══════════════════════════════════════════════════════════════════
--  1.  FUNCTION to clean up old sessions
--      Removes expired sessions older than 1 hour
--      Removes revoked sessions older than 1 hour
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION cleanup_old_sessions()
RETURNS INTEGER AS $$
DECLARE
    v_expired INTEGER;
    v_revoked INTEGER;
BEGIN
    -- Delete expired sessions older than 1 hour
    DELETE FROM auth.sessions
    WHERE expires_at < NOW() - INTERVAL '1 hour';
    GET DIAGNOSTICS v_expired = ROW_COUNT;

    -- Also delete revoked sessions older than 1 hour
    DELETE FROM auth.sessions
    WHERE is_revoked = TRUE
      AND (revoked_at IS NULL OR revoked_at < NOW() - INTERVAL '1 hour');
    GET DIAGNOSTICS v_revoked = ROW_COUNT;

    RETURN v_expired + v_revoked;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════
--  2.  TRIGGER to auto-cleanup sessions on revoke
--      When a session is revoked, immediately clean up other expired
--      sessions for the same user to keep the table lean.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_cleanup_user_sessions_on_revoke()
RETURNS TRIGGER AS $$
BEGIN
    -- Only run when a session is being revoked
    IF NEW.is_revoked = TRUE AND (OLD.is_revoked = FALSE OR OLD.is_revoked IS NULL) THEN
        -- Clean up all expired sessions for this user
        DELETE FROM auth.sessions
        WHERE user_id = NEW.user_id
          AND (
            expires_at < NOW()
            OR (is_revoked = TRUE AND revoked_at < NOW() - INTERVAL '1 hour')
          )
          AND id != NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_session_cleanup ON auth.sessions;
CREATE TRIGGER trg_session_cleanup
    AFTER UPDATE OF is_revoked ON auth.sessions
    FOR EACH ROW
    WHEN (NEW.is_revoked = TRUE AND (OLD.is_revoked = FALSE OR OLD.is_revoked IS NULL))
    EXECUTE FUNCTION fn_cleanup_user_sessions_on_revoke();

-- ═══════════════════════════════════════════════════════════════════
--  3.  FUNCTION to get active sessions for a user (with cleanup first)
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_active_sessions(p_user_id UUID)
RETURNS TABLE (
    id UUID,
    device_name TEXT,
    device_type TEXT,
    browser TEXT,
    os TEXT,
    ip_address TEXT,
    country TEXT,
    city TEXT,
    created_at TIMESTAMPTZ,
    last_active TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    is_current BOOLEAN
) AS $$
BEGIN
    -- First clean up expired sessions for this user
    DELETE FROM auth.sessions
    WHERE user_id = p_user_id AND expires_at < NOW();

    -- Return active sessions
    RETURN QUERY
    SELECT 
        s.id, s.device_name, s.device_type, s.browser, s.os,
        s.ip_address, s.country, s.city,
        s.created_at, s.last_active, s.expires_at,
        FALSE AS is_current
    FROM auth.sessions s
    WHERE s.user_id = p_user_id
      AND s.is_revoked = FALSE
      AND s.expires_at > NOW()
    ORDER BY s.last_active DESC;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════
--  4.  FUNCTION to revoke a specific session and clean up
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION revoke_session_and_cleanup(
    p_session_id UUID,
    p_user_id UUID
)
RETURNS BOOLEAN AS $$
DECLARE
    v_exists BOOLEAN;
BEGIN
    -- Check session exists and belongs to user
    SELECT EXISTS(
        SELECT 1 FROM auth.sessions
        WHERE id = p_session_id AND user_id = p_user_id AND is_revoked = FALSE
    ) INTO v_exists;

    IF NOT v_exists THEN
        RETURN FALSE;
    END IF;

    -- Revoke the session
    UPDATE auth.sessions
    SET is_revoked = TRUE,
        revoked_at = NOW(),
        revoked_reason = 'user_revoked',
        updated_at = NOW()
    WHERE id = p_session_id AND user_id = p_user_id;

    -- Clean up all expired sessions for this user
    DELETE FROM auth.sessions
    WHERE user_id = p_user_id
      AND (expires_at < NOW() OR is_revoked = TRUE)
      AND id != p_session_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════
--  5.  FUNCTION to revoke ALL sessions for a user (logout all)
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION revoke_all_sessions(
    p_user_id UUID,
    p_keep_current UUID DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE auth.sessions
    SET is_revoked = TRUE,
        revoked_at = NOW(),
        revoked_reason = 'logout_all',
        updated_at = NOW()
    WHERE user_id = p_user_id
      AND is_revoked = FALSE
      AND (p_keep_current IS NULL OR id != p_keep_current);

    GET DIAGNOSTICS v_count = ROW_COUNT;

    -- Also delete all expired sessions for this user
    DELETE FROM auth.sessions
    WHERE user_id = p_user_id AND expires_at < NOW();

    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════
--  6.  STRICT WORKSPACE OWNERSHIP FUNCTION
--      Ensures workspace owner_uid matches a valid user ID
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION validate_workspace_ownership()
RETURNS TRIGGER AS $$
DECLARE
    v_owner_exists BOOLEAN;
BEGIN
    -- Validate owner_uid is a valid UUID and exists in users table
    v_owner_exists := EXISTS(
        SELECT 1 FROM auth.users
        WHERE id::text = NEW.owner_uid AND deleted_at IS NULL
    );

    IF NOT v_owner_exists THEN
        RAISE EXCEPTION 'Workspace owner_uid % does not match any active user', NEW.owner_uid;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_workspace_owner ON workspaces;
CREATE TRIGGER trg_validate_workspace_owner
    BEFORE INSERT OR UPDATE OF owner_uid ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION validate_workspace_ownership();

-- ═══════════════════════════════════════════════════════════════════
--  7.  Clean up existing expired sessions right now
-- ═══════════════════════════════════════════════════════════════════

DELETE FROM auth.sessions WHERE expires_at < NOW();
DELETE FROM auth.sessions WHERE is_revoked = TRUE;

-- ═══════════════════════════════════════════════════════════════════
--  8.  Add missing revoked_at column if it doesn't exist
-- ═══════════════════════════════════════════════════════════════════

DO $$ BEGIN
    ALTER TABLE auth.sessions ADD COLUMN revoked_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE auth.sessions ADD COLUMN revoked_reason TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE auth.sessions ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- ═══════════════════════════════════════════════════════════════════
--  9.  Add indexes for session queries
-- ═══════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_sessions_user_active
    ON auth.sessions(user_id, last_active DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_expired
    ON auth.sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_sessions_revoked
    ON auth.sessions(revoked_at);

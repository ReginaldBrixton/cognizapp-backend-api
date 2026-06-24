-- 020_fix_revoke_session_reason.sql
-- Fix: revoke_session_and_cleanup() now accepts a reason parameter
--      instead of hardcoding 'user_revoked'. The repository passes
--      contextual reasons like 'user_logout', 'expired', etc.
-- Fix: revoke_all_sessions() also accepts a reason parameter for
--      consistent audit trails.

CREATE OR REPLACE FUNCTION revoke_session_and_cleanup(
    p_session_id UUID,
    p_user_id UUID,
    p_reason TEXT DEFAULT 'user_revoked'
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

    -- Revoke the session with the provided reason
    UPDATE auth.sessions
    SET is_revoked = TRUE,
        revoked_at = NOW(),
        revoked_reason = p_reason,
        updated_at = NOW()
    WHERE id = p_session_id AND user_id = p_user_id;

    -- Clean up all expired and revoked sessions for this user (excluding current)
    DELETE FROM auth.sessions
    WHERE user_id = p_user_id
      AND (expires_at < NOW() OR is_revoked = TRUE)
      AND id != p_session_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION revoke_all_sessions(
    p_user_id UUID,
    p_keep_current UUID DEFAULT NULL,
    p_reason TEXT DEFAULT 'logout_all'
)
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE auth.sessions
    SET is_revoked = TRUE,
        revoked_at = NOW(),
        revoked_reason = p_reason,
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

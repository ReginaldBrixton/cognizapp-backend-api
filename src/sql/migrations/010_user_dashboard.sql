-- 010_user_dashboard.sql
-- Creates a dedicated user_dashboard_stats table that stores pre-computed
-- dashboard metrics per user. This gives the frontend fast access to
-- aggregated data and provides a real database table for dashboard stats.

CREATE TABLE IF NOT EXISTS user_dashboard_stats (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    
    -- Workspace stats
    owned_workspaces    INTEGER     NOT NULL DEFAULT 0,
    member_workspaces   INTEGER     NOT NULL DEFAULT 0,
    total_workspaces    INTEGER     NOT NULL DEFAULT 0,
    
    -- Project stats
    total_projects      INTEGER     NOT NULL DEFAULT 0,
    active_projects     INTEGER     NOT NULL DEFAULT 0,
    completed_projects  INTEGER     NOT NULL DEFAULT 0,
    paused_projects     INTEGER     NOT NULL DEFAULT 0,
    archived_projects   INTEGER     NOT NULL DEFAULT 0,
    
    -- Collection stats
    total_collections   INTEGER     NOT NULL DEFAULT 0,
    folder_collections  INTEGER     NOT NULL DEFAULT 0,
    tag_collections     INTEGER     NOT NULL DEFAULT 0,
    smart_collections   INTEGER     NOT NULL DEFAULT 0,
    
    -- Analysis stats
    total_analysis      INTEGER     NOT NULL DEFAULT 0,
    pending_analysis    INTEGER     NOT NULL DEFAULT 0,
    processing_analysis INTEGER     NOT NULL DEFAULT 0,
    completed_analysis  INTEGER     NOT NULL DEFAULT 0,
    failed_analysis     INTEGER     NOT NULL DEFAULT 0,
    
    -- Activity & engagement
    total_activity      INTEGER     NOT NULL DEFAULT 0,
    last_activity_at    TIMESTAMPTZ,
    total_sessions      INTEGER     NOT NULL DEFAULT 0,
    active_sessions     INTEGER     NOT NULL DEFAULT 0,
    
    -- Notifications
    unread_notifications INTEGER    NOT NULL DEFAULT 0,
    total_notifications  INTEGER    NOT NULL DEFAULT 0,
    
    -- Storage
    storage_used_bytes  BIGINT      NOT NULL DEFAULT 0,
    storage_quota_bytes BIGINT      NOT NULL DEFAULT 5368709120,
    storage_tier        TEXT        NOT NULL DEFAULT 'free',
    
    -- Metadata
    last_computed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uds_user ON user_dashboard_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_uds_last_computed ON user_dashboard_stats(last_computed_at DESC);

-- ═══════════════════════════════════════════════════════════════════
--  Function to compute and upsert dashboard stats for a given user
--  Called by triggers and can be called directly by the API.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION compute_dashboard_stats(p_user_id UUID)
RETURNS void AS $$
BEGIN
    INSERT INTO user_dashboard_stats (
        user_id,
        owned_workspaces, member_workspaces, total_workspaces,
        total_projects, active_projects, completed_projects, paused_projects, archived_projects,
        total_collections, folder_collections, tag_collections, smart_collections,
        total_analysis, pending_analysis, processing_analysis, completed_analysis, failed_analysis,
        total_activity, last_activity_at,
        total_sessions, active_sessions,
        unread_notifications, total_notifications,
        storage_used_bytes, storage_quota_bytes, storage_tier,
        last_computed_at
    )
    SELECT
        p_user_id,
        
        -- Workspace stats
        (SELECT COUNT(*)::int FROM workspaces WHERE owner_uid = p_user_id::text AND deleted_at IS NULL),
        (SELECT COUNT(DISTINCT w.id)::int FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id
         WHERE m.user_uid = p_user_id::text AND m.deleted_at IS NULL AND w.deleted_at IS NULL AND w.owner_uid != p_user_id::text),
        0,
        
        -- Project stats
        (SELECT COUNT(*)::int FROM workspace_projects wp
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int FROM workspace_projects wp
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wp.status = 'active' AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int FROM workspace_projects wp
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wp.status = 'completed' AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int FROM workspace_projects wp
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wp.status = 'paused' AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int FROM workspace_projects wp
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wp.status = 'archived' AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        
        -- Collection stats
        (SELECT COUNT(*)::int FROM workspace_collections wc
         JOIN workspaces w ON w.id = wc.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wc.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int FROM workspace_collections wc
         JOIN workspaces w ON w.id = wc.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wc.collection_type = 'folder' AND wc.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int FROM workspace_collections wc
         JOIN workspaces w ON w.id = wc.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wc.collection_type = 'tag' AND wc.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int FROM workspace_collections wc
         JOIN workspaces w ON w.id = wc.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wc.collection_type = 'smart' AND wc.deleted_at IS NULL AND w.deleted_at IS NULL),
        
        -- Analysis stats
        (SELECT COUNT(*)::int FROM workspace_analysis wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wa.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int FROM workspace_analysis wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wa.status = 'pending' AND wa.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int FROM workspace_analysis wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wa.status = 'processing' AND wa.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int FROM workspace_analysis wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wa.status = 'completed' AND wa.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int FROM workspace_analysis wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wa.status = 'failed' AND wa.deleted_at IS NULL AND w.deleted_at IS NULL),
        
        -- Activity
        (SELECT COUNT(*)::int FROM workspace_activity wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = p_user_id::text AND w.deleted_at IS NULL),
        (SELECT MAX(wa.created_at) FROM workspace_activity wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = p_user_id::text AND w.deleted_at IS NULL),
        
        -- Sessions
        (SELECT COUNT(*)::int FROM auth.sessions WHERE user_id = p_user_id),
        (SELECT COUNT(*)::int FROM auth.sessions WHERE user_id = p_user_id AND is_revoked = FALSE AND expires_at > NOW()),
        
        -- Notifications
        (SELECT COUNT(*)::int FROM auth.notifications WHERE user_id = p_user_id AND is_read = FALSE AND is_archived = FALSE),
        (SELECT COUNT(*)::int FROM auth.notifications WHERE user_id = p_user_id AND is_archived = FALSE),
        
        -- Storage
        COALESCE((SELECT storage_used_bytes FROM auth.users WHERE id = p_user_id), 0),
        COALESCE((SELECT storage_quota_bytes FROM auth.users WHERE id = p_user_id), 5368709120),
        COALESCE((SELECT storage_tier FROM auth.users WHERE id = p_user_id), 'free'),
        
        NOW()
    ON CONFLICT (user_id) DO UPDATE SET
        owned_workspaces = EXCLUDED.owned_workspaces,
        member_workspaces = EXCLUDED.member_workspaces,
        total_workspaces = EXCLUDED.owned_workspaces + EXCLUDED.member_workspaces,
        total_projects = EXCLUDED.total_projects,
        active_projects = EXCLUDED.active_projects,
        completed_projects = EXCLUDED.completed_projects,
        paused_projects = EXCLUDED.paused_projects,
        archived_projects = EXCLUDED.archived_projects,
        total_collections = EXCLUDED.total_collections,
        folder_collections = EXCLUDED.folder_collections,
        tag_collections = EXCLUDED.tag_collections,
        smart_collections = EXCLUDED.smart_collections,
        total_analysis = EXCLUDED.total_analysis,
        pending_analysis = EXCLUDED.pending_analysis,
        processing_analysis = EXCLUDED.processing_analysis,
        completed_analysis = EXCLUDED.completed_analysis,
        failed_analysis = EXCLUDED.failed_analysis,
        total_activity = EXCLUDED.total_activity,
        last_activity_at = EXCLUDED.last_activity_at,
        total_sessions = EXCLUDED.total_sessions,
        active_sessions = EXCLUDED.active_sessions,
        unread_notifications = EXCLUDED.unread_notifications,
        total_notifications = EXCLUDED.total_notifications,
        storage_used_bytes = EXCLUDED.storage_used_bytes,
        storage_quota_bytes = EXCLUDED.storage_quota_bytes,
        storage_tier = EXCLUDED.storage_tier,
        last_computed_at = NOW(),
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════
--  Triggers to auto-refresh stats when underlying data changes
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_refresh_dashboard_stats()
RETURNS TRIGGER AS $$
DECLARE
    v_user_id UUID;
BEGIN
    IF TG_TABLE_NAME = 'workspaces' THEN
        v_user_id := (SELECT id FROM auth.users WHERE id::text = COALESCE(NEW.owner_uid, OLD.owner_uid));
    ELSIF TG_TABLE_NAME = 'workspace_members' THEN
        v_user_id := (SELECT id FROM auth.users WHERE id::text = COALESCE(NEW.user_uid, OLD.user_uid));
    ELSIF TG_TABLE_NAME = 'workspace_projects' THEN
        SELECT w.owner_uid::uuid INTO v_user_id
        FROM workspaces w
        WHERE w.id = COALESCE(NEW.workspace_id, OLD.workspace_id);
    ELSIF TG_TABLE_NAME = 'workspace_collections' THEN
        SELECT w.owner_uid::uuid INTO v_user_id
        FROM workspaces w
        WHERE w.id = COALESCE(NEW.workspace_id, OLD.workspace_id);
    ELSIF TG_TABLE_NAME = 'workspace_analysis' THEN
        SELECT w.owner_uid::uuid INTO v_user_id
        FROM workspaces w
        WHERE w.id = COALESCE(NEW.workspace_id, OLD.workspace_id);
    ELSIF TG_TABLE_NAME = 'workspace_activity' THEN
        SELECT w.owner_uid::uuid INTO v_user_id
        FROM workspaces w
        WHERE w.id = COALESCE(NEW.workspace_id, OLD.workspace_id);
    ELSIF TG_TABLE_NAME = 'notifications' THEN
        v_user_id := COALESCE(NEW.user_id, OLD.user_id);
    ELSIF TG_TABLE_NAME = 'sessions' THEN
        v_user_id := COALESCE(NEW.user_id, OLD.user_id);
    END IF;

    IF v_user_id IS NOT NULL THEN
        PERFORM compute_dashboard_stats(v_user_id);
    END IF;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create triggers on all relevant tables
DROP TRIGGER IF EXISTS trg_uds_workspaces ON workspaces;
CREATE TRIGGER trg_uds_workspaces
    AFTER INSERT OR UPDATE OR DELETE ON workspaces
    FOR EACH ROW EXECUTE FUNCTION fn_refresh_dashboard_stats();

DROP TRIGGER IF EXISTS trg_uds_workspace_members ON workspace_members;
CREATE TRIGGER trg_uds_workspace_members
    AFTER INSERT OR UPDATE OR DELETE ON workspace_members
    FOR EACH ROW EXECUTE FUNCTION fn_refresh_dashboard_stats();

DROP TRIGGER IF EXISTS trg_uds_workspace_projects ON workspace_projects;
CREATE TRIGGER trg_uds_workspace_projects
    AFTER INSERT OR UPDATE OR DELETE ON workspace_projects
    FOR EACH ROW EXECUTE FUNCTION fn_refresh_dashboard_stats();

DROP TRIGGER IF EXISTS trg_uds_workspace_collections ON workspace_collections;
CREATE TRIGGER trg_uds_workspace_collections
    AFTER INSERT OR UPDATE OR DELETE ON workspace_collections
    FOR EACH ROW EXECUTE FUNCTION fn_refresh_dashboard_stats();

DROP TRIGGER IF EXISTS trg_uds_workspace_analysis ON workspace_analysis;
CREATE TRIGGER trg_uds_workspace_analysis
    AFTER INSERT OR UPDATE OR DELETE ON workspace_analysis
    FOR EACH ROW EXECUTE FUNCTION fn_refresh_dashboard_stats();

DROP TRIGGER IF EXISTS trg_uds_workspace_activity ON workspace_activity;
CREATE TRIGGER trg_uds_workspace_activity
    AFTER INSERT OR UPDATE OR DELETE ON workspace_activity
    FOR EACH ROW EXECUTE FUNCTION fn_refresh_dashboard_stats();

DROP TRIGGER IF EXISTS trg_uds_notifications ON auth.notifications;
CREATE TRIGGER trg_uds_notifications
    AFTER INSERT OR UPDATE OR DELETE ON auth.notifications
    FOR EACH ROW EXECUTE FUNCTION fn_refresh_dashboard_stats();

DROP TRIGGER IF EXISTS trg_uds_sessions ON auth.sessions;
CREATE TRIGGER trg_uds_sessions
    AFTER INSERT OR UPDATE OR DELETE ON auth.sessions
    FOR EACH ROW EXECUTE FUNCTION fn_refresh_dashboard_stats();

-- Initialize stats for all existing users
DO $$
DECLARE
    u RECORD;
BEGIN
    FOR u IN SELECT id FROM auth.users WHERE deleted_at IS NULL LOOP
        PERFORM compute_dashboard_stats(u.id);
    END LOOP;
END $$;

-- 015_dashboard_content_overview.sql
-- Extends cached dashboard stats with content overview counts so the compact
-- dashboard endpoint can report documents, presentations, diagrams, notes,
-- tasks, and a best-effort task-list count.

ALTER TABLE user_dashboard_stats
  ADD COLUMN IF NOT EXISTS total_documents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_presentations INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_diagrams INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_notes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tasks INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_task_lists INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION compute_dashboard_stats(p_user_id UUID)
RETURNS void AS $$
BEGIN
    INSERT INTO user_dashboard_stats (
        user_id,
        owned_workspaces, member_workspaces, total_workspaces,
        total_projects, active_projects, completed_projects, paused_projects, archived_projects,
        total_documents, total_presentations, total_diagrams, total_notes, total_tasks, total_task_lists,
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
        (SELECT COUNT(*)::int FROM workspaces WHERE owner_uid = p_user_id::text AND deleted_at IS NULL),
        (SELECT COUNT(DISTINCT w.id)::int
         FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id
         WHERE m.user_uid = p_user_id::text
           AND m.deleted_at IS NULL
           AND w.deleted_at IS NULL
           AND w.owner_uid != p_user_id::text),
        0,
        (SELECT COUNT(*)::int
         FROM workspace_projects wp
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM workspace_projects wp
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wp.status = 'active' AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM workspace_projects wp
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wp.status = 'completed' AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM workspace_projects wp
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wp.status = 'paused' AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM workspace_projects wp
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wp.status = 'archived' AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM project_documents d
         JOIN workspace_projects wp ON wp.id = d.project_id
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND d.deleted_at IS NULL AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM project_slides s
         JOIN workspace_projects wp ON wp.id = s.project_id
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND s.deleted_at IS NULL AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM project_diagrams d
         JOIN workspace_projects wp ON wp.id = d.project_id
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND d.deleted_at IS NULL AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM project_notes n
         JOIN workspace_projects wp ON wp.id = n.project_id
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND n.deleted_at IS NULL AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM project_tasks t
         JOIN workspace_projects wp ON wp.id = t.project_id
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text AND t.deleted_at IS NULL AND wp.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM project_tasks t
         JOIN workspace_projects wp ON wp.id = t.project_id
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = p_user_id::text
           AND t.deleted_at IS NULL
           AND wp.deleted_at IS NULL
           AND w.deleted_at IS NULL
           AND t.document_id IS NULL
           AND t.slide_id IS NULL
           AND t.note_id IS NULL),
        (SELECT COUNT(*)::int
         FROM workspace_collections wc
         JOIN workspaces w ON w.id = wc.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wc.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM workspace_collections wc
         JOIN workspaces w ON w.id = wc.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wc.collection_type = 'folder' AND wc.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM workspace_collections wc
         JOIN workspaces w ON w.id = wc.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wc.collection_type = 'tag' AND wc.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM workspace_collections wc
         JOIN workspaces w ON w.id = wc.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wc.collection_type = 'smart' AND wc.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM workspace_analysis wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wa.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM workspace_analysis wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wa.status = 'pending' AND wa.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM workspace_analysis wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wa.status = 'processing' AND wa.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM workspace_analysis wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wa.status = 'completed' AND wa.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM workspace_analysis wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = p_user_id::text AND wa.status = 'failed' AND wa.deleted_at IS NULL AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int
         FROM workspace_activity wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = p_user_id::text AND w.deleted_at IS NULL),
        (SELECT MAX(wa.created_at)
         FROM workspace_activity wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = p_user_id::text AND w.deleted_at IS NULL),
        (SELECT COUNT(*)::int FROM auth.sessions WHERE user_id = p_user_id),
        (SELECT COUNT(*)::int FROM auth.sessions WHERE user_id = p_user_id AND is_revoked = FALSE AND expires_at > NOW()),
        (SELECT COUNT(*)::int FROM auth.notifications WHERE user_id = p_user_id AND is_read = FALSE AND is_archived = FALSE),
        (SELECT COUNT(*)::int FROM auth.notifications WHERE user_id = p_user_id AND is_archived = FALSE),
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
        total_documents = EXCLUDED.total_documents,
        total_presentations = EXCLUDED.total_presentations,
        total_diagrams = EXCLUDED.total_diagrams,
        total_notes = EXCLUDED.total_notes,
        total_tasks = EXCLUDED.total_tasks,
        total_task_lists = EXCLUDED.total_task_lists,
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

CREATE OR REPLACE FUNCTION fn_refresh_dashboard_stats()
RETURNS TRIGGER AS $$
DECLARE
    v_user_id UUID;
BEGIN
    IF TG_TABLE_NAME = 'workspaces' THEN
        v_user_id := (SELECT id FROM auth.users WHERE id::text = COALESCE(NEW.owner_uid, OLD.owner_uid));
    ELSIF TG_TABLE_NAME = 'workspace_members' THEN
        v_user_id := (SELECT id FROM auth.users WHERE id::text = COALESCE(NEW.user_uid, OLD.user_uid));
    ELSIF TG_TABLE_NAME IN ('workspace_projects', 'workspace_collections', 'workspace_analysis', 'workspace_activity') THEN
        SELECT w.owner_uid::uuid INTO v_user_id
        FROM workspaces w
        WHERE w.id = COALESCE(NEW.workspace_id, OLD.workspace_id);
    ELSIF TG_TABLE_NAME IN ('project_documents', 'project_slides', 'project_notes', 'project_tasks', 'project_diagrams') THEN
        SELECT w.owner_uid::uuid INTO v_user_id
        FROM workspace_projects wp
        JOIN workspaces w ON w.id = wp.workspace_id
        WHERE wp.id = COALESCE(NEW.project_id, OLD.project_id);
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

DROP TRIGGER IF EXISTS trg_uds_project_documents ON project_documents;
CREATE TRIGGER trg_uds_project_documents
    AFTER INSERT OR UPDATE OR DELETE ON project_documents
    FOR EACH ROW EXECUTE FUNCTION fn_refresh_dashboard_stats();

DROP TRIGGER IF EXISTS trg_uds_project_slides ON project_slides;
CREATE TRIGGER trg_uds_project_slides
    AFTER INSERT OR UPDATE OR DELETE ON project_slides
    FOR EACH ROW EXECUTE FUNCTION fn_refresh_dashboard_stats();

DROP TRIGGER IF EXISTS trg_uds_project_notes ON project_notes;
CREATE TRIGGER trg_uds_project_notes
    AFTER INSERT OR UPDATE OR DELETE ON project_notes
    FOR EACH ROW EXECUTE FUNCTION fn_refresh_dashboard_stats();

DROP TRIGGER IF EXISTS trg_uds_project_tasks ON project_tasks;
CREATE TRIGGER trg_uds_project_tasks
    AFTER INSERT OR UPDATE OR DELETE ON project_tasks
    FOR EACH ROW EXECUTE FUNCTION fn_refresh_dashboard_stats();

DROP TRIGGER IF EXISTS trg_uds_project_diagrams ON project_diagrams;
CREATE TRIGGER trg_uds_project_diagrams
    AFTER INSERT OR UPDATE OR DELETE ON project_diagrams
    FOR EACH ROW EXECUTE FUNCTION fn_refresh_dashboard_stats();

DO $$
DECLARE
    u RECORD;
BEGIN
    FOR u IN SELECT id FROM auth.users WHERE deleted_at IS NULL LOOP
        PERFORM compute_dashboard_stats(u.id);
    END LOOP;
END $$;

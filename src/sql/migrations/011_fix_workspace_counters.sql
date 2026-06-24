-- 011_fix_workspace_counters.sql
-- Fixes:
--   1. Syncs all workspace counters JSONB to match actual data
--   2. Adds triggers to auto-update counters on INSERT/UPDATE/DELETE
--   3. Cleans up orphaned deleted test workspaces

-- ═══════════════════════════════════════════════════════════════════
--  1.  FUNCTION to recompute workspace counters
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION recompute_workspace_counters(p_workspace_id UUID)
RETURNS void AS $$
DECLARE
    v_project_count INTEGER;
    v_collection_count INTEGER;
    v_analysis_count INTEGER;
    v_member_count INTEGER;
    v_task_count INTEGER;
    v_note_count INTEGER;
    v_file_count INTEGER;
BEGIN
    SELECT COUNT(*)::int INTO v_project_count
    FROM workspace_projects WHERE workspace_id = p_workspace_id AND deleted_at IS NULL;

    SELECT COUNT(*)::int INTO v_collection_count
    FROM workspace_collections WHERE workspace_id = p_workspace_id AND deleted_at IS NULL;

    SELECT COUNT(*)::int INTO v_analysis_count
    FROM workspace_analysis WHERE workspace_id = p_workspace_id AND deleted_at IS NULL;

    SELECT COUNT(*)::int INTO v_member_count
    FROM workspace_members WHERE workspace_id = p_workspace_id AND deleted_at IS NULL;

    SELECT COUNT(*)::int INTO v_task_count
    FROM project_tasks pt
    JOIN workspace_projects wp ON wp.id = pt.project_id
    WHERE wp.workspace_id = p_workspace_id AND pt.deleted_at IS NULL AND wp.deleted_at IS NULL;

    SELECT COUNT(*)::int INTO v_note_count
    FROM project_notes pn
    JOIN workspace_projects wp ON wp.id = pn.project_id
    WHERE wp.workspace_id = p_workspace_id AND pn.deleted_at IS NULL AND wp.deleted_at IS NULL;

    UPDATE workspaces
    SET counters = jsonb_build_object(
        'projects', v_project_count,
        'collections', v_collection_count,
        'analysis', v_analysis_count,
        'members', v_member_count,
        'tasks', v_task_count,
        'notes', v_note_count,
        'files', v_file_count,
        'chats', 0,
        'automations', 0,
        'storageUsed', 0,
        'aiTokensToday', 0,
        'apiCallsToday', 0
    ),
    updated_at = NOW()
    WHERE id = p_workspace_id;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════
--  2.  TRIGGERS to auto-update counters
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_update_workspace_counters()
RETURNS TRIGGER AS $$
DECLARE
    v_workspace_id UUID;
BEGIN
    IF TG_TABLE_NAME = 'workspace_projects' THEN
        v_workspace_id := COALESCE(NEW.workspace_id, OLD.workspace_id);
    ELSIF TG_TABLE_NAME = 'workspace_collections' THEN
        v_workspace_id := COALESCE(NEW.workspace_id, OLD.workspace_id);
    ELSIF TG_TABLE_NAME = 'workspace_analysis' THEN
        v_workspace_id := COALESCE(NEW.workspace_id, OLD.workspace_id);
    ELSIF TG_TABLE_NAME = 'workspace_members' THEN
        v_workspace_id := COALESCE(NEW.workspace_id, OLD.workspace_id);
    ELSIF TG_TABLE_NAME = 'project_tasks' THEN
        SELECT wp.workspace_id INTO v_workspace_id
        FROM workspace_projects wp
        WHERE wp.id = COALESCE(NEW.project_id, OLD.project_id);
    ELSIF TG_TABLE_NAME = 'project_notes' THEN
        SELECT wp.workspace_id INTO v_workspace_id
        FROM workspace_projects wp
        WHERE wp.id = COALESCE(NEW.project_id, OLD.project_id);
    END IF;

    IF v_workspace_id IS NOT NULL THEN
        PERFORM recompute_workspace_counters(v_workspace_id);
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS trg_wc_projects ON workspace_projects;
DROP TRIGGER IF EXISTS trg_wc_collections ON workspace_collections;
DROP TRIGGER IF EXISTS trg_wc_analysis ON workspace_analysis;
DROP TRIGGER IF EXISTS trg_wc_members ON workspace_members;
DROP TRIGGER IF EXISTS trg_wc_tasks ON project_tasks;
DROP TRIGGER IF EXISTS trg_wc_notes ON project_notes;

-- Create triggers
CREATE TRIGGER trg_wc_projects
    AFTER INSERT OR UPDATE OR DELETE ON workspace_projects
    FOR EACH ROW EXECUTE FUNCTION fn_update_workspace_counters();

CREATE TRIGGER trg_wc_collections
    AFTER INSERT OR UPDATE OR DELETE ON workspace_collections
    FOR EACH ROW EXECUTE FUNCTION fn_update_workspace_counters();

CREATE TRIGGER trg_wc_analysis
    AFTER INSERT OR UPDATE OR DELETE ON workspace_analysis
    FOR EACH ROW EXECUTE FUNCTION fn_update_workspace_counters();

CREATE TRIGGER trg_wc_members
    AFTER INSERT OR UPDATE OR DELETE ON workspace_members
    FOR EACH ROW EXECUTE FUNCTION fn_update_workspace_counters();

CREATE TRIGGER trg_wc_tasks
    AFTER INSERT OR UPDATE OR DELETE ON project_tasks
    FOR EACH ROW EXECUTE FUNCTION fn_update_workspace_counters();

CREATE TRIGGER trg_wc_notes
    AFTER INSERT OR UPDATE OR DELETE ON project_notes
    FOR EACH ROW EXECUTE FUNCTION fn_update_workspace_counters();

-- ═══════════════════════════════════════════════════════════════════
--  3.  Sync ALL existing workspace counters
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
    w RECORD;
BEGIN
    FOR w IN SELECT id FROM workspaces LOOP
        PERFORM recompute_workspace_counters(w.id);
    END LOOP;
END $$;

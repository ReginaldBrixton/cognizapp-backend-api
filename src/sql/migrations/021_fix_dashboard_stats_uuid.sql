-- 021_fix_dashboard_stats_uuid.sql
-- Fix PostgresError: operator does not exist: text = uuid
-- We need to safely cast owner_uid and user_uid (TEXT) to UUID before comparing with id (UUID).
-- In earlier migrations, we used: id::text = NEW.owner_uid
-- But we'll cast the UUID to TEXT using id::text = NEW.owner_uid
-- Wait, the error is text = uuid.
-- So we need to ensure anywhere we compare text and uuid, we explicitly cast the uuid to text.

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
        -- Safely cast the TEXT owner_uid to UUID, but it might fail if it's not a valid UUID.
        -- We should just get it as TEXT and then query the users table, or cast properly.
        -- Since users.id is UUID, let's select w.owner_uid::uuid. This was the cause of the issue if owner_uid wasn't valid UUID, but we enforced owner_uid is valid UUID in migration 012.
        -- The error "text = uuid" implies somewhere we did: text_column = uuid_variable or vice versa without casting.
        
        -- The previous code in 016 was:
        -- SELECT w.owner_uid::uuid INTO v_user_id FROM workspaces w ...
        -- If w.owner_uid is a valid UUID text, this cast works.
        -- But what if the error is coming from another place?
        
        -- Let's look at migration 016 line 208:
        -- v_user_id := (SELECT id FROM auth.users WHERE id::text = COALESCE(NEW.owner_uid, OLD.owner_uid));
        -- If NEW.owner_uid is somehow a UUID type? No, owner_uid is TEXT in workspaces table.
        -- Let's use explicit casting: WHERE id = (COALESCE(NEW.owner_uid, OLD.owner_uid))::uuid
        -- Or WHERE id::text = (COALESCE(NEW.owner_uid, OLD.owner_uid))::text
        
        v_user_id := (SELECT id FROM auth.users WHERE id::text = COALESCE(NEW.owner_uid, OLD.owner_uid)::text);
    ELSIF TG_TABLE_NAME IN ('project_documents', 'project_slides', 'project_notes', 'project_tasks', 'project_diagrams', 'project_task_lists') THEN
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

-- Also update validate_workspace_ownership just in case
CREATE OR REPLACE FUNCTION validate_workspace_ownership()
RETURNS TRIGGER AS $$
DECLARE
    v_owner_exists BOOLEAN;
BEGIN
    v_owner_exists := EXISTS(
        SELECT 1 FROM auth.users
        WHERE id::text = NEW.owner_uid::text
          AND status = 'active'
          AND deleted_at IS NULL
    );

    IF NOT v_owner_exists THEN
        RAISE EXCEPTION 'Workspace owner_uid % does not match an active user', NEW.owner_uid;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS public;
SET search_path TO app, auth, public;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS auth.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_at TIMESTAMPTZ,
    role TEXT NOT NULL DEFAULT 'REGULAR_USER',
    status TEXT NOT NULL DEFAULT 'active',
    banned_until TIMESTAMPTZ,
    is_anonymous BOOLEAN NOT NULL DEFAULT FALSE,
    is_sso_user BOOLEAN NOT NULL DEFAULT FALSE,
    display_name TEXT,
    full_name TEXT,
    avatar_url TEXT,
    raw_app_meta_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw_user_meta_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    providers TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    provider TEXT,
    provider_uid TEXT,
    identity_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_sign_in_at TIMESTAMPTZ,
    login_count INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_provider_uid ON auth.users(provider, provider_uid);

CREATE TABLE IF NOT EXISTS auth.sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    refresh_token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    refresh_expires_at TIMESTAMPTZ,
    ip_address TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    device_fingerprint TEXT,
    device_name TEXT,
    device_type TEXT,
    browser TEXT,
    os TEXT,
    country TEXT,
    city TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at TIMESTAMPTZ,
    revoked_reason TEXT,
    reuse_detected_at TIMESTAMPTZ,
    user_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON auth.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON auth.sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token_hash ON auth.sessions(refresh_token_hash);

CREATE TABLE IF NOT EXISTS auth.activity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    activity_type TEXT NOT NULL,
    description TEXT NOT NULL,
    session_id UUID,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_uid TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    color TEXT,
    icon TEXT,
    avatar_url TEXT,
    cover_url TEXT,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    limits JSONB NOT NULL DEFAULT '{}'::jsonb,
    counters JSONB NOT NULL DEFAULT '{"members":0,"projects":0,"collections":0,"automations":0,"chats":0,"files":0,"tasks":0,"notes":0,"storageUsed":0,"apiCallsToday":0,"aiTokensToday":0}'::jsonb,
    last_opened_at TIMESTAMPTZ,
    last_activity_at TIMESTAMPTZ,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    is_public BOOLEAN NOT NULL DEFAULT FALSE,
    share_link TEXT,
    share_token TEXT,
    share_expires_at TIMESTAMPTZ,
    view_count INTEGER NOT NULL DEFAULT 0,
    total_time_spent INTEGER NOT NULL DEFAULT 0,
    active_days INTEGER NOT NULL DEFAULT 0,
    cloned_from UUID,
    backup_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    pinned_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_uid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_default_owner ON workspaces(owner_uid, is_default) WHERE is_default = TRUE AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_uid TEXT NOT NULL,
    email TEXT,
    display_name TEXT,
    avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'member',
    permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
    invited_by TEXT,
    invited_at TIMESTAMPTZ,
    invite_token TEXT,
    invite_status TEXT NOT NULL DEFAULT 'pending',
    joined_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'active',
    activity_count INTEGER NOT NULL DEFAULT 0,
    last_activity_at TIMESTAMPTZ,
    removed_at TIMESTAMPTZ,
    removal_reason TEXT,
    preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_unique_active ON workspace_members(workspace_id, user_uid) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_uid TEXT NOT NULL,
    user_email TEXT,
    user_name TEXT,
    activity_type TEXT NOT NULL,
    description TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address TEXT,
    user_agent TEXT,
    device_type TEXT,
    related_entity_type TEXT,
    related_entity_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    invited_by TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    token_expires_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    accepted_by TEXT,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    full_name TEXT,
    avatar_url TEXT,
    schema_version INTEGER NOT NULL DEFAULT 1,
    feature_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
    account JSONB NOT NULL DEFAULT '{}'::jsonb,
    profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    appearance JSONB NOT NULL DEFAULT '{}'::jsonb,
    notifications JSONB NOT NULL DEFAULT '{}'::jsonb,
    security JSONB NOT NULL DEFAULT '{}'::jsonb,
    onboarding JSONB NOT NULL DEFAULT '{}'::jsonb,
    privacy JSONB NOT NULL DEFAULT '{}'::jsonb,
    storage JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS workspace_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL,
    general JSONB NOT NULL DEFAULT '{}'::jsonb,
    access JSONB NOT NULL DEFAULT '{}'::jsonb,
    ai JSONB NOT NULL DEFAULT '{}'::jsonb,
    integrations JSONB NOT NULL DEFAULT '{}'::jsonb,
    limits JSONB NOT NULL DEFAULT '{}'::jsonb,
    notifications JSONB NOT NULL DEFAULT '{}'::jsonb,
    security JSONB NOT NULL DEFAULT '{}'::jsonb,
    storage JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

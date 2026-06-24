-- 022_research_support_desk.sql
-- Database-backed research support desk. Client-owned records use user_key_id
-- so the authenticated user ID remains the stable lookup key.

CREATE TABLE IF NOT EXISTS support_clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_key_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    full_name TEXT NOT NULL DEFAULT '',
    whatsapp_number TEXT NOT NULL DEFAULT '',
    institution TEXT NOT NULL DEFAULT '',
    level TEXT NOT NULL DEFAULT '',
    referral_code TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id TEXT NOT NULL UNIQUE,
    user_key_id TEXT NOT NULL,
    client_id UUID REFERENCES support_clients(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    service_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    subject TEXT,
    academic_level TEXT,
    output_expectation TEXT,
    institution TEXT,
    whatsapp_number TEXT,
    supervisor_comments TEXT,
    referral_code TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    priority TEXT NOT NULL DEFAULT 'medium',
    deadline_at TIMESTAMPTZ,
    timezone TEXT NOT NULL DEFAULT 'Atlantic/Reykjavik',
    budget_min NUMERIC(12, 2),
    budget_max NUMERIC(12, 2),
    currency TEXT NOT NULL DEFAULT 'GHS',
    word_count INTEGER,
    pages INTEGER,
    attachment_metadata JSONB NOT NULL DEFAULT '[]'::jsonb,
    integrity_ack BOOLEAN NOT NULL DEFAULT FALSE,
    contact_consent BOOLEAN NOT NULL DEFAULT FALSE,
    submitted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID REFERENCES support_requests(id) ON DELETE CASCADE,
    order_id UUID,
    user_key_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_type TEXT NOT NULL DEFAULT 'document',
    file_size BIGINT NOT NULL DEFAULT 0,
    content_base64 TEXT,
    purpose TEXT NOT NULL DEFAULT 'client_upload',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE support_files
    ADD COLUMN IF NOT EXISTS content_base64 TEXT;

CREATE TABLE IF NOT EXISTS support_message_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID REFERENCES support_requests(id) ON DELETE SET NULL,
    order_id UUID,
    user_key_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'general',
    last_message_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES support_message_threads(id) ON DELETE CASCADE,
    sender_key_id TEXT NOT NULL,
    sender_name TEXT NOT NULL DEFAULT '',
    sender_role TEXT NOT NULL DEFAULT 'client',
    content TEXT NOT NULL,
    attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
    read_by TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_quotes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
    provider_key_id TEXT NOT NULL,
    quote_type TEXT NOT NULL DEFAULT 'fixed',
    line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
    deliverables TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    turnaround_hours INTEGER NOT NULL DEFAULT 24,
    revision_policy JSONB NOT NULL DEFAULT '{"included":1,"additionalCost":0,"maxRevisions":1,"revisionWindow":48}'::jsonb,
    terms TEXT NOT NULL DEFAULT '',
    total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'GHS',
    status TEXT NOT NULL DEFAULT 'draft',
    valid_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
    quote_id UUID REFERENCES support_quotes(id) ON DELETE SET NULL,
    client_key_id TEXT NOT NULL,
    provider_key_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payment_status TEXT NOT NULL DEFAULT 'pending',
    amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'GHS',
    due_date TIMESTAMPTZ,
    max_revisions INTEGER NOT NULL DEFAULT 1,
    revision_count INTEGER NOT NULL DEFAULT 0,
    scope JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_code TEXT NOT NULL,
    referred_user_key_id TEXT NOT NULL,
    request_id UUID REFERENCES support_requests(id) ON DELETE SET NULL,
    reward_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    reward_status TEXT NOT NULL DEFAULT 'pending',
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_requests_user_key ON support_requests(user_key_id);
CREATE INDEX IF NOT EXISTS idx_support_requests_status ON support_requests(status);
CREATE INDEX IF NOT EXISTS idx_support_threads_user_key ON support_message_threads(user_key_id);
CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON support_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_support_referrals_code ON support_referrals(referrer_code);

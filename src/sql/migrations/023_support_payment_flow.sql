-- 023_support_payment_flow.sql
-- Database-backed support payment proof, verification, and draft metadata.

ALTER TABLE support_requests
    ADD COLUMN IF NOT EXISTS payment_transaction_id TEXT,
    ADD COLUMN IF NOT EXISTS payment_proof_file_id UUID REFERENCES support_files(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS payment_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid',
    ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'not_started',
    ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'before_work',
    ADD COLUMN IF NOT EXISTS quoted_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS deposit_percent INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS balance_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS admin_notes TEXT,
    ADD COLUMN IF NOT EXISTS user_notes TEXT,
    ADD COLUMN IF NOT EXISTS ai_review JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS scope_locked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS payment_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS payment_verified_by TEXT,
    ADD COLUMN IF NOT EXISTS payment_notes TEXT,
    ADD COLUMN IF NOT EXISTS draft_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS draft_step INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'support_requests_payment_status_check'
          AND conrelid = 'support_requests'::regclass
    ) THEN
        ALTER TABLE support_requests
            ADD CONSTRAINT support_requests_payment_status_check
            CHECK (
                payment_status IN (
                    'unpaid',
                    'pending',
                    'paid',
                    'failed',
                    'refunded',
                    'deposit_required',
                    'deposit_pending_verification',
                    'deposit_paid',
                    'final_payment_required',
                    'final_payment_pending_verification'
                )
            );
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'support_requests_payment_status_check'
          AND conrelid = 'support_requests'::regclass
    ) THEN
        ALTER TABLE support_requests DROP CONSTRAINT support_requests_payment_status_check;
        ALTER TABLE support_requests
            ADD CONSTRAINT support_requests_payment_status_check
            CHECK (
                payment_status IN (
                    'unpaid',
                    'pending',
                    'paid',
                    'failed',
                    'refunded',
                    'deposit_required',
                    'deposit_pending_verification',
                    'deposit_paid',
                    'final_payment_required',
                    'final_payment_pending_verification'
                )
            );
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS support_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
    user_key_id TEXT NOT NULL,
    payment_type TEXT NOT NULL DEFAULT 'full_payment',
    amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'GHS',
    transaction_id TEXT,
    proof_file_id UUID REFERENCES support_files(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'submitted',
    verified_by TEXT,
    verified_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
    uploaded_by_admin_id TEXT NOT NULL,
    file_id UUID NOT NULL REFERENCES support_files(id) ON DELETE CASCADE,
    delivery_note TEXT NOT NULL DEFAULT '',
    is_locked BOOLEAN NOT NULL DEFAULT TRUE,
    unlocked_at TIMESTAMPTZ,
    downloaded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
    user_key_id TEXT NOT NULL,
    revision_message TEXT NOT NULL,
    revision_scope_status TEXT NOT NULL DEFAULT 'admin_review_required',
    admin_response TEXT,
    status TEXT NOT NULL DEFAULT 'submitted',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID REFERENCES support_requests(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    actor_role TEXT NOT NULL DEFAULT 'client',
    event_type TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_requests_payment_status
    ON support_requests(payment_status);

CREATE INDEX IF NOT EXISTS idx_support_files_request_purpose
    ON support_files(request_id, purpose);

CREATE INDEX IF NOT EXISTS idx_support_payments_request
    ON support_payments(request_id, status);

CREATE INDEX IF NOT EXISTS idx_support_deliveries_request
    ON support_deliveries(request_id, created_at);

CREATE INDEX IF NOT EXISTS idx_support_revisions_request
    ON support_revisions(request_id, created_at);

CREATE INDEX IF NOT EXISTS idx_support_events_request
    ON support_events(request_id, created_at);

-- 040_support_security_performance_rewards.sql
-- Support hardening: provider-safe visibility, partial/final delivery rules,
-- referral reward tracking, payout preferences, and hot-path indexes.

ALTER TABLE support_clients
    ADD COLUMN IF NOT EXISTS payout_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE support_deliveries
    ADD COLUMN IF NOT EXISTS delivery_type TEXT NOT NULL DEFAULT 'final',
    ADD COLUMN IF NOT EXISTS preview_allowed BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'support_deliveries_delivery_type_check'
          AND conrelid = 'support_deliveries'::regclass
    ) THEN
        ALTER TABLE support_deliveries
            ADD CONSTRAINT support_deliveries_delivery_type_check
            CHECK (delivery_type IN ('preview', 'partial', 'final'));
    END IF;
END $$;

ALTER TABLE support_referrals
    ADD COLUMN IF NOT EXISTS source_user_key_id TEXT,
    ADD COLUMN IF NOT EXISTS referred_client_id UUID REFERENCES support_clients(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reward_percent NUMERIC(5, 2) NOT NULL DEFAULT 10.00,
    ADD COLUMN IF NOT EXISTS reward_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'GHS',
    ADD COLUMN IF NOT EXISTS reward_status TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS payout_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS last_payment_id UUID REFERENCES support_payments(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS last_rewarded_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'support_referrals_reward_status_check'
          AND conrelid = 'support_referrals'::regclass
    ) THEN
        ALTER TABLE support_referrals
            ADD CONSTRAINT support_referrals_reward_status_check
            CHECK (reward_status IN ('pending', 'earned', 'partially_paid', 'paid', 'cancelled'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS support_referral_reward_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referral_id UUID NOT NULL REFERENCES support_referrals(id) ON DELETE CASCADE,
    request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
    payment_id UUID NOT NULL REFERENCES support_payments(id) ON DELETE CASCADE,
    referrer_user_key_id TEXT NOT NULL,
    referred_user_key_id TEXT NOT NULL,
    payment_amount NUMERIC(12, 2) NOT NULL,
    reward_percent NUMERIC(5, 2) NOT NULL DEFAULT 10.00,
    reward_amount NUMERIC(12, 2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'GHS',
    status TEXT NOT NULL DEFAULT 'earned',
    payout_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ,
    paid_by TEXT,
    payout_reference TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'support_referral_reward_events_status_check'
          AND conrelid = 'support_referral_reward_events'::regclass
    ) THEN
        ALTER TABLE support_referral_reward_events
            ADD CONSTRAINT support_referral_reward_events_status_check
            CHECK (status IN ('earned', 'approved', 'paid', 'cancelled'));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_referral_reward_events_payment
    ON support_referral_reward_events(payment_id);

CREATE INDEX IF NOT EXISTS idx_support_referral_reward_events_referrer
    ON support_referral_reward_events(referrer_user_key_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_referrals_request
    ON support_referrals(request_id);

CREATE INDEX IF NOT EXISTS idx_support_referrals_referrer_status
    ON support_referrals(source_user_key_id, reward_status);

CREATE INDEX IF NOT EXISTS idx_support_deliveries_request_type
    ON support_deliveries(request_id, delivery_type, is_locked, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_requests_user_status_updated
    ON support_requests(user_key_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_requests_provider_queue
    ON support_requests(status, payment_status, deadline_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_payments_user_status_created
    ON support_payments(user_key_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_message_threads_request_updated
    ON support_message_threads(request_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
    ON auth.sessions(user_id, expires_at)
    WHERE is_revoked = FALSE;

CREATE INDEX IF NOT EXISTS idx_auth_users_status_role
    ON auth.users(status, role);

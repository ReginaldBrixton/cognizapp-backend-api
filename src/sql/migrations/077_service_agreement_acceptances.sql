-- 077_service_agreement_acceptances.sql
-- Track user acceptance of service agreements and refund policies before payment.
-- Required for Ghana Electronic Transactions Act 2008 (Act 772) compliance:
--   - 7-day cooling-off period disclosure
--   - Clickwrap agreement audit trail
--   - Per-service refund policy acceptance tracking

CREATE TABLE IF NOT EXISTS service_agreement_acceptances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_key_id TEXT NOT NULL,
    service_type TEXT NOT NULL,
    service_id TEXT,
    policy_version TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'GHS',
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    agreement_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for looking up a user's acceptances
CREATE INDEX IF NOT EXISTS idx_service_agreement_acceptances_user
    ON service_agreement_acceptances(user_key_id, service_type, created_at DESC);

-- Index for checking if a specific service has an accepted agreement
CREATE INDEX IF NOT EXISTS idx_service_agreement_acceptances_service
    ON service_agreement_acceptances(user_key_id, service_type, service_id)
    WHERE service_id IS NOT NULL;

COMMENT ON TABLE service_agreement_acceptances IS
    'Audit trail of user clickwrap agreement acceptances before payment. Each row records which policy version the user accepted, for which service, and the amount at the time of acceptance.';

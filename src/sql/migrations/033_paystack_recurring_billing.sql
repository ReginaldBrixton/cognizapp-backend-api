-- 033_paystack_recurring_billing.sql
-- Adds Paystack recurring subscription fields and webhook idempotency storage.

ALTER TABLE subscription_plans
    ADD COLUMN IF NOT EXISTS paystack_monthly_plan_code TEXT,
    ADD COLUMN IF NOT EXISTS paystack_yearly_plan_code TEXT;

ALTER TABLE workspace_subscriptions
    ADD COLUMN IF NOT EXISTS paystack_email_token TEXT,
    ADD COLUMN IF NOT EXISTS next_payment_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS grace_period_ends_at TIMESTAMPTZ;

ALTER TABLE paystack_transactions
    ADD COLUMN IF NOT EXISTS paystack_subscription_code TEXT,
    ADD COLUMN IF NOT EXISTS paystack_invoice_code TEXT;

CREATE INDEX IF NOT EXISTS idx_paystack_transactions_subscription
    ON paystack_transactions(paystack_subscription_code)
    WHERE paystack_subscription_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS paystack_webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_hash TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    provider_reference TEXT,
    paystack_subscription_code TEXT,
    paystack_invoice_code TEXT,
    payload JSONB NOT NULL,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paystack_webhook_events_reference
    ON paystack_webhook_events(provider_reference)
    WHERE provider_reference IS NOT NULL;

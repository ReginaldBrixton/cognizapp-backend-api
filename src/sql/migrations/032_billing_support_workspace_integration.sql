-- 032_billing_support_workspace_integration.sql
-- Normalized workspace subscriptions, Paystack transaction tracking, usage ledger,
-- and support request linkage to workspace projects/collections.

CREATE TABLE IF NOT EXISTS subscription_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    monthly_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
    yearly_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'GHS',
    analysis_limit_monthly INTEGER NOT NULL DEFAULT 0,
    workspace_limit INTEGER NOT NULL DEFAULT 1,
    storage_quota_bytes BIGINT NOT NULL DEFAULT 1073741824,
    support_discount_percent INTEGER NOT NULL DEFAULT 0,
    monthly_support_credit NUMERIC(12, 2) NOT NULL DEFAULT 0,
    priority_level INTEGER NOT NULL DEFAULT 0,
    paystack_monthly_plan_code TEXT,
    paystack_yearly_plan_code TEXT,
    features JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO subscription_plans (
    id, name, description, monthly_price, yearly_price, currency,
    analysis_limit_monthly, workspace_limit, storage_quota_bytes,
    support_discount_percent, monthly_support_credit, priority_level,
    features, display_order
) VALUES
    (
        'free', 'Free', 'AI entry point for casual users testing CognizApp.',
        0, 0, 'GHS', 10, 1, 1073741824, 0, 0, 0,
        '{"aiChat":true,"basicAnalysis":true,"basicProjectOrganization":true,"documents":false,"slides":false,"spreadsheets":false,"supportRequests":true,"automations":false,"collaboration":false,"advancedAnalysis":false}'::jsonb,
        0
    ),
    (
        'scholar_pro', 'Scholar Pro', 'Academic workspace for students, thesis work, and research projects.',
        99, 999, 'GHS', 250, 5, 53687091200, 10, 0, 1,
        '{"aiChat":true,"basicAnalysis":true,"advancedAnalysis":true,"projects":true,"collections":true,"documents":true,"slides":true,"spreadsheets":true,"notes":true,"tasks":true,"supportRequests":true,"fileUploads":true,"automations":"basic","collaboration":false}'::jsonb,
        1
    ),
    (
        'research_max', 'Research Max', 'Premium academic operating system with priority support and credits.',
        249, 2490, 'GHS', 1000, 20, 214748364800, 20, 100, 2,
        '{"aiChat":true,"basicAnalysis":true,"advancedAnalysis":true,"projects":true,"collections":true,"documents":true,"slides":true,"spreadsheets":true,"notes":true,"tasks":true,"supportRequests":true,"fileUploads":true,"automations":"advanced","collaboration":true,"premiumExports":true,"earlyAccess":true,"prioritySupport":true}'::jsonb,
        2
    )
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    monthly_price = EXCLUDED.monthly_price,
    yearly_price = EXCLUDED.yearly_price,
    currency = EXCLUDED.currency,
    analysis_limit_monthly = EXCLUDED.analysis_limit_monthly,
    workspace_limit = EXCLUDED.workspace_limit,
    storage_quota_bytes = EXCLUDED.storage_quota_bytes,
    support_discount_percent = EXCLUDED.support_discount_percent,
    monthly_support_credit = EXCLUDED.monthly_support_credit,
    priority_level = EXCLUDED.priority_level,
    features = EXCLUDED.features,
    display_order = EXCLUDED.display_order,
    updated_at = NOW();

CREATE TABLE IF NOT EXISTS workspace_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_uid TEXT NOT NULL,
    plan_id TEXT NOT NULL REFERENCES subscription_plans(id),
    status TEXT NOT NULL DEFAULT 'active',
    billing_cycle TEXT NOT NULL DEFAULT 'monthly',
    currency TEXT NOT NULL DEFAULT 'GHS',
    current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    paystack_customer_code TEXT,
    paystack_subscription_code TEXT,
    paystack_email_token TEXT,
    next_payment_at TIMESTAMPTZ,
    grace_period_ends_at TIMESTAMPTZ,
    last_payment_reference TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspace_subscriptions_status_check'
          AND conrelid = 'workspace_subscriptions'::regclass
    ) THEN
        ALTER TABLE workspace_subscriptions
            ADD CONSTRAINT workspace_subscriptions_status_check
            CHECK (status IN ('active', 'pending', 'past_due', 'cancelled', 'expired'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspace_subscriptions_cycle_check'
          AND conrelid = 'workspace_subscriptions'::regclass
    ) THEN
        ALTER TABLE workspace_subscriptions
            ADD CONSTRAINT workspace_subscriptions_cycle_check
            CHECK (billing_cycle IN ('monthly', 'yearly'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_owner
    ON workspace_subscriptions(owner_uid);

CREATE TABLE IF NOT EXISTS workspace_usage_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_key_id TEXT NOT NULL,
    usage_type TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    source_table TEXT,
    source_id UUID,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_usage_period
    ON workspace_usage_ledger(workspace_id, usage_type, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_workspace_usage_source
    ON workspace_usage_ledger(source_table, source_id)
    WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS paystack_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
    support_request_id UUID REFERENCES support_requests(id) ON DELETE SET NULL,
    support_payment_id UUID REFERENCES support_payments(id) ON DELETE SET NULL,
    user_key_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    plan_id TEXT REFERENCES subscription_plans(id),
    billing_cycle TEXT,
    amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'GHS',
    provider TEXT NOT NULL DEFAULT 'paystack',
    provider_reference TEXT NOT NULL,
    provider_transaction_id TEXT,
    paystack_subscription_code TEXT,
    paystack_invoice_code TEXT,
    authorization_code TEXT,
    channel TEXT,
    gateway_response TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    verified_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_reference)
);

CREATE INDEX IF NOT EXISTS idx_paystack_transactions_workspace
    ON paystack_transactions(workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_paystack_transactions_support_request
    ON paystack_transactions(support_request_id);

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

ALTER TABLE support_requests
    ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES workspace_projects(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS collection_id UUID REFERENCES workspace_collections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_support_requests_workspace
    ON support_requests(workspace_id)
    WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_requests_project
    ON support_requests(project_id)
    WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_requests_collection
    ON support_requests(collection_id)
    WHERE collection_id IS NOT NULL;

ALTER TABLE support_payments
    ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS provider_reference TEXT,
    ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT,
    ADD COLUMN IF NOT EXISTS authorization_code TEXT,
    ADD COLUMN IF NOT EXISTS channel TEXT,
    ADD COLUMN IF NOT EXISTS gateway_response TEXT,
    ADD COLUMN IF NOT EXISTS verified_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE support_payments
SET provider = 'paystack',
    provider_reference = COALESCE(provider_reference, transaction_id)
WHERE status = 'paystack_pending'
  AND provider_reference IS NULL
  AND transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_payments_provider_reference
    ON support_payments(provider, provider_reference)
    WHERE provider_reference IS NOT NULL;

INSERT INTO workspace_subscriptions (
    workspace_id, owner_uid, plan_id, status, billing_cycle, currency,
    current_period_start, current_period_end, metadata
)
SELECT
    w.id,
    w.owner_uid,
    CASE
        WHEN LOWER(COALESCE(w.plan, ws.billing->>'plan', 'free')) IN ('research_max', 'max', 'enterprise') THEN 'research_max'
        WHEN LOWER(COALESCE(w.plan, ws.billing->>'plan', 'free')) IN ('scholar_pro', 'pro', 'scholar') THEN 'scholar_pro'
        ELSE 'free'
    END AS plan_id,
    COALESCE(NULLIF(ws.billing->>'status', ''), 'active') AS status,
    COALESCE(NULLIF(ws.billing->>'billingCycle', ''), 'monthly') AS billing_cycle,
    'GHS',
    NOW(),
    NULL,
    jsonb_build_object('backfilledFrom', 'workspace_settings')
FROM workspaces w
LEFT JOIN workspace_settings ws ON ws.workspace_id = w.id::text AND ws.deleted_at IS NULL
WHERE w.deleted_at IS NULL
ON CONFLICT (workspace_id) DO UPDATE SET
    owner_uid = EXCLUDED.owner_uid,
    plan_id = EXCLUDED.plan_id,
    status = CASE
        WHEN workspace_subscriptions.status = 'pending' THEN workspace_subscriptions.status
        ELSE EXCLUDED.status
    END,
    updated_at = NOW();

UPDATE workspaces w
SET plan = s.plan_id
FROM workspace_subscriptions s
WHERE s.workspace_id = w.id
  AND COALESCE(w.plan, '') <> s.plan_id;

UPDATE workspace_settings ws
SET billing = jsonb_build_object(
        'plan', s.plan_id,
        'status', s.status,
        'billingCycle', s.billing_cycle,
        'trialEndsAt', ws.billing->>'trialEndsAt',
        'subscriptionId', COALESCE(s.paystack_subscription_code, ws.billing->>'subscriptionId'),
        'customerId', COALESCE(s.paystack_customer_code, ws.billing->>'customerId'),
        'billingEmail', ws.billing->>'billingEmail',
        'currency', s.currency,
        'currentPeriodEnd', s.current_period_end,
        'cancelAtPeriodEnd', s.cancel_at_period_end,
        'billingAddress', COALESCE(ws.billing->'billingAddress', '{}'::jsonb)
    ),
    updated_at = NOW()
FROM workspace_subscriptions s
WHERE s.workspace_id::text = ws.workspace_id
  AND ws.deleted_at IS NULL;

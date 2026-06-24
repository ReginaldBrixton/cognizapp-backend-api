-- 028_support_payment_settings.sql
-- Configurable payment methods for support desk (replaces hardcoded values).

CREATE TABLE IF NOT EXISTS support_payment_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL DEFAULT 'mtn_momo',
    account_name TEXT NOT NULL,
    account_number TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'GHS',
    instructions TEXT NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM support_payment_settings LIMIT 1) THEN
        INSERT INTO support_payment_settings (provider, account_name, account_number, currency, instructions, display_order)
        VALUES ('paystack', 'CognizApp Paystack Checkout', 'Hosted Paystack checkout', 'GHS',
                'Use Paystack hosted checkout. Payment confirmation is automatic.', 0);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_support_payment_settings_active
    ON support_payment_settings(is_active, display_order);

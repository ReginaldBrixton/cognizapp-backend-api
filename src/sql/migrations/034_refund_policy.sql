-- 034_refund_policy.sql
-- Comprehensive refund policy system for support requests

-- Create support_refund_requests table
CREATE TABLE IF NOT EXISTS support_refund_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
    payment_id UUID NOT NULL REFERENCES support_payments(id) ON DELETE CASCADE,
    user_key_id TEXT NOT NULL,
    refund_type TEXT NOT NULL DEFAULT 'full',
    requested_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    approved_amount NUMERIC(12, 2),
    reason TEXT NOT NULL,
    reason_category TEXT NOT NULL DEFAULT 'other',
    status TEXT NOT NULL DEFAULT 'pending',
    admin_notes TEXT,
    user_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by TEXT,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add refund_type constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'support_refund_requests_refund_type_check'
          AND conrelid = 'support_refund_requests'::regclass
    ) THEN
        ALTER TABLE support_refund_requests
            ADD CONSTRAINT support_refund_requests_refund_type_check
            CHECK (refund_type IN ('full', 'partial'));
    END IF;
END $$;

-- Add reason_category constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'support_refund_requests_reason_category_check'
          AND conrelid = 'support_refund_requests'::regclass
    ) THEN
        ALTER TABLE support_refund_requests
            ADD CONSTRAINT support_refund_requests_reason_category_check
            CHECK (reason_category IN ('quality_issue', 'scope_mismatch', 'non_delivery', 'cancellation', 'other'));
    END IF;
END $$;

-- Add status constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'support_refund_requests_status_check'
          AND conrelid = 'support_refund_requests'::regclass
    ) THEN
        ALTER TABLE support_refund_requests
            ADD CONSTRAINT support_refund_requests_status_check
            CHECK (status IN ('pending', 'approved', 'rejected', 'processed', 'failed'));
    END IF;
END $$;

-- Add refund_status column to support_payments
ALTER TABLE support_payments
    ADD COLUMN IF NOT EXISTS refund_status TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

-- Add refund_status constraint to support_payments
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'support_payments_refund_status_check'
          AND conrelid = 'support_payments'::regclass
    ) THEN
        ALTER TABLE support_payments
            ADD CONSTRAINT support_payments_refund_status_check
            CHECK (refund_status IN ('none', 'requested', 'approved', 'processing', 'completed', 'failed'));
    END IF;
END $$;

-- Add refund columns to paystack_transactions
ALTER TABLE paystack_transactions
    ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS refund_reference TEXT,
    ADD COLUMN IF NOT EXISTS refund_status TEXT;

-- Create indexes for refund_requests
CREATE INDEX IF NOT EXISTS idx_support_refund_requests_request
    ON support_refund_requests(request_id, status);

CREATE INDEX IF NOT EXISTS idx_support_refund_requests_payment
    ON support_refund_requests(payment_id);

CREATE INDEX IF NOT EXISTS idx_support_refund_requests_user
    ON support_refund_requests(user_key_id, status);

CREATE INDEX IF NOT EXISTS idx_support_refund_requests_status
    ON support_refund_requests(status, requested_at);

CREATE INDEX IF NOT EXISTS idx_support_payments_refund_status
    ON support_payments(refund_status)
    WHERE refund_status != 'none';

CREATE INDEX IF NOT EXISTS idx_paystack_transactions_refund
    ON paystack_transactions(refund_reference)
    WHERE refund_reference IS NOT NULL;

-- Add comment for documentation
COMMENT ON TABLE support_refund_requests IS 'Tracks refund requests for support payments with approval workflow';
COMMENT ON COLUMN support_refund_requests.refund_type IS 'Type of refund: full or partial';
COMMENT ON COLUMN support_refund_requests.reason_category IS 'Category: quality_issue, scope_mismatch, non_delivery, cancellation, other';
COMMENT ON COLUMN support_refund_requests.status IS 'Status: pending, approved, rejected, processed, failed';
COMMENT ON COLUMN support_refund_requests.user_evidence IS 'JSONB array of file references and evidence details';
COMMENT ON COLUMN support_payments.refund_status IS 'Refund status: none, requested, approved, processing, completed, failed';

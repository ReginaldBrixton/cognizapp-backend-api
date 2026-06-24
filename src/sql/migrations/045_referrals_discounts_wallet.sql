-- 045_referrals_discounts_wallet.sql
-- Hybrid referral, discount-code, and wallet foundations built on the existing support schema.

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS referral_code TEXT,
  ADD COLUMN IF NOT EXISTS referred_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payout_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_referral_code
  ON auth.users(referral_code)
  WHERE referral_code IS NOT NULL;

UPDATE auth.users
SET referral_code = 'COGNI-' || upper(substr(replace(id::text, '-', ''), 1, 6))
WHERE referral_code IS NULL;

ALTER TABLE support_clients
  ADD COLUMN IF NOT EXISTS referred_by_user_key_id TEXT,
  ADD COLUMN IF NOT EXISTS referral_link_code TEXT,
  ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_wallet_balance NUMERIC(12, 2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS support_wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key_id TEXT NOT NULL,
  transaction_type TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  status TEXT NOT NULL DEFAULT 'pending',
  referral_id UUID REFERENCES support_referrals(id) ON DELETE SET NULL,
  reward_event_id UUID REFERENCES support_referral_reward_events(id) ON DELETE SET NULL,
  request_id UUID REFERENCES support_requests(id) ON DELETE SET NULL,
  payment_id UUID REFERENCES support_payments(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'support_wallet_transactions_status_check'
      AND conrelid = 'support_wallet_transactions'::regclass
  ) THEN
    ALTER TABLE support_wallet_transactions
      ADD CONSTRAINT support_wallet_transactions_status_check
      CHECK (status IN ('pending', 'approved', 'available', 'withdrawn', 'cancelled', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'support_wallet_transactions_type_check'
      AND conrelid = 'support_wallet_transactions'::regclass
  ) THEN
    ALTER TABLE support_wallet_transactions
      ADD CONSTRAINT support_wallet_transactions_type_check
      CHECK (transaction_type IN ('referral_commission', 'withdrawal', 'refund', 'admin_adjustment', 'discount_credit'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_support_wallet_transactions_user_status
  ON support_wallet_transactions(user_key_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS support_discount_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  discount_percent NUMERIC(5, 2) NOT NULL,
  max_redemptions INTEGER NOT NULL DEFAULT 1,
  redemption_count INTEGER NOT NULL DEFAULT 0,
  minimum_amount NUMERIC(12, 2),
  eligible_service_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status TEXT NOT NULL DEFAULT 'active',
  requires_admin_approval BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'support_discount_codes_percent_check'
      AND conrelid = 'support_discount_codes'::regclass
  ) THEN
    ALTER TABLE support_discount_codes
      ADD CONSTRAINT support_discount_codes_percent_check
      CHECK (discount_percent > 0 AND discount_percent <= 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'support_discount_codes_status_check'
      AND conrelid = 'support_discount_codes'::regclass
  ) THEN
    ALTER TABLE support_discount_codes
      ADD CONSTRAINT support_discount_codes_status_check
      CHECK (status IN ('active', 'redeemed', 'expired', 'disabled', 'cancelled', 'pending_approval'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_support_discount_codes_provider_status
  ON support_discount_codes(provider_key_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS support_discount_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_code_id UUID NOT NULL REFERENCES support_discount_codes(id) ON DELETE CASCADE,
  user_key_id TEXT NOT NULL,
  request_id UUID REFERENCES support_requests(id) ON DELETE SET NULL,
  original_amount NUMERIC(12, 2) NOT NULL,
  discount_percent NUMERIC(5, 2) NOT NULL,
  discount_amount NUMERIC(12, 2) NOT NULL,
  final_amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  status TEXT NOT NULL DEFAULT 'redeemed',
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'support_discount_redemptions_status_check'
      AND conrelid = 'support_discount_redemptions'::regclass
  ) THEN
    ALTER TABLE support_discount_redemptions
      ADD CONSTRAINT support_discount_redemptions_status_check
      CHECK (status IN ('redeemed', 'reversed', 'cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_support_discount_redemptions_code
  ON support_discount_redemptions(discount_code_id, redeemed_at DESC);

ALTER TABLE support_requests
  ADD COLUMN IF NOT EXISTS discount_code_id UUID REFERENCES support_discount_codes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS original_amount NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS final_amount NUMERIC(12, 2);

-- 048_referral_relationship_commissions.sql
-- Direct referral relationships, commission ledger, and payout profile setup.

SET search_path TO app, auth, public;

UPDATE auth.users
SET referral_code = 'COGNI-' || upper(substr(replace(id::text, '-', ''), 1, 6))
WHERE referral_code IS NULL;

CREATE TABLE IF NOT EXISTS referral_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  referred_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  referral_code_used TEXT NOT NULL,
  commission_rate_bps INTEGER NOT NULL DEFAULT 1000,
  commission_model TEXT NOT NULL DEFAULT 'lifetime',
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT referral_relationships_no_self_referral CHECK (referrer_user_id <> referred_user_id),
  CONSTRAINT referral_relationships_rate_check CHECK (commission_rate_bps BETWEEN 0 AND 5000),
  CONSTRAINT referral_relationships_model_check CHECK (commission_model IN ('lifetime', 'first_request_only', 'first_3_requests', '12_months')),
  CONSTRAINT referral_relationships_status_check CHECK (status IN ('active', 'suspended', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_relationships_referred_user
  ON referral_relationships(referred_user_id);

CREATE INDEX IF NOT EXISTS idx_referral_relationships_referrer_status
  ON referral_relationships(referrer_user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS referral_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id UUID NOT NULL REFERENCES referral_relationships(id) ON DELETE RESTRICT,
  referrer_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  referred_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  support_payment_id UUID REFERENCES support_payments(id) ON DELETE SET NULL,
  request_id UUID REFERENCES support_requests(id) ON DELETE SET NULL,
  amount_paid_pesewas BIGINT NOT NULL DEFAULT 0,
  commission_rate_bps INTEGER NOT NULL DEFAULT 1000,
  commission_amount_pesewas BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'GHS',
  status TEXT NOT NULL DEFAULT 'pending',
  available_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  paid_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT referral_commissions_status_check CHECK (status IN ('pending', 'available', 'paid', 'reversed', 'cancelled')),
  CONSTRAINT referral_commissions_amount_check CHECK (amount_paid_pesewas >= 0 AND commission_amount_pesewas >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_commissions_support_payment
  ON referral_commissions(support_payment_id)
  WHERE support_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_referral_commissions_referrer_status
  ON referral_commissions(referrer_user_id, status, available_at DESC);

CREATE TABLE IF NOT EXISTS referral_payout_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payout_type TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number_last4 TEXT,
  bank_code TEXT,
  bank_name TEXT,
  currency TEXT NOT NULL DEFAULT 'GHS',
  paystack_recipient_code TEXT,
  paystack_recipient_id TEXT,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT referral_payout_profiles_type_check CHECK (payout_type IN ('mobile_money', 'ghipss', 'authorization')),
  CONSTRAINT referral_payout_profiles_status_check CHECK (status IN ('active', 'disabled', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_payout_profiles_default
  ON referral_payout_profiles(user_id)
  WHERE is_default = TRUE AND status = 'active';

CREATE TABLE IF NOT EXISTS referral_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  payout_profile_id UUID REFERENCES referral_payout_profiles(id) ON DELETE SET NULL,
  amount_pesewas BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  payout_method TEXT NOT NULL DEFAULT 'paystack_transfer',
  paystack_transfer_code TEXT,
  provider_reference TEXT,
  status TEXT NOT NULL DEFAULT 'requested',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT referral_payouts_amount_check CHECK (amount_pesewas > 0),
  CONSTRAINT referral_payouts_status_check CHECK (status IN ('requested', 'processing', 'paid', 'failed', 'cancelled'))
);

DROP TRIGGER IF EXISTS trg_referral_relationships_updated_at ON referral_relationships;
CREATE TRIGGER trg_referral_relationships_updated_at
BEFORE UPDATE ON referral_relationships
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS trg_referral_commissions_updated_at ON referral_commissions;
CREATE TRIGGER trg_referral_commissions_updated_at
BEFORE UPDATE ON referral_commissions
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS trg_referral_payout_profiles_updated_at ON referral_payout_profiles;
CREATE TRIGGER trg_referral_payout_profiles_updated_at
BEFORE UPDATE ON referral_payout_profiles
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

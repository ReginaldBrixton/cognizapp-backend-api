SET search_path TO app, auth, public;

-- Discount codes are redeemed only after a request is successfully submitted.
-- Older draft-time redemptions are removed, then counters are rebuilt from submitted requests.
DELETE FROM support_discount_redemptions dr
USING support_requests r
WHERE dr.request_id = r.id
  AND r.submitted_at IS NULL;

DELETE FROM support_discount_redemptions
WHERE request_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_discount_redemptions_request_unique
  ON support_discount_redemptions(request_id)
  WHERE status = 'redeemed' AND request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_discount_redemptions_code_request_unique
  ON support_discount_redemptions(discount_code_id, request_id)
  WHERE status = 'redeemed' AND request_id IS NOT NULL;

WITH usage AS (
  SELECT
    dc.id,
    COALESCE(COUNT(dr.id), 0)::int AS used
  FROM support_discount_codes dc
  LEFT JOIN support_discount_redemptions dr
    ON dr.discount_code_id = dc.id
    AND dr.status = 'redeemed'
  LEFT JOIN support_requests r
    ON r.id = dr.request_id
    AND r.submitted_at IS NOT NULL
  GROUP BY dc.id
)
UPDATE support_discount_codes dc
SET redemption_count = usage.used,
  status = CASE
    WHEN dc.status IN ('disabled', 'cancelled', 'pending_approval', 'expired') THEN dc.status
    WHEN usage.used >= dc.max_redemptions THEN 'redeemed'
    ELSE 'active'
  END,
  updated_at = NOW()
FROM usage
WHERE usage.id = dc.id;

-- 004_repair_settings_json.sql
-- Repair JSONB sections that were accidentally corrupted into arrays by
-- binding db.json(...) through postgres.js unsafe() parameters.

CREATE OR REPLACE FUNCTION repair_jsonb_object(value JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN value IS NULL THEN '{}'::jsonb
    WHEN jsonb_typeof(value) = 'object' THEN value
    WHEN jsonb_typeof(value) = 'array' THEN COALESCE((
      SELECT jsonb_object_agg(key, item_value ORDER BY ord)
      FROM jsonb_array_elements(value) WITH ORDINALITY AS arr(item, ord)
      CROSS JOIN LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(item) = 'object' THEN item
          ELSE '{}'::jsonb
        END
      ) AS entry(key, item_value)
    ), '{}'::jsonb)
    ELSE '{}'::jsonb
  END
$$;

UPDATE user_settings
SET
  account = repair_jsonb_object(account),
  profile = repair_jsonb_object(profile),
  appearance = repair_jsonb_object(appearance),
  notifications = repair_jsonb_object(notifications),
  preferences = repair_jsonb_object(preferences),
  security = repair_jsonb_object(security),
  onboarding = repair_jsonb_object(onboarding),
  privacy = repair_jsonb_object(privacy),
  storage = repair_jsonb_object(storage),
  ai = repair_jsonb_object(ai),
  updated_at = NOW()
WHERE
  jsonb_typeof(account) = 'array'
  OR jsonb_typeof(profile) = 'array'
  OR jsonb_typeof(appearance) = 'array'
  OR jsonb_typeof(notifications) = 'array'
  OR jsonb_typeof(preferences) = 'array'
  OR jsonb_typeof(security) = 'array'
  OR jsonb_typeof(onboarding) = 'array'
  OR jsonb_typeof(privacy) = 'array'
  OR jsonb_typeof(storage) = 'array'
  OR jsonb_typeof(ai) = 'array';

UPDATE workspace_settings
SET
  general = repair_jsonb_object(general),
  access = repair_jsonb_object(access),
  ai = repair_jsonb_object(ai),
  integrations = repair_jsonb_object(integrations),
  limits = repair_jsonb_object(limits),
  notifications = repair_jsonb_object(notifications),
  security = repair_jsonb_object(security),
  storage = repair_jsonb_object(storage),
  appearance = repair_jsonb_object(appearance),
  features = repair_jsonb_object(features),
  billing = repair_jsonb_object(billing),
  updated_at = NOW()
WHERE
  jsonb_typeof(general) = 'array'
  OR jsonb_typeof(access) = 'array'
  OR jsonb_typeof(ai) = 'array'
  OR jsonb_typeof(integrations) = 'array'
  OR jsonb_typeof(limits) = 'array'
  OR jsonb_typeof(notifications) = 'array'
  OR jsonb_typeof(security) = 'array'
  OR jsonb_typeof(storage) = 'array'
  OR jsonb_typeof(appearance) = 'array'
  OR jsonb_typeof(features) = 'array'
  OR jsonb_typeof(billing) = 'array';

DROP FUNCTION IF EXISTS repair_jsonb_object(JSONB);

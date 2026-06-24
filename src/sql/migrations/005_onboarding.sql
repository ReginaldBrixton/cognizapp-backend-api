-- 005_onboarding.sql
-- User onboarding table: collects research-platform-relevant profile data
-- from first-time users (DOB, institution, role, research interests, etc.)

CREATE TABLE IF NOT EXISTS user_onboarding (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      TEXT        NOT NULL UNIQUE,
    email        TEXT        NOT NULL,

    -- Personal info
    date_of_birth          DATE,
    gender                 TEXT,        -- 'male' | 'female' | 'non_binary' | 'prefer_not_to_say' | 'other'
    country                TEXT,
    city                   TEXT,

    -- Academic / professional profile
    user_type              TEXT,        -- 'student' | 'researcher' | 'faculty' | 'professional' | 'other'
    institution            TEXT,
    department             TEXT,
    position_title         TEXT,        -- e.g. "PhD Candidate", "Associate Professor", "Data Analyst"
    field_of_study         TEXT,        -- e.g. "Computer Science", "Public Health"
    research_interests     TEXT[]  NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- e.g. ['machine learning', 'climate change', 'genomics']

    -- Platform usage intent
    primary_use_case       TEXT,        -- 'academic_writing' | 'research_papers' | 'collaborative_projects' | 'personal_notes' | 'other'
    experience_level       TEXT,        -- 'beginner' | 'intermediate' | 'advanced' | 'expert'
    how_did_you_hear       TEXT,        -- 'google' | 'social_media' | 'colleague' | 'institution' | 'other'

    -- Consent flags
    consent_analytics      BOOLEAN NOT NULL DEFAULT FALSE,
    consent_ai_training    BOOLEAN NOT NULL DEFAULT FALSE,
    consent_marketing      BOOLEAN NOT NULL DEFAULT FALSE,

    -- Progress tracking (which steps have been completed)
    steps_completed JSONB   NOT NULL DEFAULT '{
        "personal_info": false,
        "academic_profile": false,
        "research_interests": false,
        "platform_preferences": false,
        "consent": false
    }'::jsonb,

    is_completed   BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at   TIMESTAMPTZ,
    skipped_at     TIMESTAMPTZ,

    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_onboarding_user_id ON user_onboarding(user_id);
CREATE INDEX IF NOT EXISTS idx_user_onboarding_completed ON user_onboarding(is_completed);

-- Backfill onboarding rows for all existing users that don't have one yet
INSERT INTO user_onboarding (user_id, email)
SELECT u.id::text, u.email
FROM auth.users u
WHERE NOT EXISTS (
    SELECT 1 FROM user_onboarding o WHERE o.user_id = u.id::text
)
ON CONFLICT (user_id) DO NOTHING;

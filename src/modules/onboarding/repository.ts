import { getDb } from "../../lib/db";

export type OnboardingRecord = {
  id: string;
  userId: string;
  email: string;
  dateOfBirth: string | null;
  gender: string | null;
  country: string | null;
  city: string | null;
  userType: string | null;
  institution: string | null;
  department: string | null;
  positionTitle: string | null;
  fieldOfStudy: string | null;
  researchInterests: string[];
  primaryUseCase: string | null;
  experienceLevel: string | null;
  howDidYouHear: string | null;
  consentAnalytics: boolean;
  consentAiTraining: boolean;
  consentMarketing: boolean;
  stepsCompleted: Record<string, boolean>;
  isCompleted: boolean;
  completedAt: string | null;
  skippedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function mapRow(row: Record<string, unknown>): OnboardingRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    email: String(row.email),
    dateOfBirth: row.date_of_birth ? String(row.date_of_birth) : null,
    gender: row.gender ? String(row.gender) : null,
    country: row.country ? String(row.country) : null,
    city: row.city ? String(row.city) : null,
    userType: row.user_type ? String(row.user_type) : null,
    institution: row.institution ? String(row.institution) : null,
    department: row.department ? String(row.department) : null,
    positionTitle: row.position_title ? String(row.position_title) : null,
    fieldOfStudy: row.field_of_study ? String(row.field_of_study) : null,
    researchInterests: Array.isArray(row.research_interests) ? (row.research_interests as string[]) : [],
    primaryUseCase: row.primary_use_case ? String(row.primary_use_case) : null,
    experienceLevel: row.experience_level ? String(row.experience_level) : null,
    howDidYouHear: row.how_did_you_hear ? String(row.how_did_you_hear) : null,
    consentAnalytics: Boolean(row.consent_analytics),
    consentAiTraining: Boolean(row.consent_ai_training),
    consentMarketing: Boolean(row.consent_marketing),
    stepsCompleted: (row.steps_completed as Record<string, boolean>) ?? {},
    isCompleted: Boolean(row.is_completed),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    skippedAt: row.skipped_at ? String(row.skipped_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export const onboardingRepository = {
  async getByUserId(userId: string): Promise<OnboardingRecord | null> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM user_onboarding WHERE user_id = ${userId}
    `;
    return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
  },

  async upsert(userId: string, email: string): Promise<OnboardingRecord> {
    const db = getDb();
    const rows = await db`
      INSERT INTO user_onboarding (user_id, email)
      VALUES (${userId}, ${email})
      ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
      RETURNING *
    `;
    return mapRow(rows[0] as Record<string, unknown>);
  },

  async update(userId: string, fields: Partial<{
    dateOfBirth: string | null;
    gender: string | null;
    country: string | null;
    city: string | null;
    userType: string | null;
    institution: string | null;
    department: string | null;
    positionTitle: string | null;
    fieldOfStudy: string | null;
    researchInterests: string[];
    primaryUseCase: string | null;
    experienceLevel: string | null;
    howDidYouHear: string | null;
    consentAnalytics: boolean;
    consentAiTraining: boolean;
    consentMarketing: boolean;
    stepsCompleted: Record<string, boolean>;
  }>): Promise<OnboardingRecord | null> {
    const db = getDb();

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const fieldMap: Record<string, string> = {
      dateOfBirth: "date_of_birth",
      gender: "gender",
      country: "country",
      city: "city",
      userType: "user_type",
      institution: "institution",
      department: "department",
      positionTitle: "position_title",
      fieldOfStudy: "field_of_study",
      researchInterests: "research_interests",
      primaryUseCase: "primary_use_case",
      experienceLevel: "experience_level",
      howDidYouHear: "how_did_you_hear",
      consentAnalytics: "consent_analytics",
      consentAiTraining: "consent_ai_training",
      consentMarketing: "consent_marketing",
      stepsCompleted: "steps_completed",
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      const val = fields[key as keyof typeof fields];
      if (val === undefined) {
        continue;
      }

      if (col === "research_interests" && Array.isArray(val)) {
        setClauses.push(`${col} = $${idx++}::text[]`);
        values.push(val);
      } else if (col === "steps_completed") {
        setClauses.push(`${col} = $${idx++}::jsonb`);
        values.push(db.json((val ?? {}) as any));
      } else {
        setClauses.push(`${col} = $${idx++}`);
        values.push(val ?? null);
      }
    }

    if (setClauses.length === 0) return this.getByUserId(userId);

    setClauses.push(`updated_at = NOW()`);

    const setStr = setClauses.join(", ");
    const rows = await db.unsafe(
      `UPDATE user_onboarding SET ${setStr} WHERE user_id = $${idx} RETURNING *`,
      [...values, userId] as any[],
    );
    return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
  },

  async markCompleted(userId: string): Promise<OnboardingRecord | null> {
    const db = getDb();
    const rows = await db`
      UPDATE user_onboarding
      SET is_completed = TRUE,
          completed_at = NOW(),
          skipped_at   = NULL,
          updated_at   = NOW()
      WHERE user_id = ${userId}
      RETURNING *
    `;
    return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
  },

  async markSkipped(userId: string): Promise<OnboardingRecord | null> {
    const db = getDb();
    const rows = await db`
      UPDATE user_onboarding
      SET skipped_at  = NOW(),
          is_completed = FALSE,
          updated_at   = NOW()
      WHERE user_id = ${userId}
      RETURNING *
    `;
    return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
  },
};

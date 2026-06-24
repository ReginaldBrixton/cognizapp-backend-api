import { getDb } from "../../lib/db";
import type { UserSettings, UserSection } from "./types";
import { ALLOWED_USER_SECTIONS } from "./types";

const ALLOWED_SECTIONS = ["account", "profile", "appearance", "notifications", "preferences", "security", "onboarding", "privacy", "storage", "ai", "institution"] as const;

type Section = (typeof ALLOWED_SECTIONS)[number];

function assertSection(section: string): asserts section is Section {
  if (!(ALLOWED_SECTIONS as readonly string[]).includes(section)) {
    throw new Error(`Unknown user settings section: ${section}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSectionValue(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return value.reduce<Record<string, unknown>>((acc, item) => {
      if (typeof item === "string") {
        try {
          const parsed = JSON.parse(item);
          if (isRecord(parsed)) {
            Object.assign(acc, parsed);
          }
        } catch {
          // Ignore malformed legacy fragments.
        }
        return acc;
      }

      if (isRecord(item)) {
        Object.assign(acc, item);
      }
      return acc;
    }, {});
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return isRecord(value) ? value : {};
}

function pickFirstDefined<T>(...values: T[]): T | undefined {
  return values.find((value) => value !== undefined);
}

function omitKeys(
  record: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const next = { ...record };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function canonicalizeSection(
  section: Section,
  value: unknown,
): Record<string, unknown> {
  const normalized = normalizeSectionValue(value);

  switch (section) {
    case "profile": {
      const rest = omitKeys(normalized, [
        "full_name",
        "fullName",
        "avatar_url",
        "avatarUrl",
        "account_type",
        "accountType",
        "display_name",
        "displayName",
        "job_title",
        "jobTitle",
        "phone_number",
        "phoneNumber",
        "academic_institution",
        "academicInstitution",
        "research_interests",
        "researchInterests",
        "google_scholar_id",
        "googleScholarId",
        "linked_in",
        "linkedIn",
        "profile_completion",
        "profileCompletion",
      ]);

      return {
        ...rest,
        full_name: pickFirstDefined(normalized.full_name, normalized.fullName),
        avatar_url: pickFirstDefined(normalized.avatar_url, normalized.avatarUrl),
        socialLinks: normalizeSectionValue(normalized.socialLinks),
        account_type: pickFirstDefined(
          normalized.account_type,
          normalized.accountType,
        ),
        display_name: pickFirstDefined(
          normalized.display_name,
          normalized.displayName,
        ),
        bio: normalized.bio,
        company: normalized.company,
        job_title: pickFirstDefined(normalized.job_title, normalized.jobTitle),
        location: normalized.location,
        website: normalized.website,
        phone_number: pickFirstDefined(
          normalized.phone_number,
          normalized.phoneNumber,
        ),
        timezone: normalized.timezone,
        locale: normalized.locale,
        academic_institution: pickFirstDefined(
          normalized.academic_institution,
          normalized.academicInstitution,
        ),
        role: normalized.role,
        research_interests: pickFirstDefined(
          normalized.research_interests,
          normalized.researchInterests,
        ),
        orcid: normalized.orcid,
        google_scholar_id: pickFirstDefined(
          normalized.google_scholar_id,
          normalized.googleScholarId,
        ),
        linked_in: pickFirstDefined(normalized.linked_in, normalized.linkedIn),
        profile_completion: pickFirstDefined(
          normalized.profile_completion,
          normalized.profileCompletion,
        ),
      };
    }
    case "privacy": {
      const rest = omitKeys(normalized, [
        "profileVisibility",
        "profile_visibility",
        "activityStatus",
        "activity_status",
        "readReceipts",
        "read_receipts",
        "analyticsOptIn",
        "analytics_opt_in",
        "dataExportRequested",
        "data_export_requested",
        "dataRetentionDays",
        "data_retention_days",
      ]);

      return {
        ...rest,
        profileVisibility: pickFirstDefined(
          normalized.profileVisibility,
          normalized.profile_visibility,
        ),
        activityStatus: pickFirstDefined(
          normalized.activityStatus,
          normalized.activity_status,
        ),
        readReceipts: pickFirstDefined(
          normalized.readReceipts,
          normalized.read_receipts,
        ),
        analyticsOptIn: pickFirstDefined(
          normalized.analyticsOptIn,
          normalized.analytics_opt_in,
        ),
        dataExportRequested: pickFirstDefined(
          normalized.dataExportRequested,
          normalized.data_export_requested,
        ),
        dataRetentionDays: pickFirstDefined(
          normalized.dataRetentionDays,
          normalized.data_retention_days,
        ),
      };
    }
    case "notifications": {
      const email = normalizeSectionValue(normalized.email);
      const inApp = normalizeSectionValue(normalized.inApp);
      const push = normalizeSectionValue(normalized.push);

      return {
        emailEnabled: pickFirstDefined(
          normalized.emailEnabled,
          normalized.email_enabled,
          email.enabled,
          true,
        ),
        textEnabled: pickFirstDefined(
          normalized.textEnabled,
          normalized.text_enabled,
          normalized.smsEnabled,
          normalized.sms_enabled,
          false,
        ),
        pushEnabled: pickFirstDefined(
          normalized.pushEnabled,
          normalized.push_enabled,
          push.enabled,
          false,
        ),
        inAppEnabled: pickFirstDefined(
          normalized.inAppEnabled,
          normalized.in_app_enabled,
          inApp.enabled,
          true,
        ),
        desktopEnabled: pickFirstDefined(
          normalized.desktopEnabled,
          normalized.desktop_enabled,
          inApp.desktop,
          false,
        ),
        soundEnabled: pickFirstDefined(
          normalized.soundEnabled,
          normalized.sound_enabled,
          inApp.sound,
          true,
        ),
        digestFrequency: pickFirstDefined(
          normalized.digestFrequency,
          normalized.digest_frequency,
          email.digest,
          "weekly",
        ),
        mentionNotify: pickFirstDefined(
          normalized.mentionNotify,
          normalized.mention_notify,
          inApp.mentions,
          true,
        ),
        taskAssignNotify: pickFirstDefined(
          normalized.taskAssignNotify,
          normalized.task_assign_notify,
          true,
        ),
        projectUpdateNotify: pickFirstDefined(
          normalized.projectUpdateNotify,
          normalized.project_update_notify,
          true,
        ),
        marketingNotify: pickFirstDefined(
          normalized.marketingNotify,
          normalized.marketing_notify,
          email.marketing,
          false,
        ),
        researchUpdates: pickFirstDefined(
          normalized.researchUpdates,
          normalized.research_updates,
          email.productUpdates,
          true,
        ),
        collaborationInvites: pickFirstDefined(
          normalized.collaborationInvites,
          normalized.collaboration_invites,
          true,
        ),
        systemAlerts: pickFirstDefined(
          normalized.systemAlerts,
          normalized.system_alerts,
          email.securityAlerts,
          true,
        ),
      };
    }
    case "ai": {
      const rest = omitKeys(normalized, [
        "defaultModel",
        "default_model",
        "model",
        "preferredModels",
        "preferred_models",
        "autoComplete",
        "auto_complete",
        "autoSuggestions",
        "auto_suggestions",
        "suggestionsEnabled",
        "suggestions_enabled",
        "historyRetention",
        "history_retention",
        "privacyMode",
        "privacy_mode",
        "enabled",
      ]);

      return {
        ...rest,
        enabled: pickFirstDefined(normalized.enabled, true),
        defaultModel: pickFirstDefined(
          normalized.defaultModel,
          normalized.default_model,
          normalized.model,
          "gemini-3.1-flash-lite",
        ),
        preferredModels: pickFirstDefined(
          normalized.preferredModels,
          normalized.preferred_models,
          ["gemini-3.1-flash-lite"],
        ),
        autoComplete: pickFirstDefined(
          normalized.autoComplete,
          normalized.auto_complete,
          true,
        ),
        suggestionsEnabled: pickFirstDefined(
          normalized.suggestionsEnabled,
          normalized.suggestions_enabled,
          normalized.autoSuggestions,
          normalized.auto_suggestions,
          true,
        ),
        historyRetention: pickFirstDefined(
          normalized.historyRetention,
          normalized.history_retention,
          30,
        ),
        privacyMode: pickFirstDefined(
          normalized.privacyMode,
          normalized.privacy_mode,
          false,
        ),
      };
    }
    case "institution": {
      const rest = omitKeys(normalized, [
        "google_scholar_id",
        "googleScholarId",
        "research_gate_id",
        "researchGateId",
        "research_interests",
        "researchInterests",
        "affiliation_verified",
        "affiliationVerified",
      ]);

      return {
        ...rest,
        name: normalized.name,
        type: normalized.type,
        department: normalized.department,
        position: normalized.position,
        country: normalized.country,
        city: normalized.city,
        website: normalized.website,
        orcid: normalized.orcid,
        google_scholar_id: pickFirstDefined(
          normalized.googleScholarId,
          normalized.google_scholar_id,
        ),
        research_gate_id: pickFirstDefined(
          normalized.researchGateId,
          normalized.research_gate_id,
        ),
        research_interests: pickFirstDefined(
          normalized.researchInterests,
          normalized.research_interests,
          [],
        ),
        affiliation_verified: pickFirstDefined(
          normalized.affiliationVerified,
          normalized.affiliation_verified,
          false,
        ),
      };
    }
    default:
      return normalized;
  }
}

function normalizeRow(row: Record<string, unknown>): UserSettings {
  const normalized = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
  for (const section of ALLOWED_SECTIONS) {
    normalized[section] = canonicalizeSection(section, normalized[section]);
  }
  return normalized as UserSettings;
}

export const settingsRepository = {
  async getUserSettings(userId: string): Promise<UserSettings | null> {
    const db = getDb();
    const rows = await db`SELECT * FROM user_settings WHERE user_id = ${userId} LIMIT 1`;
    if (rows[0]) return normalizeRow(rows[0] as Record<string, unknown>);

    // Auto-create a default settings row if none exists
    const inserted = await db`
      INSERT INTO user_settings (user_id)
      VALUES (${userId})
      ON CONFLICT (user_id) DO NOTHING
      RETURNING *
    `;
    if (inserted[0]) return normalizeRow(inserted[0] as Record<string, unknown>);

    // Another request may have inserted concurrently; fetch it
    const retry = await db`SELECT * FROM user_settings WHERE user_id = ${userId} LIMIT 1`;
    return retry[0] ? normalizeRow(retry[0] as Record<string, unknown>) : null;
  },

  async updateUserSettings(userId: string, section: string, data: Record<string, unknown>): Promise<UserSettings | null> {
    assertSection(section);
    const db = getDb();
    const patchValue = canonicalizeSection(section, data);
    const rows = await db`
      UPDATE user_settings
      SET ${db(section)} = COALESCE(${db(section)}, '{}'::jsonb) || ${db.json(patchValue as any)}::jsonb,
          updated_at = NOW()
      WHERE user_id = ${userId}
      RETURNING *
    `;
    if (rows[0]) return normalizeRow(rows[0] as Record<string, unknown>);

    // No row existed — create one then retry the update
    await db`
      INSERT INTO user_settings (user_id)
      VALUES (${userId})
      ON CONFLICT (user_id) DO NOTHING
    `;
    const retry = await db`
      UPDATE user_settings
      SET ${db(section)} = COALESCE(${db(section)}, '{}'::jsonb) || ${db.json(patchValue as any)}::jsonb,
          updated_at = NOW()
      WHERE user_id = ${userId}
      RETURNING *
    `;
    return retry[0] ? normalizeRow(retry[0] as Record<string, unknown>) : null;
  },

  async replaceUserSettingsSection(userId: string, section: string, data: Record<string, unknown>): Promise<UserSettings | null> {
    assertSection(section);
    const db = getDb();
    const rows = await db`
      UPDATE user_settings
      SET ${db(section)} = ${db.json(canonicalizeSection(section, data) as any)},
          updated_at = NOW()
      WHERE user_id = ${userId}
      RETURNING *
    `;
    if (rows[0]) return normalizeRow(rows[0] as Record<string, unknown>);

    await db`
      INSERT INTO user_settings (user_id)
      VALUES (${userId})
      ON CONFLICT (user_id) DO NOTHING
    `;
    const retry = await db`
      UPDATE user_settings
      SET ${db(section)} = ${db.json(canonicalizeSection(section, data) as any)},
          updated_at = NOW()
      WHERE user_id = ${userId}
      RETURNING *
    `;
    return retry[0] ? normalizeRow(retry[0] as Record<string, unknown>) : null;
  },
};

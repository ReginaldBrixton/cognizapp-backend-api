import type { JSONValue } from "postgres";

import { getDb } from "../../lib/db";
import { randomToken } from "../../lib/crypto";
import type {
  WorkspaceConfig,
  Workspace,
  WorkspaceActivity,
  WorkspaceCounters,
  WorkspaceRole,
  WorkspaceInvitation,
  WorkspaceLimits,
  WorkspaceMember,
} from "./types";

function toJsonValue(value: unknown): JSONValue {
  return value as JSONValue;
}

function parseWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: String(row.id),
    ownerUid: String(row.owner_uid),
    name: String(row.name),
    slug: String(row.slug),
    description: String(row.description ?? ""),
    plan: String(row.plan ?? "free"),
    status: String(row.status),
    isDefault: Boolean(row.is_default),
    color: row.color ? String(row.color) : null,
    icon: row.icon ? String(row.icon) : null,
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
    coverUrl: row.cover_url ? String(row.cover_url) : null,
    settings: (row.settings as WorkspaceConfig | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    limits: (row.limits as WorkspaceLimits | null) ?? null,
    counters: (row.counters as WorkspaceCounters) ?? {
      projects: 0,
      collections: 0,
      automations: 0,
      chats: 0,
      members: 0,
      files: 0,
      tasks: 0,
      notes: 0,
      storageUsed: 0,
      apiCallsToday: 0,
      aiTokensToday: 0,
    },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    displayOrder: Number(row.display_order ?? 0),
  };
}

function parseMember(row: Record<string, unknown>): WorkspaceMember {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    userUid: String(row.user_uid),
    email: row.email ? String(row.email) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
    role: String(row.role) as WorkspaceRole,
    invitedBy: row.invited_by ? String(row.invited_by) : null,
    invitedAt: row.invited_at ? String(row.invited_at) : null,
    inviteToken: row.invite_token ? String(row.invite_token) : null,
    inviteStatus: row.invite_status ? String(row.invite_status) : null,
    joinedAt: row.joined_at ? String(row.joined_at) : null,
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
    status: String(row.status ?? "active"),
    activityCount: Number(row.activity_count ?? 0),
    lastActivityAt: row.last_activity_at ? String(row.last_activity_at) : null,
    preferences: (row.preferences as Record<string, unknown> | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  };
}

const workspaceColumns = [
  "id",
  "owner_uid",
  "name",
  "slug",
  "description",
  "plan",
  "status",
  "is_default",
  "color",
  "icon",
  "avatar_url",
  "cover_url",
  "settings",
  "metadata",
  "limits",
  "counters",
  "display_order",
  "created_at",
  "updated_at",
  "deleted_at",
];

const workspaceListColumns = [
  "id",
  "owner_uid",
  "name",
  "slug",
  "description",
  "plan",
  "status",
  "is_default",
  "color",
  "icon",
  "avatar_url",
  "cover_url",
  "display_order",
  "created_at",
  "updated_at",
  "deleted_at",
];

const workspaceListAliasColumns = `
  w.id, w.owner_uid, w.name, w.slug, w.description, w.plan, w.status,
  w.is_default, w.color, w.icon, w.avatar_url, w.cover_url,
  w.display_order, w.created_at, w.updated_at, w.deleted_at
`;

const memberColumns = [
  "id",
  "workspace_id",
  "user_uid",
  "email",
  "display_name",
  "avatar_url",
  "role",
  "invited_by",
  "invited_at",
  "invite_token",
  "invite_status",
  "joined_at",
  "last_seen_at",
  "status",
  "activity_count",
  "last_activity_at",
  "preferences",
  "created_at",
  "updated_at",
  "deleted_at",
];

const memberAliasColumns = `
  m.id AS member_id,
  m.workspace_id AS member_workspace_id,
  m.user_uid AS member_user_uid,
  m.email AS member_email,
  m.display_name AS member_display_name,
  m.avatar_url AS member_avatar_url,
  m.role AS member_role,
  m.invited_by AS member_invited_by,
  m.invited_at AS member_invited_at,
  m.invite_token AS member_invite_token,
  m.invite_status AS member_invite_status,
  m.joined_at AS member_joined_at,
  m.last_seen_at AS member_last_seen_at,
  m.status AS member_status,
  m.activity_count AS member_activity_count,
  m.last_activity_at AS member_last_activity_at,
  m.preferences AS member_preferences,
  m.created_at AS member_created_at,
  m.updated_at AS member_updated_at,
  m.deleted_at AS member_deleted_at
`;

const activityColumns = [
  "id",
  "workspace_id",
  "user_uid",
  "activity_type",
  "description",
  "metadata",
  "created_at",
];

const invitationColumns = [
  "id",
  "workspace_id",
  "invited_by",
  "email",
  "role",
  "token",
  "token_expires_at",
  "status",
  "accepted_by",
  "accepted_at",
  "created_at",
  "updated_at",
];

function parsePrefixedMember(row: Record<string, unknown>) {
  const member = Object.fromEntries(
    memberColumns.map((column) => [column, row[`member_${column}`]]),
  );
  return parseMember(member);
}

async function withWorkspaceQueryTiming<T>(
  name: string,
  context: Record<string, unknown>,
  query: () => Promise<T>,
) {
  const startedAt = Date.now();
  let result: T | undefined;
  try {
    result = await query();
    return result;
  } finally {
    const durationMs = Date.now() - startedAt;
    const rowCount = Array.isArray(result) ? result.length : undefined;
    if (durationMs > 200) {
      console.warn("[workspace:db] slow query", {
        query: name,
        durationMs,
        rowCount,
        ...context,
      });
    }
  }
}

function parseActivity(row: Record<string, unknown>): WorkspaceActivity {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    userUid: String(row.user_uid),
    type: String(row.activity_type),
    description: String(row.description),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: String(row.created_at),
  };
}

function parseInvitation(row: Record<string, unknown>): WorkspaceInvitation {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    invitedBy: String(row.invited_by),
    email: String(row.email),
    role: String(row.role) as WorkspaceRole,
    token: String(row.token),
    tokenExpiresAt: String(row.token_expires_at),
    status: String(row.status),
    acceptedBy: row.accepted_by ? String(row.accepted_by) : null,
    acceptedAt: row.accepted_at ? String(row.accepted_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export const workspaceRepository = {
  defaultSettings(): WorkspaceConfig {
    return {
      defaultProjectVisibility: "private",
      allowMemberInvites: true,
      requireApproval: false,
      notificationsEnabled: true,
      notificationChannels: { email: true, inApp: true, push: false },
      emailDigest: { enabled: true, frequency: "weekly", time: "09:00" },
      theme: "system",
      language: "en",
      dateFormat: "YYYY-MM-DD",
      timeZone: "UTC",
      enabledFeatures: ["ai_assistant", "automation"],
      aiSettings: {
        defaultModel: "gemini-3.1-flash-lite",
        allowedModels: ["gemini-3.1-flash-lite"],
        maxTokensPerDay: 10000,
        enableCodeExecution: false,
        enableWebSearch: true,
      },
      security: {
        twoFactorRequired: false,
        sessionTimeout: 60,
        dataRetentionDays: 90,
        requirePasswordChange: false,
        passwordChangeInterval: 90,
      },
      driveFolderId: "",
      driveFolderPath: "",
    };
  },

  defaultLimits(): WorkspaceLimits {
    return {
      maxMembers: 5,
      maxProjects: 10,
      maxStorage: 1073741824,
      maxApiCallsPerDay: 1000,
      maxAiTokensPerDay: 10000,
    };
  },

  defaultCounters(): WorkspaceCounters {
    return {
      projects: 0,
      collections: 0,
      automations: 0,
      chats: 0,
      members: 0,
      files: 0,
      tasks: 0,
      notes: 0,
      storageUsed: 0,
      apiCallsToday: 0,
      aiTokensToday: 0,
    };
  },

  async ensureUserSettings(
    userId: string,
    email: string,
    displayName: string,
    avatarUrl = "",
  ) {
    const db = getDb();
    const account = db.json({
      locale: "en",
      timezone: "UTC",
      email_verified: false,
      phone_verified: false,
      status: "active",
    });
    const profile = db.json({
      full_name: displayName,
      display_name: displayName,
      avatar_url: avatarUrl,
      account_type: "personal",
    });
    const appearance = db.json({
      theme: "system",
      color_scheme: "default",
      accent_color: "#6366f1",
      font_size: "medium",
      font_family: "system",
      density: "comfortable",
      layout: "default",
      sidebar_collapsed: false,
      reduce_motion: false,
    });
    const notifications = db.json({
      email_enabled: true,
      push_enabled: true,
      in_app_enabled: true,
      desktop_enabled: false,
      sound_enabled: true,
      digest_frequency: "daily",
      mention_notify: true,
      task_assign_notify: true,
      project_update_notify: true,
      marketing_notify: false,
      research_updates: true,
      collaboration_invites: true,
      system_alerts: true,
      dnd_enabled: false,
      quiet_hours: {
        enabled: false,
        start: "22:00",
        end: "08:00",
        timezone: "UTC",
      },
      digest_time: "09:00",
      sound_volume: 80,
    });
    const preferences = db.json({
      default_landing: "workspace",
      keyboard_shortcuts: true,
      auto_save: true,
      show_welcome_tips: true,
      date_format: "MM/DD/YYYY",
      time_format: "12h",
      first_day_of_week: 0,
      units: "metric",
      recent_items_limit: 10,
      open_last_workspace_on_login: true,
    });
    const security = db.json({
      two_factor_enabled: false,
      session_timeout_minutes: 10080,
      login_notifications: true,
      recovery_codes_generated: false,
    });
    const onboarding = db.json({
      completed: false,
      steps_done: [],
      current_step: null,
    });
    const privacy = db.json({
      telemetry_enabled: true,
      crash_reports_enabled: true,
      ai_training_opt_out: false,
      data_retention_days: 90,
    });
    const storage = db.json({
      tier: "free",
      quota_bytes: 5368709120,
      used_bytes: 0,
    });
    const ai = db.json({
      model: "gemini-3.1-flash-lite",
      temperature: 0.7,
      stream_responses: true,
      auto_suggestions: true,
      allow_external_web: true,
      data_retention_days: 30,
      allow_model_training: false,
      citation_required: true,
    });

    await db`
      INSERT INTO user_settings (
        user_id, email, full_name, avatar_url, schema_version,
        account, profile, appearance, notifications, preferences,
        security, onboarding, privacy, storage, ai
      ) VALUES (
        ${userId}, ${email}, ${displayName}, ${avatarUrl}, 1,
        ${account}, ${profile}, ${appearance}, ${notifications}, ${preferences},
        ${security}, ${onboarding}, ${privacy}, ${storage}, ${ai}
      )
      ON CONFLICT (user_id) DO UPDATE SET
        email = EXCLUDED.email,
        full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), user_settings.full_name),
        avatar_url = COALESCE(NULLIF(EXCLUDED.avatar_url, ''), user_settings.avatar_url),
        account   = CASE WHEN user_settings.account   = '{}'::jsonb THEN EXCLUDED.account   ELSE user_settings.account   END,
        profile   = CASE WHEN user_settings.profile   = '{}'::jsonb THEN EXCLUDED.profile   ELSE user_settings.profile   END,
        appearance= CASE WHEN user_settings.appearance= '{}'::jsonb THEN EXCLUDED.appearance ELSE user_settings.appearance END,
        notifications=CASE WHEN user_settings.notifications='{}'::jsonb THEN EXCLUDED.notifications ELSE user_settings.notifications END,
        preferences=CASE WHEN user_settings.preferences='{}'::jsonb THEN EXCLUDED.preferences ELSE user_settings.preferences END,
        security  = CASE WHEN user_settings.security  = '{}'::jsonb THEN EXCLUDED.security   ELSE user_settings.security   END,
        onboarding= CASE WHEN user_settings.onboarding= '{}'::jsonb THEN EXCLUDED.onboarding ELSE user_settings.onboarding END,
        privacy   = CASE WHEN user_settings.privacy   = '{}'::jsonb THEN EXCLUDED.privacy    ELSE user_settings.privacy    END,
        storage   = CASE WHEN user_settings.storage   = '{}'::jsonb THEN EXCLUDED.storage    ELSE user_settings.storage    END,
        ai        = CASE WHEN user_settings.ai        = '{}'::jsonb THEN EXCLUDED.ai         ELSE user_settings.ai         END,
        updated_at = NOW()
    `;
  },

  async ensureWorkspaceSettings(workspaceId: string, ownerId: string) {
    const db = getDb();

    // Fetch the real workspace to use its actual name/description
    const workspace = await this.getById(workspaceId);
    const wsName = workspace?.name ?? "Personal";
    const wsDescription = workspace?.description ?? "Your personal workspace";

    const general = db.json({
      name: wsName,
      description: wsDescription,
      visibility: "private",
      allowMemberInvites: true,
      requireApproval: false,
      defaultRole: "member",
    });
    const access = db.json({
      publicRead: false,
      publicWrite: false,
      allowGuestComments: false,
      inviteOnly: false,
      domainRestriction: null,
      ssoEnabled: false,
      ssoProvider: null,
    });
    const ai = db.json({
      enabled: true,
      defaultModel: "gemini-3.1-flash-lite",
      allowedModels: ["gemini-3.1-flash-lite"],
      maxTokensPerDay: 10000,
      enableCodeExecution: true,
      enableWebSearch: true,
      enableFileUpload: true,
      privacyMode: false,
      trainingOptOut: false,
    });
    const integrations = db.json({});
    const limits = db.json({
      maxMembers: 5,
      maxProjects: 10,
      maxStorage: 1073741824,
      maxApiCallsPerDay: 1000,
      maxAiTokensPerDay: 10000,
      maxDocuments: 100,
      maxSlides: 500,
      maxNotes: 500,
    });
    const notifications = db.json({
      enabled: true,
      channels: {
        email: true,
        inApp: true,
        push: true,
        slack: false,
      },
      events: {
        memberJoined: true,
        memberLeft: true,
        projectCreated: true,
        projectDeleted: true,
        taskCompleted: true,
        mentions: true,
      },
      digest: {
        enabled: true,
        frequency: "daily",
        time: "09:00",
        dayOfWeek: 1,
      },
    });
    const security = db.json({
      twoFactorRequired: false,
      sessionTimeout: 30,
      dataRetentionDays: 90,
      ipWhitelist: [],
      allowedCountries: [],
      blockedCountries: [],
      requirePasswordForSensitive: false,
      auditLogEnabled: true,
    });
    const storage = db.json({
      maxFileSize: 100,
      allowedFileTypes: [
        ".pdf",
        ".doc",
        ".docx",
        ".txt",
        ".rtf",
        ".odt",
        ".xls",
        ".xlsx",
        ".csv",
        ".ods",
        ".ppt",
        ".pptx",
        ".odp",
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".svg",
        ".webp",
        ".mp3",
        ".wav",
        ".mp4",
        ".webm",
        ".zip",
        ".tar",
        ".gz",
        ".js",
        ".ts",
        ".py",
        ".json",
        ".xml",
        ".html",
        ".css",
      ],
      autoCleanup: false,
      deletedRetentionDays: 30,
    });
    await db`
      INSERT INTO workspace_settings (
        workspace_id, owner_id, general, access, ai, integrations, limits, notifications, security, storage
      ) VALUES (
        ${workspaceId}, ${ownerId}, ${general}, ${access}, ${ai}, ${integrations}, ${limits}, ${notifications}, ${security}, ${storage}
      )
      ON CONFLICT (workspace_id) DO NOTHING
    `;
  },

  async listByOwner(userId: string) {
    const db = getDb();
    const rows = await withWorkspaceQueryTiming(
      "listByOwner",
      { userId },
      () => db`
        SELECT ${db(workspaceListColumns)} FROM workspaces WHERE owner_uid = ${userId} AND deleted_at IS NULL
        ORDER BY display_order ASC, created_at ASC
      `,
    );
    return rows.map(parseWorkspace);
  },

  async listByMembership(userId: string) {
    const db = getDb();
    const rows = await withWorkspaceQueryTiming(
      "listByMembership",
      { userId },
      () => db`
        SELECT ${db.unsafe(workspaceListAliasColumns)}
        FROM workspaces w
        INNER JOIN workspace_members m ON m.workspace_id = w.id
        WHERE m.user_uid = ${userId} AND m.deleted_at IS NULL AND w.deleted_at IS NULL
          AND w.owner_uid <> ${userId}
        ORDER BY w.created_at ASC
      `,
    );
    return rows.map(parseWorkspace);
  },

  async getById(workspaceId: string) {
    const db = getDb();
    const rows =
      await db`SELECT ${db(workspaceColumns)} FROM workspaces WHERE id = ${workspaceId} AND deleted_at IS NULL LIMIT 1`;
    return rows[0] ? parseWorkspace(rows[0]) : null;
  },

  async getDefaultWorkspace(userId: string) {
    const db = getDb();
    const rows = await db`
      SELECT ${db(workspaceColumns)} FROM workspaces
      WHERE owner_uid = ${userId} AND is_default = true AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] ? parseWorkspace(rows[0]) : null;
  },

  async getAccess(workspaceId: string, userId: string) {
    const db = getDb();
    const rows = await withWorkspaceQueryTiming(
      "getAccess",
      { workspaceId, userId },
      () => db`
        SELECT
          ${db.unsafe(workspaceListAliasColumns)},
          ${db.unsafe(memberAliasColumns)}
        FROM workspaces w
        LEFT JOIN workspace_members m
          ON m.workspace_id = w.id
          AND m.user_uid = ${userId}
          AND m.deleted_at IS NULL
        WHERE w.id = ${workspaceId}
          AND w.deleted_at IS NULL
        LIMIT 1
      `,
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      workspace: parseWorkspace(row),
      member: row.member_id ? parsePrefixedMember(row) : null,
    };
  },

  async listVisibleForUser(userId: string) {
    const db = getDb();
    const rows = await withWorkspaceQueryTiming(
      "listVisibleForUser",
      { userId },
      () => db`
        WITH visible AS (
          SELECT ${db.unsafe(workspaceListAliasColumns)}, 'owner'::text AS access_role, 0 AS sort_group
          FROM workspaces w
          WHERE w.owner_uid = ${userId}
            AND w.deleted_at IS NULL

          UNION ALL

          SELECT ${db.unsafe(workspaceListAliasColumns)}, m.role AS access_role, 1 AS sort_group
          FROM workspace_members m
          INNER JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.user_uid = ${userId}
            AND m.deleted_at IS NULL
            AND w.deleted_at IS NULL
            AND w.owner_uid <> ${userId}
        ),
        member_counts AS (
          SELECT workspace_id, COUNT(*)::int AS member_count
          FROM workspace_members
          WHERE deleted_at IS NULL
          GROUP BY workspace_id
        )
        SELECT
          v.*,
          COALESCE(mc.member_count, 0) AS member_count
        FROM visible v
        LEFT JOIN member_counts mc ON mc.workspace_id = v.id
        ORDER BY v.sort_group ASC, v.display_order ASC, v.created_at ASC
      `,
    );
    return rows.map((row) => {
      const workspace = parseWorkspace(row);
      workspace.counters.members = Number(row.member_count ?? workspace.counters.members ?? 0);
      return workspace;
    });
  },

  async countByOwner(userId: string) {
    const db = getDb();
    const rows =
      await db`SELECT COUNT(*)::int AS count FROM workspaces WHERE owner_uid = ${userId} AND deleted_at IS NULL`;
    return Number(rows[0]?.count ?? 0);
  },

  async createWorkspace(input: {
    ownerUid: string;
    name: string;
    slug: string;
    description: string;
    isDefault: boolean;
    color?: string;
    settings: WorkspaceConfig;
    metadata?: Record<string, unknown>;
    limits: WorkspaceLimits;
    counters: WorkspaceCounters;
  }) {
    const db = getDb();
    const settings = db.json(toJsonValue(input.settings));
    const metadata = db.json(toJsonValue(input.metadata ?? {}));
    const limits = db.json(toJsonValue(input.limits));
    const counters = db.json(toJsonValue(input.counters));
    const rows = await db`
      INSERT INTO workspaces (
        owner_uid, name, slug, description, status, is_default, color,
        settings, metadata, limits, counters, created_at, updated_at
      ) VALUES (
        ${input.ownerUid}, ${input.name}, ${input.slug}, ${input.description}, 'active',
        ${input.isDefault}, ${input.color ?? null}, ${settings}, ${metadata},
        ${limits}, ${counters}, NOW(), NOW()
      )
      RETURNING ${db(workspaceColumns)}
    `;
    return parseWorkspace(rows[0]);
  },

  async updateWorkspace(workspaceId: string, updates: Record<string, unknown>) {
    const db = getDb();
    const keys = Object.keys(updates);
    if (!keys.length) {
      return this.getById(workspaceId);
    }

    const jsonColumns = new Set(["settings", "metadata", "limits", "counters"]);
    const fragments = keys.flatMap((key, index) => {
      const value = updates[key];
      const assignment = jsonColumns.has(key)
        ? db`${db(key)} = ${db.json(toJsonValue((value as Record<string, unknown>) ?? {}))}`
        : db`${db(key)} = ${value as any}`;
      return index === 0 ? [assignment] : [db`, `, assignment];
    });
    const rows = await db`
      UPDATE workspaces
      SET ${fragments},
          updated_at = NOW()
      WHERE id = ${workspaceId}
        AND deleted_at IS NULL
      RETURNING ${db(workspaceColumns)}
    `;
    return rows[0] ? parseWorkspace(rows[0] as Record<string, unknown>) : null;
  },

  async softDeleteWorkspace(workspaceId: string) {
    const db = getDb();
    await db`
      UPDATE workspaces
      SET deleted_at = NOW(), status = 'deleted', updated_at = NOW()
      WHERE id = ${workspaceId} AND deleted_at IS NULL
    `;
  },

  async listMembers(workspaceId: string) {
    const db = getDb();
    const rows = await db`
      SELECT ${db(memberColumns)} FROM workspace_members
      WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
      ORDER BY created_at ASC
    `;
    return rows.map(parseMember);
  },

  async getMember(workspaceId: string, userUid: string) {
    const db = getDb();
    const rows = await db`
      SELECT ${db(memberColumns)} FROM workspace_members
      WHERE workspace_id = ${workspaceId} AND user_uid = ${userUid} AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] ? parseMember(rows[0]) : null;
  },

  async countMembers(workspaceId: string) {
    const db = getDb();
    const rows = await db`
      SELECT COUNT(*)::int AS count FROM workspace_members
      WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
    `;
    return Number(rows[0]?.count ?? 0);
  },

  async countMembersForWorkspaces(workspaceIds: string[]) {
    if (!workspaceIds.length) {
      return {};
    }
    const db = getDb();
    const rows = await withWorkspaceQueryTiming(
      "countMembersForWorkspaces",
      { workspaceCount: workspaceIds.length },
      () => db`
        SELECT workspace_id, COUNT(*)::int AS count
        FROM workspace_members
        WHERE workspace_id = ANY(${workspaceIds}::uuid[])
          AND deleted_at IS NULL
        GROUP BY workspace_id
      `,
    );
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[String(row.workspace_id)] = Number(row.count ?? 0);
    }
    return counts;
  },

  async createMember(input: {
    workspaceId: string;
    userUid: string;
    email?: string;
    displayName?: string;
    avatarUrl?: string;
    role: WorkspaceRole;
    invitedBy?: string;
    invitedAt?: string;
    inviteToken?: string;
    inviteStatus?: string;
    joinedAt?: string;
    status?: string;
    preferences?: Record<string, unknown>;
  }) {
    const db = getDb();
    const preferences = db.json(toJsonValue(input.preferences ?? {}));
    const rows = await db`
      INSERT INTO workspace_members (
        workspace_id, user_uid, email, display_name, avatar_url, role, invited_by,
        invited_at, invite_token, invite_status, joined_at, status, preferences, created_at, updated_at
      ) VALUES (
        ${input.workspaceId}, ${input.userUid}, ${input.email ?? null}, ${input.displayName ?? null},
        ${input.avatarUrl ?? null}, ${input.role}, ${input.invitedBy ?? null}, ${input.invitedAt ?? null},
        ${input.inviteToken ?? null}, ${input.inviteStatus ?? "active"}, ${input.joinedAt ?? null},
        ${input.status ?? "active"}, ${preferences}, NOW(), NOW()
      )
      RETURNING ${db(memberColumns)}
    `;
    return parseMember(rows[0]);
  },

  async updateMemberRole(
    workspaceId: string,
    userUid: string,
    role: WorkspaceRole,
  ) {
    const db = getDb();
    await db`
      UPDATE workspace_members
      SET role = ${role}, updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND user_uid = ${userUid} AND deleted_at IS NULL
    `;
  },

  async removeMember(workspaceId: string, userUid: string) {
    const db = getDb();
    await db`
      UPDATE workspace_members
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND user_uid = ${userUid} AND deleted_at IS NULL
    `;
  },

  async listActivity(workspaceId: string, skip: number, limit: number) {
    const db = getDb();
    const totalRows =
      await db`SELECT COUNT(*)::int AS count FROM workspace_activity WHERE workspace_id = ${workspaceId}`;
    const rows = await db`
      SELECT ${db(activityColumns)} FROM workspace_activity
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC
      OFFSET ${skip}
      LIMIT ${limit}
    `;
    return {
      total: Number(totalRows[0]?.count ?? 0),
      activities: rows.map(parseActivity),
    };
  },

  async insertActivity(
    workspaceId: string,
    userUid: string,
    type: string,
    description: string,
    metadata: Record<string, unknown>,
  ) {
    const db = getDb();
    const metadataJson = db.json(toJsonValue(metadata));
    await db`
      INSERT INTO workspace_activity (workspace_id, user_uid, activity_type, description, metadata, created_at)
      VALUES (${workspaceId}, ${userUid}, ${type}, ${description}, ${metadataJson}, NOW())
    `;
  },

  async createInvitation(
    workspaceId: string,
    invitedBy: string,
    email: string,
    role: WorkspaceRole,
  ) {
    const db = getDb();
    const token = randomToken(24);
    const rows = await db`
      INSERT INTO workspace_invitations (
        workspace_id, invited_by, email, role, token, token_expires_at, status, created_at, updated_at
      ) VALUES (
        ${workspaceId}, ${invitedBy}, ${email}, ${role}, ${token}, NOW() + INTERVAL '7 days',
        'pending', NOW(), NOW()
      )
      RETURNING ${db(invitationColumns)}
    `;
    return parseInvitation(rows[0]);
  },

  async getInvitationByToken(token: string) {
    const db = getDb();
    const rows =
      await db`SELECT ${db(invitationColumns)} FROM workspace_invitations WHERE token = ${token} LIMIT 1`;
    return rows[0] ? parseInvitation(rows[0]) : null;
  },

  async getInvitationById(invitationId: string) {
    const db = getDb();
    const rows =
      await db`SELECT ${db(invitationColumns)} FROM workspace_invitations WHERE id = ${invitationId} LIMIT 1`;
    return rows[0] ? parseInvitation(rows[0]) : null;
  },

  async listInvitations(workspaceId: string) {
    const db = getDb();
    const rows = await db`
      SELECT ${db(invitationColumns)} FROM workspace_invitations
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC
    `;
    return rows.map(parseInvitation);
  },

  async updateInvitationStatus(
    token: string,
    status: string,
    acceptedBy?: string,
  ) {
    const db = getDb();
    if (acceptedBy) {
      await db`
        UPDATE workspace_invitations
        SET status = ${status},
            accepted_by = ${acceptedBy},
            accepted_at = NOW(),
            updated_at = NOW()
        WHERE token = ${token}
      `;
      return;
    }

    await db`
      UPDATE workspace_invitations
      SET status = ${status},
          accepted_by = NULL,
          updated_at = NOW()
      WHERE token = ${token}
    `;
  },

  async revokeInvitation(invitationId: string) {
    const db = getDb();
    await db`
      UPDATE workspace_invitations
      SET status = 'revoked', updated_at = NOW()
      WHERE id = ${invitationId}
    `;
  },
};

import { getDb } from "../../lib/db";
import type { JSONValue } from "postgres";

function toJsonValue(value: unknown): JSONValue {
  return value as JSONValue;
}

export const dashboardRepository = {
  async getActiveSessions(userId: string) {
    const db = getDb();
    // Auto-cleanup expired sessions first
    await db`
      DELETE FROM auth.sessions
      WHERE user_id = ${userId} AND expires_at < NOW()
    `;
    const rows = await db`
      SELECT id, device_name, device_type, browser, os, ip_address, created_at, last_active, is_revoked
      FROM auth.sessions
      WHERE user_id = ${userId}
        AND is_revoked = FALSE
        AND expires_at > NOW()
      ORDER BY last_active DESC
    `;
    return rows;
  },

  async getRecentActivityAcrossWorkspaces(userId: string, limit = 10) {
    const db = getDb();
    const rows = await db`
      SELECT wa.workspace_id, wa.activity_type AS type, wa.description, wa.created_at, w.name AS workspace_name
      FROM workspace_activity wa
      JOIN workspaces w ON w.id = wa.workspace_id
      WHERE w.owner_uid = ${userId} AND w.deleted_at IS NULL
      ORDER BY wa.created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  },

  async getWorkspacesWithRole(userId: string) {
    const db = getDb();
    const owned = await db`
      SELECT w.*, 'owner' AS member_role
      FROM workspaces w
      WHERE w.owner_uid = ${userId} AND w.deleted_at IS NULL
      ORDER BY w.is_default DESC, w.display_order ASC, w.created_at ASC
    `;
    const member = await db`
      SELECT w.*, m.role AS member_role
      FROM workspaces w
      JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_uid = ${userId}
        AND m.deleted_at IS NULL
        AND w.deleted_at IS NULL
        AND w.owner_uid != ${userId}
      ORDER BY w.created_at ASC
    `;
    return [...owned, ...member];
  },

  async getUnreadNotificationCount(userId: string) {
    const db = getDb();
    const rows = await db`
      SELECT COUNT(*)::int AS count FROM auth.notifications
      WHERE user_id = ${userId} AND is_read = FALSE AND is_archived = FALSE
    `;
    return Number(rows[0]?.count ?? 0);
  },

  async getRecentNotifications(userId: string, limit = 5) {
    const db = getDb();
    return db`
      SELECT id, type, category, title, body, action_url, is_read, priority, created_at
      FROM auth.notifications
      WHERE user_id = ${userId} AND is_archived = FALSE
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  },

  async getStorageSummary(userId: string) {
    const db = getDb();
    const rows = await db`
      SELECT storage_quota_bytes, storage_used_bytes, storage_tier, subscription_status
      FROM auth.users
      WHERE id = ${userId}
    `;
    return rows[0] ?? null;
  },

  async getMemberCountsForWorkspaces(workspaceIds: string[]) {
    if (!workspaceIds.length) return {};
    const db = getDb();
    const rows = await db`
      SELECT workspace_id, COUNT(*)::int AS count
      FROM workspace_members
      WHERE workspace_id = ANY(${workspaceIds}::uuid[]) AND deleted_at IS NULL
      GROUP BY workspace_id
    `;
    const map: Record<string, number> = {};
    for (const r of rows) map[String(r.workspace_id)] = Number(r.count);
    return map;
  },

  async getAllProjectsForUser(userId: string) {
    const db = getDb();
    const rows = await db`
      SELECT wp.*, w.name AS workspace_name, w.slug AS workspace_slug
      FROM workspace_projects wp
      JOIN workspaces w ON w.id = wp.workspace_id
      WHERE w.owner_uid = ${userId} AND wp.deleted_at IS NULL
        AND w.deleted_at IS NULL
      ORDER BY wp.created_at DESC
    `;
    return rows;
  },

  async getAllCollectionsForUser(userId: string) {
    const db = getDb();
    const rows = await db`
      SELECT wc.*, w.name AS workspace_name, w.slug AS workspace_slug
      FROM workspace_collections wc
      JOIN workspaces w ON w.id = wc.workspace_id
      WHERE w.owner_uid = ${userId} AND wc.deleted_at IS NULL
        AND w.deleted_at IS NULL
      ORDER BY wc.created_at DESC
    `;
    return rows;
  },

  async getAllAnalysisForUser(userId: string) {
    const db = getDb();
    const rows = await db`
      SELECT wa.*, w.name AS workspace_name, w.slug AS workspace_slug
      FROM workspace_analysis wa
      JOIN workspaces w ON w.id = wa.workspace_id
      WHERE w.owner_uid = ${userId} AND wa.deleted_at IS NULL
        AND w.deleted_at IS NULL
      ORDER BY wa.created_at DESC
    `;
    return rows;
  },

  async getProjectStatsForUser(userId: string) {
    const db = getDb();
    const rows = await db`
      SELECT 
        COUNT(*)::int AS total,
        SUM(CASE WHEN wp.status = 'active' THEN 1 ELSE 0 END)::int AS active,
        SUM(CASE WHEN wp.status = 'completed' THEN 1 ELSE 0 END)::int AS completed,
        SUM(CASE WHEN wp.status = 'paused' THEN 1 ELSE 0 END)::int AS paused,
        SUM(CASE WHEN wp.status = 'archived' THEN 1 ELSE 0 END)::int AS archived
      FROM workspace_projects wp
      JOIN workspaces w ON w.id = wp.workspace_id
      WHERE w.owner_uid = ${userId} AND wp.deleted_at IS NULL AND w.deleted_at IS NULL
    `;
    return rows[0] ?? { total: 0, active: 0, completed: 0, paused: 0, archived: 0 };
  },

  async getAnalysisStatsForUser(userId: string) {
    const db = getDb();
    const rows = await db`
      SELECT 
        COUNT(*)::int AS total,
        SUM(CASE WHEN wa.status = 'pending' THEN 1 ELSE 0 END)::int AS pending,
        SUM(CASE WHEN wa.status = 'processing' THEN 1 ELSE 0 END)::int AS processing,
        SUM(CASE WHEN wa.status = 'completed' THEN 1 ELSE 0 END)::int AS completed,
        SUM(CASE WHEN wa.status = 'failed' THEN 1 ELSE 0 END)::int AS failed
      FROM workspace_analysis wa
      JOIN workspaces w ON w.id = wa.workspace_id
      WHERE w.owner_uid = ${userId} AND wa.deleted_at IS NULL AND w.deleted_at IS NULL
    `;
    return rows[0] ?? { total: 0, pending: 0, processing: 0, completed: 0, failed: 0 };
  },

  async getCollectionStatsForUser(userId: string) {
    const db = getDb();
    const rows = await db`
      SELECT 
        COUNT(*)::int AS total,
        SUM(CASE WHEN collection_type = 'folder' THEN 1 ELSE 0 END)::int AS folders,
        SUM(CASE WHEN collection_type = 'tag' THEN 1 ELSE 0 END)::int AS tags,
        SUM(CASE WHEN collection_type = 'smart' THEN 1 ELSE 0 END)::int AS smart
      FROM workspace_collections wc
      JOIN workspaces w ON w.id = wc.workspace_id
      WHERE w.owner_uid = ${userId} AND wc.deleted_at IS NULL AND w.deleted_at IS NULL
    `;
    return rows[0] ?? { total: 0, folders: 0, tags: 0, smart: 0 };
  },

  async getWorkspaceStats(userId: string) {
    const db = getDb();
    const owned = await db`
      SELECT COUNT(*)::int AS owned FROM workspaces WHERE owner_uid = ${userId} AND deleted_at IS NULL
    `;
    const member = await db`
      SELECT COUNT(DISTINCT w.id)::int AS member
      FROM workspaces w
      JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_uid = ${userId} AND m.deleted_at IS NULL AND w.deleted_at IS NULL AND w.owner_uid != ${userId}
    `;
    return {
      owned: Number(owned[0]?.owned ?? 0),
      member: Number(member[0]?.member ?? 0),
    };
  },

  async getActivityTimeline(userId: string, limit = 20) {
    const db = getDb();
    const rows = await db`
      SELECT 
        wa.id, wa.workspace_id, wa.activity_type, wa.description, wa.created_at,
        w.name AS workspace_name
      FROM workspace_activity wa
      JOIN workspaces w ON w.id = wa.workspace_id
      WHERE w.owner_uid = ${userId} AND w.deleted_at IS NULL
      ORDER BY wa.created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  },

  /**
   * Fetch auth activity logs (login, registration, session events, etc.)
   * Supports pagination and optional type filter.
   */
  async getAuthActivityLogs(
    userId: string,
    options: { page?: number; pageSize?: number; type?: string; startDate?: string; endDate?: string; search?: string } = {},
  ) {
    const db = getDb();
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    // Build WHERE conditions array for dynamic filtering
    const conditions: string[] = [`user_id = '${userId}'::uuid`];
    const params: any[] = [];
    let paramIdx = 1;

    if (options.type) {
      params.push(options.type);
      conditions.push(`activity_type = $${paramIdx++}`);
    }
    if (options.startDate) {
      params.push(options.startDate);
      conditions.push(`created_at >= $${paramIdx++}::timestamptz`);
    }
    if (options.endDate) {
      params.push(options.endDate);
      conditions.push(`created_at <= $${paramIdx++}::timestamptz`);
    }
    if (options.search) {
      params.push(`%${options.search}%`);
      conditions.push(`description ILIKE $${paramIdx++}`);
    }

    const whereClause = conditions.join(' AND ');

    // Use raw query for dynamic WHERE clause
    const rows = await db.unsafe(`
      SELECT id, user_id, activity_type, description, session_id, metadata, created_at
      FROM auth.activity_log
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `, params);

    const countRows = await db.unsafe(`
      SELECT COUNT(*)::int AS total
      FROM auth.activity_log
      WHERE ${whereClause}
    `, params);

    return {
      logs: rows as any[],
      totalCount: Number((countRows as any[])[0]?.total ?? 0),
      page,
      pageSize,
    };
  },

  /**
   * Insert a single auth activity log entry.
   */
  async insertAuthActivityLog(
    userId: string,
    activityType: string,
    description: string,
    sessionId: string | null = null,
    metadata: Record<string, unknown> = {},
  ) {
    const db = getDb();
    const metadataJson = db.json(metadata as any);
    const rows = await db`
      INSERT INTO auth.activity_log (user_id, activity_type, description, session_id, metadata)
      VALUES (${userId}::uuid, ${activityType}, ${description}, ${sessionId}::uuid, ${metadataJson})
      RETURNING id, activity_type, description, created_at
    `;
    return rows[0];
  },

  // ── NEW: Get pre-computed dashboard stats from the user_dashboard_stats table ──
  async getContentOverviewStatsForUser(userId: string) {
    const db = getDb();
    const rows = await db`
      SELECT
        (SELECT COUNT(*)::int
         FROM workspace_projects wp
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = ${userId}::text
           AND wp.deleted_at IS NULL
           AND w.deleted_at IS NULL) AS projects,
        (SELECT COUNT(*)::int
         FROM project_documents d
         JOIN workspace_projects wp ON wp.id = d.project_id
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = ${userId}::text
           AND d.deleted_at IS NULL
           AND wp.deleted_at IS NULL
           AND w.deleted_at IS NULL) AS documents,
        (SELECT COUNT(*)::int
         FROM project_slides s
         JOIN workspace_projects wp ON wp.id = s.project_id
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = ${userId}::text
           AND s.deleted_at IS NULL
           AND wp.deleted_at IS NULL
           AND w.deleted_at IS NULL) AS presentations,
        (SELECT COUNT(*)::int
         FROM project_diagrams d
         JOIN workspace_projects wp ON wp.id = d.project_id
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = ${userId}::text
           AND d.deleted_at IS NULL
           AND wp.deleted_at IS NULL
           AND w.deleted_at IS NULL) AS diagrams,
        (SELECT COUNT(*)::int
         FROM project_notes n
         JOIN workspace_projects wp ON wp.id = n.project_id
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = ${userId}::text
           AND n.deleted_at IS NULL
           AND wp.deleted_at IS NULL
           AND w.deleted_at IS NULL) AS notes,
        (SELECT COUNT(*)::int
         FROM project_tasks t
         JOIN workspace_projects wp ON wp.id = t.project_id
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = ${userId}::text
           AND t.deleted_at IS NULL
           AND wp.deleted_at IS NULL
           AND w.deleted_at IS NULL) AS tasks,
        (SELECT COUNT(*)::int
         FROM project_task_lists tl
         JOIN workspace_projects wp ON wp.id = tl.project_id
         JOIN workspaces w ON w.id = wp.workspace_id
         WHERE w.owner_uid = ${userId}::text
           AND tl.deleted_at IS NULL
           AND wp.deleted_at IS NULL
           AND w.deleted_at IS NULL) AS task_lists,
        (SELECT COUNT(*)::int
         FROM workspace_analysis wa
         JOIN workspaces w ON w.id = wa.workspace_id
         WHERE w.owner_uid = ${userId}::text
           AND wa.deleted_at IS NULL
           AND w.deleted_at IS NULL) AS analysis
    `;
    const row = rows[0] ?? {};
    return {
      projects: Number(row.projects ?? 0),
      documents: Number(row.documents ?? 0),
      presentations: Number(row.presentations ?? 0),
      diagrams: Number(row.diagrams ?? 0),
      notes: Number(row.notes ?? 0),
      tasks: Number(row.tasks ?? 0),
      task_lists: Number(row.task_lists ?? 0),
      analysis: Number(row.analysis ?? 0),
    };
  },

  async getUserDashboardStats(userId: string) {
    const db = getDb();
    const rows = await db`
      SELECT * FROM user_dashboard_stats
      WHERE user_id = ${userId}
    `;
    return rows[0] ?? null;
  },

  // ── NEW: Refresh dashboard stats for a user ──
  async refreshDashboardStats(userId: string) {
    const db = getDb();
    await db`SELECT compute_dashboard_stats(${userId}::uuid)`;
    return this.getUserDashboardStats(userId);
  },
};

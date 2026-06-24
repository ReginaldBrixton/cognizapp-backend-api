import { Elysia } from "elysia";

import { fail, ok } from "../../lib/http";
import { HttpError } from "../../lib/errors";
import { cache } from "../../lib/cache";
import { resolveAuth } from "../auth/middleware";
import { authRepository } from "../auth/repository";
import { settingsRepository } from "../user-settings/repository";
import { dashboardRepository } from "./repository";

export const dashboardRoutes = new Elysia({ prefix: "/api/user", tags: ["dashboard"] })
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(error.message, error.code);
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return fail("Invalid request", "invalid_request");
    }
  })

  /**
   * GET /api/user/dashboard
   *
   * Complete dashboard for the authenticated user.
   * Returns everything the frontend needs in one call:
   *   - user profile + account info
   *   - user settings (appearance, notifications, preferences, privacy, onboarding)
   *   - workspaces (owned + member) with counters and member counts
   *   - projects (full list + stats by status)
   *   - collections (full list + stats by type)
   *   - analysis (full list + stats by status)
   *   - activity timeline (last 20 events)
   *   - sessions (active devices, current flagged)
   *   - notifications (unread count + 5 most recent)
   *   - storage (used, quota, tier, percentage)
   *   - cross-workspace aggregate stats
   */
  .get("/dashboard", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    const cacheKey = `user:${auth.userId}:dashboard`;
    const cached = await cache.getJson<Record<string, unknown>>(cacheKey);
    if (cached) {
      return ok(cached);
    }

    // ── Fetch ALL data in parallel ──────────────────────────────────────────
    const [
      user,
      settings,
      workspaceRows,
      sessions,
      unreadCount,
      recentNotifications,
      recentActivity,
      storageSummary,
      projectStats,
      analysisStats,
      collectionStats,
      workspaceCounts,
      contentOverview,
      projects,
      collections,
      analysis,
      activityTimeline,
    ] = await Promise.all([
      authRepository.getUserById(auth.userId),
      settingsRepository.getUserSettings(auth.userId),
      dashboardRepository.getWorkspacesWithRole(auth.userId),
      dashboardRepository.getActiveSessions(auth.userId),
      dashboardRepository.getUnreadNotificationCount(auth.userId),
      dashboardRepository.getRecentNotifications(auth.userId, 5),
      dashboardRepository.getRecentActivityAcrossWorkspaces(auth.userId, 10),
      dashboardRepository.getStorageSummary(auth.userId),
      dashboardRepository.getProjectStatsForUser(auth.userId),
      dashboardRepository.getAnalysisStatsForUser(auth.userId),
      dashboardRepository.getCollectionStatsForUser(auth.userId),
      dashboardRepository.getWorkspaceStats(auth.userId),
      dashboardRepository.getContentOverviewStatsForUser(auth.userId),
      dashboardRepository.getAllProjectsForUser(auth.userId),
      dashboardRepository.getAllCollectionsForUser(auth.userId),
      dashboardRepository.getAllAnalysisForUser(auth.userId),
      dashboardRepository.getActivityTimeline(auth.userId, 20),
    ]);

    if (!user) {
      throw new HttpError(404, "user_not_found", "User not found");
    }

    // ── Member counts per workspace ─────────────────────────────────────────
    const workspaceIds = workspaceRows.map((w: Record<string, unknown>) => String(w.id));
    const memberCounts = await dashboardRepository.getMemberCountsForWorkspaces(workspaceIds);

    // ── Shape workspaces ────────────────────────────────────────────────────
    const workspaces = workspaceRows.map((w: Record<string, unknown>) => {
      const counters = (w.counters as Record<string, number> | null) ?? {};
      return {
        id: String(w.id),
        name: String(w.name),
        slug: String(w.slug),
        description: String(w.description ?? ""),
        is_default: Boolean(w.is_default),
        color: w.color ?? null,
        icon: w.icon ?? null,
        avatar_url: w.avatar_url ?? null,
        status: String(w.status),
        member_role: String(w.member_role),
        counters: {
          ...counters,
          members: memberCounts[String(w.id)] ?? counters.members ?? 0,
        },
        last_activity_at: w.last_activity_at ?? null,
        last_opened_at: w.last_opened_at ?? null,
        created_at: String(w.created_at),
      };
    });

    // ── Cross-workspace totals from counters ────────────────────────────────
    const workspaceStats = workspaceRows.reduce(
      (acc: Record<string, number>, w: Record<string, unknown>) => {
        const c = (w.counters as Record<string, unknown>) ?? {};
        acc.total_projects += Number(c.projects ?? 0);
        acc.total_tasks += Number(c.tasks ?? 0);
        acc.total_notes += Number(c.notes ?? 0);
        acc.total_members += Number(c.members ?? 0);
        return acc;
      },
      { total_projects: 0, total_tasks: 0, total_notes: 0, total_members: 0 },
    );

    // ── Storage ─────────────────────────────────────────────────────────────
    const quotaBytes = Number(storageSummary?.storage_quota_bytes ?? 5368709120);
    const usedBytes = Number(storageSummary?.storage_used_bytes ?? 0);

    // ── Sessions ────────────────────────────────────────────────────────────
    const sessionList = sessions.map((s: Record<string, unknown>) => ({
      id: String(s.id),
      device_name: s.device_name ?? null,
      device_type: s.device_type ?? null,
      browser: s.browser ?? null,
      os: s.os ?? null,
      ip_address: s.ip_address ?? null,
      last_active: s.last_active ?? null,
      created_at: String(s.created_at),
      is_current: String(s.id) === auth.sessionId,
    }));

    // ── Settings subset ─────────────────────────────────────────────────────
    const settingsSubset = settings
      ? {
        appearance: settings.appearance ?? {},
        notifications: settings.notifications ?? {},
        preferences: settings.preferences ?? {},
        onboarding: settings.onboarding ?? {},
        privacy: settings.privacy ?? {},
      }
      : null;

    // ── Projects ────────────────────────────────────────────────────────────
    const formattedProjects = projects.map((p: Record<string, unknown>) => ({
      id: String(p.id),
      workspace_id: String(p.workspace_id),
      workspace_name: String(p.workspace_name ?? ""),
      workspace_slug: String(p.workspace_slug ?? ""),
      title: String(p.title),
      description: String(p.description ?? ""),
      status: String(p.status),
      visibility: String(p.visibility),
      field_of_study: p.field_of_study ?? null,
      project_type: p.project_type ?? null,
      keywords: Array.isArray(p.keywords) ? p.keywords : [],
      collaborators: Array.isArray(p.collaborators) ? p.collaborators : [],
      completion_pct: Number(p.completion_pct ?? 0),
      deadline: p.deadline ? String(p.deadline) : null,
      document_count: Number(p.document_count ?? 0),
      task_count: Number(p.task_count ?? 0),
      completed_tasks: Number(p.completed_tasks ?? 0),
      created_at: String(p.created_at),
      updated_at: String(p.updated_at),
    }));

    // ── Collections ─────────────────────────────────────────────────────────
    const formattedCollections = collections.map((c: Record<string, unknown>) => ({
      id: String(c.id),
      workspace_id: String(c.workspace_id),
      workspace_name: String(c.workspace_name ?? ""),
      workspace_slug: String(c.workspace_slug ?? ""),
      name: String(c.name),
      description: String(c.description ?? ""),
      collection_type: String(c.collection_type),
      parent_id: c.parent_id ? String(c.parent_id) : null,
      sort_order: Number(c.sort_order ?? 0),
      is_default: Boolean(c.is_default),
      created_at: String(c.created_at),
      updated_at: String(c.updated_at),
    }));

    // ── Analysis ────────────────────────────────────────────────────────────
    const formattedAnalysis = analysis.map((a: Record<string, unknown>) => ({
      id: String(a.id),
      workspace_id: String(a.workspace_id),
      workspace_name: String(a.workspace_name ?? ""),
      workspace_slug: String(a.workspace_slug ?? ""),
      analysis_type: String(a.analysis_type),
      title: String(a.title),
      description: String(a.description ?? ""),
      status: String(a.status),
      confidence_score: a.confidence_score ? Number(a.confidence_score) : null,
      created_at: String(a.created_at),
      updated_at: String(a.updated_at),
    }));

    // ── Activity timeline ───────────────────────────────────────────────────
    const formattedActivity = activityTimeline.map((a: Record<string, unknown>) => ({
      id: String(a.id),
      workspace_id: String(a.workspace_id),
      workspace_name: String(a.workspace_name ?? ""),
      type: String(a.activity_type),
      description: String(a.description),
      created_at: String(a.created_at),
    }));

    // ── Recent activity ─────────────────────────────────────────────────────
    const formattedRecentActivity = recentActivity.map((a: Record<string, unknown>) => ({
      workspace_id: String(a.workspace_id),
      workspace_name: String(a.workspace_name ?? ""),
      type: String(a.type),
      description: String(a.description),
      created_at: String(a.created_at),
    }));

    // ── Recent notifications ────────────────────────────────────────────────
    const formattedRecentNotifications = recentNotifications.map((n: Record<string, unknown>) => ({
      id: String(n.id),
      type: String(n.type),
      category: String(n.category),
      title: String(n.title),
      body: n.body ?? null,
      action_url: n.action_url ?? null,
      is_read: Boolean(n.is_read),
      priority: String(n.priority),
      created_at: String(n.created_at),
    }));

    const payload = {
      user: {
        id: user.id,
        email: user.email,
        display_name: user.displayName,
        full_name: user.fullName,
        avatar_url: user.avatarUrl,
        role: user.role,
        status: user.status,
        account_type: (user.appMetadata as Record<string, unknown>)?.account_type ?? "personal",
        email_verified: user.emailVerified,
        provider: user.provider,
        login_count: user.loginCount,
        last_sign_in_at: user.lastSignInAt,
        created_at: user.createdAt,
        subscription_status: "free",
        onboarding_completed: (settings?.onboarding as Record<string, unknown> | null)?.completed ?? false,
      },
      settings: settingsSubset,
      workspaces,
      workspace_stats: {
        owned: workspaceCounts.owned,
        member: workspaceCounts.member,
        total: workspaceCounts.owned + workspaceCounts.member,
      },
      content_overview: contentOverview,
      stats: {
        total_workspaces: workspaces.length,
        owned_workspaces: workspaceCounts.owned,
        member_workspaces: workspaceCounts.member,
        ...workspaceStats,
        projects: contentOverview.projects,
        documents: contentOverview.documents,
        presentations: contentOverview.presentations,
        diagrams: contentOverview.diagrams,
        notes: contentOverview.notes,
        task_lists: contentOverview.task_lists,
        tasks: contentOverview.tasks,
        analysis: contentOverview.analysis,
        unread_notifications: unreadCount,
        active_sessions: sessionList.length,
        storage: {
          used_bytes: usedBytes,
          quota_bytes: quotaBytes,
          used_percent: quotaBytes > 0 ? Math.round((usedBytes / quotaBytes) * 100) : 0,
          tier: String(storageSummary?.storage_tier ?? "free"),
        },
      },
      projects: {
        list: formattedProjects,
        stats: {
          total: Number(projectStats.total),
          active: Number(projectStats.active),
          completed: Number(projectStats.completed),
          paused: Number(projectStats.paused),
          archived: Number(projectStats.archived),
        },
      },
      collections: {
        list: formattedCollections,
        stats: {
          total: Number(collectionStats.total),
          folders: Number(collectionStats.folders),
          tags: Number(collectionStats.tags),
          smart: Number(collectionStats.smart),
        },
      },
      analysis: {
        list: formattedAnalysis,
        stats: {
          total: Number(analysisStats.total),
          pending: Number(analysisStats.pending),
          processing: Number(analysisStats.processing),
          completed: Number(analysisStats.completed),
          failed: Number(analysisStats.failed),
        },
      },
      activity: {
        timeline: formattedActivity,
        total_events: formattedActivity.length,
      },
      recent_activity: formattedRecentActivity,
      sessions: sessionList,
      notifications: {
        unread_count: unreadCount,
        recent: formattedRecentNotifications,
      },
    };
    await cache.setJson(cacheKey, payload, 90);
    return ok(payload);
  })

  /**
   * GET /api/user/dashboard/stats
   *
   * Quick stats from the pre-computed user_dashboard_stats table.
   * Much faster than the full dashboard - ideal for header/sidebar widgets.
   */
  .get("/dashboard/stats", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    const cacheKey = `user:${auth.userId}:dashboard:stats`;
    const cached = await cache.getJson<Record<string, unknown>>(cacheKey);
    if (cached) {
      return ok(cached);
    }

    const [stats, contentOverview] = await Promise.all([
      dashboardRepository.getUserDashboardStats(auth.userId),
      dashboardRepository.getContentOverviewStatsForUser(auth.userId),
    ]);
    if (!stats) {
      // Compute on first access
      await dashboardRepository.refreshDashboardStats(auth.userId);
      const fresh = await dashboardRepository.getUserDashboardStats(auth.userId);
      const payload = {
        stats: {
          ...fresh,
          total_documents: contentOverview.documents,
          total_presentations: contentOverview.presentations,
          total_diagrams: contentOverview.diagrams,
          total_notes: contentOverview.notes,
          total_task_lists: contentOverview.task_lists,
          total_tasks: contentOverview.tasks,
          projects: Number(fresh?.total_projects ?? contentOverview.projects),
          documents: contentOverview.documents,
          presentations: contentOverview.presentations,
          diagrams: contentOverview.diagrams,
          notes: contentOverview.notes,
          task_lists: contentOverview.task_lists,
          tasks: contentOverview.tasks,
          analysis: Number(fresh?.total_analysis ?? contentOverview.analysis),
        },
      };
      await cache.setJson(cacheKey, payload, 60);
      return ok(payload);
    }

    const payload = {
      stats: {
        ...stats,
        total_documents: contentOverview.documents,
        total_presentations: contentOverview.presentations,
        total_diagrams: contentOverview.diagrams,
        total_notes: contentOverview.notes,
        total_task_lists: contentOverview.task_lists,
        total_tasks: contentOverview.tasks,
        projects: Number(stats.total_projects ?? contentOverview.projects),
        documents: contentOverview.documents,
        presentations: contentOverview.presentations,
        diagrams: contentOverview.diagrams,
        notes: contentOverview.notes,
        task_lists: contentOverview.task_lists,
        tasks: contentOverview.tasks,
        analysis: Number(stats.total_analysis ?? contentOverview.analysis),
      },
    };
    await cache.setJson(cacheKey, payload, 60);
    return ok(payload);
  })

  /**
   * POST /api/user/dashboard/stats/refresh
   *
   * Force-refresh the pre-computed dashboard stats.
   */
  .post("/dashboard/stats/refresh", async ({ headers }) => {
    const auth = await resolveAuth(headers);

    const [stats, contentOverview] = await Promise.all([
      dashboardRepository.refreshDashboardStats(auth.userId),
      dashboardRepository.getContentOverviewStatsForUser(auth.userId),
    ]);
    const payload = {
      stats: {
        ...stats,
        total_documents: contentOverview.documents,
        total_presentations: contentOverview.presentations,
        total_diagrams: contentOverview.diagrams,
        total_notes: contentOverview.notes,
        total_task_lists: contentOverview.task_lists,
        total_tasks: contentOverview.tasks,
        projects: Number(stats?.total_projects ?? contentOverview.projects),
        documents: contentOverview.documents,
        presentations: contentOverview.presentations,
        diagrams: contentOverview.diagrams,
        notes: contentOverview.notes,
        task_lists: contentOverview.task_lists,
        tasks: contentOverview.tasks,
        analysis: Number(stats?.total_analysis ?? contentOverview.analysis),
      },
      message: "Dashboard stats refreshed",
    };
    await cache.deletePattern(`user:${auth.userId}:dashboard*`);
    return ok(payload);
  });

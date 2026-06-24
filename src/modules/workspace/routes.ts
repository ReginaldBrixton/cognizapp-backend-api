import { Elysia, t } from "elysia";

import { cache } from "../../lib/cache";
import { fail, ok } from "../../lib/http";
import { HttpError } from "../../lib/errors";
import { resolveAuth } from "../auth/middleware";
import { workspaceService } from "./service";
import { settingsService as workspaceSettingsService } from "../workspace-settings/service";
import {
  ALLOWED_WORKSPACE_SECTIONS,
  READ_ONLY_WORKSPACE_SECTIONS,
} from "../workspace-settings/types";
import { sanitizeInput } from "../../lib/validation";

function toPage(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function assertWorkspaceSettingsSection(
  section: string,
): asserts section is (typeof ALLOWED_WORKSPACE_SECTIONS)[number] {
  if (!(ALLOWED_WORKSPACE_SECTIONS as readonly string[]).includes(section)) {
    throw new HttpError(400, "invalid_section", `Unknown section: ${section}`);
  }
}

function parseCreateWorkspaceBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_request", "Invalid request body");
  }

  return sanitizeInput(body as Record<string, unknown>) as Record<string, unknown>;
}

const WORKSPACE_LIST_CACHE_SECONDS = 30;

function workspaceListCacheKey(userId: string) {
  return `workspace:list:${userId}`;
}

async function invalidateWorkspaceListCache(userId: string) {
  try {
    await cache.deletePattern(workspaceListCacheKey(userId));
  } catch (error) {
    console.warn("[workspace] cache invalidation failed", {
      userId,
      plainEnglishMeaning:
        "The workspace changed, but the cached workspace list could not be cleared. It will refresh automatically when the short cache expires.",
      technicalMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

type UploadedFile = {
  name: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

function isUploadedFile(value: unknown): value is UploadedFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as { name?: unknown }).name === "string" &&
    "arrayBuffer" in value &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

export const workspaceRoutes = new Elysia({
  prefix: "/api/user/workspace",
  tags: ["workspace"],
})
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { success: false, error: error.message, errorCode: error.code };
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return { success: false, error: "Invalid request body", errorCode: "invalid_request" };
    }
    console.error("[workspace] Error:", error);
    set.status = 500;
    return { success: false, error: String(error) };
  })
  .get("/", async ({ headers, query }) => {
    console.log("[workspace] GET /");
    const auth = await resolveAuth(headers as any);
    console.log("[workspace] Auth resolved - userId:", auth.userId);
    const result = await cache.rememberJson(
      workspaceListCacheKey(auth.userId),
      WORKSPACE_LIST_CACHE_SECONDS,
      () => workspaceService.listWorkspaces(auth.userId, auth),
    );
    console.log("[workspace] Result:", result.workspaces?.length || 0, "workspaces");
    const page = toPage(
      typeof query.page === "string" ? query.page : undefined,
      1,
    );
    const pageSize = toPage(
      typeof query.page_size === "string" ? query.page_size : undefined,
      20,
    );
    const totalPages = Math.ceil(result.total / pageSize) || 1;

    return ok({
      workspaces: result.workspaces,
      policy: result.policy,
      pagination: {
        page,
        page_size: pageSize,
        total: result.total,
        total_pages: totalPages,
        has_next: page < totalPages,
        has_prev: page > 1,
      },
    });
  })
  .post(
    "/",
    async ({ headers, body, set }) => {
      try {
        const auth = await resolveAuth(headers);
        const payload = parseCreateWorkspaceBody(body);
        const workspace = await workspaceService.createWorkspace(
          auth.userId,
          payload,
        );
        await invalidateWorkspaceListCache(auth.userId);
        return ok({
          workspace,
          policy: await workspaceService.getPolicy(auth.userId),
        });
      } catch (error) {
        if (error instanceof HttpError) {
          set.status = error.status;
          return fail(error.message, error.code, error.details);
        }
        throw error;
      }
    },
  )
  .get("/default", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    return ok({
      workspace: await workspaceService.ensureDefaultWorkspace(
        auth.userId,
        auth.email,
        auth.email,
      ),
    });
  })
  .get("/details", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!query.id) {
      throw new HttpError(400, "missing_id", "Missing workspace ID");
    }
    return ok({
      workspace: await workspaceService.getWorkspace(
        auth.userId,
        String(query.id),
      ),
    });
  })
  .put(
    "/details",
    async ({ headers, query, body }) => {
      const auth = await resolveAuth(headers);
      if (!query.id) {
        throw new HttpError(400, "missing_id", "Missing workspace ID");
      }
      const workspace = await workspaceService.updateWorkspace(
        auth.userId,
        String(query.id),
        body,
        auth,
      );
      await invalidateWorkspaceListCache(auth.userId);
      return ok({
        workspace,
      });
    },
    { body: t.Any() },
  )
  .patch(
    "/details",
    async ({ headers, query, body }) => {
      const auth = await resolveAuth(headers);
      if (!query.id) {
        throw new HttpError(400, "missing_id", "Missing workspace ID");
      }
      const workspace = await workspaceService.updateWorkspace(
        auth.userId,
        String(query.id),
        body,
        auth,
      );
      await invalidateWorkspaceListCache(auth.userId);
      return ok({
        workspace,
      });
    },
    { body: t.Any() },
  )
  .delete("/details", async ({ headers, query, set }) => {
    try {
      const auth = await resolveAuth(headers);
      if (!query.id) {
        throw new HttpError(400, "missing_id", "Missing workspace ID");
      }
      await workspaceService.deleteWorkspace(auth.userId, String(query.id), auth);
      await invalidateWorkspaceListCache(auth.userId);
      return ok({ message: "Workspace deleted successfully" });
    } catch (error) {
      if (error instanceof HttpError) {
        set.status = error.status;
        return fail(error.message, error.code, error.details);
      }
      throw error;
    }
  })
  .get("/members", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!query.workspace_id) {
      throw new HttpError(400, "missing_workspace_id", "Missing workspace ID");
    }
    const members = await workspaceService.listMembers(
      auth.userId,
      String(query.workspace_id),
    );
    return ok({ members, count: members.length });
  })
  .post(
    "/members",
    async ({ headers, query, body }) => {
      const auth = await resolveAuth(headers);
      if (!query.workspace_id) {
        throw new HttpError(
          400,
          "missing_workspace_id",
          "Missing workspace ID",
        );
      }
      const member = await workspaceService.addMember(
        auth.userId,
        String(query.workspace_id),
        body.email,
        body.role,
      );
      return ok({ member });
    },
    {
      body: t.Object({
        email: t.String(),
        role: t.String(),
      }),
    },
  )
  .put(
    "/members/role",
    async ({ headers, query, body }) => {
      const auth = await resolveAuth(headers);
      if (!query.workspace_id) {
        throw new HttpError(
          400,
          "missing_workspace_id",
          "Missing workspace ID",
        );
      }
      const member = await workspaceService.updateMemberRole(
        auth.userId,
        String(query.workspace_id),
        body.userUid,
        body.role,
      );
      return ok({ member });
    },
    {
      body: t.Object({
        userUid: t.String(),
        role: t.String(),
      }),
    },
  )
  .patch(
    "/members/role",
    async ({ headers, query, body }) => {
      const auth = await resolveAuth(headers);
      if (!query.workspace_id) {
        throw new HttpError(
          400,
          "missing_workspace_id",
          "Missing workspace ID",
        );
      }
      const member = await workspaceService.updateMemberRole(
        auth.userId,
        String(query.workspace_id),
        body.userUid,
        body.role,
      );
      return ok({ member });
    },
    {
      body: t.Object({
        userUid: t.String(),
        role: t.String(),
      }),
    },
  )
  .get("/members/details", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!query.workspace_id || !query.member_uid) {
      throw new HttpError(
        400,
        "missing_params",
        "Missing workspace_id or member_uid",
      );
    }
    const members = await workspaceService.listMembers(
      auth.userId,
      String(query.workspace_id),
    );
    const member = members.find(
      (item) => item.userUid === String(query.member_uid),
    );
    if (!member) {
      throw new HttpError(404, "member_not_found", "Member not found");
    }
    return ok({ member });
  })
  .delete("/members/remove", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!query.workspace_id || !query.member_uid) {
      throw new HttpError(
        400,
        "missing_params",
        "Missing workspace_id or member_uid",
      );
    }
    await workspaceService.removeMember(
      auth.userId,
      String(query.workspace_id),
      String(query.member_uid),
    );
    return ok({ message: "Member removed successfully" });
  })
  .get("/activity", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!query.workspace_id) {
      throw new HttpError(400, "missing_workspace_id", "Missing workspace ID");
    }
    const skip = Number(query.skip ?? 0);
    const limit = Number(query.limit ?? 50);
    const result = await workspaceService.getActivity(
      auth.userId,
      String(query.workspace_id),
      skip,
      limit,
    );
    return ok({
      activities: result.activities,
      total: result.total,
      skip,
      limit,
    });
  })
  .get("/dashboard", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    const workspaceId = String(query.workspaceId ?? query.workspace_id ?? "");
    if (!workspaceId) {
      throw new HttpError(400, "missing_parameter", "workspaceId is required");
    }
    return ok({
      data: await cache.rememberJson(
        `workspace:dashboard:${auth.userId}:${workspaceId}`,
        30,
        () => workspaceService.dashboard(auth.userId, workspaceId),
      ),
    });
  })
  .post("/sync-counters", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    const workspaceId = String(query.workspace_id ?? query.id ?? "");
    if (!workspaceId) {
      throw new HttpError(400, "missing_id", "Missing workspace ID");
    }
    return ok({
      counters: await workspaceService.syncCounters(auth.userId, workspaceId),
    });
  })
  .get("/invitations", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!query.workspace_id) {
      throw new HttpError(
        400,
        "missing_workspace_id",
        "workspace_id is required",
      );
    }
    const invitations = await workspaceService.listInvitations(
      auth.userId,
      String(query.workspace_id),
    );
    return ok({ invitations, total: invitations.length });
  })
  .post(
    "/invitations",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);
      const invitation = await workspaceService.createInvitation(
        auth.userId,
        body.workspaceId,
        body.email,
        body.role,
      );
      return ok({
        invitation,
        note: "Send this token to the invitee via a secure channel.",
      });
    },
    {
      body: t.Object({
        workspaceId: t.String(),
        email: t.String(),
        role: t.String(),
      }),
    },
  )
  .delete("/invitations", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!query.token) {
      throw new HttpError(
        400,
        "missing_token",
        "token query parameter is required",
      );
    }
    await workspaceService.declineInvitation(auth.userId, String(query.token));
    return ok({ message: "Invitation declined." });
  })
  .post("/invitations/accept", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!query.token) {
      throw new HttpError(
        400,
        "missing_token",
        "token query parameter is required",
      );
    }
    await workspaceService.acceptInvitation(auth.userId, String(query.token));
    return ok({
      message: "Invitation accepted. You are now a member of the workspace.",
    });
  })
  .delete("/invitations/revoke", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!query.invitation_id) {
      throw new HttpError(
        400,
        "missing_invitation_id",
        "invitation_id is required",
      );
    }
    await workspaceService.revokeInvitation(
      auth.userId,
      String(query.invitation_id),
    );
    return ok({ message: "Invitation revoked." });
  })
  .get("/search", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    if (!query.workspace_id) {
      throw new HttpError(
        400,
        "missing_workspace_id",
        "workspace_id is required",
      );
    }
    if (!query.q) {
      throw new HttpError(400, "missing_query", "q (search query) is required");
    }
    const limit = Number(query.limit ?? 20);
    const type = String(query.type ?? "all");
    const searchText = String(query.q);
    const results = await workspaceService.search(
      auth.userId,
      String(query.workspace_id),
      searchText,
      type,
      limit,
    );
    return ok({ data: { results, total: results.length, query: searchText } });
  })
  .get("/:id/storage", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    return await cache.rememberJson(
      `workspace:storage:${auth.userId}:${String(params.id)}`,
      30,
      () => workspaceService.getStorageInfo(
        auth.userId,
        String(params.id),
      ),
    );
  })
  .get("/:id/storage/quota", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    return await cache.rememberJson(
      `workspace:storage-quota:${auth.userId}:${String(params.id)}`,
      30,
      () => workspaceService.getQuotaStatus(
        auth.userId,
        String(params.id),
      ),
    );
  })
  .post("/:id/storage/sync", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const storage = await workspaceService.syncStorageUsage(
      auth.userId,
      String(params.id),
    );
    return ok({ message: "Storage usage updated successfully", storage });
  })
  .post(
    "/:id/storage/check-quota",
    async ({ headers, params, body, set }) => {
      const auth = await resolveAuth(headers);
      try {
        await workspaceService.checkQuota(
          auth.userId,
          String(params.id),
          body.additionalBytes,
        );
        return { allowed: true };
      } catch (error) {
        if (error instanceof HttpError) {
          set.status = 200;
          return { allowed: false, reason: error.message };
        }
        throw error;
      }
    },
    {
      body: t.Object({
        additionalBytes: t.Numeric(),
      }),
    },
  )
  .post("/:id/storage/upload", async ({ headers, params, request }) => {
    const auth = await resolveAuth(headers);
    const form = await request.formData();
    const file = form.get("file");
    if (!isUploadedFile(file)) {
      throw new HttpError(400, "invalid_request", "File is required");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileId = await workspaceService.uploadFile(
      auth.userId,
      String(params.id),
      file.name,
      bytes,
    );
    return ok({
      message: "File uploaded successfully",
      fileId,
      fileName: file.name,
      size: bytes.length,
    });
  })

  // ── GET /api/user/workspace/settings ───────────────────────────────────────
  .get("/settings", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    const workspaceId = String(query.workspace_id ?? query.id ?? "");
    if (!workspaceId) {
      throw new HttpError(
        400,
        "missing_workspace_id",
        "workspace_id is required",
      );
    }
    const workspace = await workspaceService.getWorkspace(
      auth.userId,
      workspaceId,
    );
    const settings = await workspaceSettingsService.getSettings(workspaceId);
    return ok({ settings });
  })

  // ── PUT /api/user/workspace/settings ───────────────────────────────────────
  .put(
    "/settings",
    async ({ headers, query, body }) => {
      const auth = await resolveAuth(headers);
      const workspaceId = String(query.workspace_id ?? query.id ?? "");
      if (!workspaceId) {
        throw new HttpError(
          400,
          "missing_workspace_id",
          "workspace_id is required",
        );
      }
      await workspaceService.getWorkspace(auth.userId, workspaceId);
      const updates = body as Record<string, unknown>;

      const invalid = Object.keys(updates).filter(
        (k) => !(ALLOWED_WORKSPACE_SECTIONS as readonly string[]).includes(k),
      );
      if (invalid.length) {
        throw new HttpError(
          400,
          "invalid_section",
          `Unknown sections: ${invalid.join(", ")}`,
        );
      }

      const readOnly = Object.keys(updates).filter((k) =>
        READ_ONLY_WORKSPACE_SECTIONS.includes(
          k as (typeof ALLOWED_WORKSPACE_SECTIONS)[number],
        ),
      );
      if (readOnly.length) {
        throw new HttpError(
          403,
          "read_only_section",
          `These sections are read-only: ${readOnly.join(", ")}`,
        );
      }

      for (const [section, data] of Object.entries(updates)) {
        if (data && typeof data === "object" && !Array.isArray(data)) {
          const sanitized = sanitizeInput(data) as Record<string, unknown>;
          await workspaceSettingsService.updateSection(
            workspaceId,
            section as (typeof ALLOWED_WORKSPACE_SECTIONS)[number],
            sanitized,
          );
        }
      }

      const settings = await workspaceSettingsService.getSettings(workspaceId);
      return ok({ settings });
    },
    { body: t.Record(t.String(), t.Unknown()) },
  )

  // ── PATCH /api/user/workspace/settings (alias for PUT) ─────────────────────
  .patch(
    "/settings",
    async ({ headers, query, body }) => {
      const auth = await resolveAuth(headers);
      const workspaceId = String(query.workspace_id ?? query.id ?? "");
      if (!workspaceId) {
        throw new HttpError(
          400,
          "missing_workspace_id",
          "workspace_id is required",
        );
      }
      await workspaceService.getWorkspace(auth.userId, workspaceId);
      const updates = body as Record<string, unknown>;

      const invalid = Object.keys(updates).filter(
        (k) => !(ALLOWED_WORKSPACE_SECTIONS as readonly string[]).includes(k),
      );
      if (invalid.length) {
        throw new HttpError(
          400,
          "invalid_section",
          `Unknown sections: ${invalid.join(", ")}`,
        );
      }

      const readOnly = Object.keys(updates).filter((k) =>
        READ_ONLY_WORKSPACE_SECTIONS.includes(
          k as (typeof ALLOWED_WORKSPACE_SECTIONS)[number],
        ),
      );
      if (readOnly.length) {
        throw new HttpError(
          403,
          "read_only_section",
          `These sections are read-only: ${readOnly.join(", ")}`,
        );
      }

      for (const [section, data] of Object.entries(updates)) {
        if (data && typeof data === "object" && !Array.isArray(data)) {
          const sanitized = sanitizeInput(data) as Record<string, unknown>;
          await workspaceSettingsService.updateSection(
            workspaceId,
            section as (typeof ALLOWED_WORKSPACE_SECTIONS)[number],
            sanitized,
          );
        }
      }

      const settings = await workspaceSettingsService.getSettings(workspaceId);
      return ok({ settings });
    },
    { body: t.Record(t.String(), t.Unknown()) },
  )
  .get("/settings/:section", async ({ headers, query, params }) => {
    const auth = await resolveAuth(headers);
    const workspaceId = String(query.workspace_id ?? query.id ?? "");
    if (!workspaceId) {
      throw new HttpError(
        400,
        "missing_workspace_id",
        "workspace_id is required",
      );
    }

    const section = String(params.section);
    assertWorkspaceSettingsSection(section);

    await workspaceService.getWorkspace(auth.userId, workspaceId);
    const settings = await workspaceSettingsService.getSettings(workspaceId);
    return ok({
      [section]: (settings as Record<string, unknown>)[section] ?? {},
    });
  })
  .put(
    "/settings/:section",
    async ({ headers, query, params, body }) => {
      const auth = await resolveAuth(headers);
      const workspaceId = String(query.workspace_id ?? query.id ?? "");
      if (!workspaceId) {
        throw new HttpError(
          400,
          "missing_workspace_id",
          "workspace_id is required",
        );
      }

      const section = String(params.section);
      assertWorkspaceSettingsSection(section);
      if (READ_ONLY_WORKSPACE_SECTIONS.includes(section)) {
        throw new HttpError(
          403,
          "read_only_section",
          `Section '${section}' is read-only`,
        );
      }

      await workspaceService.getWorkspace(auth.userId, workspaceId);
      const sanitized = sanitizeInput(body) as Record<string, unknown>;
      await workspaceSettingsService.updateSection(workspaceId, section, sanitized);

      const settings = await workspaceSettingsService.getSettings(workspaceId);
      return ok({
        [section]: (settings as Record<string, unknown>)[section] ?? {},
      });
    },
    { body: t.Record(t.String(), t.Unknown()) },
  )
  .patch(
    "/settings/:section",
    async ({ headers, query, params, body }) => {
      const auth = await resolveAuth(headers);
      const workspaceId = String(query.workspace_id ?? query.id ?? "");
      if (!workspaceId) {
        throw new HttpError(
          400,
          "missing_workspace_id",
          "workspace_id is required",
        );
      }

      const section = String(params.section);
      assertWorkspaceSettingsSection(section);
      if (READ_ONLY_WORKSPACE_SECTIONS.includes(section)) {
        throw new HttpError(
          403,
          "read_only_section",
          `Section '${section}' is read-only`,
        );
      }

      await workspaceService.getWorkspace(auth.userId, workspaceId);
      const sanitized = sanitizeInput(body) as Record<string, unknown>;
      await workspaceSettingsService.updateSection(workspaceId, section, sanitized);

      const settings = await workspaceSettingsService.getSettings(workspaceId);
      return ok({
        [section]: (settings as Record<string, unknown>)[section] ?? {},
      });
    },
    { body: t.Record(t.String(), t.Unknown()) },
  )
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(error.message, error.code, error.details);
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return fail("Invalid request", "invalid_request");
    }
  });

import { Elysia, t } from "elysia";
import { HttpError } from "../../lib/errors";
import { resolveAuth } from "../auth/middleware";
import { projectService } from "../workspace-projects/service";
import { isValidUuid } from "../../lib/validation";
import { ok } from "../../lib/http";

const ProjectDashboardFilterQuery = t.Object({
  period: t.Optional(t.Union([t.Literal("7d"), t.Literal("30d"), t.Literal("90d")])),
});

export const projectDashboardRoutes = new Elysia({ prefix: "/api/workspace/:workspaceId/projects/:projectId", tags: ["project-dashboard"] })
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { success: false, error: error.message, errorCode: error.code };
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return { success: false, error: "Invalid request body", errorCode: "invalid_request" };
    }
    console.error("[project-dashboard] Error:", error);
    set.status = 500;
    return { success: false, error: "Internal server error", errorCode: "internal_error" };
  })
  .get("/dashboard", async ({ headers, params, query }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers as any);
    const project = await projectService.getProject(auth.userId, params.workspaceId, params.projectId);

    return ok({
      project,
      stats: {
        documentCount: project.documentCount || 0,
        taskCount: project.taskCount || 0,
        completedTasks: project.completedTasks || 0,
      },
      recentActivity: [],
    });
  });

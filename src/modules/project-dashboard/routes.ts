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
    console.error("[project-dashboard] Error:", error);
  })
  .get("/dashboard", async ({ headers, params, query }) => {
    console.log("[dashboard] GET /dashboard - workspaceId:", params.workspaceId, "projectId:", params.projectId);
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      console.log("[dashboard] Invalid UUID");
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers as any);
    console.log("[dashboard] Auth resolved - userId:", auth.userId);

    console.log("[dashboard] Calling projectService.getProject...");
    const project = await projectService.getProject(auth.userId, params.workspaceId, params.projectId);
    console.log("[dashboard] Project loaded:", project.id, "title:", project.title);

    const result = ok({
      project,
      stats: {
        documentCount: project.documentCount || 0,
        taskCount: project.taskCount || 0,
        completedTasks: project.completedTasks || 0,
      },
      recentActivity: [],
    });
    console.log("[dashboard] Result:", JSON.stringify(result).substring(0, 200));
    return result;
  });

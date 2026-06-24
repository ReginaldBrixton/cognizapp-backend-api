import { Elysia, t } from "elysia";
import { HttpError } from "../../lib/errors";
import { resolveAuth } from "../auth/middleware";
import { projectService } from "./service";
import { isValidUuid, sanitizeInput, VALIDATION_LIMITS } from "../../lib/validation";

const ProjectBody = t.Object({
  title: t.String({ minLength: 1, maxLength: VALIDATION_LIMITS.TITLE_MAX_LENGTH }),
  description: t.Optional(t.String({ maxLength: VALIDATION_LIMITS.DESCRIPTION_MAX_LENGTH })),
  visibility: t.Optional(t.Union([t.Literal("private"), t.Literal("workspace"), t.Literal("public")])),
  fieldOfStudy: t.Optional(t.String({ maxLength: VALIDATION_LIMITS.NAME_MAX_LENGTH })),
  projectType: t.Optional(t.String({ maxLength: VALIDATION_LIMITS.NAME_MAX_LENGTH })),
  keywords: t.Optional(t.Array(t.String({ maxLength: VALIDATION_LIMITS.KEYWORD_MAX_LENGTH }), { maxLength: VALIDATION_LIMITS.KEYWORDS_MAX_COUNT })),
  deadline: t.Optional(t.String({ maxLength: 50 })),
});

export const projectRoutes = new Elysia({ prefix: "/api/workspace/:workspaceId/projects", tags: ["workspace-projects"] })
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { success: false, error: error.message, errorCode: error.code };
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return { success: false, error: "Invalid request body", errorCode: "invalid_request" };
    }
    console.error("[projects] Error:", error);
    set.status = 500;
    return { success: false, error: String(error) };
  })
  .get("/", async ({ headers, params }) => {
    console.log("[projects] GET / - workspaceId:", params.workspaceId);
    if (!isValidUuid(params.workspaceId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid workspace ID");
    }
    const auth = await resolveAuth(headers as any);
    console.log("[projects] Auth resolved - userId:", auth.userId);

    const result = await projectService.listProjects(auth.userId, params.workspaceId);
    console.log("[projects] Result:", result.length, "projects");
    return result;
  })
  .post("/", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid workspace ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body) as Record<string, unknown>;
    return await projectService.createProject(auth.userId, params.workspaceId, sanitized);
  }, {
    body: ProjectBody,
  })
  .get("/:projectId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await projectService.getProject(auth.userId, params.workspaceId, params.projectId);
  })
  .put("/:projectId", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body) as Record<string, unknown>;
    return await projectService.updateProject(auth.userId, params.workspaceId, params.projectId, sanitized);
  }, { body: t.Any() })
  .delete("/:projectId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await projectService.deleteProject(auth.userId, params.workspaceId, params.projectId);
  });

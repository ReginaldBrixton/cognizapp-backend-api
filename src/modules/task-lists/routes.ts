import { Elysia, t } from "elysia";
import { HttpError } from "../../lib/errors";
import { resolveAuth } from "../auth/middleware";
import { taskListService } from "./service";
import { isValidUuid, sanitizeInput } from "../../lib/validation";

const CreateTaskListBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 255 }),
  description: t.Optional(t.String()),
  status: t.Optional(t.Union([t.Literal("active"), t.Literal("archived"), t.Literal("trashed")])),
});

const UpdateTaskListBody = t.Partial(CreateTaskListBody);

const TaskListFilterQuery = t.Object({
  search: t.Optional(t.String()),
  status: t.Optional(t.Union([t.Literal("active"), t.Literal("archived"), t.Literal("trashed")])),
  sortBy: t.Optional(t.Union([t.Literal("created_at"), t.Literal("updated_at"), t.Literal("order")])),
  sortOrder: t.Optional(t.Union([t.Literal("asc"), t.Literal("desc")])),
  page: t.Optional(t.Number({ minimum: 1 })),
  limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
});

export const taskListRoutes = new Elysia({ prefix: "/api/workspace/:workspaceId/projects/:projectId/task-lists", tags: ["task-lists"] })
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { success: false, error: error.message, errorCode: error.code };
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return { success: false, error: "Invalid request body", errorCode: "invalid_request" };
    }
    console.error("[task-lists] Error:", error);
    return { success: false, error: "Internal server error" };
  })
  .get("/", async ({ headers, params, query }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers as any);
    const filter = sanitizeInput(query) as Record<string, unknown>;
    return await taskListService.listTaskLists(auth.userId, params.workspaceId, params.projectId, filter as any);
  }, { query: TaskListFilterQuery })
  .post("/", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers as any);
    const sanitized = sanitizeInput(body);
    return await taskListService.createTaskList(auth.userId, params.workspaceId, params.projectId, sanitized as any);
  }, { body: CreateTaskListBody })
  .get("/:listId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.listId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers as any);
    return await taskListService.getTaskList(auth.userId, params.workspaceId, params.projectId, params.listId);
  })
  .put("/:listId", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.listId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers as any);
    const sanitized = sanitizeInput(body);
    return await taskListService.updateTaskList(auth.userId, params.workspaceId, params.projectId, params.listId, sanitized as any);
  }, { body: UpdateTaskListBody })
  .delete("/:listId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.listId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers as any);
    return await taskListService.deleteTaskList(auth.userId, params.workspaceId, params.projectId, params.listId);
  });

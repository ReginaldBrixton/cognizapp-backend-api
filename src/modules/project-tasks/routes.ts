import { Elysia, t } from "elysia";
import { HttpError } from "../../lib/errors";
import { handleRouteError } from "../../lib/route-helpers";
import { resolveAuth } from "../auth/middleware";
import { taskService } from "./service";
import { isValidUuid, sanitizeInput, VALIDATION_LIMITS } from "../../lib/validation";

const TaskStatus = t.Union([
  t.Literal("todo"),
  t.Literal("in_progress"),
  t.Literal("in-progress"),
  t.Literal("in_review"),
  t.Literal("review"),
  t.Literal("blocked"),
  t.Literal("done"),
  t.Literal("cancelled"),
]);

const TaskPriority = t.Union([
  t.Literal("low"),
  t.Literal("medium"),
  t.Literal("high"),
  t.Literal("urgent"),
  t.Literal("critical"),
]);

const CreateTaskBody = t.Object({
  title: t.String({ minLength: 1, maxLength: VALIDATION_LIMITS.TITLE_MAX_LENGTH }),
  description: t.Optional(t.String({ maxLength: VALIDATION_LIMITS.DESCRIPTION_MAX_LENGTH })),
  status: t.Optional(TaskStatus),
  priority: t.Optional(TaskPriority),
  taskType: t.Optional(t.String()),
  dueDate: t.Optional(t.String()),
  estimatedHours: t.Optional(t.Number()),
  tags: t.Optional(t.Array(t.String())),
  attachments: t.Optional(t.Array(t.Any())),
  subtasks: t.Optional(t.Array(t.Any())),
  documentId: t.Optional(t.String()),
  slideId: t.Optional(t.String()),
  noteId: t.Optional(t.String()),
  metadata: t.Optional(t.Any()),
});

const UpdateTaskBody = t.Partial(t.Object({
  ...CreateTaskBody.properties,
  assigneeUid: t.Optional(t.String()),
  displayOrder: t.Optional(t.Number()),
  startedAt: t.Optional(t.String()),
  completedAt: t.Optional(t.String()),
  actualHours: t.Optional(t.Number()),
}));

const TaskFilterQuery = t.Object({
  search: t.Optional(t.String()),
  status: t.Optional(TaskStatus),
  priority: t.Optional(TaskPriority),
  assigneeUid: t.Optional(t.String()),
  taskType: t.Optional(t.String()),
  sortBy: t.Optional(t.Union([t.Literal("created_at"), t.Literal("updated_at"), t.Literal("due_date"), t.Literal("display_order")])),
  sortOrder: t.Optional(t.Union([t.Literal("asc"), t.Literal("desc")])),
  page: t.Optional(t.Number({ minimum: 1 })),
  limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
});

const BatchBody = t.Object({
  items: t.Array(CreateTaskBody),
});

export const taskRoutes = new Elysia({ prefix: "/api/workspace/:workspaceId/projects/:projectId/tasks", tags: ["project-tasks"] })
  .onError(handleRouteError)
  .get("/", async ({ headers, params, query }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const filter = sanitizeInput(query) as Record<string, unknown>;
    return await taskService.listTasks(auth.userId, params.workspaceId, params.projectId, filter as any);
  }, { query: TaskFilterQuery })
  .post("/", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    return await taskService.createTask(auth.userId, params.workspaceId, params.projectId, sanitized as any);
  }, { body: CreateTaskBody })
  .get("/:taskId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.taskId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await taskService.getTask(auth.userId, params.workspaceId, params.projectId, params.taskId);
  })
  .put("/:taskId", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.taskId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    return await taskService.updateTask(auth.userId, params.workspaceId, params.projectId, params.taskId, sanitized as any);
  }, { body: UpdateTaskBody })
  .delete("/:taskId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.taskId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await taskService.deleteTask(auth.userId, params.workspaceId, params.projectId, params.taskId);
  })
  .post("/batch", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    const items = (sanitized as any).items || [];
    return await taskService.batchCreate(auth.userId, params.workspaceId, params.projectId, items);
  }, { body: BatchBody });

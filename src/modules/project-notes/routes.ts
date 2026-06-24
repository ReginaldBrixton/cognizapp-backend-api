import { Elysia, t } from "elysia";
import { HttpError } from "../../lib/errors";
import { handleRouteError } from "../../lib/route-helpers";
import { resolveAuth } from "../auth/middleware";
import { noteService } from "./service";
import { isValidUuid, sanitizeInput, VALIDATION_LIMITS } from "../../lib/validation";

const CreateNoteBody = t.Object({
  title: t.Optional(t.String({ minLength: 1, maxLength: VALIDATION_LIMITS.TITLE_MAX_LENGTH })),
  content: t.Optional(t.String({ maxLength: VALIDATION_LIMITS.DOCUMENT_CONTENT_MAX_LENGTH })),
  contentJson: t.Optional(t.Any()),
  metadata: t.Optional(t.Any()),
});

const UpdateNoteBody = t.Partial(t.Object({
  ...CreateNoteBody.properties,
  status: t.Union([t.Literal("active"), t.Literal("archived"), t.Literal("trashed")]),
  isPublic: t.Boolean(),
}));

const NoteFilterQuery = t.Object({
  search: t.Optional(t.String()),
  status: t.Optional(t.Union([t.Literal("active"), t.Literal("archived"), t.Literal("trashed")])),
  sortBy: t.Optional(t.Union([t.Literal("created_at"), t.Literal("updated_at"), t.Literal("title")])),
  sortOrder: t.Optional(t.Union([t.Literal("asc"), t.Literal("desc")])),
  page: t.Optional(t.Number({ minimum: 1 })),
  limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
});

const BatchBody = t.Object({
  items: t.Array(t.Object({
    title: t.Optional(t.String()),
    content: t.Optional(t.String()),
  })),
});

export const noteRoutes = new Elysia({ prefix: "/api/workspace/:workspaceId/projects/:projectId/notes", tags: ["project-notes"] })
  .onError(handleRouteError)
  .get("/", async ({ headers, params, query }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const filter = sanitizeInput(query) as Record<string, unknown>;
    return await noteService.listNotes(auth.userId, params.workspaceId, params.projectId, filter as any);
  }, { query: NoteFilterQuery })
  .post("/", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    return await noteService.createNote(auth.userId, params.workspaceId, params.projectId, sanitized as any);
  }, { body: CreateNoteBody })
  .get("/:noteId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.noteId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await noteService.getNote(auth.userId, params.workspaceId, params.projectId, params.noteId);
  })
  .put("/:noteId", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.noteId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    return await noteService.updateNote(auth.userId, params.workspaceId, params.projectId, params.noteId, sanitized as any);
  }, { body: UpdateNoteBody })
  .delete("/:noteId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.noteId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await noteService.deleteNote(auth.userId, params.workspaceId, params.projectId, params.noteId);
  })
  .post("/batch", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    const items = (sanitized as any).items || [];
    return await noteService.batchCreate(auth.userId, params.workspaceId, params.projectId, items);
  }, { body: BatchBody });

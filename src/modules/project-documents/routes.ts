import { Elysia, t } from "elysia";
import { HttpError } from "../../lib/errors";
import { handleRouteError } from "../../lib/route-helpers";
import { resolveAuth } from "../auth/middleware";
import { documentService } from "./service";
import { isValidUuid, sanitizeInput, VALIDATION_LIMITS } from "../../lib/validation";

const CreateDocumentBody = t.Object({
  title: t.Optional(t.String({ minLength: 1, maxLength: VALIDATION_LIMITS.TITLE_MAX_LENGTH })),
  docType: t.Optional(t.Union([
    t.Literal("document"),
    t.Literal("spreadsheet"),
    t.Literal("presentation"),
    t.Literal("note"),
    t.Literal("bibliography"),
  ])),
  content: t.Optional(t.String({ maxLength: VALIDATION_LIMITS.DOCUMENT_CONTENT_MAX_LENGTH })),
  contentJson: t.Optional(t.Any()),
  isTemplate: t.Optional(t.Boolean()),
  parentId: t.Optional(t.String()),
  abstract: t.Optional(t.String({ maxLength: 1000 })),
  keywords: t.Optional(t.Array(t.String({ maxLength: VALIDATION_LIMITS.KEYWORD_MAX_LENGTH }), { maxLength: VALIDATION_LIMITS.KEYWORDS_MAX_COUNT })),
  metadata: t.Optional(t.Any()),
});

const UpdateDocumentBody = t.Partial(CreateDocumentBody);
const UpdateDocumentBodyWithStatus = t.Partial(t.Object({
  ...CreateDocumentBody.properties,
  status: t.Union([t.Literal("active"), t.Literal("archived"), t.Literal("trashed")]),
  isPublic: t.Boolean(),
}));

const DocumentFilterQuery = t.Object({
  search: t.Optional(t.String()),
  docType: t.Optional(t.Union([
    t.Literal("document"),
    t.Literal("spreadsheet"),
    t.Literal("presentation"),
    t.Literal("note"),
    t.Literal("bibliography"),
  ])),
  status: t.Optional(t.Union([t.Literal("active"), t.Literal("archived"), t.Literal("trashed")])),
  sortBy: t.Optional(t.Union([t.Literal("created_at"), t.Literal("updated_at"), t.Literal("title")])),
  sortOrder: t.Optional(t.Union([t.Literal("asc"), t.Literal("desc")])),
  page: t.Optional(t.Number({ minimum: 1 })),
  limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
});

const BatchBody = t.Object({
  items: t.Array(t.Object({
    title: t.Optional(t.String()),
    docType: t.Optional(t.String()),
    content: t.Optional(t.String()),
  })),
});

export const documentRoutes = new Elysia({ prefix: "/api/workspace/:workspaceId/projects/:projectId/documents", tags: ["project-documents"] })
  .onError(handleRouteError)
  .get("/", async ({ headers, params, query }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers as any);
    const filter = sanitizeInput(query) as Record<string, unknown>;
    return await documentService.listDocuments(auth.userId, params.workspaceId, params.projectId, filter as any);
  }, { query: DocumentFilterQuery })
  .post("/", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    return await documentService.createDocument(auth.userId, params.workspaceId, params.projectId, sanitized as any);
  }, { body: CreateDocumentBody })
  .get("/:documentId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.documentId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await documentService.getDocument(auth.userId, params.workspaceId, params.projectId, params.documentId);
  })
  .put("/:documentId", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.documentId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    return await documentService.updateDocument(auth.userId, params.workspaceId, params.projectId, params.documentId, sanitized as any);
  }, { body: UpdateDocumentBodyWithStatus })
  .delete("/:documentId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.documentId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await documentService.deleteDocument(auth.userId, params.workspaceId, params.projectId, params.documentId);
  })
  .get("/:documentId/versions", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.documentId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await documentService.getVersions(auth.userId, params.workspaceId, params.projectId, params.documentId);
  })
  .post("/:documentId/restore/:version", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.documentId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const version = parseInt(params.version, 10);
    if (isNaN(version)) {
      throw new HttpError(400, "invalid_version", "Version must be a number");
    }
    const auth = await resolveAuth(headers);
    return await documentService.restoreVersion(auth.userId, params.workspaceId, params.projectId, params.documentId, version);
  })
  .post("/batch", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    const items = (sanitized as any).items || [];
    return await documentService.batchCreate(auth.userId, params.workspaceId, params.projectId, items);
  }, { body: BatchBody });

import { Elysia, t } from "elysia";
import { HttpError } from "../../lib/errors";
import { handleRouteError } from "../../lib/route-helpers";
import { resolveAuth } from "../auth/middleware";
import { diagramService } from "./service";
import { isValidUuid, sanitizeInput, VALIDATION_LIMITS } from "../../lib/validation";

const CreateDiagramBody = t.Object({
  title: t.Optional(t.String({ minLength: 1, maxLength: VALIDATION_LIMITS.TITLE_MAX_LENGTH })),
  diagramType: t.Optional(t.Union([
    t.Literal("mermaid"),
    t.Literal("drawio"),
    t.Literal("plantuml"),
    t.Literal("excalidraw"),
    t.Literal("svg"),
  ])),
  diagramData: t.Optional(t.Any()),
  metadata: t.Optional(t.Any()),
});

const UpdateDiagramBody = t.Partial(t.Object({
  ...CreateDiagramBody.properties,
  status: t.Union([t.Literal("active"), t.Literal("archived"), t.Literal("trashed")]),
  isPublic: t.Boolean(),
}));

const DiagramFilterQuery = t.Object({
  search: t.Optional(t.String()),
  diagramType: t.Optional(t.Union([
    t.Literal("mermaid"),
    t.Literal("drawio"),
    t.Literal("plantuml"),
    t.Literal("excalidraw"),
    t.Literal("svg"),
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
    diagramType: t.Optional(t.String()),
    diagramData: t.Optional(t.Any()),
  })),
});

export const diagramRoutes = new Elysia({ prefix: "/api/workspace/:workspaceId/projects/:projectId/diagrams", tags: ["project-diagrams"] })
  .onError(handleRouteError)
  .get("/", async ({ headers, params, query }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers as any);
    const filter = sanitizeInput(query) as Record<string, unknown>;
    return await diagramService.listDiagrams(auth.userId, params.workspaceId, params.projectId, filter as any);
  }, { query: DiagramFilterQuery })
  .post("/", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    return await diagramService.createDiagram(auth.userId, params.workspaceId, params.projectId, sanitized as any);
  }, { body: CreateDiagramBody })
  .get("/:diagramId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.diagramId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await diagramService.getDiagram(auth.userId, params.workspaceId, params.projectId, params.diagramId);
  })
  .put("/:diagramId", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.diagramId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    return await diagramService.updateDiagram(auth.userId, params.workspaceId, params.projectId, params.diagramId, sanitized as any);
  }, { body: UpdateDiagramBody })
  .delete("/:diagramId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.diagramId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await diagramService.deleteDiagram(auth.userId, params.workspaceId, params.projectId, params.diagramId);
  })
  .post("/batch", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    const items = (sanitized as any).items || [];
    return await diagramService.batchCreate(auth.userId, params.workspaceId, params.projectId, items);
  }, { body: BatchBody });
import { Elysia, t } from "elysia";
import { HttpError } from "../../lib/errors";
import { handleRouteError } from "../../lib/route-helpers";
import { resolveAuth } from "../auth/middleware";
import { slideService } from "./service";
import { isValidUuid, sanitizeInput, VALIDATION_LIMITS } from "../../lib/validation";

const CreateSlideBody = t.Object({
  title: t.Optional(t.String({ minLength: 1, maxLength: VALIDATION_LIMITS.TITLE_MAX_LENGTH })),
  slideData: t.Optional(t.Any()),
  isTemplate: t.Optional(t.Boolean()),
  metadata: t.Optional(t.Any()),
});

const UpdateSlideBody = t.Partial(t.Object({
  ...CreateSlideBody.properties,
  status: t.Union([t.Literal("active"), t.Literal("archived"), t.Literal("trashed")]),
  isPublic: t.Boolean(),
}));

const SlideFilterQuery = t.Object({
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
    slideData: t.Optional(t.Any()),
  })),
});

export const slideRoutes = new Elysia({ prefix: "/api/workspace/:workspaceId/projects/:projectId/slides", tags: ["project-slides"] })
  .onError(handleRouteError)
  .get("/", async ({ headers, params, query }) => {
    console.log("[slides] GET / - workspaceId:", params.workspaceId, "projectId:", params.projectId, "filter:", JSON.stringify(query));
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      console.log("[slides] Invalid UUID");
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers as any);
    console.log("[slides] Auth resolved - userId:", auth.userId);
    const filter = sanitizeInput(query) as Record<string, unknown>;
    console.log("[slides] Calling service...");
    const result = await slideService.listSlides(auth.userId, params.workspaceId, params.projectId, filter as any);
    console.log("[slides] Result:", JSON.stringify(result).substring(0, 200));
    return result;
  }, { query: SlideFilterQuery })
  .post("/", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    return await slideService.createSlide(auth.userId, params.workspaceId, params.projectId, sanitized as any);
  }, { body: CreateSlideBody })
  .get("/:slideId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.slideId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await slideService.getSlide(auth.userId, params.workspaceId, params.projectId, params.slideId);
  })
  .put("/:slideId", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.slideId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    return await slideService.updateSlide(auth.userId, params.workspaceId, params.projectId, params.slideId, sanitized as any);
  }, { body: UpdateSlideBody })
  .delete("/:slideId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId) || !isValidUuid(params.slideId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await slideService.deleteSlide(auth.userId, params.workspaceId, params.projectId, params.slideId);
  })
  .post("/batch", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.projectId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body);
    const items = (sanitized as any).items || [];
    return await slideService.batchCreate(auth.userId, params.workspaceId, params.projectId, items);
  }, { body: BatchBody });
import { Elysia, t } from "elysia";
import { HttpError } from "../../lib/errors";
import { fail } from "../../lib/http";
import { resolveAuth } from "../auth/middleware";
import { collectionService } from "./service";
import { isValidUuid, sanitizeInput, VALIDATION_LIMITS } from "../../lib/validation";

const CollectionBody = t.Object({
  name: t.String({ minLength: 1, maxLength: VALIDATION_LIMITS.NAME_MAX_LENGTH }),
  description: t.Optional(t.String({ maxLength: VALIDATION_LIMITS.DESCRIPTION_MAX_LENGTH })),
  collectionType: t.Union([t.Literal("folder"), t.Literal("tag"), t.Literal("smart")]),
  parentId: t.Optional(t.String({ format: "uuid" })),
});

const CollectionItemBody = t.Object({
  itemType: t.Union([t.Literal("project"), t.Literal("document"), t.Literal("analysis")]),
  itemId: t.String({ format: "uuid" }),
});

export const collectionRoutes = new Elysia({ prefix: "/api/workspace/:workspaceId/collections", tags: ["workspace-collections"] })
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(error.message, error.code, error.details);
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return fail("Invalid request body", "invalid_request");
    }
  })
  .get("/", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid workspace ID");
    }
    const auth = await resolveAuth(headers);
    return await collectionService.listCollections(auth.userId, params.workspaceId);
  })
  .post("/", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid workspace ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body) as Record<string, unknown>;
    return await collectionService.createCollection(auth.userId, params.workspaceId, sanitized);
  }, {
    body: CollectionBody,
  })
  .get("/:collectionId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.collectionId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await collectionService.getCollection(auth.userId, params.workspaceId, params.collectionId);
  })
  .put("/:collectionId", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.collectionId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body) as Record<string, unknown>;
    return await collectionService.updateCollection(auth.userId, params.workspaceId, params.collectionId, sanitized);
  }, { body: t.Any() })
  .delete("/:collectionId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.collectionId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await collectionService.deleteCollection(auth.userId, params.workspaceId, params.collectionId);
  })
  .post("/:collectionId/items", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.collectionId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body) as Record<string, unknown>;
    return await collectionService.addItem(auth.userId, params.workspaceId, params.collectionId, sanitized);
  }, {
    body: CollectionItemBody,
  })
  .delete("/:collectionId/items/:itemId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.collectionId) || !isValidUuid(params.itemId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await collectionService.removeItem(auth.userId, params.workspaceId, params.collectionId, params.itemId);
  });

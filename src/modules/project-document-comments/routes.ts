import { Elysia, t } from "elysia";
import { HttpError } from "../../lib/errors";
import { handleRouteError } from "../../lib/route-helpers";
import { resolveAuth } from "../auth/middleware";
import { documentCommentService } from "./service";
import { isValidUuid, sanitizeInput, VALIDATION_LIMITS } from "../../lib/validation";

const ReplaceCommentsBody = t.Object({
  comments: t.Array(
    t.Object({
      id: t.Optional(t.String({ maxLength: VALIDATION_LIMITS.NAME_MAX_LENGTH })),
      text: t.Optional(t.String({ maxLength: VALIDATION_LIMITS.DESCRIPTION_MAX_LENGTH })),
      selectedText: t.Optional(t.String({ maxLength: VALIDATION_LIMITS.DESCRIPTION_MAX_LENGTH })),
      createdAt: t.Optional(t.String()),
      updatedAt: t.Optional(t.String()),
      author: t.Optional(t.String({ maxLength: VALIDATION_LIMITS.NAME_MAX_LENGTH })),
      authorId: t.Optional(t.String({ maxLength: VALIDATION_LIMITS.NAME_MAX_LENGTH })),
      from: t.Optional(t.Number()),
      to: t.Optional(t.Number()),
      resolved: t.Optional(t.Boolean()),
      replies: t.Optional(t.Array(t.Any(), { maxLength: 100 })),
    }),
    { maxLength: 500 },
  ),
});

export const documentCommentRoutes = new Elysia({
  prefix: "/api/workspace/:workspaceId/projects/:projectId/documents/:documentId/comments",
  tags: ["project-document-comments"],
})
  .onError(handleRouteError)
  .get("/", async ({ headers, params }) => {
    if (
      !isValidUuid(params.workspaceId) ||
      !isValidUuid(params.projectId) ||
      !isValidUuid(params.documentId)
    ) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await documentCommentService.listComments(
      auth.userId,
      params.workspaceId,
      params.projectId,
      params.documentId,
    );
  })
  .put(
    "/",
    async ({ headers, params, body }) => {
      if (
        !isValidUuid(params.workspaceId) ||
        !isValidUuid(params.projectId) ||
        !isValidUuid(params.documentId)
      ) {
        throw new HttpError(400, "invalid_uuid", "Invalid ID");
      }
      const auth = await resolveAuth(headers);
      const sanitized = sanitizeInput(body) as typeof body;
      return await documentCommentService.replaceComments(
        auth.userId,
        params.workspaceId,
        params.projectId,
        params.documentId,
        sanitized,
      );
    },
    { body: ReplaceCommentsBody },
  );

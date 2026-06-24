import { Elysia, t } from "elysia";

import { HttpError } from "../../lib/errors";
import { ok } from "../../lib/http";
import { resolveAuth } from "../auth/middleware";
import { notificationsRepository } from "./repository";

export const notificationRoutes = new Elysia({ prefix: "/api/user/notifications", tags: ["notifications"] })
  .get(
    "/",
    async ({ headers, query }) => {
      const auth = await resolveAuth(headers);
      const notifications = await notificationsRepository.list(auth.userId, {
        unreadOnly: query.unread_only === "true",
        workspaceId: query.workspace_id || undefined,
        category: query.category || undefined,
        limit: query.limit ? Number(query.limit) : 50,
        offset: query.offset ? Number(query.offset) : 0,
      });
      return ok({ notifications });
    },
    {
      query: t.Object({
        unread_only: t.Optional(t.String()),
        workspace_id: t.Optional(t.String()),
        category: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
    },
  )
  .get("/unread-count", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    const count = await notificationsRepository.unreadCount(auth.userId, query.workspace_id || undefined);
    return ok({ count });
  })
  .patch(
    "/:id/read",
    async ({ headers, params }) => {
      const auth = await resolveAuth(headers);
      const notification = await notificationsRepository.getById(params.id, auth.userId);
      if (!notification) {
        throw new HttpError(404, "not_found", "Notification not found");
      }
      await notificationsRepository.markRead(params.id, auth.userId);
      return ok({ message: "Marked as read" });
    },
  )
  .post("/read-all", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    await notificationsRepository.markAllRead(auth.userId, query.workspace_id || undefined);
    return ok({ message: "All notifications marked as read" });
  })
  .patch(
    "/:id/archive",
    async ({ headers, params }) => {
      const auth = await resolveAuth(headers);
      const notification = await notificationsRepository.getById(params.id, auth.userId);
      if (!notification) {
        throw new HttpError(404, "not_found", "Notification not found");
      }
      await notificationsRepository.archive(params.id, auth.userId);
      return ok({ message: "Notification archived" });
    },
  );

import { getDb } from "../../lib/db";
import { auditRepository } from "../audit/repository";
import { notificationsRepository } from "../notifications/repository";

export const DEFAULT_SYSTEM_ACTOR_KEY = "SYSTEM_USER";

export const systemService = {
  async ensureDefaultActor() {
    const db = getDb();
    await db`
      INSERT INTO auth.system_actors (actor_key, name, purpose, status, capabilities)
      VALUES (
        ${DEFAULT_SYSTEM_ACTOR_KEY},
        'System User',
        'Notifications, audit-originated actions, and scheduled jobs',
        'active',
        ${db.json(["system.notifications.send", "system.jobs.execute", "system.audit.write"] as any)}
      )
      ON CONFLICT (actor_key) DO NOTHING
    `;
  },

  async sendNotification(input: {
    userId: string;
    workspaceId?: string;
    type: string;
    category?: string;
    title: string;
    body?: string;
    metadata?: Record<string, unknown>;
  }) {
    await this.ensureDefaultActor();

    const notification = await notificationsRepository.insert({
      userId: input.userId,
      workspaceId: input.workspaceId,
      type: input.type,
      category: input.category ?? "system",
      title: input.title,
      body: input.body,
      actorType: "system",
      actorKey: DEFAULT_SYSTEM_ACTOR_KEY,
      actorName: "System User",
      metadata: input.metadata,
    });

    await auditRepository.insert({
      actor: {
        actorType: "system",
        actorKey: DEFAULT_SYSTEM_ACTOR_KEY,
        role: "SYSTEM_USER",
      },
      action: "system.notification.sent",
      targetType: "notification",
      targetId: notification.id,
      metadata: {
        userId: input.userId,
        workspaceId: input.workspaceId ?? null,
        type: input.type,
      },
    });

    return notification;
  },
};

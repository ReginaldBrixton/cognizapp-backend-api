import { getDb } from "../../lib/db";

export type NotificationRecord = {
  id: string;
  userId: string;
  workspaceId: string | null;
  type: string;
  category: string;
  title: string;
  body: string | null;
  actionUrl: string | null;
  entityType: string | null;
  entityId: string | null;
  actorId: string | null;
  actorType: string;
  actorKey: string | null;
  actorName: string | null;
  actorAvatar: string | null;
  isRead: boolean;
  readAt: Date | null;
  isArchived: boolean;
  archivedAt: Date | null;
  isPinned: boolean;
  priority: string;
  deliveredEmail: boolean;
  deliveredPush: boolean;
  deliveredInApp: boolean;
  metadata: Record<string, unknown>;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function parseNotification(row: Record<string, unknown>): NotificationRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: row.workspace_id ? String(row.workspace_id) : null,
    type: String(row.type),
    category: String(row.category ?? "general"),
    title: String(row.title),
    body: row.body ? String(row.body) : null,
    actionUrl: row.action_url ? String(row.action_url) : null,
    entityType: row.entity_type ? String(row.entity_type) : null,
    entityId: row.entity_id ? String(row.entity_id) : null,
    actorId: row.actor_id ? String(row.actor_id) : null,
    actorType: String(row.actor_type ?? "human"),
    actorKey: row.actor_key ? String(row.actor_key) : null,
    actorName: row.actor_name ? String(row.actor_name) : null,
    actorAvatar: row.actor_avatar ? String(row.actor_avatar) : null,
    isRead: Boolean(row.is_read),
    readAt: row.read_at ? new Date(String(row.read_at)) : null,
    isArchived: Boolean(row.is_archived),
    archivedAt: row.archived_at ? new Date(String(row.archived_at)) : null,
    isPinned: Boolean(row.is_pinned),
    priority: String(row.priority ?? "normal"),
    deliveredEmail: Boolean(row.delivered_email),
    deliveredPush: Boolean(row.delivered_push),
    deliveredInApp: Boolean(row.delivered_in_app),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    expiresAt: row.expires_at ? new Date(String(row.expires_at)) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

type NotificationDeliveryPreferences = {
  email: boolean;
  push: boolean;
  inApp: boolean;
};

function readBoolean(
  record: Record<string, unknown>,
  keys: string[],
  fallback: boolean,
) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function getDeliveryPreferences(userId: string): Promise<NotificationDeliveryPreferences> {
  const db = getDb();
  const rows = await db`
    SELECT notifications
    FROM user_settings
    WHERE user_id = ${userId}
    LIMIT 1
  `;
  const notifications = asRecord(rows[0]?.notifications);
  const email = asRecord(notifications.email);
  const push = asRecord(notifications.push);
  const inApp = asRecord(notifications.inApp);

  return {
    email: readBoolean(notifications, ["emailEnabled", "email_enabled"], readBoolean(email, ["enabled"], true)),
    push: readBoolean(notifications, ["pushEnabled", "push_enabled", "desktopEnabled", "desktop_enabled"], readBoolean(push, ["enabled"], false)),
    inApp: readBoolean(notifications, ["inAppEnabled", "in_app_enabled"], readBoolean(inApp, ["enabled"], true)),
  };
}

export const notificationsRepository = {
  async list(
    userId: string,
    opts: { unreadOnly?: boolean; workspaceId?: string; category?: string; limit?: number; offset?: number },
  ) {
    const db = getDb();
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const conditions: ReturnType<typeof db>[] = [db`user_id = ${userId}`, db`is_archived = FALSE`];
    conditions.push(db`delivered_in_app = TRUE`);
    if (opts.unreadOnly) conditions.push(db`is_read = FALSE`);
    if (opts.workspaceId) conditions.push(db`workspace_id = ${opts.workspaceId}`);
    if (opts.category) conditions.push(db`category = ${opts.category}`);

    const where = conditions.flatMap((c, i) => (i === 0 ? [c] : [db` AND `, c]));

    const rows = await db`
      SELECT * FROM auth.notifications
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    return rows.map(parseNotification);
  },

  async unreadCount(userId: string, workspaceId?: string) {
    const db = getDb();
    let rows;
    if (workspaceId) {
      rows = await db`
        SELECT COUNT(*) AS count FROM auth.notifications
        WHERE user_id = ${userId} AND is_read = FALSE AND is_archived = FALSE
          AND delivered_in_app = TRUE
          AND workspace_id = ${workspaceId}
      `;
    } else {
      rows = await db`
        SELECT COUNT(*) AS count FROM auth.notifications
        WHERE user_id = ${userId} AND is_read = FALSE AND is_archived = FALSE
          AND delivered_in_app = TRUE
      `;
    }
    return Number(rows[0]?.count ?? 0);
  },

  async getById(id: string, userId: string) {
    const db = getDb();
    const rows = await db`
      SELECT * FROM auth.notifications
      WHERE id = ${id} AND user_id = ${userId}
      LIMIT 1
    `;
    return rows[0] ? parseNotification(rows[0]) : null;
  },

  async markRead(id: string, userId: string) {
    const db = getDb();
    await db`
      UPDATE auth.notifications
      SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
    `;
  },

  async markAllRead(userId: string, workspaceId?: string) {
    const db = getDb();
    if (workspaceId) {
      await db`
        UPDATE auth.notifications
        SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
        WHERE user_id = ${userId} AND is_read = FALSE AND workspace_id = ${workspaceId}
      `;
    } else {
      await db`
        UPDATE auth.notifications
        SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
        WHERE user_id = ${userId} AND is_read = FALSE
      `;
    }
  },

  async archive(id: string, userId: string) {
    const db = getDb();
    await db`
      UPDATE auth.notifications
      SET is_archived = TRUE, archived_at = NOW(), updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
    `;
  },

  async insert(input: {
    userId: string;
    workspaceId?: string;
    type: string;
    category?: string;
    title: string;
    body?: string;
    actionUrl?: string;
    entityType?: string;
    entityId?: string;
    actorId?: string;
    actorType?: string;
    actorKey?: string;
    actorName?: string;
    actorAvatar?: string;
    priority?: string;
    metadata?: Record<string, unknown>;
    expiresAt?: Date;
  }) {
    const db = getDb();
    const delivery = await getDeliveryPreferences(input.userId);
    const rows = await db`
      INSERT INTO auth.notifications (
        user_id, workspace_id, type, category, title, body, action_url,
        entity_type, entity_id, actor_id, actor_type, actor_key, actor_name, actor_avatar,
        priority, delivered_email, delivered_push, delivered_in_app, metadata, expires_at
      ) VALUES (
        ${input.userId}, ${input.workspaceId ?? null}, ${input.type},
        ${input.category ?? "general"}, ${input.title}, ${input.body ?? null},
        ${input.actionUrl ?? null}, ${input.entityType ?? null}, ${input.entityId ?? null},
        ${input.actorId ?? null}, ${input.actorType ?? "human"}, ${input.actorKey ?? null},
        ${input.actorName ?? null}, ${input.actorAvatar ?? null},
        ${input.priority ?? "normal"}, ${delivery.email}, ${delivery.push}, ${delivery.inApp},
        ${db.json((input.metadata ?? {}) as any)},
        ${input.expiresAt ?? null}
      )
      RETURNING *
    `;
    return parseNotification(rows[0]);
  },
};

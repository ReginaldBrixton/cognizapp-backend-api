import { getDb } from "../../lib/db";

export type AuditActor = {
  actorId?: string | null;
  actorKey?: string | null;
  actorType: "human" | "system";
  role?: string | null;
};

export const auditRepository = {
  async insert(input: {
    actor: AuditActor;
    action: string;
    targetType: string;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    const db = getDb();
    await db`
      INSERT INTO auth.audit_events (
        actor_id,
        actor_key,
        actor_type,
        actor_role,
        action,
        target_type,
        target_id,
        metadata
      ) VALUES (
        ${input.actor.actorType === "human" ? input.actor.actorId ?? null : null},
        ${input.actor.actorKey ?? input.actor.actorId ?? null},
        ${input.actor.actorType},
        ${input.actor.role ?? null},
        ${input.action},
        ${input.targetType},
        ${input.targetId ?? null},
        ${db.json((input.metadata ?? {}) as any)}
      )
    `;
  },
};

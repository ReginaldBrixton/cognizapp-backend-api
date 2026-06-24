/**
 * Admin routes — all endpoints require role >= admin.
 *
 * Endpoints:
 *   GET  /api/admin/users               List all users (paginated)
 *   GET  /api/admin/users/:id           Get full user profile
 *   PUT  /api/admin/users/:id/role      Update a user's role
 *   PUT  /api/admin/users/:id/status    Ban / unban / activate a user
 *   GET  /api/admin/permissions         List all permissions
 *   GET  /api/admin/permissions/:role   List permissions for a specific role
 *   GET  /api/admin/stats               Platform-wide statistics
 */

import { Elysia, t } from "elysia";

import { getDb } from "../../lib/db";
import { HttpError } from "../../lib/errors";
import { fail, ok } from "../../lib/http";
import { n8nService } from "../../lib/n8n";
import { auditRepository } from "../audit/repository";
import { authRepository } from "../auth/repository";
import { requirePermission, resolveAuth } from "../auth/middleware";
import { authorizationService, normalizeRole, roleHierarchy } from "../auth/policy";

const VALID_ROLES = ["REGULAR_USER", "PRO_USER", "SUPPORT_PROVIDER_USER", "DEV_USER", "ADMIN_USER"] as const;
const PRIVILEGED_PORTAL_ROLES = ["SUPPORT_PROVIDER_USER", "ADMIN_USER"] as const;

type PrivilegedAccessEvent = "granted" | "updated" | "removed";

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function portalLabelForRole(role: string) {
  return role === "ADMIN_USER" ? "CognizApp Admin" : "CognizApp Provider";
}

function portalPathForRole(role: string) {
  return role === "ADMIN_USER" ? "/admin/dashboard" : "/provider/dashboard";
}

/**
 * Notify a provider/admin whenever their privileged access changes.
 * Fire-and-forget: email failures are logged but never block the API response.
 */
async function sendPrivilegedAccessEmail(input: {
  email: string;
  role: string;
  event: PrivilegedAccessEvent;
  actorEmail: string;
  displayName?: string | null;
}) {
  const portal = portalLabelForRole(input.role);
  const greeting = input.displayName ? `Hi ${input.displayName},` : "Hello,";

  const copy: Record<PrivilegedAccessEvent, { title: string; message: string; actionUrl: string }> = {
    granted: {
      title: `${portal} access granted`,
      message: `${greeting}\n\nYou have been added as a ${portal} on CognizApp. Sign in with this Gmail account to get started — you will be taken straight to your portal.`,
      actionUrl: portalPathForRole(input.role),
    },
    updated: {
      title: `${portal} account updated`,
      message: `${greeting}\n\nYour ${portal} account on CognizApp was updated by an administrator. If you did not expect this change, please reach out to the CognizApp team.`,
      actionUrl: portalPathForRole(input.role),
    },
    removed: {
      title: `${portal} access removed`,
      message: `${greeting}\n\nYour ${portal} access on CognizApp has been removed. You will no longer be able to sign in to the ${portal} portal. Contact the CognizApp team if you believe this was a mistake.`,
      actionUrl: "/login",
    },
  };

  const { title, message, actionUrl } = copy[input.event];

  void n8nService
    .sendNotificationEmail({
      to: input.email,
      userId: input.email,
      eventType: `admin.privileged_access.${input.event}`,
      title,
      message,
      actionUrl,
      metadata: {
        role: input.role,
        event: input.event,
        actorEmail: input.actorEmail,
        displayName: input.displayName ?? null,
      },
    })
    .catch((error) => console.warn("[admin:email] privileged access email failed", error));
}

async function upsertPrivilegedGrant(input: {
  email: string;
  role: string;
  invitedBy: string;
  actorEmail: string;
  displayName?: string | null;
  notify?: boolean;
}) {
  if (!(PRIVILEGED_PORTAL_ROLES as readonly string[]).includes(input.role)) return null;
  const email = normalizeEmail(input.email);
  const db = getDb();
  const [grant] = await db`
    INSERT INTO auth.privileged_access_grants (email, role, status, invited_by, display_name, metadata)
    VALUES (${email}, ${input.role}, 'active', ${input.invitedBy}, ${input.displayName ?? null}, ${db.json({ source: "admin_panel" })})
    ON CONFLICT (lower(email), role) DO UPDATE
    SET status = 'active',
      invited_by = EXCLUDED.invited_by,
      display_name = COALESCE(EXCLUDED.display_name, auth.privileged_access_grants.display_name),
      revoked_at = NULL,
      revoked_by = NULL,
      updated_at = NOW()
    RETURNING *
  `;
  if (input.notify !== false) {
    await sendPrivilegedAccessEmail({
      email,
      role: input.role,
      event: "granted",
      actorEmail: input.actorEmail,
      displayName: input.displayName ?? (grant?.display_name as string | null),
    });
  }
  return grant;
}

/**
 * Promote (or keep) the platform user account in sync with a privileged grant.
 */
async function syncUserRoleToGrant(input: { email: string; role: string; actorId: string }) {
  const db = getDb();
  const [user] = await db`
    SELECT id, role FROM auth.users WHERE lower(email) = lower(${input.email}) LIMIT 1
  `;
  if (!user) return;
  const currentRole = normalizeRole(String(user.role));
  if ((roleHierarchy[currentRole] ?? -1) < (roleHierarchy[normalizeRole(input.role)] ?? -1)) {
    await db`
      UPDATE auth.users
      SET role = ${input.role},
        permissions = COALESCE((
          SELECT jsonb_agg(rp.permission ORDER BY rp.permission)
          FROM role_permissions rp
          WHERE rp.role = ${input.role}
        ), '[]'::jsonb),
        role_assigned_at = NOW(),
        role_assigned_by = ${input.actorId},
        updated_at = NOW()
      WHERE id = ${user.id}
    `;
    await authRepository.updateActiveSessionRoles(String(user.id), input.role);
  }
}

/**
 * Revoke a platform user's privileged role back to a regular account when their
 * grant is removed (so removed providers cannot keep portal access via an
 * already-issued token after re-login).
 */
async function demoteUserAfterRevoke(input: { email: string; role: string; actorId: string }) {
  const db = getDb();
  const [user] = await db`
    SELECT id, role FROM auth.users WHERE lower(email) = lower(${input.email}) LIMIT 1
  `;
  if (!user) return;
  if (normalizeRole(String(user.role)) !== normalizeRole(input.role)) return;
  await db`
    UPDATE auth.users
    SET role = 'REGULAR_USER',
      permissions = COALESCE((
        SELECT jsonb_agg(rp.permission ORDER BY rp.permission)
        FROM role_permissions rp
        WHERE rp.role = 'REGULAR_USER'
      ), '[]'::jsonb),
      role_assigned_at = NOW(),
      role_assigned_by = ${input.actorId},
      updated_at = NOW()
    WHERE id = ${user.id}
  `;
  await authRepository.revokeAllSessions(String(user.id), "privileged_access_revoked");
}

export const adminRoutes = new Elysia({ prefix: "/api/admin", tags: ["admin"] })
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(error.message, error.code);
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return fail("Invalid request body", "invalid_request");
    }
  })

  // ── GET /api/admin/users ──────────────────────────────────────────────────
  .get(
    "/users",
    async ({ headers, query }) => {
      const auth = await resolveAuth(headers);
      requirePermission(auth, "users.view");

      const db = getDb();
      const limit = Math.min(Number(query.limit ?? 50), 200);
      const offset = Number(query.offset ?? 0);
      const search = query.search ? `%${query.search}%` : null;

      const users = search
        ? await db`
            SELECT id, email, display_name, full_name, role, status, created_at, last_sign_in_at, login_count, providers
            FROM auth.users
            WHERE email ILIKE ${search} OR display_name ILIKE ${search} OR full_name ILIKE ${search}
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `
        : await db`
            SELECT id, email, display_name, full_name, role, status, created_at, last_sign_in_at, login_count, providers
            FROM auth.users
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `;

      const [countRow] = search
        ? await db`SELECT COUNT(*)::int AS total FROM auth.users WHERE email ILIKE ${search} OR display_name ILIKE ${search} OR full_name ILIKE ${search}`
        : await db`SELECT COUNT(*)::int AS total FROM auth.users`;

      return ok({ users, total: countRow.total, limit, offset });
    },
    { query: t.Object({ limit: t.Optional(t.String()), offset: t.Optional(t.String()), search: t.Optional(t.String()) }) },
  )

  // ── GET /api/admin/users/:id ──────────────────────────────────────────────
  .get(
    "/users/:id",
    async ({ headers, params }) => {
      const auth = await resolveAuth(headers);
      requirePermission(auth, "users.view");

      const db = getDb();
      const [user] = await db`
        SELECT u.*,
               (SELECT COUNT(*)::int FROM auth.sessions s WHERE s.user_id = u.id AND s.is_revoked = FALSE AND s.expires_at > NOW()) AS active_sessions,
               (SELECT COUNT(*)::int FROM workspaces w WHERE w.owner_uid = u.id::text AND w.deleted_at IS NULL) AS workspace_count
        FROM auth.users u
        WHERE u.id = ${params.id}::uuid
      `;
      if (!user) throw new HttpError(404, "user_not_found", "User not found");

      const [onboarding] = await db`SELECT * FROM user_onboarding WHERE user_id = ${params.id}`;

      return ok({ user, onboarding: onboarding ?? null });
    },
  )

  // ── PUT /api/admin/users/:id/role ─────────────────────────────────────────
  .put(
    "/users/:id/role",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      requirePermission(auth, "users.manage.roles");

      const requestedRole = String(body.role);
      if (!(VALID_ROLES as readonly string[]).includes(requestedRole)) {
        throw new HttpError(400, "invalid_role", `Role must be one of: ${VALID_ROLES.join(", ")}`);
      }
      const newRole = normalizeRole(requestedRole);

      const db = getDb();
      const [target] = await db`
        SELECT id, email, role
        FROM auth.users
        WHERE id = ${params.id}::uuid
      `;
      if (!target) {
        throw new HttpError(404, "user_not_found", "User not found");
      }

      // Cannot assign a role higher than your own role.
      if (!authorizationService.canAssignRole(auth, newRole)) {
        throw new HttpError(403, "forbidden", "Cannot assign the requested role");
      }

      if ((roleHierarchy[normalizeRole(String(target.role))] ?? -1) >= (roleHierarchy[normalizeRole(auth.role)] ?? -1)) {
        throw new HttpError(403, "forbidden", "Cannot modify a user with equal or higher role");
      }

      const [updated] = await db`
        UPDATE auth.users
        SET role = ${newRole},
            permissions = COALESCE((
              SELECT jsonb_agg(rp.permission ORDER BY rp.permission)
              FROM role_permissions rp
              WHERE rp.role = ${newRole}
            ), '[]'::jsonb),
            role_assigned_at = NOW(),
            role_assigned_by = ${auth.userId},
            updated_at = NOW()
        WHERE id = ${params.id}::uuid
        RETURNING id, email, role, role_assigned_at, role_assigned_by
      `;
      if (!updated) throw new HttpError(404, "user_not_found", "User not found");

      if ((PRIVILEGED_PORTAL_ROLES as readonly string[]).includes(newRole)) {
        await upsertPrivilegedGrant({
          email: String(target.email),
          role: newRole,
          invitedBy: auth.userId,
          actorEmail: auth.email,
        });
      } else if ((PRIVILEGED_PORTAL_ROLES as readonly string[]).includes(normalizeRole(String(target.role)))) {
        const previousPrivilegedRole = normalizeRole(String(target.role));
        await db`
          UPDATE auth.privileged_access_grants
          SET status = 'revoked',
            revoked_at = NOW(),
            revoked_by = ${auth.userId},
            updated_at = NOW()
          WHERE lower(email) = lower(${String(target.email)})
            AND role = ${previousPrivilegedRole}
            AND status = 'active'
        `;
        await sendPrivilegedAccessEmail({
          email: String(target.email),
          role: previousPrivilegedRole,
          event: "removed",
          actorEmail: auth.email,
        });
      }

      await authRepository.updateActiveSessionRoles(String(params.id), newRole);
      await auditRepository.insert({
        actor: { actorId: auth.userId, actorType: auth.actorType, role: auth.role },
        action: "user.role.updated",
        targetType: "user",
        targetId: String(params.id),
        metadata: { previousRole: String(target.role), newRole },
      });

      return ok({ user: updated, message: `Role updated to '${newRole}'` });
    },
    { body: t.Object({ role: t.String() }) },
  )

  // ── PUT /api/admin/users/:id/status ──────────────────────────────────────
  .put(
    "/users/:id/status",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      requirePermission(auth, "users.manage.status");

      const { status, banned_until } = body;
      const validStatuses = ["active", "banned", "disabled", "deleted"];
      if (!validStatuses.includes(status)) {
        throw new HttpError(400, "invalid_status", `Status must be one of: ${validStatuses.join(", ")}`);
      }

      // Cannot modify users with equal or higher role (except master)
      const db = getDb();
      const [target] = await db`SELECT role FROM auth.users WHERE id = ${params.id}::uuid`;
      if (!target) throw new HttpError(404, "user_not_found", "User not found");

      if ((roleHierarchy[normalizeRole(String(target.role))] ?? 0) >= (roleHierarchy[normalizeRole(auth.role)] ?? 0)) {
        throw new HttpError(403, "forbidden", "Cannot modify a user with equal or higher role");
      }

      const bannedUntil = status === "banned" && banned_until ? new Date(banned_until) : null;

      const [updated] = await db`
        UPDATE auth.users
        SET status = ${status},
            banned_until = ${bannedUntil},
            updated_at = NOW()
        WHERE id = ${params.id}::uuid
        RETURNING id, email, role, status, banned_until
      `;

      // Revoke all active sessions if banning/disabling
      if (["banned", "disabled", "deleted"].includes(status)) {
        await db`
          UPDATE auth.sessions
          SET is_revoked = TRUE, revoked_at = NOW(), revoked_reason = ${"admin_" + status}
          WHERE user_id = ${params.id}::uuid AND is_revoked = FALSE
        `;
      }

      await auditRepository.insert({
        actor: { actorId: auth.userId, actorType: auth.actorType, role: auth.role },
        action: "user.status.updated",
        targetType: "user",
        targetId: String(params.id),
        metadata: { status, bannedUntil: bannedUntil?.toISOString() ?? null },
      });

      return ok({ user: updated, message: `Status updated to '${status}'` });
    },
    {
      body: t.Object({
        status: t.String(),
        banned_until: t.Optional(t.Nullable(t.String())),
      }),
    },
  )

  // ── Privileged access grants (admin + provider portal allow-list) ──────────
  .get("/privileged-access", async ({ headers, query }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "users.manage.roles");
    const db = getDb();
    const roleFilter = query.role ? normalizeRole(String(query.role)) : null;
    const grants = roleFilter
      ? await db`
          SELECT id, email, role, status, display_name, invited_by, invited_at, accepted_at, revoked_at, revoked_by, metadata, created_at, updated_at
          FROM auth.privileged_access_grants
          WHERE role = ${roleFilter}
          ORDER BY updated_at DESC
          LIMIT 500
        `
      : await db`
          SELECT id, email, role, status, display_name, invited_by, invited_at, accepted_at, revoked_at, revoked_by, metadata, created_at, updated_at
          FROM auth.privileged_access_grants
          ORDER BY updated_at DESC
          LIMIT 500
        `;
    return ok({ grants });
  }, { query: t.Object({ role: t.Optional(t.String()) }) })

  .post(
    "/privileged-access",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);
      requirePermission(auth, "users.manage.roles");
      const email = normalizeEmail(body.email);
      const role = normalizeRole(body.role);
      if (!(PRIVILEGED_PORTAL_ROLES as readonly string[]).includes(role)) {
        throw new HttpError(400, "invalid_role", "Role must be ADMIN_USER or SUPPORT_PROVIDER_USER");
      }
      if (!/^[^@\s]+@gmail\.com$/i.test(email)) {
        throw new HttpError(400, "gmail_required", "Privileged portal access must be assigned to a Gmail account");
      }
      if (!authorizationService.canAssignRole(auth, role)) {
        throw new HttpError(403, "forbidden", "Cannot assign the requested role");
      }

      const grant = await upsertPrivilegedGrant({
        email,
        role,
        invitedBy: auth.userId,
        actorEmail: auth.email,
        displayName: body.displayName?.trim() || null,
      });
      await syncUserRoleToGrant({ email, role, actorId: auth.userId });
      await auditRepository.insert({
        actor: { actorId: auth.userId, actorType: auth.actorType, role: auth.role },
        action: "privileged_access.granted",
        targetType: "user",
        targetId: email,
        metadata: { role, displayName: body.displayName ?? null },
      });
      return ok({ grant, message: "Privileged access granted" });
    },
    {
      body: t.Object({
        email: t.String(),
        role: t.String(),
        displayName: t.Optional(t.String()),
      }),
    },
  )

  // ── PUT /api/admin/privileged-access/:id (edit email / name / role) ────────
  .put(
    "/privileged-access/:id",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      requirePermission(auth, "users.manage.roles");
      const db = getDb();

      const [existing] = await db`
        SELECT id, email, role, display_name, status
        FROM auth.privileged_access_grants
        WHERE id = ${params.id}::uuid
      `;
      if (!existing) throw new HttpError(404, "grant_not_found", "Privileged access grant not found");

      const nextEmail = body.email ? normalizeEmail(body.email) : String(existing.email);
      const nextRole = body.role ? normalizeRole(body.role) : normalizeRole(String(existing.role));
      const nextDisplayName =
        body.displayName !== undefined ? body.displayName.trim() || null : (existing.display_name as string | null);

      if (!(PRIVILEGED_PORTAL_ROLES as readonly string[]).includes(nextRole)) {
        throw new HttpError(400, "invalid_role", "Role must be ADMIN_USER or SUPPORT_PROVIDER_USER");
      }
      if (!/^[^@\s]+@gmail\.com$/i.test(nextEmail)) {
        throw new HttpError(400, "gmail_required", "Privileged portal access must be assigned to a Gmail account");
      }
      if (!authorizationService.canAssignRole(auth, nextRole)) {
        throw new HttpError(403, "forbidden", "Cannot assign the requested role");
      }

      const emailChanged = nextEmail !== normalizeEmail(String(existing.email));
      const roleChanged = nextRole !== normalizeRole(String(existing.role));

      // If the email or role changed, retire the old grant and create the new one
      // so the unique (email, role) index stays consistent.
      if (emailChanged || roleChanged) {
        await db`
          UPDATE auth.privileged_access_grants
          SET status = 'revoked', revoked_at = NOW(), revoked_by = ${auth.userId}, updated_at = NOW()
          WHERE id = ${existing.id}::uuid
        `;
        await demoteUserAfterRevoke({ email: String(existing.email), role: normalizeRole(String(existing.role)), actorId: auth.userId });
      }

      const grant = await upsertPrivilegedGrant({
        email: nextEmail,
        role: nextRole,
        invitedBy: auth.userId,
        actorEmail: auth.email,
        displayName: nextDisplayName,
        notify: false,
      });
      await syncUserRoleToGrant({ email: nextEmail, role: nextRole, actorId: auth.userId });

      await sendPrivilegedAccessEmail({
        email: nextEmail,
        role: nextRole,
        event: "updated",
        actorEmail: auth.email,
        displayName: nextDisplayName,
      });

      await auditRepository.insert({
        actor: { actorId: auth.userId, actorType: auth.actorType, role: auth.role },
        action: "privileged_access.updated",
        targetType: "user",
        targetId: nextEmail,
        metadata: {
          previousEmail: String(existing.email),
          previousRole: normalizeRole(String(existing.role)),
          email: nextEmail,
          role: nextRole,
          displayName: nextDisplayName,
        },
      });

      return ok({ grant, message: "Privileged access updated" });
    },
    {
      body: t.Object({
        email: t.Optional(t.String()),
        role: t.Optional(t.String()),
        displayName: t.Optional(t.String()),
      }),
    },
  )

  .delete("/privileged-access/:id", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "users.manage.roles");
    const [grant] = await getDb()`
      UPDATE auth.privileged_access_grants
      SET status = 'revoked',
        revoked_at = NOW(),
        revoked_by = ${auth.userId},
        updated_at = NOW()
      WHERE id = ${params.id}::uuid
      RETURNING *
    `;
    if (!grant) throw new HttpError(404, "grant_not_found", "Privileged access grant not found");

    await demoteUserAfterRevoke({
      email: String(grant.email),
      role: normalizeRole(String(grant.role)),
      actorId: auth.userId,
    });
    await sendPrivilegedAccessEmail({
      email: String(grant.email),
      role: normalizeRole(String(grant.role)),
      event: "removed",
      actorEmail: auth.email,
      displayName: grant.display_name as string | null,
    });
    await auditRepository.insert({
      actor: { actorId: auth.userId, actorType: auth.actorType, role: auth.role },
      action: "privileged_access.revoked",
      targetType: "user",
      targetId: String(grant.email),
      metadata: { role: grant.role, grantId: grant.id },
    });
    return ok({ grant, message: "Privileged access revoked" });
  })

  // ── Provider management (admin-managed support provider accounts) ──────────
  // These are thin, intention-revealing wrappers over privileged-access grants
  // scoped to the SUPPORT_PROVIDER_USER role.
  .get("/providers", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "users.manage.roles");
    const db = getDb();
    const providers = await db`
      SELECT g.id, g.email, g.role, g.status, g.display_name, g.invited_by, g.invited_at,
             g.revoked_at, g.created_at, g.updated_at,
             u.id AS user_id, u.status AS user_status, u.last_sign_in_at, u.login_count
      FROM auth.privileged_access_grants g
      LEFT JOIN auth.users u ON lower(u.email) = lower(g.email)
      WHERE g.role = 'SUPPORT_PROVIDER_USER'
      ORDER BY g.status ASC, g.updated_at DESC
      LIMIT 500
    `;
    return ok({ providers });
  })

  .post(
    "/providers",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);
      requirePermission(auth, "users.manage.roles");
      const email = normalizeEmail(body.email);
      if (!/^[^@\s]+@gmail\.com$/i.test(email)) {
        throw new HttpError(400, "gmail_required", "Provider accounts must use a Gmail address");
      }
      if (!authorizationService.canAssignRole(auth, "SUPPORT_PROVIDER_USER")) {
        throw new HttpError(403, "forbidden", "Cannot assign provider access");
      }

      const grant = await upsertPrivilegedGrant({
        email,
        role: "SUPPORT_PROVIDER_USER",
        invitedBy: auth.userId,
        actorEmail: auth.email,
        displayName: body.displayName?.trim() || null,
      });
      await syncUserRoleToGrant({ email, role: "SUPPORT_PROVIDER_USER", actorId: auth.userId });
      await auditRepository.insert({
        actor: { actorId: auth.userId, actorType: auth.actorType, role: auth.role },
        action: "provider.added",
        targetType: "user",
        targetId: email,
        metadata: { displayName: body.displayName ?? null },
      });
      return ok({ provider: grant, message: "Provider added and notified by email" });
    },
    {
      body: t.Object({
        email: t.String(),
        displayName: t.Optional(t.String()),
      }),
    },
  )

  .put(
    "/providers/:id",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      requirePermission(auth, "users.manage.roles");
      const db = getDb();

      const [existing] = await db`
        SELECT id, email, role, display_name
        FROM auth.privileged_access_grants
        WHERE id = ${params.id}::uuid AND role = 'SUPPORT_PROVIDER_USER'
      `;
      if (!existing) throw new HttpError(404, "provider_not_found", "Provider not found");

      const nextEmail = body.email ? normalizeEmail(body.email) : String(existing.email);
      const nextDisplayName =
        body.displayName !== undefined ? body.displayName.trim() || null : (existing.display_name as string | null);

      if (!/^[^@\s]+@gmail\.com$/i.test(nextEmail)) {
        throw new HttpError(400, "gmail_required", "Provider accounts must use a Gmail address");
      }

      const emailChanged = nextEmail !== normalizeEmail(String(existing.email));
      if (emailChanged) {
        await db`
          UPDATE auth.privileged_access_grants
          SET status = 'revoked', revoked_at = NOW(), revoked_by = ${auth.userId}, updated_at = NOW()
          WHERE id = ${existing.id}::uuid
        `;
        await demoteUserAfterRevoke({ email: String(existing.email), role: "SUPPORT_PROVIDER_USER", actorId: auth.userId });
      }

      const grant = await upsertPrivilegedGrant({
        email: nextEmail,
        role: "SUPPORT_PROVIDER_USER",
        invitedBy: auth.userId,
        actorEmail: auth.email,
        displayName: nextDisplayName,
        notify: false,
      });
      await syncUserRoleToGrant({ email: nextEmail, role: "SUPPORT_PROVIDER_USER", actorId: auth.userId });
      await sendPrivilegedAccessEmail({
        email: nextEmail,
        role: "SUPPORT_PROVIDER_USER",
        event: "updated",
        actorEmail: auth.email,
        displayName: nextDisplayName,
      });
      await auditRepository.insert({
        actor: { actorId: auth.userId, actorType: auth.actorType, role: auth.role },
        action: "provider.updated",
        targetType: "user",
        targetId: nextEmail,
        metadata: { previousEmail: String(existing.email), email: nextEmail, displayName: nextDisplayName },
      });
      return ok({ provider: grant, message: "Provider updated and notified by email" });
    },
    {
      body: t.Object({
        email: t.Optional(t.String()),
        displayName: t.Optional(t.String()),
      }),
    },
  )

  .delete("/providers/:id", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "users.manage.roles");
    const [grant] = await getDb()`
      UPDATE auth.privileged_access_grants
      SET status = 'revoked', revoked_at = NOW(), revoked_by = ${auth.userId}, updated_at = NOW()
      WHERE id = ${params.id}::uuid AND role = 'SUPPORT_PROVIDER_USER'
      RETURNING *
    `;
    if (!grant) throw new HttpError(404, "provider_not_found", "Provider not found");

    await demoteUserAfterRevoke({ email: String(grant.email), role: "SUPPORT_PROVIDER_USER", actorId: auth.userId });
    await sendPrivilegedAccessEmail({
      email: String(grant.email),
      role: "SUPPORT_PROVIDER_USER",
      event: "removed",
      actorEmail: auth.email,
      displayName: grant.display_name as string | null,
    });
    await auditRepository.insert({
      actor: { actorId: auth.userId, actorType: auth.actorType, role: auth.role },
      action: "provider.removed",
      targetType: "user",
      targetId: String(grant.email),
      metadata: { grantId: grant.id },
    });
    return ok({ provider: grant, message: "Provider removed and notified by email" });
  })

  .get("/permissions", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "users.view");

    const db = getDb();
    const permissions = await db`SELECT * FROM permissions ORDER BY category, name`;
    return ok({ permissions });
  })

  // ── GET /api/admin/permissions/:role ─────────────────────────────────────
  .get("/permissions/:role", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "users.view");
    const role = normalizeRole(params.role);

    const db = getDb();
    const perms = await db`
      SELECT p.name, p.display_name, p.description, p.category
      FROM role_permissions rp
      JOIN permissions p ON p.name = rp.permission
      WHERE rp.role = ${role}
      ORDER BY p.category, p.name
    `;
    return ok({ role, permissions: perms });
  })

  // ── GET /api/admin/stats ──────────────────────────────────────────────────
  .get("/stats", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    requirePermission(auth, "admin.analytics.view");

    const db = getDb();

    const [
      userStats,
      roleBreakdown,
      sessionStats,
      workspaceStats,
      onboardingStats,
    ] = await Promise.all([
      db`SELECT
          COUNT(*)::int                                          AS total_users,
          COUNT(*) FILTER (WHERE status = 'active')::int        AS active_users,
          COUNT(*) FILTER (WHERE status = 'banned')::int        AS banned_users,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS new_last_7_days,
          COUNT(*) FILTER (WHERE last_sign_in_at > NOW() - INTERVAL '30 days')::int AS active_last_30_days
        FROM auth.users`,
      db`SELECT role, COUNT(*)::int AS cnt FROM auth.users GROUP BY role ORDER BY cnt DESC`,
      db`SELECT
          COUNT(*)::int                                          AS total_sessions,
          COUNT(*) FILTER (WHERE is_revoked = FALSE AND expires_at > NOW())::int AS active_sessions,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS sessions_last_24h
        FROM auth.sessions`,
      db`SELECT
          COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active_workspaces,
          COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted_workspaces,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND deleted_at IS NULL)::int AS new_last_7_days
        FROM workspaces`,
      db`SELECT
          COUNT(*)::int                                       AS total,
          COUNT(*) FILTER (WHERE is_completed = TRUE)::int   AS completed,
          COUNT(*) FILTER (WHERE skipped_at IS NOT NULL)::int AS skipped,
          COUNT(*) FILTER (WHERE is_completed = FALSE AND skipped_at IS NULL)::int AS pending
        FROM user_onboarding`,
    ]);

    return ok({
      users: userStats[0],
      roles: roleBreakdown,
      sessions: sessionStats[0],
      workspaces: workspaceStats[0],
      onboarding: onboardingStats[0],
    });
  });

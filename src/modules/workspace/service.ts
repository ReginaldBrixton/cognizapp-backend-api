import { HttpError } from "../../lib/errors";
import { getDb } from "../../lib/db";
import { auditRepository } from "../audit/repository";
import { authRepository } from "../auth/repository";
import { authorizationService, normalizeRole } from "../auth/policy";
import { notificationsRepository } from "../notifications/repository";
import { systemService } from "../system/service";
import {
  ASSIGNABLE_WORKSPACE_ROLES,
  type AssignableWorkspaceRole,
} from "./types";
import { workspaceRepository } from "./repository";
import type { AuthContext } from "../auth/context";

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function getOptionalWorkspaceRelations() {
  const db = getDb();
  const [row] = await db`
    SELECT
      to_regclass('auth.projects') IS NOT NULL AS has_projects,
      to_regclass('auth.project_documents') IS NOT NULL AS has_project_documents,
      to_regclass('auth.project_notes') IS NOT NULL AS has_project_notes,
      to_regclass('auth.project_tasks') IS NOT NULL AS has_project_tasks
  `;

  return {
    hasProjects: Boolean(row?.has_projects),
    hasProjectDocuments: Boolean(row?.has_project_documents),
    hasProjectNotes: Boolean(row?.has_project_notes),
    hasProjectTasks: Boolean(row?.has_project_tasks),
  };
}

async function getActor(userId: string) {
  const user = await authRepository.getUserById(userId);
  if (!user) {
    throw new HttpError(404, "user_not_found", "User not found");
  }

  return {
    actorId: user.id,
    actorType: "human" as const,
    role: normalizeRole(user.role),
    permissions: user.permissions,
    email: user.email,
    displayName: user.displayName || user.fullName || user.email,
  };
}

function actorFromAuth(auth: AuthContext) {
  return {
    actorId: auth.userId,
    actorType: auth.actorType,
    role: normalizeRole(auth.role),
    permissions: auth.permissions,
    email: auth.email,
    displayName: auth.user
      ? auth.user.displayName || auth.user.fullName || auth.user.email
      : auth.email,
  };
}

function assertAssignableWorkspaceRole(
  role: string,
): asserts role is AssignableWorkspaceRole {
  if (!(ASSIGNABLE_WORKSPACE_ROLES as readonly string[]).includes(role)) {
    throw new HttpError(
      400,
      "invalid_workspace_role",
      `Role must be one of: ${ASSIGNABLE_WORKSPACE_ROLES.join(", ")}`,
    );
  }
}

export const workspaceService = {
  async getPolicy(userId: string) {
    const actor = await getActor(userId);
    const ownedWorkspaceCount = await workspaceRepository.countByOwner(userId);
    return {
      role: actor.role,
      ownedWorkspaceCount,
      maxOwnedWorkspaces: authorizationService.maxOwnedWorkspaces(actor),
      canCreateWorkspace: authorizationService.canCreateWorkspace(
        actor,
        ownedWorkspaceCount,
      ),
      canInviteMembers: authorizationService.canInviteMembers(actor),
    };
  },

  async ensureBootstrap(userId: string, email: string, displayName: string) {
    await workspaceRepository.ensureUserSettings(userId, email, displayName);
    const workspace = await this.ensureDefaultWorkspace(
      userId,
      email,
      displayName,
    );
    await workspaceRepository.ensureWorkspaceSettings(workspace.id, userId);
    return workspace;
  },

  async ensureDefaultWorkspace(
    userId: string,
    email: string,
    displayName: string,
  ) {
    const existing = await workspaceRepository.getDefaultWorkspace(userId);
    if (existing) {
      return existing;
    }

    const actor = await getActor(userId);
    if (
      !authorizationService.canCreateWorkspace(
        actor,
        await workspaceRepository.countByOwner(userId),
        true,
      )
    ) {
      throw new HttpError(
        403,
        "forbidden",
        "User cannot be provisioned with a workspace",
      );
    }

    const workspaceName = displayName
      ? `${displayName}'s Workspace`
      : "Personal";
    const workspace = await workspaceRepository.createWorkspace({
      ownerUid: userId,
      name: workspaceName,
      slug: slugify(workspaceName),
      description: "Your personal workspace",
      isDefault: true,
      settings: workspaceRepository.defaultSettings(),
      limits: workspaceRepository.defaultLimits(),
      counters: workspaceRepository.defaultCounters(),
    });

    await workspaceRepository.createMember({
      workspaceId: workspace.id,
      userUid: userId,
      email,
      displayName,
      role: "owner",
      joinedAt: new Date().toISOString(),
      status: "active",
      inviteStatus: "accepted",
      preferences: {
        emailNotifications: true,
        pushNotifications: true,
        defaultView: "list",
        timezone: "UTC",
      },
    });

    await workspaceRepository.ensureWorkspaceSettings(workspace.id, userId);
    await auditRepository.insert({
      actor: { actorId: userId, actorType: "human", role: actor.role },
      action: "workspace.bootstrap.created",
      targetType: "workspace",
      targetId: workspace.id,
      metadata: { isDefault: true },
    });
    await systemService.sendNotification({
      userId,
      workspaceId: workspace.id,
      type: "workspace.welcome",
      title: "Workspace ready",
      body: "Your default workspace has been created.",
      metadata: { workspaceId: workspace.id },
    });
    return workspace;
  },

  async listWorkspaces(userId: string, authContext?: AuthContext) {
    const startedAt = Date.now();
    const actor = authContext ? actorFromAuth(authContext) : await getActor(userId);
    let workspaces = await workspaceRepository.listVisibleForUser(userId);
    let ownedWorkspaceCount = workspaces.filter(
      (workspace) => workspace.ownerUid === userId,
    ).length;
    if (!ownedWorkspaceCount) {
      await this.ensureDefaultWorkspace(userId, "", "");
      workspaces = await workspaceRepository.listVisibleForUser(userId);
      ownedWorkspaceCount = workspaces.filter(
        (workspace) => workspace.ownerUid === userId,
      ).length;
    }

    const durationMs = Date.now() - startedAt;
    if (durationMs > 1000) {
      console.warn("[workspace] listWorkspaces slow", {
        userId,
        durationMs,
        owned: ownedWorkspaceCount,
        memberships: workspaces.length - ownedWorkspaceCount,
        total: workspaces.length,
      });
    }

    return {
      workspaces,
      total: workspaces.length,
      policy: {
        role: actor.role,
        ownedWorkspaceCount,
        maxOwnedWorkspaces: authorizationService.maxOwnedWorkspaces(actor),
        canCreateWorkspace: authorizationService.canCreateWorkspace(
          actor,
          ownedWorkspaceCount,
        ),
        canInviteMembers: authorizationService.canInviteMembers(actor),
      },
    };
  },

  async getWorkspace(
    userId: string,
    workspaceId: string,
    options?: { includeMemberCount?: boolean },
  ) {
    const access = await workspaceRepository.getAccess(workspaceId, userId);
    if (!access) {
      throw new HttpError(404, "not_found", "Workspace not found");
    }
    const { workspace, member } = access;
    if (workspace.ownerUid !== userId && !member) {
      throw new HttpError(403, "forbidden", "Access denied");
    }
    if (options?.includeMemberCount) {
      workspace.counters.members =
        await workspaceRepository.countMembers(workspaceId);
    }
    return workspace;
  },

  async createWorkspace(userId: string, payload: Record<string, unknown>) {
    const actor = await getActor(userId);
    if (!payload.name || typeof payload.name !== "string") {
      throw new HttpError(400, "validation_error", "Name is required");
    }
    const ownedWorkspaceCount = await workspaceRepository.countByOwner(userId);
    if (!authorizationService.canCreateWorkspace(actor, ownedWorkspaceCount)) {
      throw new HttpError(
        403,
        "workspace_limit_reached",
        "This account cannot create another workspace",
      );
    }

    const workspace = await workspaceRepository.createWorkspace({
      ownerUid: userId,
      name: payload.name,
      slug: slugify(
        typeof payload.slug === "string" && payload.slug
          ? payload.slug
          : payload.name,
      ),
      description:
        typeof payload.description === "string" ? payload.description : "",
      isDefault: false,
      color: typeof payload.color === "string" ? payload.color : undefined,
      settings:
        (payload.settings as Record<string, unknown>) ??
        workspaceRepository.defaultSettings(),
      metadata: (payload.metadata as Record<string, unknown>) ?? {},
      limits: (payload.limits as never) ?? workspaceRepository.defaultLimits(),
      counters: workspaceRepository.defaultCounters(),
    });

    await workspaceRepository.createMember({
      workspaceId: workspace.id,
      userUid: userId,
      role: "owner",
      joinedAt: new Date().toISOString(),
      status: "active",
      inviteStatus: "accepted",
      preferences: {
        emailNotifications: true,
        pushNotifications: true,
        defaultView: "list",
        timezone: "UTC",
      },
    });
    await workspaceRepository.ensureWorkspaceSettings(workspace.id, userId);
    await workspaceRepository.insertActivity(
      workspace.id,
      userId,
      "workspace_created",
      "Workspace created",
      {},
    );
    await auditRepository.insert({
      actor: { actorId: userId, actorType: "human", role: actor.role },
      action: "workspace.created",
      targetType: "workspace",
      targetId: workspace.id,
      metadata: { isDefault: false },
    });
    return workspace;
  },

  async updateWorkspace(
    userId: string,
    workspaceId: string,
    updates: Record<string, unknown>,
    authContext?: AuthContext,
  ) {
    const workspace = await this.getWorkspace(userId, workspaceId);
    const actor = authContext ? actorFromAuth(authContext) : await getActor(userId);
    if (workspace.ownerUid !== userId) {
      const member = await workspaceRepository.getMember(workspaceId, userId);
      if (
        !authorizationService.can(actor, "workspace.manage.settings") ||
        !authorizationService.canManageWorkspace(
          actor,
          workspace.ownerUid,
          member?.role,
        )
      ) {
        throw new HttpError(403, "forbidden", "Access denied");
      }
    }

    const mapped: Record<string, unknown> = {};
    if ("name" in updates) mapped.name = updates.name;
    if ("description" in updates) mapped.description = updates.description;
    if ("slug" in updates && typeof updates.slug === "string")
      mapped.slug = slugify(updates.slug);
    if ("color" in updates) mapped.color = updates.color;
    if ("icon" in updates) mapped.icon = updates.icon;
    if ("status" in updates) mapped.status = updates.status;
    if ("settings" in updates) mapped.settings = updates.settings;
    if ("metadata" in updates) mapped.metadata = updates.metadata;
    if ("limits" in updates) mapped.limits = updates.limits;

    const updated = await workspaceRepository.updateWorkspace(
      workspaceId,
      mapped,
    );
    await workspaceRepository.insertActivity(
      workspaceId,
      userId,
      "workspace_updated",
      "Workspace updated",
      mapped,
    );
    return updated;
  },

  async deleteWorkspace(userId: string, workspaceId: string, authContext?: AuthContext) {
    const access = await workspaceRepository.getAccess(workspaceId, userId);
    if (!access) {
      throw new HttpError(404, "not_found", "Workspace not found");
    }
    const { workspace, member } = access;
    if (workspace.ownerUid !== userId && !member) {
      throw new HttpError(403, "forbidden", "Access denied");
    }
    const actor = authContext ? actorFromAuth(authContext) : await getActor(userId);
    const ownedWorkspaceCount = await workspaceRepository.countByOwner(userId);
    if (
      !authorizationService.canDeleteWorkspace(
        actor,
        workspace.ownerUid,
        ownedWorkspaceCount,
        workspace.isDefault,
      )
    ) {
      throw new HttpError(
        403,
        workspace.isDefault ? "cannot_delete_default" : "forbidden",
        workspace.isDefault
          ? "Cannot delete the only default workspace"
          : "Access denied",
      );
    }
    await workspaceRepository.softDeleteWorkspace(workspaceId);
    await workspaceRepository.insertActivity(
      workspaceId,
      userId,
      "workspace_deleted",
      "Workspace deleted",
      {},
    );
    await auditRepository.insert({
      actor: { actorId: userId, actorType: "human", role: actor.role },
      action: "workspace.deleted",
      targetType: "workspace",
      targetId: workspaceId,
    });
  },

  async listMembers(userId: string, workspaceId: string) {
    await this.getWorkspace(userId, workspaceId);
    return workspaceRepository.listMembers(workspaceId);
  },

  async addMember(
    userId: string,
    workspaceId: string,
    email: string,
    role: string,
  ) {
    const workspace = await this.getWorkspace(userId, workspaceId);
    const actor = await getActor(userId);
    assertAssignableWorkspaceRole(role);
    if (!authorizationService.canInviteMembers(actor)) {
      throw new HttpError(403, "forbidden", "Access denied");
    }
    if (workspace.ownerUid !== userId) {
      const member = await workspaceRepository.getMember(workspaceId, userId);
      if (
        !authorizationService.canManageWorkspace(
          actor,
          workspace.ownerUid,
          member?.role,
        )
      ) {
        throw new HttpError(403, "forbidden", "Access denied");
      }
    }

    const existing = await workspaceRepository.getMember(workspaceId, email);
    if (existing) {
      throw new HttpError(409, "member_exists", "User is already a member");
    }

    const limits = workspace.limits ?? workspaceRepository.defaultLimits();
    const memberCount = await workspaceRepository.countMembers(workspaceId);
    if (limits.maxMembers > 0 && memberCount >= limits.maxMembers) {
      throw new HttpError(
        403,
        "member_limit_exceeded",
        "Member limit exceeded",
        { current: memberCount, max: limits.maxMembers },
      );
    }

    const created = await workspaceRepository.createMember({
      workspaceId,
      userUid: email,
      email,
      displayName: email,
      role,
      invitedBy: userId,
      invitedAt: new Date().toISOString(),
      inviteStatus: "pending",
      status: "active",
      preferences: {},
    });
    await workspaceRepository.insertActivity(
      workspaceId,
      userId,
      "member_added",
      "Member added",
      { member_email: email, role },
    );
    await notificationsRepository.insert({
      userId: workspace.ownerUid,
      workspaceId,
      type: "workspace.member_added",
      category: "workspace",
      title: "Workspace member invited",
      body: `${email} was invited to ${workspace.name}.`,
      actorId: userId,
      actorType: "human",
      actorName: actor.displayName,
      metadata: { invitedEmail: email, role },
    });
    return created;
  },

  async updateMemberRole(
    userId: string,
    workspaceId: string,
    memberUid: string,
    role: string,
  ) {
    const workspace = await this.getWorkspace(userId, workspaceId);
    const actor = await getActor(userId);
    assertAssignableWorkspaceRole(role);
    if (!authorizationService.canInviteMembers(actor)) {
      throw new HttpError(403, "forbidden", "Access denied");
    }
    if (workspace.ownerUid !== userId) {
      const current = await workspaceRepository.getMember(workspaceId, userId);
      if (
        !authorizationService.canManageWorkspace(
          actor,
          workspace.ownerUid,
          current?.role,
        )
      ) {
        throw new HttpError(403, "forbidden", "Access denied");
      }
    }
    if (memberUid === userId) {
      throw new HttpError(
        403,
        "cannot_change_own_role",
        "Cannot change your own role",
      );
    }
    const target = await workspaceRepository.getMember(workspaceId, memberUid);
    if (!target) {
      throw new HttpError(404, "member_not_found", "Member not found");
    }
    if (target.role === "owner") {
      throw new HttpError(
        403,
        "cannot_remove_owner",
        "Cannot remove workspace owner",
      );
    }
    await workspaceRepository.updateMemberRole(workspaceId, memberUid, role);
    await workspaceRepository.insertActivity(
      workspaceId,
      userId,
      "member_role_changed",
      "Member role changed",
      { member_uid: memberUid, new_role: role },
    );
    return workspaceRepository.getMember(workspaceId, memberUid);
  },

  async removeMember(userId: string, workspaceId: string, memberUid: string) {
    const workspace = await this.getWorkspace(userId, workspaceId);
    const actor = await getActor(userId);
    if (!authorizationService.canInviteMembers(actor)) {
      throw new HttpError(403, "forbidden", "Access denied");
    }
    if (workspace.ownerUid !== userId) {
      const current = await workspaceRepository.getMember(workspaceId, userId);
      if (
        !authorizationService.canManageWorkspace(
          actor,
          workspace.ownerUid,
          current?.role,
        )
      ) {
        throw new HttpError(403, "forbidden", "Access denied");
      }
    }
    const target = await workspaceRepository.getMember(workspaceId, memberUid);
    if (!target) {
      throw new HttpError(404, "member_not_found", "Member not found");
    }
    if (target.role === "owner") {
      throw new HttpError(
        403,
        "cannot_remove_owner",
        "Cannot remove workspace owner",
      );
    }
    await workspaceRepository.removeMember(workspaceId, memberUid);
    await workspaceRepository.insertActivity(
      workspaceId,
      userId,
      "member_removed",
      "Member removed",
      { member_uid: memberUid },
    );
  },

  async getActivity(
    userId: string,
    workspaceId: string,
    skip: number,
    limit: number,
  ) {
    await this.getWorkspace(userId, workspaceId);
    return workspaceRepository.listActivity(workspaceId, skip, limit);
  },

  async syncCounters(userId: string, workspaceId: string) {
    const workspace = await this.getWorkspace(userId, workspaceId);
    const memberCount = await workspaceRepository.countMembers(workspaceId);
    const updatedWorkspace = await workspaceRepository.updateWorkspace(
      workspaceId,
      {
        counters: {
          ...workspaceRepository.defaultCounters(),
          ...workspace.counters,
          members: memberCount,
        },
      },
    );
    await workspaceRepository.insertActivity(
      workspaceId,
      userId,
      "workspace_updated",
      "Workspace counters synced",
      {},
    );
    return updatedWorkspace?.counters;
  },

  async createInvitation(
    userId: string,
    workspaceId: string,
    email: string,
    role: string,
  ) {
    const workspace = await this.getWorkspace(userId, workspaceId);
    const actor = await getActor(userId);
    assertAssignableWorkspaceRole(role);
    if (!authorizationService.canInviteMembers(actor)) {
      throw new HttpError(403, "forbidden", "Access denied");
    }
    if (workspace.ownerUid !== userId) {
      const member = await workspaceRepository.getMember(workspaceId, userId);
      if (
        !authorizationService.canManageWorkspace(
          actor,
          workspace.ownerUid,
          member?.role,
        )
      ) {
        throw new HttpError(403, "forbidden", "Access denied");
      }
    }
    const invitation = await workspaceRepository.createInvitation(
      workspaceId,
      userId,
      email,
      role,
    );
    await workspaceRepository.insertActivity(
      workspaceId,
      userId,
      "invitation_created",
      "Invitation created",
      { email, role },
    );
    await auditRepository.insert({
      actor: { actorId: userId, actorType: "human", role: actor.role },
      action: "workspace.invitation.created",
      targetType: "workspace_invitation",
      targetId: invitation.id,
      metadata: { workspaceId, email, role },
    });
    return invitation;
  },

  async listInvitations(userId: string, workspaceId: string) {
    await this.getWorkspace(userId, workspaceId);
    return workspaceRepository.listInvitations(workspaceId);
  },

  async acceptInvitation(userId: string, token: string) {
    const invitation = await workspaceRepository.getInvitationByToken(token);
    if (!invitation) {
      throw new HttpError(404, "invite_not_found", "Invitation not found");
    }
    if (invitation.status !== "pending") {
      throw new HttpError(
        400,
        "invite_invalid",
        "Invitation is no longer valid",
      );
    }
    const user = await authRepository.getUserById(userId);
    if (!user) {
      throw new HttpError(404, "user_not_found", "User not found");
    }
    // Verify that the authenticated user's email matches the invited email
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new HttpError(
        403,
        "invite_email_mismatch",
        "This invitation was sent to a different email address",
      );
    }
    await workspaceRepository.createMember({
      workspaceId: invitation.workspaceId,
      userUid: user.id,
      email: user.email,
      displayName: user.displayName || user.fullName || user.email,
      avatarUrl: user.avatarUrl,
      role: invitation.role,
      invitedBy: invitation.invitedBy,
      invitedAt: invitation.createdAt,
      inviteToken: invitation.token,
      inviteStatus: "accepted",
      joinedAt: new Date().toISOString(),
      status: "active",
      preferences: {},
    });
    await workspaceRepository.updateInvitationStatus(token, "accepted", userId);
  },

  async declineInvitation(userId: string, token: string) {
    const invitation = await workspaceRepository.getInvitationByToken(token);
    if (!invitation) {
      throw new HttpError(404, "invite_not_found", "Invitation not found");
    }
    if (invitation.email) {
      const user = await authRepository.getUserById(userId);
      if (user && user.email !== invitation.email) {
        throw new HttpError(
          403,
          "forbidden",
          "You can only decline your own invitations",
        );
      }
    }
    await workspaceRepository.updateInvitationStatus(token, "declined");
  },

  async revokeInvitation(userId: string, invitationId: string) {
    const invitation =
      await workspaceRepository.getInvitationById(invitationId);
    if (!invitation) {
      throw new HttpError(404, "invite_not_found", "Invitation not found");
    }
    const workspace = await workspaceRepository.getById(invitation.workspaceId);
    if (!workspace) {
      throw new HttpError(404, "workspace_not_found", "Workspace not found");
    }
    if (workspace.ownerUid !== userId) {
      throw new HttpError(
        403,
        "forbidden",
        "Only workspace owner can revoke invitations",
      );
    }
    await workspaceRepository.revokeInvitation(invitationId);
  },

  async search(
    userId: string,
    workspaceId: string,
    query: string,
    type: string,
    limit: number,
  ) {
    await this.getWorkspace(userId, workspaceId);
    const db = getDb();
    const likeQuery = `%${query}%`;
    const relations = await getOptionalWorkspaceRelations();
    const results: Array<Record<string, unknown>> = [];

    if (type === "all" || type === "member") {
      const rows = await db`
        SELECT id, user_uid, COALESCE(display_name, email, '') AS title, COALESCE(email, '') AS excerpt, updated_at
        FROM workspace_members
        WHERE workspace_id = ${workspaceId}
          AND deleted_at IS NULL
          AND (
            COALESCE(display_name, '') ILIKE ${likeQuery}
            OR COALESCE(email, '') ILIKE ${likeQuery}
          )
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
      for (const row of rows) {
        results.push({
          type: "member",
          id: row.id,
          title: row.title,
          excerpt: row.excerpt,
          userUid: row.user_uid,
          updatedAt: row.updated_at,
        });
      }
    }

    if (type === "all" || type === "activity") {
      const rows = await db`
        SELECT id, activity_type, COALESCE(description, '') AS excerpt, created_at
        FROM workspace_activity
        WHERE workspace_id = ${workspaceId}
          AND (
            COALESCE(activity_type, '') ILIKE ${likeQuery}
            OR COALESCE(description, '') ILIKE ${likeQuery}
          )
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      for (const row of rows) {
        results.push({
          type: "activity",
          id: row.id,
          title: row.activity_type,
          excerpt: row.excerpt,
          updatedAt: row.created_at,
        });
      }
    }

    if (relations.hasProjects && (type === "all" || type === "project")) {
      const rows = await db`
        SELECT id, name, COALESCE(description, '') AS excerpt, updated_at
        FROM projects
        WHERE workspace_id = ${workspaceId}
          AND deleted_at IS NULL
          AND (name ILIKE ${likeQuery} OR description ILIKE ${likeQuery})
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
      for (const row of rows) {
        results.push({
          type: "project",
          id: row.id,
          title: row.name,
          excerpt: row.excerpt,
          updatedAt: row.updated_at,
        });
      }
    }

    if (
      relations.hasProjects &&
      relations.hasProjectDocuments &&
      (type === "all" || type === "document")
    ) {
      const rows = await db`
        SELECT d.id, d.title, COALESCE(d.plain_text, '') AS excerpt, d.project_id, COALESCE(p.name, '') AS project_name, d.updated_at
        FROM project_documents d
        JOIN projects p ON p.id = d.project_id
        WHERE p.workspace_id = ${workspaceId}
          AND d.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND (d.title ILIKE ${likeQuery} OR d.plain_text ILIKE ${likeQuery})
        ORDER BY d.updated_at DESC
        LIMIT ${limit}
      `;
      for (const row of rows) {
        results.push({
          type: "document",
          id: row.id,
          title: row.title,
          excerpt: row.excerpt,
          projectId: row.project_id,
          projectName: row.project_name,
          updatedAt: row.updated_at,
        });
      }
    }

    if (
      relations.hasProjects &&
      relations.hasProjectNotes &&
      (type === "all" || type === "note")
    ) {
      const rows = await db`
        SELECT n.id, n.title, COALESCE(n.plain_text, '') AS excerpt, n.project_id, COALESCE(p.name, '') AS project_name, n.updated_at
        FROM project_notes n
        JOIN projects p ON p.id = n.project_id
        WHERE p.workspace_id = ${workspaceId}
          AND n.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND (n.title ILIKE ${likeQuery} OR n.plain_text ILIKE ${likeQuery})
        ORDER BY n.updated_at DESC
        LIMIT ${limit}
      `;
      for (const row of rows) {
        results.push({
          type: "note",
          id: row.id,
          title: row.title,
          excerpt: row.excerpt,
          projectId: row.project_id,
          projectName: row.project_name,
          updatedAt: row.updated_at,
        });
      }
    }

    if (
      relations.hasProjects &&
      relations.hasProjectTasks &&
      (type === "all" || type === "task")
    ) {
      const rows = await db`
        SELECT t.id, t.title, COALESCE(t.description, '') AS excerpt, t.project_id, COALESCE(p.name, '') AS project_name, t.updated_at
        FROM project_tasks t
        JOIN projects p ON p.id = t.project_id
        WHERE p.workspace_id = ${workspaceId}
          AND t.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND (t.title ILIKE ${likeQuery} OR t.description ILIKE ${likeQuery})
        ORDER BY t.updated_at DESC
        LIMIT ${limit}
      `;
      for (const row of rows) {
        results.push({
          type: "task",
          id: row.id,
          title: row.title,
          excerpt: row.excerpt,
          projectId: row.project_id,
          projectName: row.project_name,
          updatedAt: row.updated_at,
        });
      }
    }

    return results
      .sort((left, right) =>
        String(right.updatedAt ?? "").localeCompare(
          String(left.updatedAt ?? ""),
        ),
      )
      .slice(0, limit);
  },

  async dashboard(userId: string, workspaceId: string) {
    const workspace = await this.getWorkspace(userId, workspaceId);
    const db = getDb();
    const counters = {
      ...workspaceRepository.defaultCounters(),
      ...(workspace.counters ?? {}),
    };
    const [memberCount, activity, recentAlerts, unreadAlerts, dailyStats] =
      await Promise.all([
        workspaceRepository.countMembers(workspaceId),
        workspaceRepository.listActivity(workspaceId, 0, 10),
        notificationsRepository.list(userId, { workspaceId, limit: 5 }),
        notificationsRepository.unreadCount(userId, workspaceId),
        db`
        SELECT
          date,
          new_members,
          active_members,
          new_projects,
          new_tasks,
          completed_tasks,
          new_conversations,
          ai_tokens_used,
          api_calls,
          storage_delta_bytes,
          activity_score
        FROM workspace_daily_stats
        WHERE workspace_id = ${workspaceId}
        ORDER BY date DESC
        LIMIT 30
      `,
      ]);

    return {
      workspace,
      statistics: {
        projects: Number(counters.projects ?? 0),
        files: Number(counters.files ?? 0),
        tasks: Number(counters.tasks ?? 0),
        notes: Number(counters.notes ?? 0),
        members: memberCount,
        storageUsed: Number(counters.storageUsed ?? 0),
        apiCallsToday: Number(counters.apiCallsToday ?? 0),
        aiTokensToday: Number(counters.aiTokensToday ?? 0),
        unreadNotifications: unreadAlerts,
      },
      totalCounts: {
        projects: Number(counters.projects ?? 0),
        documents: Number(counters.files ?? 0),
        notes: Number(counters.notes ?? 0),
        tasks: Number(counters.tasks ?? 0),
        members: memberCount,
      },
      recentActivity: activity.activities,
      recentAlerts: recentAlerts.map((notification) => ({
        id: notification.id,
        type: notification.type,
        category: notification.category,
        title: notification.title,
        body: notification.body,
        isRead: notification.isRead,
        priority: notification.priority,
        createdAt: notification.createdAt,
      })),
      dailyStats: dailyStats.map((row) => ({
        date: String(row.date),
        newMembers: Number(row.new_members ?? 0),
        activeMembers: Number(row.active_members ?? 0),
        newProjects: Number(row.new_projects ?? 0),
        newTasks: Number(row.new_tasks ?? 0),
        completedTasks: Number(row.completed_tasks ?? 0),
        newConversations: Number(row.new_conversations ?? 0),
        aiTokensUsed: Number(row.ai_tokens_used ?? 0),
        apiCalls: Number(row.api_calls ?? 0),
        storageDeltaBytes: Number(row.storage_delta_bytes ?? 0),
        activityScore: Number(row.activity_score ?? 0),
      })),
      lastUpdated: workspace.updatedAt,
    };
  },

  async getStorageInfo(userId: string, workspaceId: string) {
    const workspace = await this.getWorkspace(userId, workspaceId);
    const limitBytes = workspace.limits?.maxStorage ?? 1073741824;
    const db = getDb();
    const rows = await db`
      SELECT *
      FROM (
        SELECT
          'support_file' AS source,
          f.id,
          f.request_id AS parent_id,
          r.collection_id,
          COALESCE(NULLIF(f.file_name, ''), 'Uploaded file') AS name,
          COALESCE(NULLIF(f.file_type, ''), 'application/octet-stream') AS file_type,
          GREATEST(COALESCE(f.file_size, 0), 0)::bigint AS file_size,
          COALESCE(NULLIF(f.external_file_url, ''), NULLIF(f.file_url, '')) AS preview_url,
          r.title AS folder_name,
          f.created_at
        FROM support_files f
        INNER JOIN support_requests r ON r.id = f.request_id
        WHERE r.workspace_id = ${workspaceId}::uuid
          AND r.user_key_id = ${userId}

        UNION ALL

        SELECT
          'document' AS source,
          d.id,
          d.project_id AS parent_id,
          NULL::uuid AS collection_id,
          COALESCE(NULLIF(d.title, ''), 'Document') AS name,
          COALESCE(NULLIF(d.doc_type, ''), 'document') AS file_type,
          GREATEST(octet_length(COALESCE(d.content, '')), octet_length(COALESCE(d.content_json::text, '{}')))::bigint AS file_size,
          '/' || p.workspace_id::text || '/projects/' || p.id::text || '/documents/' || d.id::text AS preview_url,
          p.title AS folder_name,
          d.created_at
        FROM project_documents d
        INNER JOIN workspace_projects p ON p.id = d.project_id
        WHERE p.workspace_id = ${workspaceId}::uuid
          AND d.owner_uid = ${userId}
          AND d.deleted_at IS NULL
          AND p.deleted_at IS NULL

        UNION ALL

        SELECT
          'presentation' AS source,
          s.id,
          s.project_id AS parent_id,
          NULL::uuid AS collection_id,
          COALESCE(NULLIF(s.title, ''), 'Presentation') AS name,
          'presentation' AS file_type,
          octet_length(COALESCE(s.slide_data::text, '[]'))::bigint AS file_size,
          '/' || p.workspace_id::text || '/projects/' || p.id::text || '/presentations/' || s.id::text AS preview_url,
          p.title AS folder_name,
          s.created_at
        FROM project_slides s
        INNER JOIN workspace_projects p ON p.id = s.project_id
        WHERE p.workspace_id = ${workspaceId}::uuid
          AND s.owner_uid = ${userId}
          AND s.deleted_at IS NULL
          AND p.deleted_at IS NULL

        UNION ALL

        SELECT
          'note' AS source,
          n.id,
          n.project_id AS parent_id,
          NULL::uuid AS collection_id,
          COALESCE(NULLIF(n.title, ''), 'Note') AS name,
          'note' AS file_type,
          GREATEST(octet_length(COALESCE(n.content, '')), octet_length(COALESCE(n.content_json::text, '{}')))::bigint AS file_size,
          '/' || p.workspace_id::text || '/projects/' || p.id::text || '/notes/' || n.id::text AS preview_url,
          p.title AS folder_name,
          n.created_at
        FROM project_notes n
        INNER JOIN workspace_projects p ON p.id = n.project_id
        WHERE p.workspace_id = ${workspaceId}::uuid
          AND n.owner_uid = ${userId}
          AND n.deleted_at IS NULL
          AND p.deleted_at IS NULL
      ) files
      ORDER BY created_at DESC
      LIMIT 500
    `;
    const [folderStats] = await db`
      SELECT COUNT(*)::int AS folder_count
      FROM workspace_collections
      WHERE workspace_id = ${workspaceId}::uuid
        AND owner_uid = ${userId}
        AND deleted_at IS NULL
    `;

    const categoryFor = (name: string, type: string, source: string) => {
      const value = `${name} ${type} ${source}`.toLowerCase();
      if (value.match(/\b(image|png|jpg|jpeg|gif|webp|svg)\b/)) return "images";
      if (value.match(/\b(xls|xlsx|csv|ods|spreadsheet|sheet|excel)\b/)) return "spreadsheets";
      if (value.match(/\b(ppt|pptx|odp|presentation|slides?)\b/)) return "presentations";
      if (value.match(/\b(pdf|doc|docx|txt|rtf|odt|document|note)\b/)) return "documents";
      return "other";
    };
    const breakdownMap = new Map<string, { id: string; label: string; count: number; bytes: number }>(
      [
        ["images", { id: "images", label: "Images", count: 0, bytes: 0 }],
        ["documents", { id: "documents", label: "Documents", count: 0, bytes: 0 }],
        ["spreadsheets", { id: "spreadsheets", label: "Excel sheets", count: 0, bytes: 0 }],
        ["presentations", { id: "presentations", label: "PowerPoints", count: 0, bytes: 0 }],
        ["other", { id: "other", label: "Other files", count: 0, bytes: 0 }],
      ],
    );
    const recentFiles = rows.map((row) => {
      const name = String(row.name ?? "File");
      const type = String(row.file_type ?? "");
      const source = String(row.source ?? "");
      const size = Number(row.file_size ?? 0);
      const category = categoryFor(name, type, source);
      const stat = breakdownMap.get(category) ?? breakdownMap.get("other")!;
      stat.count += 1;
      stat.bytes += size;
      return {
        id: String(row.id),
        name,
        size,
        type,
        category,
        source,
        previewUrl: row.preview_url ? String(row.preview_url) : "",
        folderName: row.folder_name ? String(row.folder_name) : "Workspace",
        collectionId: row.collection_id ? String(row.collection_id) : null,
        uploadedAt: String(row.created_at),
      };
    });
    const usedBytes = recentFiles.reduce((sum, file) => sum + file.size, 0);
    return {
      workspaceId,
      driveFolderId: workspace.settings?.driveFolderId ?? "",
      driveFolderPath: workspace.settings?.driveFolderPath ?? "",
      quotaBytes: limitBytes,
      usedBytes,
      usedPercent:
        limitBytes > 0 ? Math.round((usedBytes / limitBytes) * 100) : 0,
      folderCount: Number(folderStats?.folder_count ?? 0),
      fileCount: recentFiles.length,
      breakdown: Array.from(breakdownMap.values()),
      recentFiles,
    };
  },

  async getQuotaStatus(userId: string, workspaceId: string) {
    const info = await this.getStorageInfo(userId, workspaceId);
    return {
      allowed: info.quotaBytes <= 0 ? true : info.usedBytes < info.quotaBytes,
      ...info,
    };
  },

  async syncStorageUsage(userId: string, workspaceId: string) {
    return this.getStorageInfo(userId, workspaceId);
  },

  async checkQuota(
    userId: string,
    workspaceId: string,
    additionalBytes: number,
  ) {
    const info = await this.getStorageInfo(userId, workspaceId);
    if (
      info.quotaBytes > 0 &&
      info.usedBytes + additionalBytes > info.quotaBytes
    ) {
      throw new HttpError(402, "quota_exceeded", "quota exceeded");
    }
    return { allowed: true };
  },

  async uploadFile(
    userId: string,
    workspaceId: string,
    fileName: string,
    content: Uint8Array,
  ) {
    void fileName;
    void content;
    await this.checkQuota(userId, workspaceId, content.length);
    await this.getWorkspace(userId, workspaceId);
    throw new HttpError(
      503,
      "storage_unavailable",
      "Workspace file storage is handled by the configured external workflow",
    );
  },
};

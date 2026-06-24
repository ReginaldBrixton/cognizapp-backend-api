export const CANONICAL_ROLES = [
  "REGULAR_USER",
  "PRO_USER",
  "SUPPORT_PROVIDER_USER",
  "DEV_USER",
  "ADMIN_USER",
  "SYSTEM_USER",
] as const;

export type CanonicalRole = (typeof CANONICAL_ROLES)[number];

export type ActorType = "human" | "system";

export type Permission =
  | "workspace.create.own"
  | "workspace.create.multi"
  | "workspace.invite.members"
  | "workspace.manage.settings"
  | "workspace.delete.owned"
  | "projects.create"
  | "projects.update"
  | "projects.delete"
  | "tasks.create"
  | "tasks.update"
  | "tasks.assign"
  | "tasks.delete"
  | "users.view"
  | "users.manage.status"
  | "users.manage.roles"
  | "support.tickets.view"
  | "support.tickets.respond"
  | "support.users.inspect"
  | "support.workspaces.inspect"
  | "admin.analytics.view"
  | "dev.debug.access"
  | "dev.featureflags.manage"
  | "dev.ops.run"
  | "system.notifications.send"
  | "system.jobs.execute"
  | "system.audit.write";

export type AccessActor = {
  actorId: string;
  actorType: ActorType;
  role: string;
  permissions?: string[];
};

export const legacyRoleMap: Record<string, CanonicalRole> = {
  user: "REGULAR_USER",
  premium: "PRO_USER",
  support_provider: "SUPPORT_PROVIDER_USER",
  developer: "DEV_USER",
  admin: "ADMIN_USER",
  master: "ADMIN_USER",
};

export const roleHierarchy: Record<CanonicalRole, number> = {
  REGULAR_USER: 0,
  PRO_USER: 1,
  SUPPORT_PROVIDER_USER: 2,
  DEV_USER: 3,
  ADMIN_USER: 4,
  SYSTEM_USER: 5,
};

const rolePermissions: Record<CanonicalRole, Permission[]> = {
  REGULAR_USER: [
    "workspace.create.own",
    "workspace.delete.owned",
    "projects.create",
    "projects.update",
    "projects.delete",
    "tasks.create",
    "tasks.update",
    "tasks.assign",
    "tasks.delete",
  ],
  PRO_USER: [
    "workspace.create.own",
    "workspace.create.multi",
    "workspace.invite.members",
    "workspace.manage.settings",
    "workspace.delete.owned",
    "projects.create",
    "projects.update",
    "projects.delete",
    "tasks.create",
    "tasks.update",
    "tasks.assign",
    "tasks.delete",
  ],
  SUPPORT_PROVIDER_USER: [
    "support.tickets.view",
    "support.tickets.respond",
  ],
  DEV_USER: [
    "dev.debug.access",
    "dev.featureflags.manage",
    "dev.ops.run",
  ],
  ADMIN_USER: [
    "users.view",
    "users.manage.status",
    "users.manage.roles",
    "support.tickets.view",
    "support.tickets.respond",
    "support.users.inspect",
    "support.workspaces.inspect",
    "admin.analytics.view",
  ],
  SYSTEM_USER: [
    "system.notifications.send",
    "system.jobs.execute",
    "system.audit.write",
  ],
};

const assignableRolesByAdmin = new Set<CanonicalRole>([
  "REGULAR_USER",
  "PRO_USER",
  "SUPPORT_PROVIDER_USER",
  "DEV_USER",
  "ADMIN_USER",
]);

export function normalizeRole(role: string | null | undefined): CanonicalRole {
  const value = String(role ?? "").trim();
  if ((CANONICAL_ROLES as readonly string[]).includes(value)) {
    return value as CanonicalRole;
  }
  return legacyRoleMap[value] ?? "REGULAR_USER";
}

export function getActorType(role: string | null | undefined): ActorType {
  return normalizeRole(role) === "SYSTEM_USER" ? "system" : "human";
}

export function permissionsForRole(role: string | null | undefined): Permission[] {
  return rolePermissions[normalizeRole(role)];
}

export const authorizationService = {
  can(actor: AccessActor, permission: Permission) {
    const effective = new Set<string>([
      ...permissionsForRole(actor.role),
      ...((actor.permissions ?? []).map((item) => String(item))),
    ]);
    return effective.has(permission);
  },

  canCreateWorkspace(actor: AccessActor, ownedWorkspaceCount: number, isBootstrap = false) {
    const role = normalizeRole(actor.role);
    if (isBootstrap) {
      return actor.actorType === "human";
    }
    if (role === "REGULAR_USER") {
      return ownedWorkspaceCount < 1 && this.can(actor, "workspace.create.own");
    }
    if (role === "PRO_USER") {
      return this.can(actor, "workspace.create.multi");
    }
    return false;
  },

  maxOwnedWorkspaces(actor: AccessActor) {
    const role = normalizeRole(actor.role);
    if (role === "REGULAR_USER") {
      return 1;
    }
    if (role === "PRO_USER") {
      return null;
    }
    return 1;
  },

  canInviteMembers(actor: AccessActor) {
    return this.can(actor, "workspace.invite.members");
  },

  canManageWorkspace(actor: AccessActor, workspaceOwnerId: string, membershipRole?: string | null) {
    if (workspaceOwnerId === actor.actorId) {
      return true;
    }
    return ["owner", "admin"].includes(String(membershipRole ?? ""));
  },

  canDeleteWorkspace(actor: AccessActor, workspaceOwnerId: string, ownedWorkspaceCount: number, isDefault: boolean) {
    if (!this.can(actor, "workspace.delete.owned")) {
      return false;
    }
    if (workspaceOwnerId !== actor.actorId) {
      return false;
    }
    if (isDefault && ownedWorkspaceCount <= 1) {
      return false;
    }
    return true;
  },

  canAssignRole(actor: AccessActor, targetRole: string) {
    const actorRole = normalizeRole(actor.role);
    const nextRole = normalizeRole(targetRole);

    if (actorRole !== "ADMIN_USER") {
      return false;
    }

    return assignableRolesByAdmin.has(nextRole);
  },

  isInteractiveRole(role: string) {
    return normalizeRole(role) !== "SYSTEM_USER";
  },
};

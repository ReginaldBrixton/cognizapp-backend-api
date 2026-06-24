import { describe, expect, it } from "bun:test";
import {
  normalizeRole,
  getActorType,
  permissionsForRole,
  authorizationService,
  legacyRoleMap,
  roleHierarchy,
  CANONICAL_ROLES,
  type AccessActor,
} from "../src/modules/auth/policy";

describe("normalizeRole", () => {
  it("returns canonical role when already canonical", () => {
    expect(normalizeRole("REGULAR_USER")).toBe("REGULAR_USER");
    expect(normalizeRole("ADMIN_USER")).toBe("ADMIN_USER");
    expect(normalizeRole("SYSTEM_USER")).toBe("SYSTEM_USER");
  });

  it("maps legacy role names to canonical", () => {
    expect(normalizeRole("user")).toBe("REGULAR_USER");
    expect(normalizeRole("premium")).toBe("PRO_USER");
    expect(normalizeRole("admin")).toBe("ADMIN_USER");
    expect(normalizeRole("master")).toBe("ADMIN_USER");
    expect(normalizeRole("support_provider")).toBe("SUPPORT_PROVIDER_USER");
    expect(normalizeRole("developer")).toBe("DEV_USER");
  });

  it("defaults to REGULAR_USER for unknown roles", () => {
    expect(normalizeRole("unknown")).toBe("REGULAR_USER");
    expect(normalizeRole("")).toBe("REGULAR_USER");
  });

  it("handles null and undefined", () => {
    expect(normalizeRole(null)).toBe("REGULAR_USER");
    expect(normalizeRole(undefined)).toBe("REGULAR_USER");
  });

  it("trims whitespace", () => {
    expect(normalizeRole("  ADMIN_USER  ")).toBe("ADMIN_USER");
  });
});

describe("getActorType", () => {
  it('returns "system" for SYSTEM_USER', () => {
    expect(getActorType("SYSTEM_USER")).toBe("system");
  });

  it('returns "human" for all other roles', () => {
    expect(getActorType("REGULAR_USER")).toBe("human");
    expect(getActorType("ADMIN_USER")).toBe("human");
    expect(getActorType("user")).toBe("human");
    expect(getActorType(null)).toBe("human");
  });
});

describe("permissionsForRole", () => {
  it("returns permissions for REGULAR_USER", () => {
    const perms = permissionsForRole("REGULAR_USER");
    expect(perms).toContain("workspace.create.own");
    expect(perms).toContain("projects.create");
    expect(perms).not.toContain("admin.analytics.view");
  });

  it("returns admin permissions for ADMIN_USER", () => {
    const perms = permissionsForRole("ADMIN_USER");
    expect(perms).toContain("admin.analytics.view");
    expect(perms).toContain("users.manage.roles");
  });

  it("returns system permissions for SYSTEM_USER", () => {
    const perms = permissionsForRole("SYSTEM_USER");
    expect(perms).toContain("system.jobs.execute");
  });

  it("resolves legacy roles before looking up permissions", () => {
    const perms = permissionsForRole("user");
    expect(perms).toEqual(permissionsForRole("REGULAR_USER"));
  });
});

describe("roleHierarchy", () => {
  it("has ascending levels from REGULAR to SYSTEM", () => {
    expect(roleHierarchy.REGULAR_USER).toBeLessThan(roleHierarchy.PRO_USER);
    expect(roleHierarchy.PRO_USER).toBeLessThan(roleHierarchy.SUPPORT_PROVIDER_USER);
    expect(roleHierarchy.SUPPORT_PROVIDER_USER).toBeLessThan(roleHierarchy.DEV_USER);
    expect(roleHierarchy.DEV_USER).toBeLessThan(roleHierarchy.ADMIN_USER);
    expect(roleHierarchy.ADMIN_USER).toBeLessThan(roleHierarchy.SYSTEM_USER);
  });
});

describe("authorizationService.can", () => {
  const makeActor = (role: string, permissions?: string[]): AccessActor => ({
    actorId: "user-1",
    actorType: "human",
    role,
    permissions,
  });

  it("grants permission from role-based permissions", () => {
    const actor = makeActor("ADMIN_USER");
    expect(authorizationService.can(actor, "admin.analytics.view")).toBe(true);
  });

  it("denies permission not in role", () => {
    const actor = makeActor("REGULAR_USER");
    expect(authorizationService.can(actor, "admin.analytics.view")).toBe(false);
  });

  it("grants permission from extra permissions array", () => {
    const actor = makeActor("REGULAR_USER", ["admin.analytics.view"]);
    expect(authorizationService.can(actor, "admin.analytics.view")).toBe(true);
  });
});

describe("authorizationService.canCreateWorkspace", () => {
  const makeActor = (role: string): AccessActor => ({
    actorId: "user-1",
    actorType: "human",
    role,
  });

  it("allows bootstrap workspace creation for human actors", () => {
    expect(
      authorizationService.canCreateWorkspace(makeActor("REGULAR_USER"), 0, true),
    ).toBe(true);
  });

  it("denies bootstrap for system actors", () => {
    const actor: AccessActor = {
      actorId: "sys-1",
      actorType: "system",
      role: "SYSTEM_USER",
    };
    expect(authorizationService.canCreateWorkspace(actor, 0, true)).toBe(false);
  });

  it("allows REGULAR_USER to create first workspace", () => {
    expect(
      authorizationService.canCreateWorkspace(makeActor("REGULAR_USER"), 0),
    ).toBe(true);
  });

  it("denies REGULAR_USER additional workspaces", () => {
    expect(
      authorizationService.canCreateWorkspace(makeActor("REGULAR_USER"), 1),
    ).toBe(false);
  });

  it("allows PRO_USER multiple workspaces", () => {
    expect(
      authorizationService.canCreateWorkspace(makeActor("PRO_USER"), 5),
    ).toBe(true);
  });
});

describe("authorizationService.maxOwnedWorkspaces", () => {
  const makeActor = (role: string): AccessActor => ({
    actorId: "user-1",
    actorType: "human",
    role,
  });

  it("returns 1 for REGULAR_USER", () => {
    expect(authorizationService.maxOwnedWorkspaces(makeActor("REGULAR_USER"))).toBe(1);
  });

  it("returns null (unlimited) for PRO_USER", () => {
    expect(authorizationService.maxOwnedWorkspaces(makeActor("PRO_USER"))).toBeNull();
  });
});

describe("authorizationService.canDeleteWorkspace", () => {
  const actor: AccessActor = {
    actorId: "user-1",
    actorType: "human",
    role: "REGULAR_USER",
  };

  it("allows deleting owned non-default workspace", () => {
    expect(
      authorizationService.canDeleteWorkspace(actor, "user-1", 2, false),
    ).toBe(true);
  });

  it("denies deleting when not owner", () => {
    expect(
      authorizationService.canDeleteWorkspace(actor, "other-user", 2, false),
    ).toBe(false);
  });

  it("denies deleting last default workspace", () => {
    expect(
      authorizationService.canDeleteWorkspace(actor, "user-1", 1, true),
    ).toBe(false);
  });
});

describe("authorizationService.canAssignRole", () => {
  const adminActor: AccessActor = {
    actorId: "admin-1",
    actorType: "human",
    role: "ADMIN_USER",
  };

  const regularActor: AccessActor = {
    actorId: "user-1",
    actorType: "human",
    role: "REGULAR_USER",
  };

  it("allows admin to assign standard roles", () => {
    expect(authorizationService.canAssignRole(adminActor, "REGULAR_USER")).toBe(true);
    expect(authorizationService.canAssignRole(adminActor, "PRO_USER")).toBe(true);
    expect(authorizationService.canAssignRole(adminActor, "ADMIN_USER")).toBe(true);
  });

  it("denies admin from assigning SYSTEM_USER", () => {
    expect(authorizationService.canAssignRole(adminActor, "SYSTEM_USER")).toBe(false);
  });

  it("denies non-admin from assigning any role", () => {
    expect(authorizationService.canAssignRole(regularActor, "REGULAR_USER")).toBe(false);
  });
});

describe("authorizationService.isInteractiveRole", () => {
  it("returns true for human roles", () => {
    expect(authorizationService.isInteractiveRole("REGULAR_USER")).toBe(true);
    expect(authorizationService.isInteractiveRole("ADMIN_USER")).toBe(true);
    expect(authorizationService.isInteractiveRole("user")).toBe(true);
  });

  it("returns false for SYSTEM_USER", () => {
    expect(authorizationService.isInteractiveRole("SYSTEM_USER")).toBe(false);
  });
});

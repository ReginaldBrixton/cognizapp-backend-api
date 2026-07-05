import { describe, expect, it } from "bun:test";
import {
  normalizeSelectedPrivilegedRole,
  privilegedPortalLabel,
  assertSelectedRoleMatchesGrant,
} from "../src/modules/auth/portal-role";
import { HttpError } from "../src/lib/errors";

describe("normalizeSelectedPrivilegedRole", () => {
  it("returns undefined for empty/null/undefined input", () => {
    expect(normalizeSelectedPrivilegedRole(undefined)).toBeUndefined();
    expect(normalizeSelectedPrivilegedRole(null)).toBeUndefined();
    expect(normalizeSelectedPrivilegedRole("")).toBeUndefined();
    expect(normalizeSelectedPrivilegedRole("  ")).toBeUndefined();
  });

  it("returns canonical role names directly", () => {
    expect(normalizeSelectedPrivilegedRole("ADMIN_USER")).toBe("ADMIN_USER");
    expect(normalizeSelectedPrivilegedRole("SUPPORT_PROVIDER_USER")).toBe("SUPPORT_PROVIDER_USER");
  });

  it('maps "admin" alias to ADMIN_USER', () => {
    expect(normalizeSelectedPrivilegedRole("admin")).toBe("ADMIN_USER");
    expect(normalizeSelectedPrivilegedRole("Admin")).toBe("ADMIN_USER");
  });

  it("maps provider aliases to SUPPORT_PROVIDER_USER", () => {
    expect(normalizeSelectedPrivilegedRole("provider")).toBe("SUPPORT_PROVIDER_USER");
    expect(normalizeSelectedPrivilegedRole("support_provider")).toBe("SUPPORT_PROVIDER_USER");
    expect(normalizeSelectedPrivilegedRole("provider_support")).toBe("SUPPORT_PROVIDER_USER");
    expect(normalizeSelectedPrivilegedRole("support_provider_user")).toBe("SUPPORT_PROVIDER_USER");
  });

  it("throws HttpError for unrecognized role", () => {
    try {
      normalizeSelectedPrivilegedRole("unknown_role");
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).code).toBe("invalid_selected_role");
    }
  });
});

describe("privilegedPortalLabel", () => {
  it('returns "Admin" for ADMIN_USER', () => {
    expect(privilegedPortalLabel("ADMIN_USER")).toBe("Admin");
  });

  it('returns "Provider" for SUPPORT_PROVIDER_USER', () => {
    expect(privilegedPortalLabel("SUPPORT_PROVIDER_USER")).toBe("Provider");
  });

  it("returns string representation for unknown roles", () => {
    expect(privilegedPortalLabel("OTHER")).toBe("OTHER");
    expect(privilegedPortalLabel(null)).toBe("Unknown");
    expect(privilegedPortalLabel(undefined)).toBe("Unknown");
  });
});

describe("assertSelectedRoleMatchesGrant", () => {
  it("does nothing when selectedRole is undefined", () => {
    expect(() => assertSelectedRoleMatchesGrant(undefined, "ADMIN_USER")).not.toThrow();
  });

  it("does nothing when roles match", () => {
    expect(() =>
      assertSelectedRoleMatchesGrant("ADMIN_USER", "ADMIN_USER"),
    ).not.toThrow();
  });

  it("throws HttpError 403 when roles do not match", () => {
    try {
      assertSelectedRoleMatchesGrant("ADMIN_USER", "SUPPORT_PROVIDER_USER");
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(403);
      expect((error as HttpError).code).toBe("role_mismatch");
      expect((error as HttpError).message).toContain("Admin");
      expect((error as HttpError).message).toContain("Provider");
    }
  });
});

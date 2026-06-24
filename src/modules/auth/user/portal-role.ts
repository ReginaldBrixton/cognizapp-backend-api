import { HttpError } from "../../../lib/errors";

export type PrivilegedPortalRole = "ADMIN_USER" | "SUPPORT_PROVIDER_USER";

export function normalizeSelectedPrivilegedRole(input?: string | null): PrivilegedPortalRole | undefined {
  const value = String(input ?? "").trim();
  if (!value) {
    return undefined;
  }

  if (value === "ADMIN_USER" || value === "SUPPORT_PROVIDER_USER") {
    return value;
  }

  const alias = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (alias === "admin") {
    return "ADMIN_USER";
  }
  if (alias === "provider" || alias === "support_provider" || alias === "provider_support" || alias === "support_provider_user") {
    return "SUPPORT_PROVIDER_USER";
  }

  throw new HttpError(400, "invalid_selected_role", "Choose either the Admin or Provider portal.");
}

export function privilegedPortalLabel(role: string | null | undefined) {
  if (role === "ADMIN_USER") {
    return "Admin";
  }
  if (role === "SUPPORT_PROVIDER_USER") {
    return "Provider";
  }
  return String(role ?? "Unknown");
}

export function assertSelectedRoleMatchesGrant(selectedRole: PrivilegedPortalRole | undefined, grantedRole: string) {
  if (!selectedRole || grantedRole === selectedRole) {
    return;
  }

  throw new HttpError(
    403,
    "role_mismatch",
    `You selected the ${privilegedPortalLabel(selectedRole)} portal, but your account is approved for ${privilegedPortalLabel(grantedRole)} access only.`,
  );
}

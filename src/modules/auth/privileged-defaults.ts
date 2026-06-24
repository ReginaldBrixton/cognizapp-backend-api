import { env } from "../../config/env";

export function normalizePrivilegedEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isDefaultAdminEmail(email: string) {
  return env.defaultAdminEmails.includes(normalizePrivilegedEmail(email));
}

export function defaultPrivilegedRoleForEmail(email: string) {
  return isDefaultAdminEmail(email) ? "ADMIN_USER" : null;
}

import { Elysia, t } from "elysia";

import { HttpError } from "../../lib/errors";
import { fail, ok } from "../../lib/http";
import { resolveAuth } from "../auth/middleware";
import { settingsRepository } from "./repository";
import { ALLOWED_USER_SECTIONS } from "./types";

type UserSection = (typeof ALLOWED_USER_SECTIONS)[number];

const READ_ONLY_USER_SECTIONS: string[] = [];

const SectionBody = t.Record(t.String(), t.Unknown());

function validateSections(updates: Record<string, unknown>) {
  const invalid = Object.keys(updates).filter(
    (k) => !(ALLOWED_USER_SECTIONS as readonly string[]).includes(k),
  );
  if (invalid.length) {
    throw new HttpError(
      400,
      "invalid_section",
      `Unknown settings sections: ${invalid.join(", ")}`,
    );
  }

  const readOnly = Object.keys(updates).filter((k) =>
    READ_ONLY_USER_SECTIONS.includes(k),
  );
  if (readOnly.length) {
    throw new HttpError(
      403,
      "read_only_section",
      `These sections are read-only: ${readOnly.join(", ")}`,
    );
  }
}

export const settingsRoutes = new Elysia({
  prefix: "/api/user",
  tags: ["settings"],
})
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

  // ── GET /api/user/settings ─────────────────────────────────────────────────
  .get("/settings", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    const settings = await settingsRepository.getUserSettings(auth.userId);
    if (!settings) {
      throw new HttpError(404, "settings_not_found", "User settings not found");
    }
    return ok({ settings });
  })

  // ── PUT /api/user/settings (merge sections) ───────────────────────────────
  .put(
    "/settings",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);

      const updates = body as Record<string, unknown>;
      validateSections(updates);

      let settings = null;
      for (const [section, data] of Object.entries(updates)) {
        if (data && typeof data === "object" && !Array.isArray(data)) {
          settings = await settingsRepository.updateUserSettings(
            auth.userId,
            section as UserSection,
            data as Record<string, unknown>,
          );
        }
      }
      if (!settings) {
        throw new HttpError(404, "settings_not_found", "User settings not found");
      }

      return ok({ settings });
    },
    { body: SectionBody },
  )

  // ── PATCH /api/user/settings (merge sections, alias for PUT) ──────────────
  .patch(
    "/settings",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);

      const updates = body as Record<string, unknown>;
      validateSections(updates);

      let settings = null;
      for (const [section, data] of Object.entries(updates)) {
        if (data && typeof data === "object" && !Array.isArray(data)) {
          settings = await settingsRepository.updateUserSettings(
            auth.userId,
            section as UserSection,
            data as Record<string, unknown>,
          );
        }
      }
      if (!settings) {
        throw new HttpError(404, "settings_not_found", "User settings not found");
      }

      return ok({ settings });
    },
    { body: SectionBody },
  )

  // ── GET /api/user/settings/:section ───────────────────────────────────────
  .get("/settings/:section", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    const section = params.section as UserSection;
    if (!(ALLOWED_USER_SECTIONS as readonly string[]).includes(section)) {
      throw new HttpError(
        400,
        "invalid_section",
        `Unknown section: ${section}`,
      );
    }
    const settings = await settingsRepository.getUserSettings(auth.userId);
    if (!settings) {
      throw new HttpError(404, "settings_not_found", "User settings not found");
    }
    return ok({
      [section]: (settings as Record<string, unknown>)[section] ?? {},
    });
  })

  // ── PUT /api/user/settings/:section ───────────────────────────────────────
  .put(
    "/settings/:section",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const section = params.section as UserSection;
      if (!(ALLOWED_USER_SECTIONS as readonly string[]).includes(section)) {
        throw new HttpError(400, "invalid_section", `Unknown section: ${section}`);
      }
      if (READ_ONLY_USER_SECTIONS.includes(section)) {
        throw new HttpError(403, "read_only_section", `Section '${section}' is read-only`);
      }
      const settings = await settingsRepository.updateUserSettings(auth.userId, section, body as Record<string, unknown>);
      if (!settings) {
        throw new HttpError(404, "settings_not_found", "User settings not found");
      }
      return ok({ [section]: (settings as Record<string, unknown>)[section] ?? {} });
    },
    { body: SectionBody },
  )

  // ── PATCH /api/user/settings/:section (alias for PUT) ─────────────────────
  .patch(
    "/settings/:section",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      const section = params.section as UserSection;
      if (!(ALLOWED_USER_SECTIONS as readonly string[]).includes(section)) {
        throw new HttpError(400, "invalid_section", `Unknown section: ${section}`);
      }
      if (READ_ONLY_USER_SECTIONS.includes(section)) {
        throw new HttpError(403, "read_only_section", `Section '${section}' is read-only`);
      }
      const settings = await settingsRepository.updateUserSettings(auth.userId, section, body as Record<string, unknown>);
      if (!settings) {
        throw new HttpError(404, "settings_not_found", "User settings not found");
      }
      return ok({ [section]: (settings as Record<string, unknown>)[section] ?? {} });
    },
    { body: SectionBody },
  );

import { Elysia, t } from "elysia";
import { HttpError } from "../../lib/errors";
import { fail, ok } from "../../lib/http";
import { resolveAuth } from "../auth/middleware";
import { workspaceRepository } from "../workspace/repository";
import { settingsService } from "./service";
import {
  ALLOWED_WORKSPACE_SECTIONS,
  READ_ONLY_WORKSPACE_SECTIONS,
} from "./types";
import {
  isValidUuid,
  sanitizeInput,
  VALIDATION_LIMITS,
} from "../../lib/validation";

type WorkspaceSection = (typeof ALLOWED_WORKSPACE_SECTIONS)[number];

const SectionBody = t.Record(t.String(), t.Unknown());

async function verifyWorkspaceAccess(
  userId: string,
  workspaceId: string,
): Promise<void> {
  if (!isValidUuid(workspaceId)) {
    throw new HttpError(400, "invalid_uuid", "Invalid workspace ID");
  }
  const workspace = await workspaceRepository.getById(workspaceId);
  if (!workspace) {
    throw new HttpError(404, "workspace_not_found", "Workspace not found");
  }
  if (workspace.ownerUid === userId) {
    return;
  }
  const member = await workspaceRepository.getMember(workspaceId, userId);
  if (!member) {
    throw new HttpError(403, "forbidden", "Access denied to this workspace");
  }
}

export const workspaceSettingsRoutes = new Elysia({
  prefix: "/api/workspace/:workspaceId/settings",
  tags: ["workspace-settings"],
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

  // ── GET /api/workspace/:workspaceId/settings ───────────────────────────────
  .get("/", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    await verifyWorkspaceAccess(auth.userId, params.workspaceId);
    const settings = await settingsService.getSettings(params.workspaceId);
    // Merge workspace name/description into general section
    const workspace = await workspaceRepository.getById(params.workspaceId);
    if (workspace) {
      const general = (settings as Record<string, unknown>).general as Record<string, unknown> ?? {};
      (settings as Record<string, unknown>).general = {
        ...general,
        name: general.name || workspace.name || "",
        description: general.description || workspace.description || "",
      };
    }
    return ok({ settings });
  })

  // ── GET /api/workspace/:workspaceId/settings/:section ──────────────────────
  .get("/:section", async ({ headers, params }) => {
    const auth = await resolveAuth(headers);
    await verifyWorkspaceAccess(auth.userId, params.workspaceId);
    const section = params.section as WorkspaceSection;
    if (!(ALLOWED_WORKSPACE_SECTIONS as readonly string[]).includes(section)) {
      throw new HttpError(
        400,
        "invalid_section",
        `Unknown section: ${section}`,
      );
    }
    const settings = await settingsService.getSettings(params.workspaceId);
    let sectionData = (settings as Record<string, unknown>)[section] ?? {};
    // Merge workspace name/description into general section
    if (section === "general") {
      const workspace = await workspaceRepository.getById(params.workspaceId);
      if (workspace) {
        sectionData = {
          ...(sectionData as Record<string, unknown>),
          name: (sectionData as Record<string, unknown>).name || workspace.name || "",
          description: (sectionData as Record<string, unknown>).description || workspace.description || "",
        };
      }
    }
    return ok({
      [section]: sectionData,
    });
  })

  // ── PUT /api/workspace/:workspaceId/settings/:section ────────────────────────
  .put(
    "/:section",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      await verifyWorkspaceAccess(auth.userId, params.workspaceId);
      const section = params.section as WorkspaceSection;
      if (
        !(ALLOWED_WORKSPACE_SECTIONS as readonly string[]).includes(section)
      ) {
        throw new HttpError(
          400,
          "invalid_section",
          `Unknown section: ${section}`,
        );
      }
      if (READ_ONLY_WORKSPACE_SECTIONS.includes(section)) {
        throw new HttpError(
          403,
          "read_only_section",
          `Section '${section}' is read-only`,
        );
      }
      const sanitized = sanitizeInput(body) as Record<string, unknown>;
      // Sync name/description to workspaces table when updating general
      if (section === "general") {
        const name = sanitized.name as string | undefined;
        const description = sanitized.description as string | undefined;
        if (name !== undefined || description !== undefined) {
          await workspaceRepository.updateWorkspace(params.workspaceId, {
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
          });
        }
      }
      await settingsService.updateSection(
        params.workspaceId,
        section,
        sanitized,
      );
      const settings = await settingsService.getSettings(params.workspaceId);
      let sectionData = (settings as Record<string, unknown>)[section] ?? {};
      if (section === "general") {
        const workspace = await workspaceRepository.getById(params.workspaceId);
        if (workspace) {
          sectionData = {
            ...(sectionData as Record<string, unknown>),
            name: (sectionData as Record<string, unknown>).name || workspace.name || "",
            description: (sectionData as Record<string, unknown>).description || workspace.description || "",
          };
        }
      }
      return ok({
        [section]: sectionData,
      });
    },
    { body: SectionBody },
  )

  // ── PATCH /api/workspace/:workspaceId/settings/:section ─────────────────────
  .patch(
    "/:section",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      await verifyWorkspaceAccess(auth.userId, params.workspaceId);
      const section = params.section as WorkspaceSection;
      if (
        !(ALLOWED_WORKSPACE_SECTIONS as readonly string[]).includes(section)
      ) {
        throw new HttpError(
          400,
          "invalid_section",
          `Unknown section: ${section}`,
        );
      }
      if (READ_ONLY_WORKSPACE_SECTIONS.includes(section)) {
        throw new HttpError(
          403,
          "read_only_section",
          `Section '${section}' is read-only`,
        );
      }
      const sanitized = sanitizeInput(body) as Record<string, unknown>;
      // Sync name/description to workspaces table when updating general
      if (section === "general") {
        const name = sanitized.name as string | undefined;
        const description = sanitized.description as string | undefined;
        if (name !== undefined || description !== undefined) {
          await workspaceRepository.updateWorkspace(params.workspaceId, {
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
          });
        }
      }
      await settingsService.updateSection(
        params.workspaceId,
        section,
        sanitized,
      );
      const settings = await settingsService.getSettings(params.workspaceId);
      let sectionData = (settings as Record<string, unknown>)[section] ?? {};
      if (section === "general") {
        const workspace = await workspaceRepository.getById(params.workspaceId);
        if (workspace) {
          sectionData = {
            ...(sectionData as Record<string, unknown>),
            name: (sectionData as Record<string, unknown>).name || workspace.name || "",
            description: (sectionData as Record<string, unknown>).description || workspace.description || "",
          };
        }
      }
      return ok({
        [section]: sectionData,
      });
    },
    { body: SectionBody },
  )

  // ── PUT /api/workspace/:workspaceId/settings ─────────────────────────────────
  .put(
    "/",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      await verifyWorkspaceAccess(auth.userId, params.workspaceId);
      const updates = body as Record<string, unknown>;

      const invalid = Object.keys(updates).filter((k) => !(ALLOWED_WORKSPACE_SECTIONS as readonly string[]).includes(k));
      if (invalid.length) {
        throw new HttpError(400, "invalid_section", `Unknown sections: ${invalid.join(", ")}`);
      }

      const readOnly = Object.keys(updates).filter((k) => READ_ONLY_WORKSPACE_SECTIONS.includes(k as WorkspaceSection));
      if (readOnly.length) {
        throw new HttpError(403, "read_only_section", `These sections are read-only: ${readOnly.join(", ")}`);
      }

      for (const [section, data] of Object.entries(updates)) {
        if (data && typeof data === "object" && !Array.isArray(data)) {
          const sanitized = sanitizeInput(data) as Record<string, unknown>;
          // Sync name/description to workspaces table when updating general
          if (section === "general") {
            const name = sanitized.name as string | undefined;
            const description = sanitized.description as string | undefined;
            if (name !== undefined || description !== undefined) {
              await workspaceRepository.updateWorkspace(params.workspaceId, {
                ...(name !== undefined ? { name } : {}),
                ...(description !== undefined ? { description } : {}),
              });
            }
          }
          await settingsService.updateSection(params.workspaceId, section as WorkspaceSection, sanitized);
        }
      }

      const settings = await settingsService.getSettings(params.workspaceId);
      // Merge workspace name/description into general section
      const workspace = await workspaceRepository.getById(params.workspaceId);
      if (workspace) {
        const general = (settings as Record<string, unknown>).general as Record<string, unknown> ?? {};
        (settings as Record<string, unknown>).general = {
          ...general,
          name: general.name || workspace.name || "",
          description: general.description || workspace.description || "",
        };
      }
      return ok({ settings });
    },
    { body: SectionBody },
  )

  // ── PATCH /api/workspace/:workspaceId/settings (alias for PUT) ──────────────
  .patch(
    "/",
    async ({ headers, params, body }) => {
      const auth = await resolveAuth(headers);
      await verifyWorkspaceAccess(auth.userId, params.workspaceId);
      const updates = body as Record<string, unknown>;

      const invalid = Object.keys(updates).filter((k) => !(ALLOWED_WORKSPACE_SECTIONS as readonly string[]).includes(k));
      if (invalid.length) {
        throw new HttpError(400, "invalid_section", `Unknown sections: ${invalid.join(", ")}`);
      }

      const readOnly = Object.keys(updates).filter((k) => READ_ONLY_WORKSPACE_SECTIONS.includes(k as WorkspaceSection));
      if (readOnly.length) {
        throw new HttpError(403, "read_only_section", `These sections are read-only: ${readOnly.join(", ")}`);
      }

      for (const [section, data] of Object.entries(updates)) {
        if (data && typeof data === "object" && !Array.isArray(data)) {
          const sanitized = sanitizeInput(data) as Record<string, unknown>;
          // Sync name/description to workspaces table when updating general
          if (section === "general") {
            const name = sanitized.name as string | undefined;
            const description = sanitized.description as string | undefined;
            if (name !== undefined || description !== undefined) {
              await workspaceRepository.updateWorkspace(params.workspaceId, {
                ...(name !== undefined ? { name } : {}),
                ...(description !== undefined ? { description } : {}),
              });
            }
          }
          await settingsService.updateSection(params.workspaceId, section as WorkspaceSection, sanitized);
        }
      }

      const settings = await settingsService.getSettings(params.workspaceId);
      // Merge workspace name/description into general section
      const workspace = await workspaceRepository.getById(params.workspaceId);
      if (workspace) {
        const general = (settings as Record<string, unknown>).general as Record<string, unknown> ?? {};
        (settings as Record<string, unknown>).general = {
          ...general,
          name: general.name || workspace.name || "",
          description: general.description || workspace.description || "",
        };
      }
      return ok({ settings });
    },
    { body: SectionBody },
  );

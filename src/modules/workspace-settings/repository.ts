import { getDb } from "../../lib/db";
import type { WorkspaceSettings, WorkspaceSection } from "./types";

const ALLOWED_SECTIONS = [
  "general", "appearance", "notifications", "security", "limits", 
  "ai", "access", "features", "storage", "integrations", "billing", "institution"
] as const;

type Section = (typeof ALLOWED_SECTIONS)[number];

function assertSection(section: string): asserts section is Section {
  if (!(ALLOWED_SECTIONS as readonly string[]).includes(section)) {
    throw new Error(`Unknown workspace settings section: ${section}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSectionValue(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return value.reduce<Record<string, unknown>>((acc, item) => {
      if (typeof item === "string") {
        try {
          const parsed = JSON.parse(item);
          if (isRecord(parsed)) Object.assign(acc, parsed);
        } catch { /* ignore */ }
        return acc;
      }
      if (isRecord(item)) Object.assign(acc, item);
      return acc;
    }, {});
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return isRecord(value) ? value : {};
}

function normalizeRow(row: Record<string, unknown>): WorkspaceSettings {
  const normalized = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
  for (const section of ALLOWED_SECTIONS) {
    normalized[section] = normalizeSectionValue(normalized[section]);
  }
  return normalized as WorkspaceSettings;
}

export const settingsRepository = {
  async findByWorkspaceId(workspaceId: string): Promise<WorkspaceSettings | null> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM workspace_settings
      WHERE workspace_id = ${workspaceId}
      AND deleted_at IS NULL
    `;
    return rows[0] ? normalizeRow(rows[0] as Record<string, unknown>) : null;
  },

  async create(data: Omit<WorkspaceSettings, "id" | "createdAt" | "updatedAt">): Promise<WorkspaceSettings> {
    const db = getDb();
    const rows = await db`
      INSERT INTO workspace_settings (
        workspace_id, owner_id, general, appearance, notifications, security, limits, ai, access, features, storage, integrations, billing, institution
      ) VALUES (
        ${data.workspaceId}, ${data.ownerId}, 
        ${JSON.stringify(data.general)}, ${JSON.stringify(data.appearance)}, 
        ${JSON.stringify(data.notifications)}, ${JSON.stringify(data.security)}, 
        ${JSON.stringify(data.limits)}, ${JSON.stringify(data.ai)}, 
        ${JSON.stringify(data.access)}, ${JSON.stringify(data.features)}, 
        ${JSON.stringify(data.storage)}, ${JSON.stringify(data.integrations)}, 
        ${JSON.stringify(data.billing)}, ${JSON.stringify(data.institution)}
      )
      RETURNING *
    `;
    return normalizeRow(rows[0] as Record<string, unknown>);
  },

  async updateSection(workspaceId: string, section: string, data: Record<string, unknown>): Promise<void> {
    assertSection(section);
    const db = getDb();
    const current = await this.findByWorkspaceId(workspaceId);
    const nextValue = { ...normalizeSectionValue(current?.[section as keyof WorkspaceSettings]), ...data };
    await db`
      UPDATE workspace_settings
      SET ${db(section)} = ${db.json(nextValue as any)},
          updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
    `;
  },

  async replaceSection(workspaceId: string, section: string, data: Record<string, unknown>): Promise<void> {
    assertSection(section);
    const db = getDb();
    await db`
      UPDATE workspace_settings
      SET ${db(section)} = ${db.json(data as any)},
          updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
    `;
  },

  async delete(workspaceId: string): Promise<void> {
    const db = getDb();
    await db`
      UPDATE workspace_settings
      SET deleted_at = NOW()
      WHERE workspace_id = ${workspaceId}
    `;
  },
};

import { HttpError } from "../../lib/errors";
import { settingsRepository } from "./repository";
import type { WorkspaceSettings, WorkspaceSection } from "./types";

export const settingsService = {
  async getSettings(workspaceId: string): Promise<WorkspaceSettings> {
    const settings = await settingsRepository.findByWorkspaceId(workspaceId);
    if (!settings) {
      throw new HttpError(404, "settings_not_found", "Settings not found");
    }
    return settings;
  },

  async updateSection(workspaceId: string, section: WorkspaceSection, data: Record<string, unknown>): Promise<void> {
    await settingsRepository.updateSection(workspaceId, section, data);
  },

  async replaceSection(workspaceId: string, section: WorkspaceSection, data: Record<string, unknown>): Promise<void> {
    await settingsRepository.replaceSection(workspaceId, section, data);
  },

  // Convenience methods for specific sections
  async updateGeneral(workspaceId: string, data: Record<string, unknown>): Promise<void> {
    await this.updateSection(workspaceId, "general", data);
  },

  async updateAppearance(workspaceId: string, data: Record<string, unknown>): Promise<void> {
    await this.updateSection(workspaceId, "appearance", data);
  },

  async updateNotifications(workspaceId: string, data: Record<string, unknown>): Promise<void> {
    await this.updateSection(workspaceId, "notifications", data);
  },

  async updateSecurity(workspaceId: string, data: Record<string, unknown>): Promise<void> {
    await this.updateSection(workspaceId, "security", data);
  },

  async updateLimits(workspaceId: string, data: Record<string, unknown>): Promise<void> {
    await this.updateSection(workspaceId, "limits", data);
  },

  async updateAi(workspaceId: string, data: Record<string, unknown>): Promise<void> {
    await this.updateSection(workspaceId, "ai", data);
  },

  async updateAccess(workspaceId: string, data: Record<string, unknown>): Promise<void> {
    await this.updateSection(workspaceId, "access", data);
  },

  async updateFeatures(workspaceId: string, data: Record<string, unknown>): Promise<void> {
    await this.updateSection(workspaceId, "features", data);
  },

  async updateStorage(workspaceId: string, data: Record<string, unknown>): Promise<void> {
    await this.updateSection(workspaceId, "storage", data);
  },

  async updateIntegrations(workspaceId: string, data: Record<string, unknown>): Promise<void> {
    await this.updateSection(workspaceId, "integrations", data);
  },

  async updateBilling(workspaceId: string, data: Record<string, unknown>): Promise<void> {
    await this.updateSection(workspaceId, "billing", data);
  },

  async updateInstitution(workspaceId: string, data: Record<string, unknown>): Promise<void> {
    await this.updateSection(workspaceId, "institution", data);
  },
};

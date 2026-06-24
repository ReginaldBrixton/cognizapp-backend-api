import { HttpError } from "../../lib/errors";
import { verifyProjectAccess } from "../../lib/project-access";
import { diagramRepository } from "./repository";
import type { CreateDiagramInput, UpdateDiagramInput, DiagramFilter } from "./types";

export const diagramService = {
  async listDiagrams(userId: string, workspaceId: string, projectId: string, filter?: DiagramFilter) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const diagrams = await diagramRepository.findByProjectId(projectId, filter);
    const total = await diagramRepository.countByProjectId(projectId, filter);
    return { diagrams, total };
  },

  async getDiagram(userId: string, workspaceId: string, projectId: string, diagramId: string) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const diagram = await diagramRepository.findById(diagramId);
    if (!diagram || diagram.projectId !== projectId) {
      throw new HttpError(404, "diagram_not_found", "Diagram not found");
    }
    return diagram;
  },

  async createDiagram(userId: string, workspaceId: string, projectId: string, data: CreateDiagramInput) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    return await diagramRepository.create(projectId, userId, data);
  },

  async updateDiagram(userId: string, workspaceId: string, projectId: string, diagramId: string, data: UpdateDiagramInput) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const diagram = await diagramRepository.findById(diagramId);
    if (!diagram || diagram.projectId !== projectId) {
      throw new HttpError(404, "diagram_not_found", "Diagram not found");
    }
    return await diagramRepository.update(diagramId, data);
  },

  async deleteDiagram(userId: string, workspaceId: string, projectId: string, diagramId: string) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const diagram = await diagramRepository.findById(diagramId);
    if (!diagram || diagram.projectId !== projectId) {
      throw new HttpError(404, "diagram_not_found", "Diagram not found");
    }
    return await diagramRepository.delete(diagramId);
  },

  async batchCreate(userId: string, workspaceId: string, projectId: string, items: CreateDiagramInput[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const results = [];
    for (const item of items) {
      const diagram = await diagramRepository.create(projectId, userId, item);
      results.push(diagram);
    }
    return results;
  },

  async batchUpdate(userId: string, workspaceId: string, projectId: string, updates: { id: string; data: UpdateDiagramInput }[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const results = [];
    for (const update of updates) {
      const diagram = await diagramRepository.findById(update.id);
      if (!diagram || diagram.projectId !== projectId) continue;
      const updated = await diagramRepository.update(update.id, update.data);
      results.push(updated);
    }
    return results;
  },

  async batchDelete(userId: string, workspaceId: string, projectId: string, diagramIds: string[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    for (const id of diagramIds) {
      const diagram = await diagramRepository.findById(id);
      if (!diagram || diagram.projectId !== projectId) continue;
      await diagramRepository.delete(id);
    }
    return { deleted: diagramIds.length };
  },
};
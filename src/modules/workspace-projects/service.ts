import { HttpError } from "../../lib/errors";
import { workspaceRepository } from "../workspace/repository";
import { projectRepository } from "./repository";
import type { Project } from "./types";

/**
 * Verifies that the user has access to the workspace.
 * User must be either the owner or a member of the workspace.
 */
async function verifyWorkspaceAccess(userId: string, workspaceId: string): Promise<void> {
  const access = await workspaceRepository.getAccess(workspaceId, userId);
  if (!access) {
    throw new HttpError(404, "workspace_not_found", "Workspace not found");
  }
  if (access.workspace.ownerUid === userId || access.member) {
    return; // Owner has full access
  }
  throw new HttpError(403, "forbidden", "Access denied to this workspace");
}

export const projectService = {
  async listProjects(userId: string, workspaceId: string) {
    await verifyWorkspaceAccess(userId, workspaceId);
    return await projectRepository.findByWorkspaceId(workspaceId);
  },

  async createProject(userId: string, workspaceId: string, data: Record<string, unknown>) {
    await verifyWorkspaceAccess(userId, workspaceId);
    return await projectRepository.create({
      workspaceId,
      ownerUid: userId,
      title: data.title as string,
      description: (data.description as string) || "",
      status: "active",
      visibility: (data.visibility as Project["visibility"]) || "private",
      fieldOfStudy: (data.fieldOfStudy as string) || null,
      projectType: (data.projectType as string) || null,
      keywords: (data.keywords as string[]) || [],
      collaborators: [],
      completionPct: 0,
      deadline: (data.deadline as string) || null,
      documentCount: 0,
      taskCount: 0,
      completedTasks: 0,
      metadata: {},
      deletedAt: null,
    });
  },

  async getProject(userId: string, workspaceId: string, projectId: string) {
    await verifyWorkspaceAccess(userId, workspaceId);
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== workspaceId) {
      throw new HttpError(404, "project_not_found", "Project not found");
    }
    return project;
  },

  async updateProject(userId: string, workspaceId: string, projectId: string, data: Record<string, unknown>) {
    await verifyWorkspaceAccess(userId, workspaceId);
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== workspaceId) {
      throw new HttpError(404, "project_not_found", "Project not found");
    }
    return await projectRepository.update(projectId, data);
  },

  async deleteProject(userId: string, workspaceId: string, projectId: string) {
    await verifyWorkspaceAccess(userId, workspaceId);
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== workspaceId) {
      throw new HttpError(404, "project_not_found", "Project not found");
    }
    return await projectRepository.delete(projectId);
  },
};

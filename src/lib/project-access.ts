import { HttpError } from "./errors";
import { workspaceRepository } from "../modules/workspace/repository";
import { projectRepository } from "../modules/workspace-projects/repository";

export async function verifyProjectAccess(
  userId: string,
  workspaceId: string,
  projectId: string,
) {
  const workspace = await workspaceRepository.getById(workspaceId);
  if (!workspace) {
    throw new HttpError(404, "workspace_not_found", "Workspace not found");
  }
  if (workspace.ownerUid !== userId) {
    const member = await workspaceRepository.getMember(workspaceId, userId);
    if (!member) {
      throw new HttpError(403, "forbidden", "Access denied to this workspace");
    }
  }

  const project = await projectRepository.findById(projectId);
  if (!project || project.workspaceId !== workspaceId) {
    throw new HttpError(404, "project_not_found", "Project not found");
  }
  return project;
}

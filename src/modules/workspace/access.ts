import { HttpError } from "../../lib/errors";
import { workspaceRepository } from "./repository";

export async function verifyWorkspaceAccess(userId: string, workspaceId: string): Promise<void> {
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

import { HttpError } from "../../lib/errors";
import { workspaceRepository } from "../workspace/repository";
import { projectRepository } from "../workspace-projects/repository";
import { taskListRepository } from "./repository";
import type { CreateTaskListInput, UpdateTaskListInput, TaskListFilter } from "./types";

async function verifyProjectAccess(userId: string, workspaceId: string, projectId: string) {
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

export const taskListService = {
  async listTaskLists(userId: string, workspaceId: string, projectId: string, filter?: TaskListFilter) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const taskLists = await taskListRepository.findByProjectId(projectId, filter);
    const total = await taskListRepository.countByProjectId(projectId, filter);
    return { taskLists, total };
  },

  async getTaskList(userId: string, workspaceId: string, projectId: string, listId: string) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const taskList = await taskListRepository.findById(listId);
    if (!taskList || taskList.projectId !== projectId) {
      throw new HttpError(404, "task_list_not_found", "Task list not found");
    }
    return taskList;
  },

  async createTaskList(userId: string, workspaceId: string, projectId: string, data: CreateTaskListInput) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    return await taskListRepository.create(projectId, userId, data);
  },

  async updateTaskList(userId: string, workspaceId: string, projectId: string, listId: string, data: UpdateTaskListInput) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const taskList = await taskListRepository.findById(listId);
    if (!taskList || taskList.projectId !== projectId) {
      throw new HttpError(404, "task_list_not_found", "Task list not found");
    }
    return await taskListRepository.update(listId, data);
  },

  async deleteTaskList(userId: string, workspaceId: string, projectId: string, listId: string) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const taskList = await taskListRepository.findById(listId);
    if (!taskList || taskList.projectId !== projectId) {
      throw new HttpError(404, "task_list_not_found", "Task list not found");
    }
    await taskListRepository.delete(listId);
    return { success: true };
  },
};

import { HttpError } from "../../lib/errors";
import { verifyProjectAccess } from "../../lib/project-access";
import { taskRepository } from "./repository";
import type { CreateTaskInput, UpdateTaskInput, TaskFilter } from "./types";

export const taskService = {
  async listTasks(userId: string, workspaceId: string, projectId: string, filter?: TaskFilter) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const tasks = await taskRepository.findByProjectId(projectId, filter);
    const total = await taskRepository.countByProjectId(projectId, filter);
    return { tasks, total };
  },

  async getTask(userId: string, workspaceId: string, projectId: string, taskId: string) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const task = await taskRepository.findById(taskId);
    if (!task || task.projectId !== projectId) {
      throw new HttpError(404, "task_not_found", "Task not found");
    }
    return task;
  },

  async createTask(userId: string, workspaceId: string, projectId: string, data: CreateTaskInput) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    return await taskRepository.create(projectId, userId, userId, data);
  },

  async updateTask(userId: string, workspaceId: string, projectId: string, taskId: string, data: UpdateTaskInput) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const task = await taskRepository.findById(taskId);
    if (!task || task.projectId !== projectId) {
      throw new HttpError(404, "task_not_found", "Task not found");
    }
    return await taskRepository.update(taskId, data);
  },

  async deleteTask(userId: string, workspaceId: string, projectId: string, taskId: string) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const task = await taskRepository.findById(taskId);
    if (!task || task.projectId !== projectId) {
      throw new HttpError(404, "task_not_found", "Task not found");
    }
    return await taskRepository.delete(taskId);
  },

  async batchCreate(userId: string, workspaceId: string, projectId: string, items: CreateTaskInput[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const results = [];
    for (const item of items) {
      const task = await taskRepository.create(projectId, userId, userId, item);
      results.push(task);
    }
    return results;
  },

  async batchUpdate(userId: string, workspaceId: string, projectId: string, updates: { id: string; data: UpdateTaskInput }[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const results = [];
    for (const update of updates) {
      const task = await taskRepository.findById(update.id);
      if (!task || task.projectId !== projectId) continue;
      const updated = await taskRepository.update(update.id, update.data);
      results.push(updated);
    }
    return results;
  },

  async batchDelete(userId: string, workspaceId: string, projectId: string, taskIds: string[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    for (const id of taskIds) {
      const task = await taskRepository.findById(id);
      if (!task || task.projectId !== projectId) continue;
      await taskRepository.delete(id);
    }
    return { deleted: taskIds.length };
  },
};
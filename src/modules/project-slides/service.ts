import { HttpError } from "../../lib/errors";
import { verifyProjectAccess } from "../../lib/project-access";
import { slideRepository } from "./repository";
import type { CreateSlideInput, UpdateSlideInput, SlideFilter } from "./types";

export const slideService = {
  async listSlides(userId: string, workspaceId: string, projectId: string, filter?: SlideFilter) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const slides = await slideRepository.findByProjectId(projectId, filter);
    const total = await slideRepository.countByProjectId(projectId, filter);
    return { slides, total };
  },

  async getSlide(userId: string, workspaceId: string, projectId: string, slideId: string) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const slide = await slideRepository.findById(slideId);
    if (!slide || slide.projectId !== projectId) {
      throw new HttpError(404, "slide_not_found", "Slide not found");
    }
    return slide;
  },

  async createSlide(userId: string, workspaceId: string, projectId: string, data: CreateSlideInput) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    return await slideRepository.create(projectId, userId, data);
  },

  async updateSlide(userId: string, workspaceId: string, projectId: string, slideId: string, data: UpdateSlideInput) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const slide = await slideRepository.findById(slideId);
    if (!slide || slide.projectId !== projectId) {
      throw new HttpError(404, "slide_not_found", "Slide not found");
    }
    return await slideRepository.update(slideId, data);
  },

  async deleteSlide(userId: string, workspaceId: string, projectId: string, slideId: string) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const slide = await slideRepository.findById(slideId);
    if (!slide || slide.projectId !== projectId) {
      throw new HttpError(404, "slide_not_found", "Slide not found");
    }
    return await slideRepository.delete(slideId);
  },

  async batchCreate(userId: string, workspaceId: string, projectId: string, items: CreateSlideInput[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const results = [];
    for (const item of items) {
      const slide = await slideRepository.create(projectId, userId, item);
      results.push(slide);
    }
    return results;
  },

  async batchUpdate(userId: string, workspaceId: string, projectId: string, updates: { id: string; data: UpdateSlideInput }[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const results = [];
    for (const update of updates) {
      const slide = await slideRepository.findById(update.id);
      if (!slide || slide.projectId !== projectId) continue;
      const updated = await slideRepository.update(update.id, update.data);
      results.push(updated);
    }
    return results;
  },

  async batchDelete(userId: string, workspaceId: string, projectId: string, slideIds: string[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    for (const id of slideIds) {
      const slide = await slideRepository.findById(id);
      if (!slide || slide.projectId !== projectId) continue;
      await slideRepository.delete(id);
    }
    return { deleted: slideIds.length };
  },
};
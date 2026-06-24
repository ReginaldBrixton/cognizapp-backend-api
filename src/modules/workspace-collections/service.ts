import { HttpError } from "../../lib/errors";
import { verifyWorkspaceAccess } from "../workspace/access";
import { collectionRepository } from "./repository";
import type { Collection, CollectionItem } from "./types";

export const collectionService = {
  async listCollections(userId: string, workspaceId: string) {
    await verifyWorkspaceAccess(userId, workspaceId);
    return await collectionRepository.findByWorkspaceId(workspaceId);
  },

  async createCollection(userId: string, workspaceId: string, data: Record<string, unknown>) {
    await verifyWorkspaceAccess(userId, workspaceId);
    return await collectionRepository.create({
      workspaceId,
      ownerUid: userId,
      name: data.name as string,
      description: (data.description as string) || "",
      collectionType: (data.collectionType as Collection["collectionType"]) || "folder",
      parentId: (data.parentId as string) || null,
      items: [],
      filters: null,
      sortOrder: 0,
      isDefault: false,
      metadata: {},
      deletedAt: null,
    });
  },

  async getCollection(userId: string, workspaceId: string, collectionId: string) {
    await verifyWorkspaceAccess(userId, workspaceId);
    const collection = await collectionRepository.findById(collectionId);
    if (!collection || collection.workspaceId !== workspaceId) {
      throw new HttpError(404, "collection_not_found", "Collection not found");
    }
    return collection;
  },

  async updateCollection(userId: string, workspaceId: string, collectionId: string, data: Record<string, unknown>) {
    await verifyWorkspaceAccess(userId, workspaceId);
    const collection = await collectionRepository.findById(collectionId);
    if (!collection || collection.workspaceId !== workspaceId) {
      throw new HttpError(404, "collection_not_found", "Collection not found");
    }
    return await collectionRepository.update(collectionId, data);
  },

  async deleteCollection(userId: string, workspaceId: string, collectionId: string) {
    await verifyWorkspaceAccess(userId, workspaceId);
    const collection = await collectionRepository.findById(collectionId);
    if (!collection || collection.workspaceId !== workspaceId) {
      throw new HttpError(404, "collection_not_found", "Collection not found");
    }
    return await collectionRepository.delete(collectionId);
  },

  async addItem(userId: string, workspaceId: string, collectionId: string, data: Record<string, unknown>) {
    await verifyWorkspaceAccess(userId, workspaceId);
    const collection = await collectionRepository.findById(collectionId);
    if (!collection || collection.workspaceId !== workspaceId) {
      throw new HttpError(404, "collection_not_found", "Collection not found");
    }
    return await collectionRepository.addItem({
      collectionId,
      itemType: data.itemType as CollectionItem["itemType"],
      itemId: data.itemId as string,
      addedBy: userId,
      sortOrder: 0,
      metadata: {},
    });
  },

  async removeItem(userId: string, workspaceId: string, collectionId: string, itemId: string) {
    await verifyWorkspaceAccess(userId, workspaceId);
    const collection = await collectionRepository.findById(collectionId);
    if (!collection || collection.workspaceId !== workspaceId) {
      throw new HttpError(404, "collection_not_found", "Collection not found");
    }
    return await collectionRepository.removeItem(itemId);
  },
};

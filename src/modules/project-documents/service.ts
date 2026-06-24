import { HttpError } from "../../lib/errors";
import { verifyProjectAccess } from "../../lib/project-access";
import { documentRepository } from "./repository";
import type { CreateDocumentInput, UpdateDocumentInput, DocumentFilter } from "./types";

export const documentService = {
  async listDocuments(userId: string, workspaceId: string, projectId: string, filter?: DocumentFilter) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const documents = await documentRepository.findByProjectId(projectId, filter);
    const total = await documentRepository.countByProjectId(projectId, filter);
    return { documents, total };
  },

  async getDocument(userId: string, workspaceId: string, projectId: string, documentId: string) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const document = await documentRepository.findById(documentId);
    if (!document || document.projectId !== projectId) {
      throw new HttpError(404, "document_not_found", "Document not found");
    }
    return document;
  },

  async createDocument(userId: string, workspaceId: string, projectId: string, data: CreateDocumentInput) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    return await documentRepository.create(projectId, userId, data);
  },

  async updateDocument(userId: string, workspaceId: string, projectId: string, documentId: string, data: UpdateDocumentInput) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const document = await documentRepository.findById(documentId);
    if (!document || document.projectId !== projectId) {
      throw new HttpError(404, "document_not_found", "Document not found");
    }
    return await documentRepository.update(documentId, data);
  },

  async deleteDocument(userId: string, workspaceId: string, projectId: string, documentId: string) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const document = await documentRepository.findById(documentId);
    if (!document || document.projectId !== projectId) {
      throw new HttpError(404, "document_not_found", "Document not found");
    }
    return await documentRepository.delete(documentId);
  },

  async getVersions(userId: string, workspaceId: string, projectId: string, documentId: string) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const document = await documentRepository.findById(documentId);
    if (!document || document.projectId !== projectId) {
      throw new HttpError(404, "document_not_found", "Document not found");
    }
    return await documentRepository.getVersions(documentId);
  },

  async restoreVersion(userId: string, workspaceId: string, projectId: string, documentId: string, version: number) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const document = await documentRepository.findById(documentId);
    if (!document || document.projectId !== projectId) {
      throw new HttpError(404, "document_not_found", "Document not found");
    }
    return await documentRepository.restoreVersion(documentId, version);
  },

  async batchCreate(userId: string, workspaceId: string, projectId: string, items: CreateDocumentInput[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const results = [];
    for (const item of items) {
      const doc = await documentRepository.create(projectId, userId, item);
      results.push(doc);
    }
    return results;
  },

  async batchUpdate(userId: string, workspaceId: string, projectId: string, updates: { id: string; data: UpdateDocumentInput }[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const results = [];
    for (const update of updates) {
      const doc = await documentRepository.findById(update.id);
      if (!doc || doc.projectId !== projectId) continue;
      const updated = await documentRepository.update(update.id, update.data);
      results.push(updated);
    }
    return results;
  },

  async batchDelete(userId: string, workspaceId: string, projectId: string, documentIds: string[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    for (const id of documentIds) {
      const doc = await documentRepository.findById(id);
      if (!doc || doc.projectId !== projectId) continue;
      await documentRepository.delete(id);
    }
    return { deleted: documentIds.length };
  },
};
import { HttpError } from "../../lib/errors";
import { verifyProjectAccess } from "../../lib/project-access";
import { documentRepository } from "../project-documents/repository";
import { documentCommentRepository } from "./repository";
import type { ReplaceCommentsInput } from "./types";

async function verifyDocumentAccess(
  userId: string,
  workspaceId: string,
  projectId: string,
  documentId: string,
) {
  await verifyProjectAccess(userId, workspaceId, projectId);

  const document = await documentRepository.findById(documentId);
  if (!document || document.projectId !== projectId) {
    throw new HttpError(404, "document_not_found", "Document not found");
  }

  return document;
}

export const documentCommentService = {
  async listComments(
    userId: string,
    workspaceId: string,
    projectId: string,
    documentId: string,
  ) {
    await verifyDocumentAccess(userId, workspaceId, projectId, documentId);
    return {
      comments: await documentCommentRepository.findByDocumentId(documentId),
    };
  },

  async replaceComments(
    userId: string,
    workspaceId: string,
    projectId: string,
    documentId: string,
    payload: ReplaceCommentsInput,
  ) {
    await verifyDocumentAccess(userId, workspaceId, projectId, documentId);
    return {
      comments: await documentCommentRepository.replaceForDocument(
        documentId,
        projectId,
        userId,
        payload,
      ),
    };
  },
};

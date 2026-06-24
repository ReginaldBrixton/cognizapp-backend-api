import { HttpError } from "../../lib/errors";
import { verifyProjectAccess } from "../../lib/project-access";
import { noteRepository } from "./repository";
import type { CreateNoteInput, UpdateNoteInput, NoteFilter } from "./types";

export const noteService = {
  async listNotes(userId: string, workspaceId: string, projectId: string, filter?: NoteFilter) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const notes = await noteRepository.findByProjectId(projectId, filter);
    const total = await noteRepository.countByProjectId(projectId, filter);
    return { notes, total };
  },

  async getNote(userId: string, workspaceId: string, projectId: string, noteId: string) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const note = await noteRepository.findById(noteId);
    if (!note || note.projectId !== projectId) {
      throw new HttpError(404, "note_not_found", "Note not found");
    }
    return note;
  },

  async createNote(userId: string, workspaceId: string, projectId: string, data: CreateNoteInput) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    return await noteRepository.create(projectId, userId, data);
  },

  async updateNote(userId: string, workspaceId: string, projectId: string, noteId: string, data: UpdateNoteInput) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const note = await noteRepository.findById(noteId);
    if (!note || note.projectId !== projectId) {
      throw new HttpError(404, "note_not_found", "Note not found");
    }
    return await noteRepository.update(noteId, data);
  },

  async deleteNote(userId: string, workspaceId: string, projectId: string, noteId: string) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const note = await noteRepository.findById(noteId);
    if (!note || note.projectId !== projectId) {
      throw new HttpError(404, "note_not_found", "Note not found");
    }
    return await noteRepository.delete(noteId);
  },

  async batchCreate(userId: string, workspaceId: string, projectId: string, items: CreateNoteInput[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const results = [];
    for (const item of items) {
      const note = await noteRepository.create(projectId, userId, item);
      results.push(note);
    }
    return results;
  },

  async batchUpdate(userId: string, workspaceId: string, projectId: string, updates: { id: string; data: UpdateNoteInput }[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    const results = [];
    for (const update of updates) {
      const note = await noteRepository.findById(update.id);
      if (!note || note.projectId !== projectId) continue;
      const updated = await noteRepository.update(update.id, update.data);
      results.push(updated);
    }
    return results;
  },

  async batchDelete(userId: string, workspaceId: string, projectId: string, noteIds: string[]) {
    await verifyProjectAccess(userId, workspaceId, projectId);
    for (const id of noteIds) {
      const note = await noteRepository.findById(id);
      if (!note || note.projectId !== projectId) continue;
      await noteRepository.delete(id);
    }
    return { deleted: noteIds.length };
  },
};
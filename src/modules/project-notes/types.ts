export type ProjectNote = {
  id: string;
  projectId: string;
  ownerUid: string;
  title: string;
  content: string;
  contentJson: Record<string, unknown>;
  collaborators: string[];
  isPublic: boolean;
  status: "active" | "archived" | "trashed";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type CreateNoteInput = {
  title?: string;
  content?: string;
  contentJson?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type UpdateNoteInput = Partial<CreateNoteInput> & {
  status?: ProjectNote["status"];
  isPublic?: boolean;
};

export type NoteFilter = {
  search?: string;
  status?: ProjectNote["status"];
  sortBy?: "created_at" | "updated_at" | "title";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
};